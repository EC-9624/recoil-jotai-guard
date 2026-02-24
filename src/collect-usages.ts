import * as fs from 'node:fs';
import {parseSync, type Node} from 'oxc-parser';
import {walk} from 'oxc-walker';
import type {
  ExtractionResult,
  RecoilDefinition,
  Usage,
  UsageCollectionResult,
  UsageType,
} from './types.js';

/** Recoil hooks that produce reader usages. */
const readerHooks = new Set(['useRecoilValue']);
/** Recoil hooks that produce setter usages. */
const setterHooks = new Set(['useSetRecoilState', 'useResetRecoilState']);
/** Recoil hooks that produce both reader and setter usages. */
const dualHooks = new Set(['useRecoilState']);
/** All Recoil hooks we care about. */
const allRecoilHooks = new Set([
  ...readerHooks,
  ...setterHooks,
  ...dualHooks,
  'useRecoilCallback',
]);

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source[index] === '\n') {
      line++;
    }
  }

  return line;
}

/**
 * Extract the atom name from a hook argument. Handles both:
 * - Direct identifier: `useRecoilValue(myAtom)` -> 'myAtom'
 * - Family call: `useRecoilValue(myFamily(id))` -> 'myFamily'
 */
function extractAtomName(argument: any): string | null {
  if (!argument) {
    return null;
  }

  // Direct identifier: useRecoilValue(myAtom)
  if (argument.type === 'Identifier') {
    return argument.name as string;
  }

  // Family call: useRecoilValue(myFamily(id))
  if (
    argument.type === 'CallExpression' &&
    argument.callee?.type === 'Identifier'
  ) {
    return argument.callee.name as string;
  }

  return null;
}

/**
 * Check if a call site is inside a function whose name starts with "initialize"
 * (case-insensitive). This is used to classify set() calls as initializers.
 */
function isInsideInitializer(ancestors: any[]): boolean {
  for (const ancestor of ancestors) {
    // FunctionDeclaration: function initializeMyState(...) { ... }
    if (
      ancestor.type === 'FunctionDeclaration' &&
      ancestor.id?.type === 'Identifier'
    ) {
      const name = ancestor.id.name as string;
      if (/^initialize/i.test(name)) {
        return true;
      }
    }

    // VariableDeclarator: const initializeMyState = (...) => { ... }
    if (
      ancestor.type === 'VariableDeclarator' &&
      ancestor.id?.type === 'Identifier'
    ) {
      const name = ancestor.id.name as string;
      if (/^initialize/i.test(name)) {
        return true;
      }
    }

    // FunctionExpression with a name: const x = function initializeMyState() { ... }
    if (
      ancestor.type === 'FunctionExpression' &&
      ancestor.id?.type === 'Identifier'
    ) {
      const name = ancestor.id.name as string;
      if (/^initialize/i.test(name)) {
        return true;
      }
    }

    // JSXAttribute named 'initializeState' on RecoilRoot
    if (
      ancestor.type === 'JSXAttribute' &&
      ancestor.name?.type === 'JSXIdentifier' &&
      ancestor.name.name === 'initializeState'
    ) {
      return true;
    }
  }

  return false;
}

type CallbackContext = {
  setAlias: string | null;
  resetAlias: string | null;
  getPromiseAlias: string | null;
  snapshotAlias: string | null;
};

/**
 * Parse the destructured parameter of a useRecoilCallback's callback function.
 *
 * Handles two styles:
 * - Style A: ({set, snapshot: {getPromise}}) => ...
 * - Style B: ({set, snapshot}) => ...
 */
// eslint-disable-next-line complexity
function parseCallbackParameter(parameter: any): CallbackContext {
  const context: CallbackContext = {
    setAlias: null,
    resetAlias: null,
    getPromiseAlias: null,
    snapshotAlias: null,
  };

  if (parameter?.type !== 'ObjectPattern') {
    return context;
  }

  const properties = parameter.properties as any[] | undefined;
  if (!properties) {
    return context;
  }

  for (const property of properties) {
    if (property.type !== 'Property') {
      continue;
    }

    const keyName = property.key?.name as string | undefined;
    if (!keyName) {
      continue;
    }

    if (keyName === 'set' && property.value?.type === 'Identifier') {
      context.setAlias = (
        property.shorthand ? property.key.name : property.value.name
      ) as string;
    } else if (keyName === 'reset' && property.value?.type === 'Identifier') {
      context.resetAlias = (
        property.shorthand ? property.key.name : property.value.name
      ) as string;
    } else if (keyName === 'snapshot') {
      if (property.value?.type === 'ObjectPattern') {
        // Style A: nested destructuring {snapshot: {getPromise}}
        const innerProperties = property.value.properties as any[] | undefined;
        if (innerProperties) {
          for (const inner of innerProperties) {
            if (inner.type === 'Property' && inner.key?.name === 'getPromise') {
              context.getPromiseAlias = (
                inner.shorthand ? inner.key.name : inner.value?.name
              ) as string;
            }
          }
        }
      } else if (property.value?.type === 'Identifier') {
        // Style B: snapshot as variable
        context.snapshotAlias = (
          property.shorthand ? property.key.name : property.value.name
        ) as string;
      }
    }
  }

  return context;
}

/**
 * Walk a useRecoilCallback body to find set(), reset(), getPromise(), and
 * snapshot.getPromise() calls.
 */
function walkCallbackBody(
  bodyNode: Node,
  context: CallbackContext,
  filePath: string,
  source: string,
  usages: Usage[],
  ancestors: any[],
): void {
  walk(bodyNode, {
    enter(node) {
      if (node.type !== 'CallExpression') {
        return;
      }

      const callNode = node as any;
      const {callee} = callNode;
      const line = offsetToLine(source, (node as any).start as number);

      // set(X, value) or set(family(id), value)
      if (
        context.setAlias &&
        callee?.type === 'Identifier' &&
        callee.name === context.setAlias
      ) {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          const type: UsageType = isInsideInitializer(ancestors)
            ? 'initializer'
            : 'setter';
          usages.push({
            atomName,
            localName: atomName,
            type,
            hook: 'set(callback)',
            file: filePath,
            line,
          });
        }
      }

      // reset(X) or reset(family(id))
      if (
        context.resetAlias &&
        callee?.type === 'Identifier' &&
        callee.name === context.resetAlias
      ) {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push({
            atomName,
            localName: atomName,
            type: 'setter',
            hook: 'reset(callback)',
            file: filePath,
            line,
          });
        }
      }

      // getPromise(X) -- Style A, sub-pattern 1 (inline nested destructuring)
      if (
        context.getPromiseAlias &&
        callee?.type === 'Identifier' &&
        callee.name === context.getPromiseAlias
      ) {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push({
            atomName,
            localName: atomName,
            type: 'reader',
            hook: 'getPromise(callback)',
            file: filePath,
            line,
          });
        }
      }

      // snapshot.getPromise(X) -- Style B, sub-pattern 2
      if (
        context.snapshotAlias &&
        callee?.type === 'MemberExpression' &&
        callee.object?.type === 'Identifier' &&
        callee.object.name === context.snapshotAlias &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'getPromise'
      ) {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push({
            atomName,
            localName: atomName,
            type: 'reader',
            hook: 'getPromise(callback)',
            file: filePath,
            line,
          });
        }
      }
    },
  });
}

/**
 * Walk a selector's get() body (or inline default get body) for get(X) calls.
 *
 * The `get` function parameter is used to read atoms. We look for
 * CallExpression nodes where the callee is the `get` parameter alias.
 */
function walkSelectorGetBody(
  bodyNode: Node,
  filePath: string,
  source: string,
  usages: Usage[],
  definitionName: string,
): void {
  walk(bodyNode, {
    enter(node) {
      if (node.type !== 'CallExpression') {
        return;
      }

      const callNode = node as any;
      const {callee} = callNode;

      // get(X) -- the callee name is 'get' (the selector's get parameter)
      if (callee?.type === 'Identifier' && callee.name === 'get') {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          const line = offsetToLine(source, (node as any).start as number);
          usages.push({
            atomName,
            localName: atomName,
            type: 'reader',
            hook: 'get(selector)',
            file: filePath,
            line,
            enclosingDefinition: definitionName,
          });
        }
      }
    },
  });
}

/**
 * Collect all Recoil usages from a single file.
 */
function collectFromFile(
  filePath: string,
  source: string,
  usages: Usage[],
): void {
  let ast;
  try {
    ast = parseSync(filePath, source, {
      sourceType: 'module',
      lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
    });
  } catch {
    return;
  }

  // Map local alias -> canonical Recoil hook name
  const hookAliases = new Map<string, string>();

  // Build ancestor chain manually during walk
  const ancestors: any[] = [];

  // Track function names for initializer detection
  // Maps function AST node start -> function name
  const functionNameStack: string[] = [];

  walk(ast.program, {
    // eslint-disable-next-line complexity
    enter(node, parent) {
      ancestors.push(node);

      // Track function names for initializer detection
      if (node.type === 'FunctionDeclaration') {
        const functionNode = node as any;
        if (functionNode.id?.type === 'Identifier') {
          functionNameStack.push(functionNode.id.name as string);
        }
      }

      // --- Import declarations: track Recoil hook aliases ---
      if (node.type === 'ImportDeclaration') {
        const importSource = (node as any).source?.value as string | undefined;
        const importKind = (node as any).importKind as string | undefined;
        if (importSource !== 'recoil' || importKind === 'type') {
          return;
        }

        const specifiers = (node as any).specifiers as any[] | undefined;
        if (!specifiers) {
          return;
        }

        for (const spec of specifiers) {
          if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') {
            continue;
          }

          const imported = spec.imported?.name as string | undefined;
          const local = spec.local?.name as string | undefined;
          if (imported && local && allRecoilHooks.has(imported)) {
            hookAliases.set(local, imported);
          }
        }

        return;
      }

      // --- Call expressions: detect hook calls and initializer set() calls ---
      if (node.type !== 'CallExpression') {
        return;
      }

      const callNode = node as any;
      const {callee} = callNode;
      if (callee?.type !== 'Identifier') {
        return;
      }

      const calleeName = callee.name as string;

      // Detect set() calls inside initialize* functions (not via useRecoilCallback)
      // These are standalone functions that receive `set: SetRecoilState` as a parameter
      if (calleeName === 'set' && functionNameStack.length > 0) {
        const currentFunction = functionNameStack.at(-1);
        if (currentFunction && /^initialize/i.test(currentFunction)) {
          const atomName = extractAtomName(callNode.arguments?.[0]);
          if (atomName) {
            const line = offsetToLine(source, (node as any).start as number);
            usages.push({
              atomName,
              localName: atomName,
              type: 'initializer',
              hook: 'set(initializer)',
              file: filePath,
              line,
            });
          }

          return;
        }
      }

      const hookName = hookAliases.get(calleeName);
      if (!hookName) {
        return;
      }

      const line = offsetToLine(source, (node as any).start as number);

      // useRecoilValue(X)
      if (hookName === 'useRecoilValue') {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push({
            atomName,
            localName: atomName,
            type: 'reader',
            hook: 'useRecoilValue',
            file: filePath,
            line,
          });
        }

        return;
      }

      // useSetRecoilState(X)
      if (hookName === 'useSetRecoilState') {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push({
            atomName,
            localName: atomName,
            type: 'setter',
            hook: 'useSetRecoilState',
            file: filePath,
            line,
          });
        }

        return;
      }

      // useResetRecoilState(X)
      if (hookName === 'useResetRecoilState') {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push({
            atomName,
            localName: atomName,
            type: 'setter',
            hook: 'useResetRecoilState',
            file: filePath,
            line,
          });
        }

        return;
      }

      // useRecoilState(X) -- emit both reader and setter
      if (hookName === 'useRecoilState') {
        const atomName = extractAtomName(callNode.arguments?.[0]);
        if (atomName) {
          usages.push(
            {
              atomName,
              localName: atomName,
              type: 'reader',
              hook: 'useRecoilState',
              file: filePath,
              line,
            },
            {
              atomName,
              localName: atomName,
              type: 'setter',
              hook: 'useRecoilState',
              file: filePath,
              line,
            },
          );
        }

        return;
      }

      // useRecoilCallback(callbackFn)
      if (hookName === 'useRecoilCallback') {
        const callbackFunction = callNode.arguments?.[0];
        if (
          !callbackFunction ||
          (callbackFunction.type !== 'ArrowFunctionExpression' &&
            callbackFunction.type !== 'FunctionExpression')
        ) {
          return;
        }

        const params = callbackFunction.params as any[] | undefined;
        if (!params || params.length === 0) {
          return;
        }

        const context = parseCallbackParameter(params[0]);

        // The callback function's body may itself be a function
        // e.g., ({set}) => () => { ... } or ({set}) => async () => { ... }
        // We need to walk whichever body contains the actual set/get calls
        const {body} = callbackFunction;
        if (body) {
          walkCallbackBody(
            body as Node,
            context,
            filePath,
            source,
            usages,
            ancestors,
          );
        }
      }
    },
    leave(node) {
      ancestors.pop();

      // Pop function name when leaving a FunctionDeclaration
      if (node.type === 'FunctionDeclaration') {
        const functionNode = node as any;
        if (functionNode.id?.type === 'Identifier') {
          functionNameStack.pop();
        }
      }
    },
  });
}

/**
 * Walk selector get() bodies and inline default get bodies from the extraction
 * results to collect get(X) reader usages.
 */
function collectFromSelectorBodies(
  extraction: ExtractionResult,
  usages: Usage[],
): void {
  for (const def of extraction.recoilDefinitions) {
    const source = readFileSource(def.file);
    if (!source) {
      continue;
    }

    // Standalone selector/selectorFamily get() body
    if (
      (def.kind === 'selector' || def.kind === 'selectorFamily') &&
      def.getBodyAst
    ) {
      walkSelectorGetBody(def.getBodyAst, def.file, source, usages, def.name);
    }

    // Inline default selector get() body (atom/atomFamily with default: selector/selectorFamily)
    if (
      (def.kind === 'atom' || def.kind === 'atomFamily') &&
      def.inlineDefaultGetBody
    ) {
      walkSelectorGetBody(
        def.inlineDefaultGetBody,
        def.file,
        source,
        usages,
        def.name,
      );
    }
  }
}

// Simple file source cache
const sourceCache = new Map<string, string>();

function readFileSource(filePath: string): string | null {
  const cached = sourceCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const source = fs.readFileSync(filePath, 'utf8');
    sourceCache.set(filePath, source);
    return source;
  } catch {
    return null;
  }
}

export function collectUsages(
  files: string[],
  extraction: ExtractionResult,
): UsageCollectionResult {
  const usages: Usage[] = [];

  // Clear source cache
  sourceCache.clear();

  // Pass 2a: Collect hook-based usages from all files
  for (const filePath of files) {
    const source = readFileSource(filePath);
    if (!source) {
      continue;
    }

    collectFromFile(filePath, source, usages);
  }

  // Pass 2b: Collect get(X) usages from selector bodies
  collectFromSelectorBodies(extraction, usages);

  return {usages};
}

import * as fs from 'node:fs';
import {parseSync, type Node} from 'oxc-parser';
import {walk} from 'oxc-walker';
import type {
  ExtractionResult,
  JotaiDefinition,
  JotaiImport,
  RecoilDefinition,
  StateKind,
} from './types.js';

const recoilStateCreators = new Set([
  'atom',
  'selector',
  'atomFamily',
  'selectorFamily',
]);

const jotaiAtomCreators = new Set([
  'atom',
  'atomFamily',
  'atomWithDefault',
  'atomWithReset',
  'atomWithStorage',
  'atomWithReducer',
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

function isJotaiSource(source: string): boolean {
  return (
    source === 'jotai' ||
    source.startsWith('jotai/') ||
    source.includes('/jotai/')
  );
}

/**
 * Extract the `get()` body AST from a selector's config object.
 *
 * For `selector({ get: ({get}) => ... })`:
 *   - ArrowFunctionExpression whose body is the get body
 *   - FunctionExpression (method shorthand: get({get}) { ... })
 *
 * Returns the function body node (BlockStatement or expression body).
 */
function extractSelectorGetBody(configObject: Node): Node | null {
  if (configObject.type !== 'ObjectExpression') {
    return null;
  }

  const properties = (configObject as any).properties as any[] | undefined;
  if (!properties) {
    return null;
  }

  const getProperty = properties.find(
    (p: any) =>
      p.type === 'Property' &&
      p.key?.type === 'Identifier' &&
      p.key.name === 'get',
  );

  if (!getProperty) {
    return null;
  }

  const {value} = getProperty;

  // ArrowFunctionExpression: get: ({get}) => ...
  if (value?.type === 'ArrowFunctionExpression') {
    return value.body ?? null;
  }

  // FunctionExpression (method shorthand): get({get}) { ... }
  if (value?.type === 'FunctionExpression') {
    return value.body ?? null;
  }

  return null;
}

/**
 * Extract the inner get() body from a selectorFamily's config object.
 *
 * Pattern: get: (id) => ({get}) => { ... }
 * The outer arrow receives the param, the inner arrow receives {get}.
 */
function extractSelectorFamilyGetBody(configObject: Node): Node | null {
  if (configObject.type !== 'ObjectExpression') {
    return null;
  }

  const properties = (configObject as any).properties as any[] | undefined;
  if (!properties) {
    return null;
  }

  const getProperty = properties.find(
    (p: any) =>
      p.type === 'Property' &&
      p.key?.type === 'Identifier' &&
      p.key.name === 'get',
  );

  if (!getProperty) {
    return null;
  }

  const outerFunction = getProperty.value;

  // Outer: (id) => ...
  if (outerFunction?.type !== 'ArrowFunctionExpression') {
    return null;
  }

  const innerFunction = outerFunction.body;

  // Inner: ({get}) => { ... }
  if (
    innerFunction?.type === 'ArrowFunctionExpression' ||
    innerFunction?.type === 'FunctionExpression'
  ) {
    return innerFunction.body ?? null;
  }

  return null;
}

/**
 * Extract inline default selector/selectorFamily get() body from an
 * atom/atomFamily config's `default` property.
 */
function extractInlineDefaultGetBody(
  configObject: Node,
  recoilAliases: Map<string, string>,
): Node | null {
  if (configObject.type !== 'ObjectExpression') {
    return null;
  }

  const properties = (configObject as any).properties as any[] | undefined;
  if (!properties) {
    return null;
  }

  const defaultProperty = properties.find(
    (p: any) =>
      p.type === 'Property' &&
      p.key?.type === 'Identifier' &&
      p.key.name === 'default',
  );

  if (!defaultProperty) {
    return null;
  }

  const defaultValue = defaultProperty.value;
  if (defaultValue?.type !== 'CallExpression') {
    return null;
  }

  const {callee} = defaultValue;
  if (callee?.type !== 'Identifier') {
    return null;
  }

  const calleeName = callee.name as string;

  // Check if the callee is a selector or selectorFamily alias
  const resolvedKind = recoilAliases.get(calleeName);

  if (resolvedKind === 'selector') {
    const innerConfig = defaultValue.arguments?.[0];
    if (innerConfig) {
      return extractSelectorGetBody(innerConfig as Node);
    }
  }

  if (resolvedKind === 'selectorFamily') {
    const innerConfig = defaultValue.arguments?.[0];
    if (innerConfig) {
      return extractSelectorFamilyGetBody(innerConfig as Node);
    }
  }

  return null;
}

function extractFromFile(
  filePath: string,
  source: string,
  result: ExtractionResult,
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

  // Maps: localName -> recoil kind name (e.g., 'myAtom' -> 'atom')
  const recoilAliases = new Map<string, string>();
  // Maps: localName -> jotai creator name
  const jotaiCreatorAliases = new Map<string, string>();

  walk(ast.program, {
    // eslint-disable-next-line complexity
    enter(node, parent) {
      // --- Import declarations ---
      if (node.type === 'ImportDeclaration') {
        const importSource = (node as any).source?.value as string | undefined;
        const importKind = (node as any).importKind as string | undefined;
        if (!importSource) {
          return;
        }

        const specifiers = (node as any).specifiers as any[] | undefined;
        if (!specifiers) {
          return;
        }

        // Recoil imports
        if (importSource === 'recoil') {
          if (importKind === 'type') {
            return;
          }

          for (const spec of specifiers) {
            if (spec.type !== 'ImportSpecifier') {
              continue;
            }

            if (spec.importKind === 'type') {
              continue;
            }

            const imported = spec.imported?.name as string | undefined;
            const local = spec.local?.name as string | undefined;
            if (imported && local && recoilStateCreators.has(imported)) {
              recoilAliases.set(local, imported);
            }
          }
        }

        // Jotai imports
        if (isJotaiSource(importSource)) {
          if (importKind === 'type') {
            return;
          }

          for (const spec of specifiers) {
            if (spec.type !== 'ImportSpecifier') {
              continue;
            }

            if (spec.importKind === 'type') {
              continue;
            }

            const imported = spec.imported?.name as string | undefined;
            const local = spec.local?.name as string | undefined;
            if (!imported || !local) {
              continue;
            }

            // Record JotaiImport
            result.jotaiImports.push({
              localName: local,
              importedName: imported,
              source: importSource,
              file: filePath,
            });

            // Track jotai atom creators
            if (jotaiAtomCreators.has(imported)) {
              jotaiCreatorAliases.set(local, imported);
            }
          }
        }

        return;
      }

      // --- Call expressions (definitions) ---
      if (
        node.type === 'CallExpression' &&
        parent?.type === 'VariableDeclarator'
      ) {
        const {callee} = node as any;
        if (callee?.type !== 'Identifier') {
          return;
        }

        const calleeName = callee.name as string;
        const parentId = (parent as any).id;
        if (parentId?.type !== 'Identifier') {
          return;
        }

        const defName = parentId.name as string;
        const line = offsetToLine(source, (parent as any).start as number);

        // Recoil definition
        const recoilKind = recoilAliases.get(calleeName);
        if (recoilKind) {
          const kind = recoilKind as StateKind;
          const configArgument = (node as any).arguments?.[0] as
            | Node
            | undefined;

          let getBodyAst: Node | null = null;
          let inlineDefaultGetBody: Node | null = null;

          if (kind === 'selector' && configArgument) {
            getBodyAst = extractSelectorGetBody(configArgument);
          } else if (kind === 'selectorFamily' && configArgument) {
            getBodyAst = extractSelectorFamilyGetBody(configArgument);
          } else if (
            (kind === 'atom' || kind === 'atomFamily') &&
            configArgument
          ) {
            inlineDefaultGetBody = extractInlineDefaultGetBody(
              configArgument,
              recoilAliases,
            );
          }

          result.recoilDefinitions.push({
            name: defName,
            kind,
            file: filePath,
            line,
            getBodyAst,
            inlineDefaultGetBody,
          });

          return;
        }

        // Jotai definition
        const jotaiKind = jotaiCreatorAliases.get(calleeName);
        if (jotaiKind) {
          result.jotaiDefinitions.push({
            name: defName,
            file: filePath,
            line,
          });
        }
      }
    },
  });
}

export function extractDefinitions(files: string[]): ExtractionResult {
  const result: ExtractionResult = {
    recoilDefinitions: [],
    jotaiDefinitions: [],
    jotaiImports: [],
  };

  for (const filePath of files) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    extractFromFile(filePath, source, result);
  }

  return result;
}

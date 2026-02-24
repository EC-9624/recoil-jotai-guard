import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseSync, type Node} from 'oxc-parser';
import {walk} from 'oxc-walker';
import type {
  ExtractionResult,
  HookWriteBinding,
  SetterBindingMap,
} from './types.js';

/** Recoil hooks that produce setter-only bindings. */
const setterHookNames = new Set(['useSetRecoilState', 'useResetRecoilState']);

/** Recoil hooks that produce tuple (reader + setter) bindings. */
const tupleHookNames = new Set(['useRecoilState']);

/** All setter-related Recoil hooks (union of setter + tuple). */
const allSetterHooks = new Set([...setterHookNames, ...tupleHookNames]);

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
 * - Direct identifier: `useSetRecoilState(myAtom)` -> 'myAtom'
 * - Family call: `useSetRecoilState(myFamily(id))` -> 'myFamily'
 */
function extractAtomName(argument: any): string | null {
  if (!argument) {
    return null;
  }

  if (argument.type === 'Identifier') {
    return argument.name as string;
  }

  if (
    argument.type === 'CallExpression' &&
    argument.callee?.type === 'Identifier'
  ) {
    return argument.callee.name as string;
  }

  return null;
}

/**
 * Build a map of Recoil hook local aliases for a file's import declarations.
 *
 * Scans the file AST's ImportDeclarations for `from 'recoil'` and returns
 * a map: localName -> canonical hook name (e.g., 'useSetRecoilState').
 */
function getRecoilHookAliases(ast: any): Map<string, string> {
  const aliases = new Map<string, string>();

  walk(ast, {
    enter(node) {
      if (node.type !== 'ImportDeclaration') {
        return;
      }

      const importNode = node as any;
      const importSource = importNode.source?.value as string | undefined;
      const importKind = importNode.importKind as string | undefined;

      if (importSource !== 'recoil' || importKind === 'type') {
        return;
      }

      const specifiers = importNode.specifiers as any[] | undefined;
      if (!specifiers) {
        return;
      }

      for (const spec of specifiers) {
        if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') {
          continue;
        }

        const imported = spec.imported?.name as string | undefined;
        const local = spec.local?.name as string | undefined;
        if (imported && local && allSetterHooks.has(imported)) {
          aliases.set(local, imported);
        }
      }
    },
  });

  return aliases;
}

/**
 * Check if a `CallExpression` is a direct Recoil setter/tuple hook call.
 *
 * Returns a `HookWriteBinding` with the atom name resolved from the first
 * argument, or `undefined` if the call is not a recognized hook.
 *
 * @param callExpr - The CallExpression AST node
 * @param hookAliases - Map of local alias -> canonical Recoil hook name
 */
export function resolveDirectHookWriteBinding(
  callExpr: any,
  hookAliases: Map<string, string>,
): HookWriteBinding | undefined {
  const {callee} = callExpr;
  if (callee?.type !== 'Identifier') {
    return undefined;
  }

  const calleeName = callee.name as string;
  const canonicalHook = hookAliases.get(calleeName);
  if (!canonicalHook) {
    return undefined;
  }

  const atomName = extractAtomName(callExpr.arguments?.[0]);
  if (!atomName) {
    return undefined;
  }

  if (setterHookNames.has(canonicalHook)) {
    return {kind: 'setter', stateId: atomName};
  }

  if (tupleHookNames.has(canonicalHook)) {
    return {kind: 'tuple', stateId: atomName};
  }

  return undefined;
}

/** Parsed file info for resolving function definitions. */
type ParsedFile = {
  ast: any;
  source: string;
};

/** Result of resolving a callee to its function definition. */
type FunctionDefinitionResult = {
  /** The function body AST node. */
  body: any;
  /** The file where the function is defined. */
  file: string;
  /** Line number of the function definition. */
  line: number;
  /** Whether the body is an arrow shorthand (expression, not block). */
  isArrowShorthand: boolean;
  /** Hook aliases from the file's imports. */
  hookAliases: Map<string, string>;
};

/** Maximum depth for following import/re-export chains. */
const maxChainDepth = 5;

/** Cache for parsed file ASTs. */
const parsedFileCache = new Map<string, ParsedFile | null>();

/**
 * Parse a file and cache the result.
 */
function parseFile(filePath: string): ParsedFile | null {
  const cached = parsedFileCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    parsedFileCache.set(filePath, null);
    return null;
  }

  try {
    const ast = parseSync(filePath, source, {
      sourceType: 'module',
      lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
    });
    const result: ParsedFile = {ast: ast.program, source};
    parsedFileCache.set(filePath, result);
    return result;
  } catch {
    parsedFileCache.set(filePath, null);
    return null;
  }
}

/**
 * Find a function definition by name within a file's top-level declarations.
 *
 * Handles:
 * - `FunctionDeclaration`: `export function useSetFoo() { ... }`
 * - `VariableDeclarator` with arrow/function expression:
 *   `export const useSetFoo = () => ...`
 */
function findFunctionInFile(
  name: string,
  filePath: string,
): FunctionDefinitionResult | undefined {
  const parsed = parseFile(filePath);
  if (!parsed) {
    return undefined;
  }

  const hookAliases = getRecoilHookAliases(parsed.ast);
  let result: FunctionDefinitionResult | undefined;

  walk(parsed.ast, {
    enter(node, parent) {
      if (result) {
        return;
      }

      // FunctionDeclaration: function useSetFoo() { ... }
      if (
        node.type === 'FunctionDeclaration' &&
        (node as any).id?.type === 'Identifier' &&
        (node as any).id.name === name
      ) {
        const {body} = node as any;
        if (body) {
          result = {
            body,
            file: filePath,
            line: offsetToLine(parsed.source, (node as any).start as number),
            isArrowShorthand: false,
            hookAliases,
          };
        }

        return;
      }

      // VariableDeclarator: const useSetFoo = () => ... or const useSetFoo = function() { ... }
      if (
        node.type === 'VariableDeclarator' &&
        (node as any).id?.type === 'Identifier' &&
        (node as any).id.name === name
      ) {
        const {init} = node as any;
        if (
          init?.type === 'ArrowFunctionExpression' ||
          init?.type === 'FunctionExpression'
        ) {
          const isArrowShorthand =
            init.type === 'ArrowFunctionExpression' &&
            init.body?.type !== 'FunctionBody';
          result = {
            body: init.body,
            file: filePath,
            line: offsetToLine(parsed.source, (node as any).start as number),
            isArrowShorthand,
            hookAliases,
          };
        }
      }
    },
  });

  return result;
}

/**
 * Resolve a module specifier to an absolute file path.
 */
function resolveModulePath(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const dir = path.dirname(fromFile);
  const basePath = path.resolve(dir, specifier);

  const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  for (const extension of extensions) {
    const candidate = basePath + extension;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Import record for resolving callee functions across files.
 */
type ImportRecord = {
  localName: string;
  exportedName: string;
  sourceFile: string;
};

/**
 * Re-export record for following export chains.
 */
type ReExportRecord = {
  type: 'named' | 'star';
  localName?: string;
  exportedName?: string;
  sourceFile: string;
};

/**
 * Collect import and re-export records from a file AST.
 */
function collectFileImportsAndExports(
  filePath: string,
  ast: any,
): {imports: ImportRecord[]; reExports: ReExportRecord[]} {
  const imports: ImportRecord[] = [];
  const reExports: ReExportRecord[] = [];

  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as any;
        const importSource = importNode.source?.value as string | undefined;
        const importKind = importNode.importKind as string | undefined;

        if (!importSource || importKind === 'type') {
          return;
        }

        const resolvedSource = resolveModulePath(importSource, filePath);
        if (!resolvedSource) {
          return;
        }

        const specifiers = importNode.specifiers as any[] | undefined;
        if (!specifiers) {
          return;
        }

        for (const spec of specifiers) {
          if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') {
            continue;
          }

          const imported = spec.imported?.name as string | undefined;
          const local = spec.local?.name as string | undefined;
          if (imported && local) {
            imports.push({
              localName: local,
              exportedName: imported,
              sourceFile: resolvedSource,
            });
          }
        }

        return;
      }

      if (node.type === 'ExportNamedDeclaration') {
        const exportNode = node as any;
        const exportSource = exportNode.source?.value as string | undefined;

        if (exportSource) {
          const resolvedSource = resolveModulePath(exportSource, filePath);
          if (!resolvedSource) {
            return;
          }

          const specifiers = exportNode.specifiers as any[] | undefined;
          if (specifiers) {
            for (const spec of specifiers) {
              const exported = spec.exported?.name as string | undefined;
              const local = spec.local?.name as string | undefined;
              if (exported && local) {
                reExports.push({
                  type: 'named',
                  localName: exported,
                  exportedName: local,
                  sourceFile: resolvedSource,
                });
              }
            }
          }
        }

        return;
      }

      if (node.type === 'ExportAllDeclaration') {
        const exportNode = node as any;
        const exportSource = exportNode.source?.value as string | undefined;
        if (exportSource) {
          const resolvedSource = resolveModulePath(exportSource, filePath);
          if (resolvedSource) {
            reExports.push({
              type: 'star',
              sourceFile: resolvedSource,
            });
          }
        }
      }
    },
  });

  return {imports, reExports};
}

/**
 * Follow an exported name through re-export chains to find its source file.
 */
function followExportChain(
  name: string,
  filePath: string,
  depth: number,
  visited: Set<string>,
): {sourceFile: string; exportedName: string} | undefined {
  if (depth > maxChainDepth) {
    return undefined;
  }

  const visitKey = `${filePath}:${name}`;
  if (visited.has(visitKey)) {
    return undefined;
  }

  visited.add(visitKey);

  // Check if name is defined locally in the file
  const localDef = findFunctionInFile(name, filePath);
  if (localDef) {
    return {sourceFile: filePath, exportedName: name};
  }

  // Check re-exports
  const parsed = parseFile(filePath);
  if (!parsed) {
    return undefined;
  }

  const {imports, reExports} = collectFileImportsAndExports(
    filePath,
    parsed.ast,
  );

  // Named re-exports: export { X } from './source'
  for (const reExport of reExports) {
    if (reExport.type === 'named' && reExport.localName === name) {
      return followExportChain(
        reExport.exportedName!,
        reExport.sourceFile,
        depth + 1,
        visited,
      );
    }
  }

  // Star re-exports: export * from './source'
  for (const reExport of reExports) {
    if (reExport.type === 'star') {
      const result = followExportChain(
        name,
        reExport.sourceFile,
        depth + 1,
        visited,
      );
      if (result) {
        return result;
      }
    }
  }

  // Import then local export: import { X } from './source'; export { X }
  for (const importRecord of imports) {
    if (importRecord.localName === name) {
      return followExportChain(
        importRecord.exportedName,
        importRecord.sourceFile,
        depth + 1,
        visited,
      );
    }
  }

  return undefined;
}

/**
 * Resolve a callee identifier to its function definition AST.
 *
 * For same-file definitions, scans the file AST. For imported identifiers,
 * follows the import chain to find the source file and exported function.
 *
 * @param calleeName - The identifier name of the callee
 * @param file - The file where the call expression appears
 */
export function resolveCalleeToFunctionDefinition(
  calleeName: string,
  file: string,
): FunctionDefinitionResult | undefined {
  // Step 1: Check if calleeName is defined in the same file
  const localDef = findFunctionInFile(calleeName, file);
  if (localDef) {
    return localDef;
  }

  // Step 2: Check imports
  const parsed = parseFile(file);
  if (!parsed) {
    return undefined;
  }

  const {imports} = collectFileImportsAndExports(file, parsed.ast);

  for (const importRecord of imports) {
    if (importRecord.localName === calleeName) {
      // Follow the chain to find the actual definition
      const resolved = followExportChain(
        importRecord.exportedName,
        importRecord.sourceFile,
        1,
        new Set(),
      );
      if (resolved) {
        return findFunctionInFile(resolved.exportedName, resolved.sourceFile);
      }

      // Direct check in the source file
      const directDef = findFunctionInFile(
        importRecord.exportedName,
        importRecord.sourceFile,
      );
      if (directDef) {
        return directDef;
      }
    }
  }

  return undefined;
}

/**
 * Extract the return expression from a wrapper function definition.
 *
 * Handles two cases:
 * - Arrow shorthand: `() => expr` -> the body IS the return expression
 * - Block body: find the first `ReturnStatement` in the function's own scope
 *   (skip nested functions)
 *
 * The return expression must be a `CallExpression` that
 * `resolveDirectHookWriteBinding` can resolve. Otherwise returns `undefined`.
 */
export function analyzeWrapperReturnExpression(
  functionDef: FunctionDefinitionResult,
): HookWriteBinding | undefined {
  const returnExpr = getReturnExpression(functionDef);
  if (!returnExpr) {
    return undefined;
  }

  if (returnExpr.type === 'CallExpression') {
    return resolveDirectHookWriteBinding(returnExpr, functionDef.hookAliases);
  }

  return undefined;
}

/**
 * Get the return expression from a function definition.
 *
 * - Arrow shorthand: body IS the return expression
 * - Block body: find the first ReturnStatement in own scope (skip nested functions)
 */
function getReturnExpression(
  functionDef: FunctionDefinitionResult,
): any | undefined {
  const {body, isArrowShorthand} = functionDef;

  // Arrow shorthand: () => expr
  if (isArrowShorthand) {
    return body;
  }

  // Block body: find the first ReturnStatement
  if (!body) {
    return undefined;
  }

  return findFirstReturnInOwnScope(body);
}

/**
 * Find the first ReturnStatement in the given block, skipping nested functions.
 */
function findFirstReturnInOwnScope(blockNode: any): any | undefined {
  let result: any | undefined;

  walk(blockNode as Node, {
    enter(node) {
      if (result) {
        return;
      }

      // Skip nested function bodies
      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        // Don't descend into nested functions, but we need to allow
        // walking the top-level block itself. The first enter is the
        // block node or function body, so we skip ONLY nested functions.
        // Since walk enters the top-level node first, and we're walking
        // the block (not the function), nested functions are any function
        // node we encounter.
        return;
      }

      if (node.type === 'ReturnStatement') {
        const returnNode = node as any;
        if (returnNode.argument) {
          result = returnNode.argument;
        }
      }
    },
  });

  return result;
}

/**
 * Main entry point: resolve a call expression to a `HookWriteBinding`.
 *
 * Tries direct resolution first (is the call itself a Recoil hook?),
 * then single-level wrapper resolution via callee-to-function lookup
 * and `analyzeWrapperReturnExpression`.
 *
 * Results are cached by `"file:line"` key.
 *
 * @param callExpr - The CallExpression AST node
 * @param file - The file where the call expression appears
 * @param hookAliases - Map of local alias -> canonical Recoil hook name for the file
 * @param wrapperCache - Cache for wrapper analysis results
 */
export function resolveHookWriteBinding(
  callExpr: any,
  file: string,
  hookAliases: Map<string, string>,
  wrapperCache: Map<string, HookWriteBinding | null>,
): HookWriteBinding | undefined {
  // Step 1: Try direct resolution
  const directBinding = resolveDirectHookWriteBinding(callExpr, hookAliases);
  if (directBinding) {
    return directBinding;
  }

  // Step 2: Resolve callee to its function definition (single level)
  const {callee} = callExpr;
  if (callee?.type !== 'Identifier') {
    return undefined;
  }

  const calleeName = callee.name as string;
  const functionDef = resolveCalleeToFunctionDefinition(calleeName, file);
  if (!functionDef) {
    return undefined;
  }

  // Step 3: Check cache
  const cacheKey = `${functionDef.file}:${functionDef.line}`;
  const cached = wrapperCache.get(cacheKey);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  // Step 4: Analyze the wrapper's return expression
  const binding = analyzeWrapperReturnExpression(functionDef);
  wrapperCache.set(cacheKey, binding ?? null);
  return binding;
}

/**
 * Map declared variable names to atom names in the binding map.
 *
 * - Simple Identifier: `const setFoo = useSetFoo()` -> `"file:setFoo"` -> atomName
 * - ArrayPattern (tuple): `const [val, setFoo] = useFoo()` -> `"file:setFoo"` -> atomName
 */
export function bindSetterIdentifiers(
  declarator: any,
  binding: HookWriteBinding,
  file: string,
  setterBindings: SetterBindingMap,
): void {
  // Case 1: Simple identifier -- const setFoo = useSetFoo()
  if (binding.kind === 'setter' && declarator.id?.type === 'Identifier') {
    const name = declarator.id.name as string;
    setterBindings.set(`${file}:${name}`, binding.stateId);
    return;
  }

  // Case 2: Array destructuring -- const [foo, setFoo] = useFoo()
  if (binding.kind === 'tuple' && declarator.id?.type === 'ArrayPattern') {
    const elements = declarator.id.elements as any[] | undefined;
    if (elements && elements.length >= 2) {
      const setterElement = elements[1];
      if (setterElement?.type === 'Identifier') {
        const name = setterElement.name as string;
        setterBindings.set(`${file}:${name}`, binding.stateId);
      }
    }
  }
}

/**
 * Walk all files, find VariableDeclarator nodes with CallExpression initializers,
 * run the resolution pipeline, and build the SetterBindingMap.
 *
 * Also tracks which factory sites were resolved (for coverage merge in impact.ts).
 */
export function buildSetterBindings(
  files: string[],
  _extraction: ExtractionResult,
): {
  setterBindings: SetterBindingMap;
  resolvedFactoryKeys: Set<string>;
} {
  const setterBindings: SetterBindingMap = new Map();
  const wrapperCache = new Map<string, HookWriteBinding | null>();
  const resolvedFactoryKeys = new Set<string>();

  // Clear parsed file cache at the start
  parsedFileCache.clear();

  for (const file of files) {
    const parsed = parseFile(file);
    if (!parsed) {
      continue;
    }

    const hookAliases = getRecoilHookAliases(parsed.ast);

    walk(parsed.ast, {
      enter(node) {
        if (
          node.type !== 'VariableDeclarator' ||
          (node as any).init?.type !== 'CallExpression'
        ) {
          return;
        }

        const declarator = node as any;
        const callExpr = declarator.init;

        const binding = resolveHookWriteBinding(
          callExpr,
          file,
          hookAliases,
          wrapperCache,
        );
        if (!binding) {
          return;
        }

        bindSetterIdentifiers(declarator, binding, file, setterBindings);

        // Track resolved factory sites: if this was a wrapper call (not direct),
        // the wrapper function's factory site is now resolved
        const directBinding = resolveDirectHookWriteBinding(
          callExpr,
          hookAliases,
        );
        if (!directBinding) {
          // This was resolved via wrapper; the wrapper function has been traced
          const calleeName = callExpr.callee?.name as string | undefined;
          if (calleeName) {
            const functionDef = resolveCalleeToFunctionDefinition(
              calleeName,
              file,
            );
            if (functionDef) {
              resolvedFactoryKeys.add(
                `${functionDef.file}:${functionDef.line}`,
              );
            }
          }
        }
      },
    });
  }

  return {setterBindings, resolvedFactoryKeys};
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseSync} from 'oxc-parser';
import {walk} from 'oxc-walker';
import type {
  ExtractionResult,
  ResolvedUsage,
  UsageCollectionResult,
} from './types.js';

/** Maximum depth for following import/re-export chains to avoid infinite loops. */
const maxChainDepth = 5;

/**
 * Per-file import record.
 * Maps (importingFile, localName) -> (resolvedSourceFile, exportedName).
 */
type ImportRecord = {
  localName: string;
  exportedName: string;
  sourceFile: string;
};

/**
 * Per-file re-export record.
 * Named: `export { X as Y } from './source'`
 * Star: `export * from './source'`
 */
type ReExportRecord = {
  type: 'named' | 'star';
  localName?: string; // for named: the exported name from this file
  exportedName?: string; // for named: the name in the source file
  sourceFile: string;
};

/** Source root for resolving @/ path aliases. Set during resolveUsages(). */
let sourceRoot: string | null = null;

/**
 * Infer the source root (the `src/` directory) from the target directory.
 *
 * For paths like `.../apps/prtimes/src/features/press-release-editor-v3/`,
 * the source root is `.../apps/prtimes/src/`.
 *
 * We look for the LAST `/src/` segment, since the monorepo may have
 * a parent `src/` directory (e.g., `prtimes-frontend/src/apps/prtimes/src/`).
 */
function inferSourceRoot(targetDir: string): string | null {
  const srcSegment = `${path.sep}src${path.sep}`;
  const lastSrcIndex = targetDir.lastIndexOf(srcSegment);
  if (lastSrcIndex === -1) {
    // Try the case where targetDir ends with /src
    if (targetDir.endsWith(`${path.sep}src`)) {
      return targetDir;
    }

    return null;
  }

  return targetDir.slice(0, lastSrcIndex + 4); // +4 for '/src'
}

/** Try to resolve a module specifier to an absolute file path. */
function resolveModulePath(specifier: string, fromFile: string): string | null {
  let resolvedSpecifier = specifier;

  // Handle @/ path alias
  if (specifier.startsWith('@/')) {
    if (!sourceRoot) {
      // Try to infer from fromFile
      const inferred = inferSourceRoot(fromFile);
      if (inferred) {
        sourceRoot = inferred;
      } else {
        return null;
      }
    }

    resolvedSpecifier =
      './' +
      path.relative(
        path.dirname(fromFile),
        path.join(sourceRoot, specifier.slice(2)),
      );
  }

  // Only handle relative paths (after alias resolution)
  if (!resolvedSpecifier.startsWith('.')) {
    return null;
  }

  const dir = path.dirname(fromFile);
  const basePath = path.resolve(dir, resolvedSpecifier);

  // Try extensions in order
  const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

  // First try exact match (in case specifier already has extension)
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
 * Parse a file and collect its imports and re-exports.
 */
function parseFileImports(
  filePath: string,
  source: string,
): {
  imports: ImportRecord[];
  reExports: ReExportRecord[];
  localExports: Set<string>;
} {
  const imports: ImportRecord[] = [];
  const reExports: ReExportRecord[] = [];
  const localExports = new Set<string>();

  let ast;
  try {
    ast = parseSync(filePath, source, {
      sourceType: 'module',
      lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
    });
  } catch {
    return {imports, reExports, localExports};
  }

  walk(ast.program, {
    // eslint-disable-next-line complexity
    enter(node) {
      // ImportDeclaration: import { X as Y } from './source'
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

      // ExportNamedDeclaration with source: export { X } from './source'
      if (node.type === 'ExportNamedDeclaration') {
        const exportNode = node as any;
        const exportSource = exportNode.source?.value as string | undefined;

        if (exportSource) {
          // Re-export from another module
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
        } else {
          // Local export: export { X } or export const X = ...
          const specifiers = exportNode.specifiers as any[] | undefined;
          if (specifiers) {
            for (const spec of specifiers) {
              const exported = spec.exported?.name as string | undefined;
              if (exported) {
                localExports.add(exported);
              }
            }
          }

          // export const/function declaration
          const {declaration} = exportNode;
          if (declaration) {
            if (
              declaration.type === 'VariableDeclaration' &&
              declaration.declarations
            ) {
              for (const decl of declaration.declarations as any[]) {
                if (decl.id?.type === 'Identifier') {
                  localExports.add(decl.id.name as string);
                }
              }
            } else if (
              declaration.type === 'FunctionDeclaration' &&
              declaration.id?.type === 'Identifier'
            ) {
              localExports.add(declaration.id.name as string);
            }
          }
        }

        return;
      }

      // ExportAllDeclaration: export * from './source'
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

  return {imports, reExports, localExports};
}

/**
 * Build a complete import/re-export graph for all files.
 */
type FileGraph = Map<
  string,
  {
    imports: ImportRecord[];
    reExports: ReExportRecord[];
    localExports: Set<string>;
  }
>;

function buildFileGraph(files: string[]): FileGraph {
  const graph: FileGraph = new Map();

  for (const filePath of files) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    graph.set(filePath, parseFileImports(filePath, source));
  }

  return graph;
}

/**
 * Build a definition lookup map: (file, exportedName) -> canonical definition name.
 */
type DefinitionLookup = Map<string, Map<string, string>>;

function buildDefinitionLookup(extraction: ExtractionResult): DefinitionLookup {
  const lookup: DefinitionLookup = new Map();

  for (const def of extraction.recoilDefinitions) {
    if (!lookup.has(def.file)) {
      lookup.set(def.file, new Map());
    }

    lookup.get(def.file)!.set(def.name, def.name);
  }

  return lookup;
}

/**
 * Resolve a name in a given file to its canonical definition name.
 *
 * Follows import chains and re-export chains up to maxChainDepth.
 */
function resolveName(
  file: string,
  name: string,
  graph: FileGraph,
  definitionLookup: DefinitionLookup,
  depth: number,
  visited: Set<string>,
): {resolvedName: string; definitionFile: string} | null {
  if (depth > maxChainDepth) {
    return null;
  }

  const visitKey = `${file}:${name}`;
  if (visited.has(visitKey)) {
    return null;
  }

  visited.add(visitKey);

  // Check if the name is defined in this file
  const fileDefs = definitionLookup.get(file);
  if (fileDefs?.has(name)) {
    return {resolvedName: fileDefs.get(name)!, definitionFile: file};
  }

  const fileInfo = graph.get(file);
  if (!fileInfo) {
    return null;
  }

  // Check imports: maybe this name was imported from somewhere
  for (const importRecord of fileInfo.imports) {
    if (importRecord.localName === name) {
      return resolveName(
        importRecord.sourceFile,
        importRecord.exportedName,
        graph,
        definitionLookup,
        depth + 1,
        visited,
      );
    }
  }

  return null;
}

/**
 * Resolve a name that is exported from a file (following re-export chains).
 * Used when following import chains: file A imports name from file B,
 * but file B might re-export it from file C.
 */
function resolveExportedName(
  file: string,
  name: string,
  graph: FileGraph,
  definitionLookup: DefinitionLookup,
  depth: number,
  visited: Set<string>,
): {resolvedName: string; definitionFile: string} | null {
  if (depth > maxChainDepth) {
    return null;
  }

  const visitKey = `${file}:${name}`;
  if (visited.has(visitKey)) {
    return null;
  }

  visited.add(visitKey);

  // Check if the name is defined in this file
  const fileDefs = definitionLookup.get(file);
  if (fileDefs?.has(name)) {
    return {resolvedName: fileDefs.get(name)!, definitionFile: file};
  }

  const fileInfo = graph.get(file);
  if (!fileInfo) {
    return null;
  }

  // Check named re-exports: export { name as localName } from './source'
  for (const reExport of fileInfo.reExports) {
    if (reExport.type === 'named' && reExport.localName === name) {
      return resolveExportedName(
        reExport.sourceFile,
        reExport.exportedName!,
        graph,
        definitionLookup,
        depth + 1,
        visited,
      );
    }
  }

  // Check star re-exports: export * from './source'
  for (const reExport of fileInfo.reExports) {
    if (reExport.type === 'star') {
      const result = resolveExportedName(
        reExport.sourceFile,
        name,
        graph,
        definitionLookup,
        depth + 1,
        visited,
      );
      if (result) {
        return result;
      }
    }
  }

  // Check if imported and then locally exported
  for (const importRecord of fileInfo.imports) {
    if (importRecord.localName === name) {
      return resolveExportedName(
        importRecord.sourceFile,
        importRecord.exportedName,
        graph,
        definitionLookup,
        depth + 1,
        visited,
      );
    }
  }

  return null;
}

export function resolveUsages(
  files: string[],
  extraction: ExtractionResult,
  usages: UsageCollectionResult,
): ResolvedUsage[] {
  // Infer source root from file paths for @/ alias resolution
  sourceRoot = null;
  if (files.length > 0) {
    sourceRoot = inferSourceRoot(files[0]);
  }

  const graph = buildFileGraph(files);
  const definitionLookup = buildDefinitionLookup(extraction);
  const resolved: ResolvedUsage[] = [];

  for (const usage of usages.usages) {
    // Step 1: Check if the atom is defined in the same file
    const localDefs = definitionLookup.get(usage.file);
    if (localDefs?.has(usage.localName)) {
      resolved.push({
        ...usage,
        resolvedName: localDefs.get(usage.localName)!,
        definitionFile: usage.file,
      });
      continue;
    }

    // Step 2: Follow import chain from the usage file
    const fileInfo = graph.get(usage.file);
    if (!fileInfo) {
      continue;
    }

    let found = false;

    // Look up the import for this local name
    for (const importRecord of fileInfo.imports) {
      if (importRecord.localName === usage.localName) {
        const result = resolveExportedName(
          importRecord.sourceFile,
          importRecord.exportedName,
          graph,
          definitionLookup,
          1,
          new Set(),
        );
        if (result) {
          resolved.push({
            ...usage,
            resolvedName: result.resolvedName,
            definitionFile: result.definitionFile,
          });
          found = true;
        }

        break;
      }
    }

    if (found) {
      continue;
    }

    // Step 3: If not found via direct import, the usage might reference
    // a name that isn't imported (e.g., local variable same name as an atom).
    // Skip it - it can't be resolved to a Recoil definition.
  }

  return resolved;
}

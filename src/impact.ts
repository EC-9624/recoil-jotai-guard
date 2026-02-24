import * as path from 'node:path';
import type {
  CoverageOptions,
  DependencyGraph,
  ExtractionResult,
  ImpactResult,
  ImpactSummary,
  ResolvedUsage,
  TransitiveDependency,
} from './types.js';

/** Maximum BFS depth for transitive selector chain traversal. */
const maxDepth = 5;

/**
 * Analyze the full impact of a single Recoil atom/selector.
 *
 * Performs BFS through the selector dependency chain to find all transitive
 * usages, partitioned into direct (hook-based) and transitive (via selectors).
 *
 * When `coverageOptions` is provided (default mode), setter output uses
 * coverage-first merge: resolved wrappers show runtime callsites (labeled
 * `runtime`), unresolved wrappers keep their factory sites (labeled `fallback`).
 *
 * When `coverageOptions` is undefined (legacy mode), setter output is
 * factory-only (pre-Phase-13 behavior).
 *
 * @returns ImpactResult if the atom exists in the graph, null otherwise.
 */
export function analyzeAtomImpact(
  graph: DependencyGraph,
  atomName: string,
  coverageOptions?: CoverageOptions,
): ImpactResult | null {
  const definition = graph.definitions.get(atomName);
  if (!definition) {
    return null;
  }

  // Direct component usages
  const directUsages = graph.componentUsages.get(atomName) ?? [];
  const readers = directUsages.filter((u) => u.type === 'reader');
  const factorySetters = directUsages.filter((u) => u.type === 'setter');
  const initializers = directUsages.filter((u) => u.type === 'initializer');

  // Coverage merge for setters
  let setters: ResolvedUsage[];
  if (coverageOptions) {
    const {runtimeCallsites, resolvedFactoryKeys} = coverageOptions;

    // Collect runtime callsites for this atom
    const runtimeForAtom = runtimeCallsites.filter(
      (c) => c.atomName === atomName,
    );

    // Convert runtime callsites to ResolvedUsage entries
    const runtimeUsages: ResolvedUsage[] = runtimeForAtom.map((c) => ({
      atomName: c.atomName,
      localName: c.calleeName,
      type: 'setter' as const,
      hook: 'setter call',
      file: c.file,
      line: c.line,
      resolvedName: c.atomName,
      definitionFile: definition.file,
      writerKind: 'runtime' as const,
    }));

    // Factory setters that were NOT resolved (their wrapper couldn't be traced)
    // are kept as fallback entries.
    // A factory setter is "resolved" if its file:line key is in resolvedFactoryKeys.
    const fallbackSetters: ResolvedUsage[] = factorySetters
      .filter((f) => {
        const factoryKey = `${f.file}:${f.line}`;
        return !resolvedFactoryKeys.has(factoryKey);
      })
      .map((f) => ({
        ...f,
        writerKind: 'fallback' as const,
      }));

    // Runtime entries first, then fallback entries
    setters = [...runtimeUsages, ...fallbackSetters];
  } else {
    // Legacy mode: factory-site setters only (no writerKind)
    setters = factorySetters;
  }

  // Transitive traversal via BFS
  const transitive: TransitiveDependency[] = [];
  const queue: Array<{selectorName: string; depth: number}> = [];
  const visited = new Set<string>();

  // Seed the queue with direct dependent selectors
  const directDependentSelectors =
    graph.dependentSelectors.get(atomName) ?? new Set<string>();
  for (const selectorName of directDependentSelectors) {
    queue.push({selectorName, depth: 1});
  }

  while (queue.length > 0) {
    const {selectorName, depth} = queue.shift()!;

    if (depth > maxDepth) {
      continue;
    }

    if (visited.has(selectorName)) {
      continue;
    }

    visited.add(selectorName);

    const selectorDefinition = graph.definitions.get(selectorName);
    const selectorUsages = graph.componentUsages.get(selectorName) ?? [];

    transitive.push({
      via: selectorName,
      viaDefinition: selectorDefinition
        ? {
            file: selectorDefinition.file,
            line: selectorDefinition.line,
            kind: selectorDefinition.kind,
          }
        : {file: '', line: 0, kind: 'selector'},
      depth,
      readers: selectorUsages.filter((u) => u.type === 'reader'),
      setters: selectorUsages.filter((u) => u.type === 'setter'),
    });

    // Follow the chain: which selectors depend on this selector?
    const nextSelectors =
      graph.dependentSelectors.get(selectorName) ?? new Set<string>();
    for (const nextSelector of nextSelectors) {
      if (!visited.has(nextSelector)) {
        queue.push({selectorName: nextSelector, depth: depth + 1});
      }
    }
  }

  // Compute summary
  const allFiles = new Set<string>();
  const componentFiles = new Set<string>();

  for (const usage of [...readers, ...setters, ...initializers]) {
    allFiles.add(usage.file);
    componentFiles.add(usage.file);
  }

  for (const dep of transitive) {
    if (dep.viaDefinition.file) {
      allFiles.add(dep.viaDefinition.file);
    }

    for (const usage of [...dep.readers, ...dep.setters]) {
      allFiles.add(usage.file);
      componentFiles.add(usage.file);
    }
  }

  const summary: ImpactSummary = {
    totalFiles: allFiles.size,
    totalComponents: componentFiles.size,
    totalSelectors: transitive.length,
  };

  return {
    target: {
      name: definition.name,
      kind: definition.kind,
      file: definition.file,
      line: definition.line,
    },
    direct: {readers, setters, initializers},
    transitive,
    summary,
  };
}

/**
 * Analyze the impact of all Recoil definitions in a given file.
 *
 * Resolves the file path to absolute, finds all Recoil definitions in that
 * file, and runs `analyzeAtomImpact` for each one.
 *
 * @returns Array of ImpactResults (one per definition found). Empty if no
 *   definitions exist in the file.
 */
export function analyzeFileImpact(
  graph: DependencyGraph,
  filePath: string,
  extraction: ExtractionResult,
  coverageOptions?: CoverageOptions,
): ImpactResult[] {
  const resolvedPath = path.resolve(filePath);
  const definitions = extraction.recoilDefinitions.filter(
    (d) => d.file === resolvedPath,
  );

  const results: ImpactResult[] = [];
  for (const definition of definitions) {
    const result = analyzeAtomImpact(graph, definition.name, coverageOptions);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Analyze the impact of all Recoil definitions across multiple changed files.
 *
 * Iterates over the given file paths (typically from `git diff`), runs
 * `analyzeFileImpact` for each, and returns the flattened results.
 *
 * @returns Array of ImpactResults across all changed files. Empty if no
 *   definitions exist in any of the changed files.
 */
export function analyzeGitImpact(
  graph: DependencyGraph,
  changedFiles: readonly string[],
  extraction: ExtractionResult,
  coverageOptions?: CoverageOptions,
): ImpactResult[] {
  const results: ImpactResult[] = [];
  for (const filePath of changedFiles) {
    results.push(
      ...analyzeFileImpact(graph, filePath, extraction, coverageOptions),
    );
  }

  return results;
}

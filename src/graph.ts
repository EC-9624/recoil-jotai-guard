import type {
  DependencyGraph,
  ExtractionResult,
  ResolvedUsage,
} from './types.js';

export function buildDependencyGraph(
  extraction: ExtractionResult,
  resolvedUsages: ResolvedUsage[],
): DependencyGraph {
  const definitions: DependencyGraph['definitions'] = new Map();
  const dependentSelectors: DependencyGraph['dependentSelectors'] = new Map();
  const componentUsages: DependencyGraph['componentUsages'] = new Map();

  // Index definitions by name
  for (const def of extraction.recoilDefinitions) {
    definitions.set(def.name, def);
  }

  // Partition resolved usages
  for (const usage of resolvedUsages) {
    if (usage.hook === 'get(selector)' && usage.enclosingDefinition) {
      // Selector dependency: enclosingDefinition reads usage.resolvedName
      if (!dependentSelectors.has(usage.resolvedName)) {
        dependentSelectors.set(usage.resolvedName, new Set());
      }

      dependentSelectors
        .get(usage.resolvedName)!
        .add(usage.enclosingDefinition);
    } else {
      // Component/hook usage
      if (!componentUsages.has(usage.resolvedName)) {
        componentUsages.set(usage.resolvedName, []);
      }

      componentUsages.get(usage.resolvedName)!.push(usage);
    }
  }

  return {definitions, dependentSelectors, componentUsages};
}

import {describe, expect, it} from 'vitest';
import {buildDependencyGraph} from '../src/graph.js';
import type {
  ExtractionResult,
  RecoilDefinition,
  ResolvedUsage,
} from '../src/types.js';

function makeDefinition(
  overrides: Partial<RecoilDefinition> & {name: string},
): RecoilDefinition {
  return {
    kind: 'atom',
    file: '/test/atoms.ts',
    line: 1,
    getBodyAst: null,
    inlineDefaultGetBody: null,
    ...overrides,
  };
}

function makeResolvedUsage(
  overrides: Partial<ResolvedUsage> & {resolvedName: string; hook: string},
): ResolvedUsage {
  return {
    atomName: overrides.resolvedName,
    localName: overrides.resolvedName,
    type: 'reader',
    file: '/test/component.tsx',
    line: 10,
    definitionFile: '/test/atoms.ts',
    ...overrides,
  };
}

describe('buildDependencyGraph', () => {
  it('correctly partitions selector deps vs component usages', () => {
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        makeDefinition({name: 'atomA'}),
        makeDefinition({name: 'selectorB', kind: 'selector'}),
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      makeResolvedUsage({
        resolvedName: 'atomA',
        hook: 'get(selector)',
        enclosingDefinition: 'selectorB',
        type: 'reader',
      }),
      makeResolvedUsage({
        resolvedName: 'atomA',
        hook: 'useRecoilValue',
        type: 'reader',
      }),
    ];

    const graph = buildDependencyGraph(extraction, resolvedUsages);

    // Selector dependency
    expect(graph.dependentSelectors.has('atomA')).toBe(true);
    expect(graph.dependentSelectors.get('atomA')).toEqual(
      new Set(['selectorB']),
    );

    // Component usage
    expect(graph.componentUsages.has('atomA')).toBe(true);
    expect(graph.componentUsages.get('atomA')).toHaveLength(1);
    expect(graph.componentUsages.get('atomA')![0].hook).toBe('useRecoilValue');
  });

  it('handles multiple selectors depending on the same atom', () => {
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        makeDefinition({name: 'atomA'}),
        makeDefinition({name: 'selectorB', kind: 'selector'}),
        makeDefinition({name: 'selectorC', kind: 'selector'}),
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      makeResolvedUsage({
        resolvedName: 'atomA',
        hook: 'get(selector)',
        enclosingDefinition: 'selectorB',
        type: 'reader',
      }),
      makeResolvedUsage({
        resolvedName: 'atomA',
        hook: 'get(selector)',
        enclosingDefinition: 'selectorC',
        type: 'reader',
      }),
    ];

    const graph = buildDependencyGraph(extraction, resolvedUsages);

    expect(graph.dependentSelectors.get('atomA')).toEqual(
      new Set(['selectorB', 'selectorC']),
    );
  });

  it('handles atom with no usages', () => {
    const extraction: ExtractionResult = {
      recoilDefinitions: [makeDefinition({name: 'lonelyAtom'})],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const graph = buildDependencyGraph(extraction, []);

    expect(graph.definitions.has('lonelyAtom')).toBe(true);
    expect(graph.dependentSelectors.has('lonelyAtom')).toBe(false);
    expect(graph.componentUsages.has('lonelyAtom')).toBe(false);
  });

  it('indexes all definitions correctly', () => {
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        makeDefinition({name: 'atom1'}),
        makeDefinition({name: 'atom2'}),
        makeDefinition({name: 'atom3'}),
        makeDefinition({name: 'selector1', kind: 'selector'}),
        makeDefinition({name: 'selector2', kind: 'selector'}),
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const graph = buildDependencyGraph(extraction, []);

    expect(graph.definitions.size).toBe(5);
    expect(graph.definitions.has('atom1')).toBe(true);
    expect(graph.definitions.has('atom2')).toBe(true);
    expect(graph.definitions.has('atom3')).toBe(true);
    expect(graph.definitions.has('selector1')).toBe(true);
    expect(graph.definitions.has('selector2')).toBe(true);
  });

  it('handles usages without enclosingDefinition', () => {
    const extraction: ExtractionResult = {
      recoilDefinitions: [makeDefinition({name: 'atomA'})],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      makeResolvedUsage({
        resolvedName: 'atomA',
        hook: 'get(selector)',
        // No enclosingDefinition — defensive case
        type: 'reader',
      }),
    ];

    const graph = buildDependencyGraph(extraction, resolvedUsages);

    // Should go to componentUsages, not dependentSelectors
    expect(graph.dependentSelectors.has('atomA')).toBe(false);
    expect(graph.componentUsages.has('atomA')).toBe(true);
    expect(graph.componentUsages.get('atomA')).toHaveLength(1);
  });
});

import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  analyzeAtomImpact,
  analyzeFileImpact,
  analyzeGitImpact,
} from '../src/impact.js';
import type {
  CoverageOptions,
  DependencyGraph,
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
  overrides: Partial<ResolvedUsage> & {resolvedName: string},
): ResolvedUsage {
  return {
    atomName: overrides.resolvedName,
    localName: overrides.resolvedName,
    type: 'reader',
    hook: 'useRecoilValue',
    file: '/test/component.tsx',
    line: 10,
    definitionFile: '/test/atoms.ts',
    ...overrides,
  };
}

function makeEmptyGraph(): DependencyGraph {
  return {
    definitions: new Map(),
    dependentSelectors: new Map(),
    componentUsages: new Map(),
  };
}

describe('analyzeAtomImpact', () => {
  it('direct impact only (atom with hook usages, no selector deps)', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set('myAtom', makeDefinition({name: 'myAtom'}));

    graph.componentUsages.set('myAtom', [
      makeResolvedUsage({
        resolvedName: 'myAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/reader1.tsx',
        line: 5,
      }),
      makeResolvedUsage({
        resolvedName: 'myAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/reader2.tsx',
        line: 8,
      }),
      makeResolvedUsage({
        resolvedName: 'myAtom',
        type: 'setter',
        hook: 'useSetRecoilState',
        file: '/test/setter.tsx',
        line: 12,
      }),
    ]);

    const result = analyzeAtomImpact(graph, 'myAtom');

    expect(result).not.toBeNull();
    expect(result!.direct.readers).toHaveLength(2);
    expect(result!.direct.setters).toHaveLength(1);
    expect(result!.direct.initializers).toHaveLength(0);
    expect(result!.transitive).toHaveLength(0);
  });

  it('single-level transitive (atom -> selector -> component)', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'baseAtom',
      makeDefinition({name: 'baseAtom', file: '/test/atoms.ts', line: 1}),
    );
    graph.definitions.set(
      'middleSelector',
      makeDefinition({
        name: 'middleSelector',
        kind: 'selector',
        file: '/test/atoms.ts',
        line: 5,
      }),
    );

    // baseAtom is read by middleSelector via get()
    graph.dependentSelectors.set('baseAtom', new Set(['middleSelector']));

    // middleSelector is used by a component
    graph.componentUsages.set('middleSelector', [
      makeResolvedUsage({
        resolvedName: 'middleSelector',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/consumer.tsx',
        line: 10,
      }),
    ]);

    const result = analyzeAtomImpact(graph, 'baseAtom');

    expect(result).not.toBeNull();
    expect(result!.transitive).toHaveLength(1);
    expect(result!.transitive[0].via).toBe('middleSelector');
    expect(result!.transitive[0].depth).toBe(1);
    expect(result!.transitive[0].readers).toHaveLength(1);
    expect(result!.transitive[0].readers[0].file).toBe('/test/consumer.tsx');
  });

  it('multi-level transitive (atom -> selectorA -> selectorB -> component)', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'baseAtom',
      makeDefinition({name: 'baseAtom', file: '/test/atoms.ts', line: 1}),
    );
    graph.definitions.set(
      'middleSelector',
      makeDefinition({
        name: 'middleSelector',
        kind: 'selector',
        file: '/test/atoms.ts',
        line: 5,
      }),
    );
    graph.definitions.set(
      'topSelector',
      makeDefinition({
        name: 'topSelector',
        kind: 'selector',
        file: '/test/atoms.ts',
        line: 10,
      }),
    );

    // baseAtom -> middleSelector -> topSelector
    graph.dependentSelectors.set('baseAtom', new Set(['middleSelector']));
    graph.dependentSelectors.set('middleSelector', new Set(['topSelector']));

    // topSelector is used by a component
    graph.componentUsages.set('topSelector', [
      makeResolvedUsage({
        resolvedName: 'topSelector',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/consumer.tsx',
        line: 20,
      }),
    ]);

    const result = analyzeAtomImpact(graph, 'baseAtom');

    expect(result).not.toBeNull();
    expect(result!.transitive).toHaveLength(2);

    const middleDep = result!.transitive.find(
      (t) => t.via === 'middleSelector',
    );
    const topDep = result!.transitive.find((t) => t.via === 'topSelector');

    expect(middleDep).toBeDefined();
    expect(middleDep!.depth).toBe(1);

    expect(topDep).toBeDefined();
    expect(topDep!.depth).toBe(2);
    expect(topDep!.readers).toHaveLength(1);
  });

  it('circular selector dependencies do not hang', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'baseAtom',
      makeDefinition({name: 'baseAtom', file: '/test/atoms.ts', line: 1}),
    );
    graph.definitions.set(
      'selectorA',
      makeDefinition({
        name: 'selectorA',
        kind: 'selector',
        file: '/test/atoms.ts',
        line: 5,
      }),
    );
    graph.definitions.set(
      'selectorB',
      makeDefinition({
        name: 'selectorB',
        kind: 'selector',
        file: '/test/atoms.ts',
        line: 10,
      }),
    );

    // baseAtom -> selectorA -> selectorB -> selectorA (circular)
    graph.dependentSelectors.set('baseAtom', new Set(['selectorA']));
    graph.dependentSelectors.set('selectorA', new Set(['selectorB']));
    graph.dependentSelectors.set('selectorB', new Set(['selectorA']));

    const result = analyzeAtomImpact(graph, 'baseAtom');

    expect(result).not.toBeNull();
    // Each selector visited at most once
    const visitedSelectors = new Set(result!.transitive.map((t) => t.via));
    expect(visitedSelectors.size).toBe(result!.transitive.length);
    expect(visitedSelectors.has('selectorA')).toBe(true);
    expect(visitedSelectors.has('selectorB')).toBe(true);
  });

  it('depth limit respected', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'baseAtom',
      makeDefinition({name: 'baseAtom', file: '/test/atoms.ts', line: 1}),
    );

    // Create a chain of 7 selectors: sel1 -> sel2 -> sel3 -> sel4 -> sel5 -> sel6 -> sel7
    const selectorNames = Array.from(
      {length: 7},
      (_, index) => `sel${String(index + 1)}`,
    );
    for (const name of selectorNames) {
      graph.definitions.set(
        name,
        makeDefinition({
          name,
          kind: 'selector',
          file: '/test/atoms.ts',
          line: 1,
        }),
      );
    }

    // baseAtom -> sel1
    graph.dependentSelectors.set('baseAtom', new Set(['sel1']));
    // sel1 -> sel2 -> sel3 -> ... -> sel7
    for (let index = 0; index < selectorNames.length - 1; index++) {
      graph.dependentSelectors.set(
        selectorNames[index],
        new Set([selectorNames[index + 1]]),
      );
    }

    const result = analyzeAtomImpact(graph, 'baseAtom');

    expect(result).not.toBeNull();
    // MAX_DEPTH is 5, so only sel1..sel5 should appear
    expect(result!.transitive).toHaveLength(5);

    const maxDepthInResult = Math.max(
      ...result!.transitive.map((t) => t.depth),
    );
    expect(maxDepthInResult).toBe(5);

    // sel6 and sel7 should NOT be in the results
    const visitedNames = new Set(result!.transitive.map((t) => t.via));
    expect(visitedNames.has('sel6')).toBe(false);
    expect(visitedNames.has('sel7')).toBe(false);
  });

  it('atom with no usages', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'lonelyAtom',
      makeDefinition({name: 'lonelyAtom', file: '/test/atoms.ts', line: 1}),
    );

    const result = analyzeAtomImpact(graph, 'lonelyAtom');

    expect(result).not.toBeNull();
    expect(result!.direct.readers).toHaveLength(0);
    expect(result!.direct.setters).toHaveLength(0);
    expect(result!.direct.initializers).toHaveLength(0);
    expect(result!.transitive).toHaveLength(0);
    expect(result!.summary.totalFiles).toBe(0);
    expect(result!.summary.totalComponents).toBe(0);
    expect(result!.summary.totalSelectors).toBe(0);
  });

  it('unknown atom returns null', () => {
    const graph = makeEmptyGraph();

    const result = analyzeAtomImpact(graph, 'nonExistentAtom');

    expect(result).toBeNull();
  });

  it('summary counts are correct', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'myAtom',
      makeDefinition({
        name: 'myAtom',
        file: '/test/atoms.ts',
        line: 1,
      }),
    );
    graph.definitions.set(
      'depSelector',
      makeDefinition({
        name: 'depSelector',
        kind: 'selector',
        file: '/test/selectors.ts',
        line: 5,
      }),
    );

    // Direct usages in two different component files
    graph.componentUsages.set('myAtom', [
      makeResolvedUsage({
        resolvedName: 'myAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/comp-a.tsx',
        line: 3,
      }),
      makeResolvedUsage({
        resolvedName: 'myAtom',
        type: 'setter',
        hook: 'useSetRecoilState',
        file: '/test/comp-b.tsx',
        line: 7,
      }),
    ]);

    // Transitive: myAtom -> depSelector -> component in comp-c.tsx
    graph.dependentSelectors.set('myAtom', new Set(['depSelector']));
    graph.componentUsages.set('depSelector', [
      makeResolvedUsage({
        resolvedName: 'depSelector',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/comp-c.tsx',
        line: 15,
      }),
    ]);

    const result = analyzeAtomImpact(graph, 'myAtom');

    expect(result).not.toBeNull();

    // totalFiles: comp-a.tsx, comp-b.tsx, selectors.ts (viaDefinition), comp-c.tsx = 4
    expect(result!.summary.totalFiles).toBe(4);
    // totalComponents: comp-a.tsx, comp-b.tsx, comp-c.tsx = 3 (selectors.ts is only viaDefinition, not a component usage)
    expect(result!.summary.totalComponents).toBe(3);
    // totalSelectors: 1 (depSelector)
    expect(result!.summary.totalSelectors).toBe(1);
  });

  it('summary deduplicates files across direct and transitive usages', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'myAtom',
      makeDefinition({
        name: 'myAtom',
        file: '/test/atoms.ts',
        line: 1,
      }),
    );
    graph.definitions.set(
      'depSelector',
      makeDefinition({
        name: 'depSelector',
        kind: 'selector',
        file: '/test/selectors.ts',
        line: 5,
      }),
    );

    // Direct usage in shared.tsx
    graph.componentUsages.set('myAtom', [
      makeResolvedUsage({
        resolvedName: 'myAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/shared.tsx',
        line: 3,
      }),
    ]);

    // Transitive: myAtom -> depSelector -> also used in shared.tsx (same file)
    graph.dependentSelectors.set('myAtom', new Set(['depSelector']));
    graph.componentUsages.set('depSelector', [
      makeResolvedUsage({
        resolvedName: 'depSelector',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/test/shared.tsx',
        line: 20,
      }),
    ]);

    const result = analyzeAtomImpact(graph, 'myAtom');

    expect(result).not.toBeNull();

    // totalFiles: shared.tsx + selectors.ts = 2 (shared.tsx counted only once despite appearing in both direct and transitive)
    expect(result!.summary.totalFiles).toBe(2);
    // totalComponents: shared.tsx = 1 (deduplicated)
    expect(result!.summary.totalComponents).toBe(1);
    // totalSelectors: 1 (depSelector)
    expect(result!.summary.totalSelectors).toBe(1);
  });
});

describe('coverage merge', () => {
  it('resolved wrapper: factory site excluded, runtime callsites shown', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'fooState',
      makeDefinition({name: 'fooState', file: '/test/atoms.ts', line: 1}),
    );

    // Factory setter from the wrapper (useSetFoo = () => useSetRecoilState(fooState))
    // This factory site IS in the resolvedFactoryKeys, meaning its wrapper was traced
    graph.componentUsages.set('fooState', [
      makeResolvedUsage({
        resolvedName: 'fooState',
        type: 'setter',
        hook: 'useSetRecoilState',
        file: '/test/wrapper-hooks.ts',
        line: 5,
      }),
    ]);

    const coverageOptions: CoverageOptions = {
      runtimeCallsites: [
        {
          atomName: 'fooState',
          file: '/test/consumer.tsx',
          line: 42,
          calleeName: 'setFoo',
        },
      ],
      // The factory site file:line is resolved (wrapper was successfully traced)
      resolvedFactoryKeys: new Set(['/test/wrapper-hooks.ts:5']),
    };

    const result = analyzeAtomImpact(graph, 'fooState', coverageOptions);

    expect(result).not.toBeNull();
    // Factory site should be excluded (resolved), only runtime callsite shown
    expect(result!.direct.setters).toHaveLength(1);
    expect(result!.direct.setters[0].writerKind).toBe('runtime');
    expect(result!.direct.setters[0].file).toBe('/test/consumer.tsx');
    expect(result!.direct.setters[0].line).toBe(42);
    expect(result!.direct.setters[0].hook).toBe('setter call');
    // Factory site should NOT be in the output
    const factoryEntries = result!.direct.setters.filter(
      (s) => s.file === '/test/wrapper-hooks.ts',
    );
    expect(factoryEntries).toHaveLength(0);
  });

  it('unresolved wrapper: factory site kept as fallback', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'barState',
      makeDefinition({name: 'barState', file: '/test/atoms.ts', line: 10}),
    );

    // Factory setter from an unresolved wrapper (e.g., object-returning pattern not supported by V1)
    graph.componentUsages.set('barState', [
      makeResolvedUsage({
        resolvedName: 'barState',
        type: 'setter',
        hook: 'useSetRecoilState',
        file: '/test/unsupported-wrapper.ts',
        line: 15,
      }),
    ]);

    const coverageOptions: CoverageOptions = {
      runtimeCallsites: [],
      // The factory site is NOT in resolvedFactoryKeys (wrapper could not be traced)
      resolvedFactoryKeys: new Set(),
    };

    const result = analyzeAtomImpact(graph, 'barState', coverageOptions);

    expect(result).not.toBeNull();
    // Factory site should be kept as fallback
    expect(result!.direct.setters).toHaveLength(1);
    expect(result!.direct.setters[0].writerKind).toBe('fallback');
    expect(result!.direct.setters[0].file).toBe('/test/unsupported-wrapper.ts');
    expect(result!.direct.setters[0].line).toBe(15);
    expect(result!.direct.setters[0].hook).toBe('useSetRecoilState');
  });

  it('direct hook in component (no wrapper): shown as runtime', () => {
    const graph = makeEmptyGraph();

    graph.definitions.set(
      'fooState',
      makeDefinition({name: 'fooState', file: '/test/atoms.ts', line: 1}),
    );

    // Direct useSetRecoilState in a component (factory setter).
    // This factory site IS in resolvedFactoryKeys because the direct hook
    // binding was resolved (const setFoo = useSetRecoilState(fooState)).
    graph.componentUsages.set('fooState', [
      makeResolvedUsage({
        resolvedName: 'fooState',
        type: 'setter',
        hook: 'useSetRecoilState',
        file: '/test/component.tsx',
        line: 6,
      }),
    ]);

    const coverageOptions: CoverageOptions = {
      runtimeCallsites: [
        {
          atomName: 'fooState',
          file: '/test/component.tsx',
          line: 20,
          calleeName: 'setFoo',
        },
      ],
      // The factory site is resolved because buildSetterBindings resolved it directly
      resolvedFactoryKeys: new Set(['/test/component.tsx:6']),
    };

    const result = analyzeAtomImpact(graph, 'fooState', coverageOptions);

    expect(result).not.toBeNull();
    // Only the runtime callsite should appear
    expect(result!.direct.setters).toHaveLength(1);
    expect(result!.direct.setters[0].writerKind).toBe('runtime');
    expect(result!.direct.setters[0].file).toBe('/test/component.tsx');
    expect(result!.direct.setters[0].line).toBe(20);
    expect(result!.direct.setters[0].hook).toBe('setter call');
    expect(result!.direct.setters[0].localName).toBe('setFoo');
    // Factory site at line 6 should NOT appear (it's resolved)
    const factoryEntries = result!.direct.setters.filter((s) => s.line === 6);
    expect(factoryEntries).toHaveLength(0);
  });
});

describe('analyzeFileImpact', () => {
  it('finds all atoms in file', () => {
    const graph = makeEmptyGraph();
    const filePath = '/test/atoms.ts';

    graph.definitions.set(
      'atomOne',
      makeDefinition({name: 'atomOne', file: filePath, line: 1}),
    );
    graph.definitions.set(
      'atomTwo',
      makeDefinition({name: 'atomTwo', file: filePath, line: 10}),
    );

    const extraction: ExtractionResult = {
      recoilDefinitions: [
        makeDefinition({name: 'atomOne', file: filePath, line: 1}),
        makeDefinition({name: 'atomTwo', file: filePath, line: 10}),
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const results = analyzeFileImpact(graph, filePath, extraction);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.target.name).sort()).toEqual([
      'atomOne',
      'atomTwo',
    ]);
  });

  it('returns empty array for file containing no atoms', () => {
    const graph = makeEmptyGraph();
    const filePath = '/test/no-atoms.ts';

    const extraction: ExtractionResult = {
      recoilDefinitions: [
        makeDefinition({
          name: 'otherAtom',
          file: '/test/other-file.ts',
          line: 1,
        }),
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const results = analyzeFileImpact(graph, filePath, extraction);

    expect(results).toHaveLength(0);
  });
});

describe('analyzeGitImpact', () => {
  it('aggregates results from multiple changed files', () => {
    const graph = makeEmptyGraph();
    const fileA = path.resolve('/test/file-a.ts');
    const fileB = path.resolve('/test/file-b.ts');

    graph.definitions.set(
      'atomA',
      makeDefinition({name: 'atomA', file: fileA, line: 1}),
    );
    graph.definitions.set(
      'atomB',
      makeDefinition({name: 'atomB', file: fileB, line: 1}),
    );

    const extraction: ExtractionResult = {
      recoilDefinitions: [
        makeDefinition({name: 'atomA', file: fileA, line: 1}),
        makeDefinition({name: 'atomB', file: fileB, line: 1}),
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const results = analyzeGitImpact(graph, [fileA, fileB], extraction);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.target.name).sort()).toEqual([
      'atomA',
      'atomB',
    ]);
  });
});

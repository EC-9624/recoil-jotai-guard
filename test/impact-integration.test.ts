import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {extractDefinitions} from '../src/extract.js';
import {collectUsages} from '../src/collect-usages.js';
import {resolveUsages} from '../src/resolve.js';
import {buildDependencyGraph} from '../src/graph.js';
import {
  analyzeAtomImpact,
  analyzeFileImpact,
  analyzeGitImpact,
} from '../src/impact.js';
import {formatImpactText, formatImpactJson} from '../src/impact-reporter.js';
import {globFiles} from '../src/files.js';
import {runChecks} from '../src/checks.js';
import type {
  DependencyGraph,
  ExtractionResult,
  ImpactResult,
  ResolvedUsage,
} from '../src/types.js';

/**
 * Resolve the press-release-editor-v3 directory relative to this repo.
 * The test file lives at scripts/recoil-jotai-guard/test/,
 * and the target is at apps/prtimes/src/features/press-release-editor-v3/.
 */
const targetDir = path.resolve(
  __dirname,
  '../../../apps/prtimes/src/features/press-release-editor-v3',
);

/**
 * Shared pipeline result cache. The expensive 3-pass pipeline + graph build
 * runs at most once and is reused across all test suites in this file.
 */
type PipelineData = {
  extraction: ExtractionResult;
  resolved: ResolvedUsage[];
  graph: DependencyGraph;
  targetDir: string;
};

let sharedPipeline: PipelineData | undefined = null;

function getSharedPipeline(): PipelineData {
  if (sharedPipeline) {
    return sharedPipeline;
  }

  const files = globFiles(targetDir);
  const extraction = extractDefinitions(files);
  const usages = collectUsages(files, extraction);
  const resolved = resolveUsages(files, extraction, usages);
  const graph = buildDependencyGraph(extraction, resolved);

  sharedPipeline = {
    extraction,
    resolved,
    graph,
    targetDir,
  };
  return sharedPipeline;
}

/**
 * Run the full 3-pass pipeline + graph build once (shared across all tests).
 * Uses a lazy singleton so the expensive pipeline runs at most once.
 */
let pipelineResult:
  | {
      result: ImpactResult;
      targetDir: string;
    }
  | undefined = null;

function getPipeline(): {result: ImpactResult; targetDir: string} {
  if (pipelineResult) {
    return pipelineResult;
  }

  const {graph} = getSharedPipeline();
  const result = analyzeAtomImpact(graph, 'pressReleaseTitleState');

  if (!result) {
    throw new Error(
      'analyzeAtomImpact returned null for pressReleaseTitleState',
    );
  }

  pipelineResult = {result, targetDir};
  return pipelineResult;
}

describe('impact integration: pressReleaseTitleState (--atom mode)', () => {
  it('finds the atom definition in states/contents.ts', () => {
    const {result} = getPipeline();

    expect(result.target.name).toBe('pressReleaseTitleState');
    expect(result.target.kind).toBe('atom');
    expect(result.target.file).toContain('states/contents.ts');
    expect(result.target.line).toBe(39);
  });

  it('lists all direct readers', () => {
    const {result} = getPipeline();

    expect(result.direct.readers.length).toBeGreaterThan(0);

    // All direct readers should reference pressReleaseTitleState
    for (const reader of result.direct.readers) {
      expect(reader.resolvedName).toBe('pressReleaseTitleState');
      expect(reader.type).toBe('reader');
    }

    // Check known direct readers include useRecoilValue calls and callback readers
    const readerHooks = new Set(result.direct.readers.map((r) => r.hook));
    expect(readerHooks.has('useRecoilValue')).toBe(true);
  });

  it('lists all direct setters', () => {
    const {result} = getPipeline();

    expect(result.direct.setters.length).toBeGreaterThan(0);

    for (const setter of result.direct.setters) {
      expect(setter.resolvedName).toBe('pressReleaseTitleState');
      expect(setter.type).toBe('setter');
    }

    // Check known setter hooks
    const setterHooks = new Set(result.direct.setters.map((s) => s.hook));
    expect(setterHooks.has('useSetRecoilState')).toBe(true);
  });

  it('lists initializers from initializePressReleaseContents', () => {
    const {result} = getPipeline();

    expect(result.direct.initializers.length).toBeGreaterThan(0);

    // The initializer is the set() call inside initializePressReleaseContents
    const initInContents = result.direct.initializers.find((init) =>
      init.file.includes('states/contents.ts'),
    );
    expect(initInContents).toBeDefined();
    expect(initInContents!.hook).toBe('set(initializer)');
  });

  it('shows pressReleaseTitleForPreview in transitive section', () => {
    const {result} = getPipeline();

    // PressReleaseTitleForPreview selector reads pressReleaseTitleState via get()
    const previewSelector = result.transitive.find(
      (t) => t.via === 'pressReleaseTitleForPreview',
    );

    expect(previewSelector).toBeDefined();
    expect(previewSelector!.depth).toBe(1);
    expect(previewSelector!.viaDefinition.kind).toBe('selector');
    expect(previewSelector!.viaDefinition.file).toContain('states/contents.ts');
  });

  it('shows components using transitive selectors at correct depth', () => {
    const {result} = getPipeline();

    const previewSelector = result.transitive.find(
      (t) => t.via === 'pressReleaseTitleForPreview',
    );
    expect(previewSelector).toBeDefined();

    // The selector should have readers (components consuming usePressReleaseTitleForPreview
    // or useRecoilValue(pressReleaseTitleForPreview))
    const transitiveReaders = previewSelector!.readers;
    expect(transitiveReaders.length).toBeGreaterThan(0);

    // All transitive readers should be at depth 1 (direct selector dependency)
    expect(previewSelector!.depth).toBe(1);
  });

  it('file paths are accurate (spot-check references)', () => {
    const {result} = getPipeline();

    // Spot-check 1: The atom definition itself
    expect(result.target.file).toMatch(/states\/contents\.ts$/);
    expect(result.target.line).toBe(39);

    // Spot-check 2: The selector definition in transitive section
    const previewSelector = result.transitive.find(
      (t) => t.via === 'pressReleaseTitleForPreview',
    );
    expect(previewSelector).toBeDefined();
    expect(previewSelector!.viaDefinition.file).toMatch(
      /states\/contents\.ts$/,
    );
    // PressReleaseTitleForPreview is defined at line 62
    expect(previewSelector!.viaDefinition.line).toBe(62);

    // Spot-check 3: The initializer in contents.ts at line 29
    const initInContents = result.direct.initializers.find(
      (init) =>
        init.file.includes('states/contents.ts') &&
        init.hook === 'set(initializer)',
    );
    expect(initInContents).toBeDefined();
    expect(initInContents!.line).toBe(29);

    // Spot-check 4: A direct reader - useRecoilValue in contents.ts (line 44, the wrapper hook)
    const wrapperReader = result.direct.readers.find(
      (r) =>
        r.file.includes('states/contents.ts') && r.hook === 'useRecoilValue',
    );
    expect(wrapperReader).toBeDefined();
    expect(wrapperReader!.line).toBe(44);

    // Spot-check 5: A direct setter - useSetRecoilState in contents.ts (line 47, the wrapper hook)
    const wrapperSetter = result.direct.setters.find(
      (s) =>
        s.file.includes('states/contents.ts') && s.hook === 'useSetRecoilState',
    );
    expect(wrapperSetter).toBeDefined();
    expect(wrapperSetter!.line).toBe(47);
  });

  it('summary counts are reasonable', () => {
    const {result} = getPipeline();

    // PressReleaseTitleState is widely used, expect multiple files and components
    expect(result.summary.totalFiles).toBeGreaterThanOrEqual(3);
    expect(result.summary.totalComponents).toBeGreaterThanOrEqual(2);
    // At least pressReleaseTitleForPreview as transitive selector
    expect(result.summary.totalSelectors).toBeGreaterThanOrEqual(1);
  });

  it('all file paths in the result are absolute', () => {
    const {result} = getPipeline();

    // Target file path
    expect(path.isAbsolute(result.target.file)).toBe(true);

    // Direct usage file paths
    for (const usage of [
      ...result.direct.readers,
      ...result.direct.setters,
      ...result.direct.initializers,
    ]) {
      expect(path.isAbsolute(usage.file)).toBe(true);
    }

    // Transitive usage file paths
    for (const dep of result.transitive) {
      expect(path.isAbsolute(dep.viaDefinition.file)).toBe(true);
      for (const usage of [...dep.readers, ...dep.setters]) {
        expect(path.isAbsolute(usage.file)).toBe(true);
      }
    }
  });

  it('text output is well-formed', () => {
    const {result, targetDir: dir} = getPipeline();

    const text = formatImpactText([result], dir);

    // Header
    expect(text).toContain('Impact: pressReleaseTitleState (atom)');
    expect(text).toContain('Defined at: states/contents.ts:39');

    // Direct section exists
    expect(text).toContain('Direct:');
    expect(text).toContain('READERS');
    expect(text).toContain('SETTERS');

    // Transitive section exists
    expect(text).toContain('Transitive (via selectors):');
    expect(text).toContain('pressReleaseTitleForPreview');

    // Summary
    expect(text).toMatch(/Summary: \d+ files, \d+ components, \d+ selectors/);

    // File paths in output are relative (not absolute)
    expect(text).not.toContain(dir);
  });

  it('JSON output is valid and parseable', () => {
    const {result, targetDir: dir} = getPipeline();

    const json = formatImpactJson([result], dir);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Single result should be an object, not an array
    expect(parsed).not.toBeInstanceOf(Array);

    // Check required top-level keys
    expect(parsed).toHaveProperty('target');
    expect(parsed).toHaveProperty('direct');
    expect(parsed).toHaveProperty('transitive');
    expect(parsed).toHaveProperty('summary');
  });

  it('JSON structure matches ImpactResult schema', () => {
    const {result, targetDir: dir} = getPipeline();

    const json = formatImpactJson([result], dir);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Target: { name: string, kind: StateKind, file: string, line: number }
    const target = parsed.target as Record<string, unknown>;
    expect(target).toHaveProperty('name', 'pressReleaseTitleState');
    expect(target).toHaveProperty('kind', 'atom');
    expect(target).toHaveProperty('file', 'states/contents.ts');
    expect(target).toHaveProperty('line', 39);
    expect(typeof target.name).toBe('string');
    expect(typeof target.kind).toBe('string');
    expect(typeof target.file).toBe('string');
    expect(typeof target.line).toBe('number');
    expect(['atom', 'selector', 'atomFamily', 'selectorFamily']).toContain(
      target.kind,
    );

    // Direct: { readers: JsonUsage[], setters: JsonUsage[], initializers: JsonUsage[] }
    const direct = parsed.direct as Record<string, unknown[]>;
    expect(direct).toHaveProperty('readers');
    expect(direct).toHaveProperty('setters');
    expect(direct).toHaveProperty('initializers');
    expect(Array.isArray(direct.readers)).toBe(true);
    expect(Array.isArray(direct.setters)).toBe(true);
    expect(Array.isArray(direct.initializers)).toBe(true);

    // Validate usage item shape: only { file, line, hook, type } (no internal fields)
    const allDirectUsages = [
      ...direct.readers,
      ...direct.setters,
      ...direct.initializers,
    ] as Array<Record<string, unknown>>;
    expect(allDirectUsages.length).toBeGreaterThan(0);

    for (const usage of allDirectUsages) {
      expect(Object.keys(usage).sort()).toEqual(
        ['file', 'hook', 'line', 'type'].sort(),
      );
      expect(typeof usage.file).toBe('string');
      expect(typeof usage.line).toBe('number');
      expect(typeof usage.hook).toBe('string');
      expect(typeof usage.type).toBe('string');
      expect(['reader', 'setter', 'initializer']).toContain(usage.type);
      // No internal fields leaked into JSON
      expect(usage).not.toHaveProperty('atomName');
      expect(usage).not.toHaveProperty('localName');
      expect(usage).not.toHaveProperty('resolvedName');
      expect(usage).not.toHaveProperty('definitionFile');
    }

    // Transitive: TransitiveDependency[] with { via, viaDefinition, depth, readers, setters }
    const transitive = parsed.transitive as Array<Record<string, unknown>>;
    expect(Array.isArray(transitive)).toBe(true);
    expect(transitive.length).toBeGreaterThanOrEqual(1);

    const firstTransitive = transitive[0];
    expect(firstTransitive).toHaveProperty('via');
    expect(firstTransitive).toHaveProperty('viaDefinition');
    expect(firstTransitive).toHaveProperty('depth');
    expect(firstTransitive).toHaveProperty('readers');
    expect(firstTransitive).toHaveProperty('setters');
    expect(typeof firstTransitive.via).toBe('string');
    expect(typeof firstTransitive.depth).toBe('number');
    expect(Array.isArray(firstTransitive.readers)).toBe(true);
    expect(Array.isArray(firstTransitive.setters)).toBe(true);

    // viaDefinition: { file: string, line: number, kind: StateKind }
    const viaDef = firstTransitive.viaDefinition as Record<string, unknown>;
    expect(viaDef).toHaveProperty('file');
    expect(viaDef).toHaveProperty('line');
    expect(viaDef).toHaveProperty('kind');
    expect(typeof viaDef.file).toBe('string');
    expect(typeof viaDef.line).toBe('number');
    expect(typeof viaDef.kind).toBe('string');
    expect(['atom', 'selector', 'atomFamily', 'selectorFamily']).toContain(
      viaDef.kind,
    );

    // Validate transitive usage items have the same simplified shape
    const transitiveUsages = [
      ...(firstTransitive.readers as Array<Record<string, unknown>>),
      ...(firstTransitive.setters as Array<Record<string, unknown>>),
    ];
    for (const usage of transitiveUsages) {
      expect(Object.keys(usage).sort()).toEqual(
        ['file', 'hook', 'line', 'type'].sort(),
      );
      expect(typeof usage.file).toBe('string');
      expect(typeof usage.line).toBe('number');
      expect(typeof usage.hook).toBe('string');
      expect(typeof usage.type).toBe('string');
    }

    // Summary: { totalFiles: number, totalComponents: number, totalSelectors: number }
    const summary = parsed.summary as Record<string, unknown>;
    expect(summary).toHaveProperty('totalFiles');
    expect(summary).toHaveProperty('totalComponents');
    expect(summary).toHaveProperty('totalSelectors');
    expect(typeof summary.totalFiles).toBe('number');
    expect(typeof summary.totalComponents).toBe('number');
    expect(typeof summary.totalSelectors).toBe('number');
  });

  it('JSON file paths are relative to target directory', () => {
    const {result, targetDir: dir} = getPipeline();

    const json = formatImpactJson([result], dir);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Target file should be relative
    const target = parsed.target as Record<string, unknown>;
    expect(target.file).toBe('states/contents.ts');
    expect(String(target.file).startsWith('/')).toBe(false);

    // Check some direct usage file paths are relative
    const direct = parsed.direct as Record<
      string,
      Array<Record<string, unknown>>
    >;
    for (const reader of direct.readers) {
      expect(String(reader.file).startsWith('/')).toBe(false);
    }

    // Check transitive file paths are relative
    const transitive = parsed.transitive as Array<Record<string, unknown>>;
    for (const dep of transitive) {
      const viaDef = dep.viaDefinition as Record<string, unknown>;
      expect(String(viaDef.file).startsWith('/')).toBe(false);
    }
  });
});

/**
 * Integration tests for an atomFamily with inline default selectorFamily deps.
 *
 * pressReleaseImageFileNameState is an atomFamily defined in states/images.ts
 * with `default: selectorFamily({ get: (id) => ({get}) => get(pressReleaseImageInitialValueList)... })`.
 *
 * The inline selectorFamily's get() body reads pressReleaseImageInitialValueList,
 * which should be reflected in the dependency graph. Additionally, several
 * standalone selectors (e.g. getAtomIdByFileName, pressReleaseImage) read
 * pressReleaseImageFileNameState via get(), creating transitive chains.
 */
describe('impact integration: inline default selector deps (atomFamily from images.ts)', () => {
  /**
   * Analyze pressReleaseImageFileNameState -- an atomFamily with an inline
   * selectorFamily default that reads pressReleaseImageInitialValueList.
   */
  function getImageFileNameResult(): ImpactResult {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    if (!result) {
      throw new Error(
        'analyzeAtomImpact returned null for pressReleaseImageFileNameState',
      );
    }

    return result;
  }

  /**
   * Analyze pressReleaseImageInitialValueList -- the atom read by the inline
   * default selectors of 4 atomFamily definitions. Its transitive dependents
   * should include all 4 atomFamilies via their inline selectorFamily defaults.
   */
  function getInitListResult(): ImpactResult {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(
      graph,
      'pressReleaseImageInitialValueList',
    );

    if (!result) {
      throw new Error(
        'analyzeAtomImpact returned null for pressReleaseImageInitialValueList',
      );
    }

    return result;
  }

  it('finds pressReleaseImageFileNameState as atomFamily in states/images.ts', () => {
    const result = getImageFileNameResult();

    expect(result.target.name).toBe('pressReleaseImageFileNameState');
    expect(result.target.kind).toBe('atomFamily');
    expect(result.target.file).toContain('states/images.ts');
    expect(result.target.line).toBe(112);
  });

  it('inline default selectorFamily dep is reflected in graph: pressReleaseImageInitialValueList has pressReleaseImageFileNameState as dependent', () => {
    const {graph} = getSharedPipeline();

    // The inline selectorFamily's get() in pressReleaseImageFileNameState reads
    // pressReleaseImageInitialValueList. In the graph, this means
    // pressReleaseImageInitialValueList -> dependentSelectors includes
    // pressReleaseImageFileNameState (the enclosingDefinition of the get() usage).
    const dependents = graph.dependentSelectors.get(
      'pressReleaseImageInitialValueList',
    );
    expect(dependents).toBeDefined();
    expect(dependents!.has('pressReleaseImageFileNameState')).toBe(true);
  });

  it('all 4 atomFamilies with inline defaults appear as dependents of pressReleaseImageInitialValueList', () => {
    const {graph} = getSharedPipeline();

    const dependents = graph.dependentSelectors.get(
      'pressReleaseImageInitialValueList',
    );
    expect(dependents).toBeDefined();

    // All 4 atomFamily definitions with inline selectorFamily defaults
    // that read pressReleaseImageInitialValueList
    const expectedDependents = [
      'pressReleaseImageFileNameState',
      'pressReleaseImageFileNameS3State',
      'pressReleaseImageCaptionState',
      'pressReleaseImagePixtaIdState',
    ];

    for (const name of expectedDependents) {
      expect(dependents!.has(name)).toBe(true);
    }
  });

  it('pressReleaseImageInitialValueList impact shows atomFamilies in transitive section', () => {
    const result = getInitListResult();

    // The 4 atomFamilies with inline defaults should appear as transitive
    // dependencies at depth 1 (they are "selectors" in graph terms because
    // their inline default's get() reads pressReleaseImageInitialValueList)
    const transitiveNames = new Set(result.transitive.map((t) => t.via));

    expect(transitiveNames.has('pressReleaseImageFileNameState')).toBe(true);
    expect(transitiveNames.has('pressReleaseImageFileNameS3State')).toBe(true);
    expect(transitiveNames.has('pressReleaseImageCaptionState')).toBe(true);
    expect(transitiveNames.has('pressReleaseImagePixtaIdState')).toBe(true);
  });

  it('transitive atomFamilies are at depth 1 from pressReleaseImageInitialValueList', () => {
    const result = getInitListResult();

    const fileNameDep = result.transitive.find(
      (t) => t.via === 'pressReleaseImageFileNameState',
    );
    expect(fileNameDep).toBeDefined();
    expect(fileNameDep!.depth).toBe(1);
    expect(fileNameDep!.viaDefinition.kind).toBe('atomFamily');
    expect(fileNameDep!.viaDefinition.file).toContain('states/images.ts');
  });

  it('pressReleaseImageFileNameState has selectors reading it via get() as transitive deps', () => {
    const result = getImageFileNameResult();

    // GetAtomIdByFileName is a selectorFamily that reads
    // pressReleaseImageFileNameState via get() at line 98 of images.ts
    const getAtomIdDep = result.transitive.find(
      (t) => t.via === 'getAtomIdByFileName',
    );
    expect(getAtomIdDep).toBeDefined();
    expect(getAtomIdDep!.depth).toBe(1);
    expect(getAtomIdDep!.viaDefinition.kind).toBe('selectorFamily');
  });

  it('multi-level chain: pressReleaseImageInitialValueList -> atomFamily -> selector -> component', () => {
    const result = getInitListResult();

    // GetAtomIdByFileName reads pressReleaseImageFileNameState (depth 1 from
    // pressReleaseImageFileNameState, depth 2 from pressReleaseImageInitialValueList)
    const getAtomIdDep = result.transitive.find(
      (t) => t.via === 'getAtomIdByFileName',
    );
    expect(getAtomIdDep).toBeDefined();
    expect(getAtomIdDep!.depth).toBe(2);

    // GetAtomIdByFileName has a wrapper hook useGetAtomIdByImageFileName that
    // calls useRecoilValue -- so it should have readers
    expect(getAtomIdDep!.readers.length).toBeGreaterThan(0);
  });

  it('pressReleaseImageFileNameState has direct component readers via useRecoilValue', () => {
    const result = getImageFileNameResult();

    // UseGetPressReleaseImageFileNameState (line 131) calls
    // useRecoilValue(pressReleaseImageFileNameState(imageAtomId))
    const directReaders = result.direct.readers;
    expect(directReaders.length).toBeGreaterThan(0);

    const readerInImages = directReaders.find(
      (r) => r.file.includes('states/images.ts') && r.hook === 'useRecoilValue',
    );
    expect(readerInImages).toBeDefined();
    expect(readerInImages!.line).toBe(131);
  });

  it('pressReleaseImageFileNameState has direct setters from useRecoilCallback', () => {
    const result = getImageFileNameResult();

    // Use-press-release-image.ts has set() and reset() calls for this atomFamily
    const {setters} = result.direct;
    expect(setters.length).toBeGreaterThan(0);

    const setterHooks = new Set(setters.map((s) => s.hook));
    // Set(pressReleaseImageFileNameState(id), ...) inside useRecoilCallback
    expect(
      setterHooks.has('set(callback)') || setterHooks.has('reset(callback)'),
    ).toBe(true);
  });

  it('summary counts are reasonable for an atomFamily with inline defaults', () => {
    const result = getImageFileNameResult();

    // PressReleaseImageFileNameState is used across multiple files
    expect(result.summary.totalFiles).toBeGreaterThanOrEqual(2);
    expect(result.summary.totalComponents).toBeGreaterThanOrEqual(1);
    // At least getAtomIdByFileName as transitive selector
    expect(result.summary.totalSelectors).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Integration test for an unknown atom name.
 *
 * When `--atom nonExistentAtom` is passed, the graph has no definition for it.
 * `analyzeAtomImpact` should return null, and the CLI would print
 * "No Recoil definition found for 'nonExistentAtom'" and exit 0.
 */
describe('impact integration: unknown atom name (--atom mode)', () => {
  it('returns null for an atom that does not exist in the codebase', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'nonExistentAtom');

    expect(result).toBeNull();
  });

  it('returns null for a plausible but misspelled atom name', () => {
    const {graph} = getSharedPipeline();
    // Misspelling of pressReleaseTitleState
    const result = analyzeAtomImpact(graph, 'pressReleaseTitleStat');

    expect(result).toBeNull();
  });

  it('returns null for an empty string atom name', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, '');

    expect(result).toBeNull();
  });
});

/**
 * Integration test for an atom flagged by Check 3 (unused).
 *
 * selectPurposeModalState is defined in
 * pages/step1/LeftSideMenu/RegularMenu/select-purpose/select-purpose-modal/index.tsx
 * and has no readers, no setters, and no selector dependencies.
 * The impact command should return empty results with zeros in the summary.
 */
describe('impact integration: atom with no usages (Check 3 unused atom)', () => {
  function getUnusedAtomResult(): ImpactResult {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'selectPurposeModalState');

    if (!result) {
      throw new Error(
        'analyzeAtomImpact returned null for selectPurposeModalState',
      );
    }

    return result;
  }

  it('finds selectPurposeModalState definition', () => {
    const result = getUnusedAtomResult();

    expect(result.target.name).toBe('selectPurposeModalState');
    expect(result.target.kind).toBe('atom');
    expect(result.target.file).toContain(
      'select-purpose/select-purpose-modal/index.tsx',
    );
    expect(result.target.line).toBe(17);
  });

  it('has no direct readers', () => {
    const result = getUnusedAtomResult();

    expect(result.direct.readers).toHaveLength(0);
  });

  it('has no direct setters', () => {
    const result = getUnusedAtomResult();

    expect(result.direct.setters).toHaveLength(0);
  });

  it('has no direct initializers', () => {
    const result = getUnusedAtomResult();

    expect(result.direct.initializers).toHaveLength(0);
  });

  it('has no transitive dependencies', () => {
    const result = getUnusedAtomResult();

    expect(result.transitive).toHaveLength(0);
  });

  it('summary shows all zeros', () => {
    const result = getUnusedAtomResult();

    expect(result.summary.totalFiles).toBe(0);
    expect(result.summary.totalComponents).toBe(0);
    expect(result.summary.totalSelectors).toBe(0);
  });

  it('text output shows zero summary', () => {
    const result = getUnusedAtomResult();
    const {targetDir: dir} = getSharedPipeline();

    const text = formatImpactText([result], dir);

    expect(text).toContain('Impact: selectPurposeModalState (atom)');
    expect(text).toContain('Summary: 0 files, 0 components, 0 selectors');
    // Empty impact should not show Direct or Transitive sections
    expect(text).not.toContain('READERS');
    expect(text).not.toContain('SETTERS');
    expect(text).not.toContain('INITIALIZERS');
    expect(text).not.toContain('Transitive (via selectors):');
  });

  it('JSON output shows empty arrays and zero summary', () => {
    const result = getUnusedAtomResult();
    const {targetDir: dir} = getSharedPipeline();

    const json = formatImpactJson([result], dir);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Single result should be an object, not an array
    expect(parsed).not.toBeInstanceOf(Array);

    const direct = parsed.direct as Record<string, unknown[]>;
    expect(direct.readers).toHaveLength(0);
    expect(direct.setters).toHaveLength(0);
    expect(direct.initializers).toHaveLength(0);

    const transitive = parsed.transitive as unknown[];
    expect(transitive).toHaveLength(0);

    const summary = parsed.summary as Record<string, number>;
    expect(summary.totalFiles).toBe(0);
    expect(summary.totalComponents).toBe(0);
    expect(summary.totalSelectors).toBe(0);
  });
});

/**
 * Integration test for --file mode with a file containing multiple atoms.
 *
 * states/core.ts defines many Recoil atoms and selectors:
 * - pressReleaseEditModeState (selector)
 * - pressReleaseIsPublishedState (atom)
 * - isSystemAdminModeState (atom)
 * - isSystemAdminRestrictedModeState (selector)
 * - shouldShowReleaseCountLimitAlertState (atom)
 * - pressReleaseEditorCurrentStepState (atom)
 * - pressReleaseEditorPreviousStepState (selector)
 * - pressReleaseEditorNextStepState (selector)
 * - releaseIdState (atom)
 * - editStartedAtState (atom)
 * - releaseSendKbnState (atom)
 * - savedAtState (atom)
 * - saveStatusState (atom)
 *
 * analyzeFileImpact should return one ImpactResult per definition,
 * and formatImpactText should separate them with \n---\n.
 */
describe('impact integration: --file mode with multiple atoms (states/core.ts)', () => {
  const coreFilePath = path.resolve(targetDir, 'states/core.ts');

  function getFileResults(): ImpactResult[] {
    const {graph, extraction} = getSharedPipeline();
    return analyzeFileImpact(graph, coreFilePath, extraction);
  }

  it('returns one ImpactResult per Recoil definition in the file', () => {
    const results = getFileResults();

    // States/core.ts defines 13 atoms/selectors
    expect(results.length).toBeGreaterThanOrEqual(10);

    // Each result should have a unique target name
    const names = results.map((r) => r.target.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('includes all known atom definitions from states/core.ts', () => {
    const results = getFileResults();
    const names = new Set(results.map((r) => r.target.name));

    // Atoms
    expect(names.has('pressReleaseIsPublishedState')).toBe(true);
    expect(names.has('isSystemAdminModeState')).toBe(true);
    expect(names.has('shouldShowReleaseCountLimitAlertState')).toBe(true);
    expect(names.has('pressReleaseEditorCurrentStepState')).toBe(true);
    expect(names.has('releaseIdState')).toBe(true);
    expect(names.has('editStartedAtState')).toBe(true);
    expect(names.has('releaseSendKbnState')).toBe(true);
    expect(names.has('savedAtState')).toBe(true);
    expect(names.has('saveStatusState')).toBe(true);
  });

  it('includes selector definitions from states/core.ts', () => {
    const results = getFileResults();
    const names = new Set(results.map((r) => r.target.name));

    // Selectors
    expect(names.has('pressReleaseEditModeState')).toBe(true);
    expect(names.has('isSystemAdminRestrictedModeState')).toBe(true);
    expect(names.has('pressReleaseEditorPreviousStepState')).toBe(true);
    expect(names.has('pressReleaseEditorNextStepState')).toBe(true);
  });

  it('each result has the correct file path pointing to states/core.ts', () => {
    const results = getFileResults();

    for (const result of results) {
      expect(result.target.file).toContain('states/core.ts');
    }
  });

  it('each result has a valid line number', () => {
    const results = getFileResults();

    for (const result of results) {
      expect(result.target.line).toBeGreaterThan(0);
    }
  });

  it('well-used atoms have non-empty direct usages', () => {
    const results = getFileResults();

    // PressReleaseIsPublishedState is used in multiple places via wrapper hooks
    const isPublished = results.find(
      (r) => r.target.name === 'pressReleaseIsPublishedState',
    );
    expect(isPublished).toBeDefined();
    expect(isPublished!.direct.readers.length).toBeGreaterThan(0);
  });

  it('text output separates multiple results with --- delimiter', () => {
    const results = getFileResults();
    const text = formatImpactText(results, targetDir);

    // With multiple results, there should be --- separators
    const separatorCount = text.split('\n---\n').length - 1;
    expect(separatorCount).toBe(results.length - 1);
    expect(separatorCount).toBeGreaterThanOrEqual(1);
  });

  it('text output contains Impact header for each definition', () => {
    const results = getFileResults();
    const text = formatImpactText(results, targetDir);

    for (const result of results) {
      expect(text).toContain(
        `Impact: ${result.target.name} (${result.target.kind})`,
      );
    }
  });

  it('text output contains Summary line for each definition', () => {
    const results = getFileResults();
    const text = formatImpactText(results, targetDir);

    // Count the number of Summary lines — should match the number of results
    const summaryLines = text
      .split('\n')
      .filter((line) => line.includes('Summary:'));
    expect(summaryLines).toHaveLength(results.length);
  });

  it('JSON output is a valid array when multiple results exist', () => {
    const results = getFileResults();
    const json = formatImpactJson(results, targetDir);
    const parsed = JSON.parse(json) as unknown;

    // Multiple results should be an array
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(results.length);
  });

  it('JSON output contains correct target names for each definition', () => {
    const results = getFileResults();
    const json = formatImpactJson(results, targetDir);
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;

    const jsonNames = new Set(
      parsed.map((item) => (item.target as Record<string, unknown>).name),
    );
    const resultNames = new Set(results.map((r) => r.target.name));

    expect(jsonNames).toEqual(resultNames);
  });

  it('JSON output has relative file paths for all definitions', () => {
    const results = getFileResults();
    const json = formatImpactJson(results, targetDir);
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;

    for (const item of parsed) {
      const target = item.target as Record<string, unknown>;
      expect(String(target.file)).toBe('states/core.ts');
      expect(String(target.file).startsWith('/')).toBe(false);
    }
  });
});

/**
 * Integration test for --file mode with a file containing no Recoil atoms.
 *
 * pages/step1/CharCounter/index.tsx is a pure presentational component with
 * no atom(), atomFamily(), selector(), or selectorFamily() definitions.
 * analyzeFileImpact should return an empty array, and the CLI would print
 * "No Recoil definitions found in ..." and exit 0.
 */
describe('impact integration: --file mode with no atoms (pages/step1/CharCounter/index.tsx)', () => {
  const noAtomsFilePath = path.resolve(
    targetDir,
    'pages/step1/CharCounter/index.tsx',
  );

  it('returns an empty array when the file has no Recoil definitions', () => {
    const {graph, extraction} = getSharedPipeline();
    const results = analyzeFileImpact(graph, noAtomsFilePath, extraction);

    expect(results).toHaveLength(0);
  });

  it('confirms the file exists but simply has no definitions', () => {
    const {extraction} = getSharedPipeline();

    // The file should exist in the scanned file set
    const absolutePath = path.resolve(noAtomsFilePath);
    const definitionsInFile = extraction.recoilDefinitions.filter(
      (d) => d.file === absolutePath,
    );

    expect(definitionsInFile).toHaveLength(0);
  });

  it('text output would show the "no definitions" message (CLI behavior)', () => {
    const {graph, extraction} = getSharedPipeline();
    const results = analyzeFileImpact(graph, noAtomsFilePath, extraction);

    // The CLI prints this message and exits 0 when results are empty.
    // We verify the condition that triggers that message.
    expect(results.length).toBe(0);

    // The display path shown by the CLI would be relative to targetDir
    const displayPath = path.relative(targetDir, path.resolve(noAtomsFilePath));
    expect(displayPath).toBe('pages/step1/CharCounter/index.tsx');
  });
});

/**
 * Integration test for --file mode relative path resolution.
 *
 * Verifies that `--file states/core.ts` (relative to target dir) produces the
 * same results as passing the full absolute path. The CLI's resolveFilePath
 * function resolves relative paths against the target directory. This test
 * validates that analyzeFileImpact produces identical results regardless of
 * how the path is constructed — relative-then-resolved or absolute from the start.
 */
describe('impact integration: --file mode relative path resolution', () => {
  const absoluteCorePath = path.resolve(targetDir, 'states/core.ts');

  /**
   * Simulate what the CLI's resolveFilePath would do for a relative path:
   * resolve it against the target directory to produce an absolute path.
   */
  function resolveRelativePath(relativePath: string): string {
    return path.resolve(targetDir, relativePath);
  }

  it('relative path "states/core.ts" resolves to the same absolute path', () => {
    const resolvedFromRelative = resolveRelativePath('states/core.ts');

    expect(resolvedFromRelative).toBe(absoluteCorePath);
    expect(path.isAbsolute(resolvedFromRelative)).toBe(true);
  });

  it('relative path with "./" prefix resolves to the same absolute path', () => {
    const resolvedFromDotSlash = resolveRelativePath('./states/core.ts');

    expect(resolvedFromDotSlash).toBe(absoluteCorePath);
  });

  it('analyzeFileImpact returns identical results for relative-resolved and absolute paths', () => {
    const {graph, extraction} = getSharedPipeline();

    const absoluteResults = analyzeFileImpact(
      graph,
      absoluteCorePath,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      resolveRelativePath('states/core.ts'),
      extraction,
    );

    // Same number of definitions found
    expect(relativeResults.length).toBe(absoluteResults.length);

    // Same target names in the same order
    const absoluteNames = absoluteResults.map((r) => r.target.name);
    const relativeNames = relativeResults.map((r) => r.target.name);
    expect(relativeNames).toEqual(absoluteNames);

    // Each result has identical target metadata
    for (const [index, absResult] of absoluteResults.entries()) {
      const relResult = relativeResults[index];
      expect(relResult.target.name).toBe(absResult.target.name);
      expect(relResult.target.kind).toBe(absResult.target.kind);
      expect(relResult.target.file).toBe(absResult.target.file);
      expect(relResult.target.line).toBe(absResult.target.line);
    }
  });

  it('direct usages are identical for relative-resolved and absolute paths', () => {
    const {graph, extraction} = getSharedPipeline();

    const absoluteResults = analyzeFileImpact(
      graph,
      absoluteCorePath,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      resolveRelativePath('states/core.ts'),
      extraction,
    );

    for (const [index, absResult] of absoluteResults.entries()) {
      const relResult = relativeResults[index];
      expect(relResult.direct.readers.length).toBe(
        absResult.direct.readers.length,
      );
      expect(relResult.direct.setters.length).toBe(
        absResult.direct.setters.length,
      );
      expect(relResult.direct.initializers.length).toBe(
        absResult.direct.initializers.length,
      );
    }
  });

  it('transitive dependencies are identical for relative-resolved and absolute paths', () => {
    const {graph, extraction} = getSharedPipeline();

    const absoluteResults = analyzeFileImpact(
      graph,
      absoluteCorePath,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      resolveRelativePath('states/core.ts'),
      extraction,
    );

    for (const [index, absResult] of absoluteResults.entries()) {
      const relResult = relativeResults[index];
      expect(relResult.transitive.length).toBe(absResult.transitive.length);

      const absTransitiveNames = absResult.transitive.map((t) => t.via).sort();
      const relTransitiveNames = relResult.transitive.map((t) => t.via).sort();
      expect(relTransitiveNames).toEqual(absTransitiveNames);
    }
  });

  it('summaries are identical for relative-resolved and absolute paths', () => {
    const {graph, extraction} = getSharedPipeline();

    const absoluteResults = analyzeFileImpact(
      graph,
      absoluteCorePath,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      resolveRelativePath('states/core.ts'),
      extraction,
    );

    for (const [index, absResult] of absoluteResults.entries()) {
      const relResult = relativeResults[index];
      expect(relResult.summary).toEqual(absResult.summary);
    }
  });

  it('text output is identical for relative-resolved and absolute paths', () => {
    const {graph, extraction} = getSharedPipeline();

    const absoluteResults = analyzeFileImpact(
      graph,
      absoluteCorePath,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      resolveRelativePath('states/core.ts'),
      extraction,
    );

    const absoluteText = formatImpactText(absoluteResults, targetDir);
    const relativeText = formatImpactText(relativeResults, targetDir);

    expect(relativeText).toBe(absoluteText);
  });

  it('JSON output is identical for relative-resolved and absolute paths', () => {
    const {graph, extraction} = getSharedPipeline();

    const absoluteResults = analyzeFileImpact(
      graph,
      absoluteCorePath,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      resolveRelativePath('states/core.ts'),
      extraction,
    );

    const absoluteJson = formatImpactJson(absoluteResults, targetDir);
    const relativeJson = formatImpactJson(relativeResults, targetDir);

    expect(relativeJson).toBe(absoluteJson);
  });

  it('works for a nested relative path (pages/step1/CharCounter/index.tsx)', () => {
    const {graph, extraction} = getSharedPipeline();

    const nestedAbsolute = path.resolve(
      targetDir,
      'pages/step1/CharCounter/index.tsx',
    );
    const nestedRelativeResolved = resolveRelativePath(
      'pages/step1/CharCounter/index.tsx',
    );

    expect(nestedRelativeResolved).toBe(nestedAbsolute);

    const absoluteResults = analyzeFileImpact(
      graph,
      nestedAbsolute,
      extraction,
    );
    const relativeResults = analyzeFileImpact(
      graph,
      nestedRelativeResolved,
      extraction,
    );

    expect(relativeResults.length).toBe(absoluteResults.length);
  });

  it('works for images.ts with atomFamily definitions', () => {
    const {graph, extraction} = getSharedPipeline();

    const absolutePath = path.resolve(targetDir, 'states/images.ts');
    const relativeResolved = resolveRelativePath('states/images.ts');

    expect(relativeResolved).toBe(absolutePath);

    const absoluteResults = analyzeFileImpact(graph, absolutePath, extraction);
    const relativeResults = analyzeFileImpact(
      graph,
      relativeResolved,
      extraction,
    );

    expect(relativeResults.length).toBe(absoluteResults.length);
    expect(relativeResults.length).toBeGreaterThan(0);

    const absoluteNames = absoluteResults.map((r) => r.target.name);
    const relativeNames = relativeResults.map((r) => r.target.name);
    expect(relativeNames).toEqual(absoluteNames);
  });
});

/**
 * Integration test for --git mode with uncommitted changes.
 *
 * The `--git` mode runs `git diff --name-only HEAD` to find changed files,
 * filters them to .ts/.tsx, and calls `analyzeGitImpact` which delegates to
 * `analyzeFileImpact` for each changed file. These tests simulate the
 * behaviour by providing file paths (as `getGitChangedFiles` would return)
 * and verifying the end-to-end analysis pipeline produces correct results.
 */
describe('impact integration: --git mode with uncommitted changes', () => {
  it('returns impact results when a changed file contains Recoil atoms', () => {
    const {graph, extraction} = getSharedPipeline();

    // Simulate git reporting states/contents.ts as changed
    const changedFiles = [path.resolve(targetDir, 'states/contents.ts')];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    // states/contents.ts defines multiple atoms including pressReleaseTitleState
    expect(results.length).toBeGreaterThan(0);

    const names = new Set(results.map((r) => r.target.name));
    expect(names.has('pressReleaseTitleState')).toBe(true);
  });

  it('returns results matching analyzeFileImpact for the same file', () => {
    const {graph, extraction} = getSharedPipeline();

    const contentsFile = path.resolve(targetDir, 'states/contents.ts');

    // Git mode result
    const gitResults = analyzeGitImpact(graph, [contentsFile], extraction);

    // File mode result
    const fileResults = analyzeFileImpact(graph, contentsFile, extraction);

    // Should produce identical results
    expect(gitResults.length).toBe(fileResults.length);

    const gitNames = gitResults.map((r) => r.target.name).sort();
    const fileNames = fileResults.map((r) => r.target.name).sort();
    expect(gitNames).toEqual(fileNames);

    // Each result should have matching summaries
    for (const gitResult of gitResults) {
      const fileResult = fileResults.find(
        (r) => r.target.name === gitResult.target.name,
      );
      expect(fileResult).toBeDefined();
      expect(gitResult.summary).toEqual(fileResult!.summary);
    }
  });

  it('aggregates results from multiple changed files', () => {
    const {graph, extraction} = getSharedPipeline();

    // Simulate git reporting both states/contents.ts and states/core.ts as changed
    const changedFiles = [
      path.resolve(targetDir, 'states/contents.ts'),
      path.resolve(targetDir, 'states/core.ts'),
    ];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    // Should include atoms from both files
    const names = new Set(results.map((r) => r.target.name));

    // From states/contents.ts
    expect(names.has('pressReleaseTitleState')).toBe(true);

    // From states/core.ts
    expect(names.has('pressReleaseIsPublishedState')).toBe(true);
    expect(names.has('releaseIdState')).toBe(true);

    // Total count should be sum of both files' definitions
    const contentsResults = analyzeFileImpact(
      graph,
      path.resolve(targetDir, 'states/contents.ts'),
      extraction,
    );
    const coreResults = analyzeFileImpact(
      graph,
      path.resolve(targetDir, 'states/core.ts'),
      extraction,
    );

    expect(results.length).toBe(contentsResults.length + coreResults.length);
  });

  it('returns empty results when changed files contain no Recoil definitions', () => {
    const {graph, extraction} = getSharedPipeline();

    // Simulate git reporting a component file with no atom definitions
    const changedFiles = [
      path.resolve(targetDir, 'pages/step1/CharCounter/index.tsx'),
    ];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    expect(results).toHaveLength(0);
  });

  it('returns empty results for an empty changed file list', () => {
    const {graph, extraction} = getSharedPipeline();

    const results = analyzeGitImpact(graph, [], extraction);

    expect(results).toHaveLength(0);
  });

  it('filters out changed files with no atoms from mixed list', () => {
    const {graph, extraction} = getSharedPipeline();

    // Mix of files: one with atoms, one without
    const changedFiles = [
      path.resolve(targetDir, 'states/contents.ts'),
      path.resolve(targetDir, 'pages/step1/CharCounter/index.tsx'),
    ];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    // Only atoms from states/contents.ts should appear
    const contentsResults = analyzeFileImpact(
      graph,
      path.resolve(targetDir, 'states/contents.ts'),
      extraction,
    );

    expect(results.length).toBe(contentsResults.length);

    // All result targets should reference states/contents.ts
    for (const result of results) {
      expect(result.target.file).toContain('states/contents.ts');
    }
  });

  it('each result has valid target metadata', () => {
    const {graph, extraction} = getSharedPipeline();

    const changedFiles = [path.resolve(targetDir, 'states/core.ts')];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    for (const result of results) {
      // Target name should be non-empty
      expect(result.target.name.length).toBeGreaterThan(0);
      // Target should point to the correct file
      expect(result.target.file).toContain('states/core.ts');
      // Line numbers should be positive
      expect(result.target.line).toBeGreaterThan(0);
      // Kind should be a valid Recoil kind
      expect(['atom', 'selector', 'atomFamily', 'selectorFamily']).toContain(
        result.target.kind,
      );
    }
  });

  it('text output for git results separates multiple atoms with ---', () => {
    const {graph, extraction} = getSharedPipeline();

    const changedFiles = [path.resolve(targetDir, 'states/core.ts')];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    // Multiple atoms in core.ts -> results separated by ---
    expect(results.length).toBeGreaterThan(1);

    const text = formatImpactText(results, targetDir);
    const separatorCount = text.split('\n---\n').length - 1;
    expect(separatorCount).toBe(results.length - 1);
  });

  it('JSON output for git results is a valid array', () => {
    const {graph, extraction} = getSharedPipeline();

    const changedFiles = [path.resolve(targetDir, 'states/core.ts')];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    const json = formatImpactJson(results, targetDir);
    const parsed = JSON.parse(json) as unknown;

    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(results.length);
  });

  it('handles atomFamily files in git-changed list', () => {
    const {graph, extraction} = getSharedPipeline();

    // states/images.ts contains atomFamily definitions with inline defaults
    const changedFiles = [path.resolve(targetDir, 'states/images.ts')];

    const results = analyzeGitImpact(graph, changedFiles, extraction);

    expect(results.length).toBeGreaterThan(0);

    // Should include the atomFamily we tested earlier
    const names = new Set(results.map((r) => r.target.name));
    expect(names.has('pressReleaseImageFileNameState')).toBe(true);

    // atomFamily results should have correct kind
    const imageFileName = results.find(
      (r) => r.target.name === 'pressReleaseImageFileNameState',
    );
    expect(imageFileName).toBeDefined();
    expect(imageFileName!.target.kind).toBe('atomFamily');
  });
});

/**
 * Acceptance criteria: Transitive dependency chains through selectors are traced correctly.
 *
 * This suite validates that BFS traversal through the selector dependency graph
 * correctly identifies all transitive selectors at the right depths. It covers:
 *
 * 1. Simple depth-1 chains (atom -> selector)
 * 2. Multi-level depth-2 chains (atom -> selector -> selector)
 * 3. Deep chains in images.ts (atomFamily -> selectorFamily -> selector -> selector)
 * 4. Diamond dependencies (multiple paths converging on the same selector)
 * 5. Cross-file transitive chains (core.ts -> medialists.ts)
 * 6. Inline default selector chains (atomFamily with default selectorFamily)
 */
describe('impact integration: transitive dependency chains through selectors are traced correctly', () => {
  it('depth-1: pressReleaseTitleState -> pressReleaseTitleForPreview', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseTitleState');

    expect(result).not.toBeNull();

    const previewSelector = result!.transitive.find(
      (t) => t.via === 'pressReleaseTitleForPreview',
    );
    expect(previewSelector).toBeDefined();
    expect(previewSelector!.depth).toBe(1);
    expect(previewSelector!.viaDefinition.kind).toBe('selector');
    expect(previewSelector!.viaDefinition.file).toContain('states/contents.ts');
    expect(previewSelector!.viaDefinition.line).toBeGreaterThan(0);
  });

  it('depth-2: releaseSendKbnState -> pressReleaseEditModeState -> pressReleaseEditorPreviousStepState', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'releaseSendKbnState');

    expect(result).not.toBeNull();

    // Depth 1: pressReleaseEditModeState reads releaseSendKbnState via get()
    const editMode = result!.transitive.find(
      (t) => t.via === 'pressReleaseEditModeState',
    );
    expect(editMode).toBeDefined();
    expect(editMode!.depth).toBe(1);
    expect(editMode!.viaDefinition.kind).toBe('selector');

    // Depth 2: pressReleaseEditorPreviousStepState reads pressReleaseEditModeState via get()
    const previousStep = result!.transitive.find(
      (t) => t.via === 'pressReleaseEditorPreviousStepState',
    );
    expect(previousStep).toBeDefined();
    expect(previousStep!.depth).toBe(2);
    expect(previousStep!.viaDefinition.kind).toBe('selector');
    expect(previousStep!.viaDefinition.file).toContain('states/core.ts');
  });

  it('depth-2: releaseSendKbnState -> pressReleaseEditModeState -> pressReleaseEditorNextStepState', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'releaseSendKbnState');

    expect(result).not.toBeNull();

    const nextStep = result!.transitive.find(
      (t) => t.via === 'pressReleaseEditorNextStepState',
    );
    expect(nextStep).toBeDefined();
    expect(nextStep!.depth).toBe(2);
    expect(nextStep!.viaDefinition.kind).toBe('selector');
    expect(nextStep!.viaDefinition.file).toContain('states/core.ts');
  });

  it('depth-2: pressReleaseIsPublishedState -> isSystemAdminRestrictedModeState -> pressReleaseEditorPreviousStepState', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseIsPublishedState');

    expect(result).not.toBeNull();

    // Depth 1: isSystemAdminRestrictedModeState reads pressReleaseIsPublishedState
    const restricted = result!.transitive.find(
      (t) => t.via === 'isSystemAdminRestrictedModeState',
    );
    expect(restricted).toBeDefined();
    expect(restricted!.depth).toBe(1);

    // Depth 2: pressReleaseEditorPreviousStepState reads isSystemAdminRestrictedModeState
    const previousStep = result!.transitive.find(
      (t) => t.via === 'pressReleaseEditorPreviousStepState',
    );
    expect(previousStep).toBeDefined();
    // depth could be 2 via either path (editMode or restricted), BFS picks the first found
    expect(previousStep!.depth).toBeGreaterThanOrEqual(2);
  });

  it('depth-2: releaseSendKbnState -> pressReleaseEditModeState -> shouldShowReleaseCountLimitAlertState (inline default selector)', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'releaseSendKbnState');

    expect(result).not.toBeNull();

    // shouldShowReleaseCountLimitAlertState is an atom with an inline default selector
    // that reads pressReleaseEditModeState via get(). Its enclosingDefinition is
    // shouldShowReleaseCountLimitAlertState itself, so it appears as a depth-2
    // transitive dependency from releaseSendKbnState.
    const limitAlert = result!.transitive.find(
      (t) => t.via === 'shouldShowReleaseCountLimitAlertState',
    );
    expect(limitAlert).toBeDefined();
    expect(limitAlert!.depth).toBe(2);
    expect(limitAlert!.viaDefinition.file).toContain('states/core.ts');
  });

  it('deep chain in images.ts: pressReleaseImageFileNameState -> pressReleaseImage -> pressReleaseImageList', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();

    // Depth 1: pressReleaseImage reads pressReleaseImageFileNameState via get()
    const pressReleaseImage = result!.transitive.find(
      (t) => t.via === 'pressReleaseImage',
    );
    expect(pressReleaseImage).toBeDefined();
    expect(pressReleaseImage!.depth).toBe(1);
    expect(pressReleaseImage!.viaDefinition.kind).toBe('selectorFamily');

    // Depth 2: pressReleaseImageList reads pressReleaseImage via get()
    const imageList = result!.transitive.find(
      (t) => t.via === 'pressReleaseImageList',
    );
    expect(imageList).toBeDefined();
    expect(imageList!.depth).toBe(2);
    expect(imageList!.viaDefinition.kind).toBe('selector');
  });

  it('deep chain in images.ts: pressReleaseImageFileNameState -> ... -> pressReleaseNextMainImageFileNameState at depth 3', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();

    // Depth 3: pressReleaseNextMainImageFileNameState reads pressReleaseImageList via get()
    // Chain: pressReleaseImageFileNameState -> pressReleaseImage -> pressReleaseImageList -> pressReleaseNextMainImageFileNameState
    const nextMain = result!.transitive.find(
      (t) => t.via === 'pressReleaseNextMainImageFileNameState',
    );
    expect(nextMain).toBeDefined();
    expect(nextMain!.depth).toBe(3);
    expect(nextMain!.viaDefinition.kind).toBe('selector');
    expect(nextMain!.viaDefinition.file).toContain('states/images.ts');
  });

  it('deep chain in images.ts: pressReleaseImageFileNameState -> ... -> pressReleaseCurrentMainImageFileState at depth 3', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();

    const currentMain = result!.transitive.find(
      (t) => t.via === 'pressReleaseCurrentMainImageFileState',
    );
    expect(currentMain).toBeDefined();
    expect(currentMain!.depth).toBe(3);
    expect(currentMain!.viaDefinition.kind).toBe('selector');
  });

  it('diamond dependency: pressReleaseImageFileNameState reaches pressReleaseImageIsMain via two paths', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();

    // pressReleaseImageIsMain reads both pressReleaseImageFileNameState (direct)
    // and pressReleaseImageIsUploading (which also reads pressReleaseImageFileNameState).
    // BFS ensures it appears exactly once with the shortest depth.
    const isMain = result!.transitive.find(
      (t) => t.via === 'pressReleaseImageIsMain',
    );
    expect(isMain).toBeDefined();
    // pressReleaseImageIsMain reads pressReleaseImageFileNameState directly via get(),
    // so it should appear at depth 1
    expect(isMain!.depth).toBe(1);
    expect(isMain!.viaDefinition.kind).toBe('selectorFamily');

    // Verify it appears only once (BFS visited set prevents duplicates)
    const isMainCount = result!.transitive.filter(
      (t) => t.via === 'pressReleaseImageIsMain',
    ).length;
    expect(isMainCount).toBe(1);
  });

  it('each transitive entry has a valid viaDefinition with file, line, and kind', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();
    expect(result!.transitive.length).toBeGreaterThan(0);

    for (const dep of result!.transitive) {
      expect(dep.via.length).toBeGreaterThan(0);
      expect(dep.viaDefinition.file.length).toBeGreaterThan(0);
      expect(path.isAbsolute(dep.viaDefinition.file)).toBe(true);
      expect(dep.viaDefinition.line).toBeGreaterThan(0);
      expect(['atom', 'selector', 'atomFamily', 'selectorFamily']).toContain(
        dep.viaDefinition.kind,
      );
      expect(dep.depth).toBeGreaterThanOrEqual(1);
      expect(dep.depth).toBeLessThanOrEqual(5);
    }
  });

  it('transitive entries are deduplicated (no selector appears twice)', () => {
    const {graph} = getSharedPipeline();

    // Test with an atom that has a complex graph with diamond dependencies
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();

    const viaNames = result!.transitive.map((t) => t.via);
    const uniqueNames = new Set(viaNames);
    expect(uniqueNames.size).toBe(viaNames.length);
  });

  it('releaseSendKbnState transitive chain includes all known downstream selectors', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'releaseSendKbnState');

    expect(result).not.toBeNull();

    const transitiveNames = new Set(result!.transitive.map((t) => t.via));

    // Depth 1: pressReleaseEditModeState
    expect(transitiveNames.has('pressReleaseEditModeState')).toBe(true);

    // Depth 2: selectors that read pressReleaseEditModeState
    expect(transitiveNames.has('pressReleaseEditorPreviousStepState')).toBe(
      true,
    );
    expect(transitiveNames.has('pressReleaseEditorNextStepState')).toBe(true);
    expect(transitiveNames.has('shouldShowReleaseCountLimitAlertState')).toBe(
      true,
    );
  });

  it('transitive depths increase monotonically along the chain', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseImageFileNameState');

    expect(result).not.toBeNull();

    // Group transitive entries by depth and verify ordering
    const depthValues = result!.transitive.map((t) => t.depth);
    // BFS processes level by level, so depths should be non-decreasing
    for (let index = 1; index < depthValues.length; index++) {
      expect(depthValues[index]).toBeGreaterThanOrEqual(depthValues[index - 1]);
    }
  });

  it('inline default selectorFamily chains are traced: pressReleaseImageInitialValueList -> 4 atomFamilies at depth 1', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(
      graph,
      'pressReleaseImageInitialValueList',
    );

    expect(result).not.toBeNull();

    const depth1 = result!.transitive.filter((t) => t.depth === 1);
    const depth1Names = new Set(depth1.map((t) => t.via));

    // All 4 atomFamilies with inline default selectorFamilies that read this atom
    expect(depth1Names.has('pressReleaseImageFileNameState')).toBe(true);
    expect(depth1Names.has('pressReleaseImageFileNameS3State')).toBe(true);
    expect(depth1Names.has('pressReleaseImageCaptionState')).toBe(true);
    expect(depth1Names.has('pressReleaseImagePixtaIdState')).toBe(true);
  });

  it('inline default chains continue beyond depth 1: pressReleaseImageInitialValueList -> atomFamily -> selectorFamily at depth 2', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(
      graph,
      'pressReleaseImageInitialValueList',
    );

    expect(result).not.toBeNull();

    // Depth 2: selectors/selectorFamilies that read the atomFamilies
    // e.g., getAtomIdByFileName reads pressReleaseImageFileNameState
    const depth2 = result!.transitive.filter((t) => t.depth === 2);
    expect(depth2.length).toBeGreaterThan(0);

    const depth2Names = new Set(depth2.map((t) => t.via));
    expect(depth2Names.has('getAtomIdByFileName')).toBe(true);
  });
});

/**
 * Acceptance criterion: Impact analysis reuses the existing 3-pass pipeline
 * without modifying its output.
 *
 * Both the `check` command (index.ts) and the `impact` command (impact-cli.ts)
 * call the same functions: extractDefinitions, collectUsages, resolveUsages.
 * This suite verifies that the impact pipeline consumes the same pipeline
 * output that the check pipeline produces, and that running impact analysis
 * does not alter the pipeline results.
 */
describe('acceptance: impact analysis reuses the existing 3-pass pipeline without modifying its output', () => {
  it('impact command calls the same extractDefinitions, collectUsages, resolveUsages as check', () => {
    const files = globFiles(targetDir);

    // Run the 3-pass pipeline exactly as both commands do
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // Snapshot the pipeline output before impact analysis
    const extractionSnapshot = JSON.stringify(extraction);
    const resolvedSnapshot = JSON.stringify(resolved);
    const resolvedCount = resolved.length;
    const definitionCount = extraction.recoilDefinitions.length;

    // Run the check command's logic on the same pipeline output
    const violations = runChecks(extraction, resolved);
    expect(violations).toBeDefined();

    // Run the impact command's logic on the same pipeline output
    const graph = buildDependencyGraph(extraction, resolved);
    const result = analyzeAtomImpact(graph, 'pressReleaseTitleState');
    expect(result).not.toBeNull();

    // Verify the pipeline output was NOT mutated by either consumer
    expect(JSON.stringify(extraction)).toBe(extractionSnapshot);
    expect(JSON.stringify(resolved)).toBe(resolvedSnapshot);
    expect(resolved.length).toBe(resolvedCount);
    expect(extraction.recoilDefinitions.length).toBe(definitionCount);
  });

  it('pipeline output counts are identical whether consumed by check or impact', () => {
    const files = globFiles(targetDir);
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // Record key counts
    const recoilDefCount = extraction.recoilDefinitions.length;
    const jotaiDefCount = extraction.jotaiDefinitions.length;
    const jotaiImportCount = extraction.jotaiImports.length;
    const usageCount = usages.usages.length;
    const resolvedCount = resolved.length;

    // Run check (as index.ts does)
    runChecks(extraction, resolved);

    // Run impact (as impact-cli.ts does)
    const graph = buildDependencyGraph(extraction, resolved);
    analyzeAtomImpact(graph, 'pressReleaseTitleState');

    // Counts must remain unchanged
    expect(extraction.recoilDefinitions.length).toBe(recoilDefCount);
    expect(extraction.jotaiDefinitions.length).toBe(jotaiDefCount);
    expect(extraction.jotaiImports.length).toBe(jotaiImportCount);
    expect(usages.usages.length).toBe(usageCount);
    expect(resolved.length).toBe(resolvedCount);
  });

  it('the shared pipeline runs once and both check and impact can consume it independently', () => {
    // Use the shared pipeline (same singleton both suites use)
    const {extraction, resolved, graph} = getSharedPipeline();

    // Check command can consume the pipeline output
    const violations = runChecks(extraction, resolved);
    expect(Array.isArray(violations)).toBe(true);

    // Impact command can consume the same pipeline output
    const result = analyzeAtomImpact(graph, 'pressReleaseTitleState');
    expect(result).not.toBeNull();
    expect(result!.target.name).toBe('pressReleaseTitleState');

    // Both work on the exact same data without conflict
    const result2 = analyzeAtomImpact(graph, 'releaseIdState');
    expect(result2).not.toBeNull();
  });

  it('graph builder only reads from pipeline output, does not modify extraction or resolved arrays', () => {
    const files = globFiles(targetDir);
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // Deep-copy the resolved usages to compare after graph building
    const resolvedBefore = resolved.map((r) => ({...r}));
    const defsBefore = extraction.recoilDefinitions.map((d) => ({
      name: d.name,
      kind: d.kind,
      file: d.file,
      line: d.line,
    }));

    // Build graph (this is the extra step impact adds)
    buildDependencyGraph(extraction, resolved);

    // Verify no mutation
    expect(resolved.length).toBe(resolvedBefore.length);
    for (const [index, usage] of resolved.entries()) {
      expect(usage.resolvedName).toBe(resolvedBefore[index].resolvedName);
      expect(usage.file).toBe(resolvedBefore[index].file);
      expect(usage.line).toBe(resolvedBefore[index].line);
      expect(usage.type).toBe(resolvedBefore[index].type);
      expect(usage.hook).toBe(resolvedBefore[index].hook);
    }

    expect(extraction.recoilDefinitions.length).toBe(defsBefore.length);
    for (const [index, def] of extraction.recoilDefinitions.entries()) {
      expect(def.name).toBe(defsBefore[index].name);
      expect(def.kind).toBe(defsBefore[index].kind);
      expect(def.file).toBe(defsBefore[index].file);
      expect(def.line).toBe(defsBefore[index].line);
    }
  });
});

/**
 * Acceptance criterion: Tool runs in under 5 seconds on the
 * press-release-editor-v3 directory.
 *
 * The impact command runs the same 3-pass pipeline as check, plus graph
 * building and BFS traversal. This test verifies the full pipeline +
 * analysis completes well within the 5-second budget.
 */
describe('acceptance: impact command runs in under 5 seconds', () => {
  it('full pipeline + graph build + atom analysis completes in under 5 seconds', () => {
    const startTime = performance.now();

    const files = globFiles(targetDir);
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);
    const graph = buildDependencyGraph(extraction, resolved);

    // Run analysis for a well-connected atom to exercise the full BFS
    const result = analyzeAtomImpact(graph, 'pressReleaseTitleState');
    expect(result).not.toBeNull();

    // Also format output (as the CLI does)
    formatImpactText([result!], targetDir);
    formatImpactJson([result!], targetDir);

    const elapsedMs = performance.now() - startTime;

    expect(elapsedMs).toBeLessThan(5000);
  });

  it('--file mode analysis for a large file completes in under 5 seconds', () => {
    const startTime = performance.now();

    const files = globFiles(targetDir);
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);
    const graph = buildDependencyGraph(extraction, resolved);

    // Analyze all atoms in states/core.ts (13+ definitions)
    const coreFilePath = path.resolve(targetDir, 'states/core.ts');
    const results = analyzeFileImpact(graph, coreFilePath, extraction);
    expect(results.length).toBeGreaterThanOrEqual(10);

    // Also format output
    formatImpactText(results, targetDir);
    formatImpactJson(results, targetDir);

    const elapsedMs = performance.now() - startTime;

    expect(elapsedMs).toBeLessThan(5000);
  });
});

/**
 * Acceptance criterion: Impact command always exits with code 0.
 *
 * Unlike the `check` command which exits 1 on violations, the `impact`
 * command always exits 0. This suite validates that all code paths in
 * the impact CLI lead to exit 0 (or print an informational message and
 * exit 0 for "not found" cases).
 */
describe('acceptance: impact command always exits with code 0', () => {
  it('--atom mode with valid atom: analysis succeeds (exit 0 path)', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'pressReleaseTitleState');

    // A valid result means the CLI would print output and exit 0
    expect(result).not.toBeNull();
    expect(result!.target.name).toBe('pressReleaseTitleState');
  });

  it('--atom mode with unknown atom: returns null (CLI prints message and exits 0)', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'nonExistentAtom');

    // Null result means the CLI prints "No Recoil definition found" and exits 0
    expect(result).toBeNull();
  });

  it('--file mode with atoms: returns results (exit 0 path)', () => {
    const {graph, extraction} = getSharedPipeline();
    const coreFilePath = path.resolve(targetDir, 'states/core.ts');
    const results = analyzeFileImpact(graph, coreFilePath, extraction);

    // Non-empty results means the CLI prints output and exits 0
    expect(results.length).toBeGreaterThan(0);
  });

  it('--file mode with no atoms: returns empty array (CLI prints message and exits 0)', () => {
    const {graph, extraction} = getSharedPipeline();
    const noAtomsFile = path.resolve(
      targetDir,
      'pages/step1/CharCounter/index.tsx',
    );
    const results = analyzeFileImpact(graph, noAtomsFile, extraction);

    // Empty results means the CLI prints "No Recoil definitions found" and exits 0
    expect(results).toHaveLength(0);
  });

  it('--git mode with changed files containing atoms: returns results (exit 0 path)', () => {
    const {graph, extraction} = getSharedPipeline();
    const changedFiles = [path.resolve(targetDir, 'states/contents.ts')];
    const results = analyzeGitImpact(graph, changedFiles, extraction);

    // Non-empty results means the CLI prints output and exits 0
    expect(results.length).toBeGreaterThan(0);
  });

  it('--git mode with no changes: returns empty array (CLI prints message and exits 0)', () => {
    const {graph, extraction} = getSharedPipeline();
    const results = analyzeGitImpact(graph, [], extraction);

    // Empty results means the CLI prints "No changed files with Recoil definitions" and exits 0
    expect(results).toHaveLength(0);
  });

  it('--git mode with changed files containing no atoms: returns empty array (exit 0 path)', () => {
    const {graph, extraction} = getSharedPipeline();
    const changedFiles = [
      path.resolve(targetDir, 'pages/step1/CharCounter/index.tsx'),
    ];
    const results = analyzeGitImpact(graph, changedFiles, extraction);

    // Empty results from component-only files -> CLI exits 0
    expect(results).toHaveLength(0);
  });

  it('impact-cli.ts only calls process.exit(0) or process.exit(1) for arg errors', () => {
    // Read the source to verify exit code patterns
    const cliSource = fs.readFileSync(
      path.resolve(__dirname, '../src/impact-cli.ts'),
      'utf8',
    );

    // Extract all process.exit() calls
    const exitCalls = [...cliSource.matchAll(/process\.exit\((\d+)\)/g)];
    expect(exitCalls.length).toBeGreaterThan(0);

    // Categorize exits
    const exitCodes = exitCalls.map((match) => Number.parseInt(match[1], 10));
    const exit0Count = exitCodes.filter((code) => code === 0).length;
    const exit1Count = exitCodes.filter((code) => code === 1).length;

    // Exit 1 should only be for argument validation errors (before pipeline runs)
    // Exit 0 should be used for all analysis paths (success, no results, etc.)
    expect(exit0Count).toBeGreaterThanOrEqual(1);

    // Verify that the final exit at the end of main() is exit(0)
    const mainFunctionMatch = /process\.exit\(0\);\s*}\s*\n\s*main\(\)/.exec(
      cliSource,
    );
    expect(mainFunctionMatch).not.toBeNull();

    // Verify exit(1) only appears in argument validation (before pipeline)
    // All exit(1) calls should be before the pipeline runs
    const lines = cliSource.split('\n');
    const pipelineStartLine = lines.findIndex((l: string) =>
      l.includes('const files = globFiles'),
    );
    expect(pipelineStartLine).toBeGreaterThan(0);

    for (
      let lineIndex = pipelineStartLine;
      lineIndex < lines.length;
      lineIndex++
    ) {
      // After pipeline starts, no exit(1) should exist
      expect(lines[lineIndex]).not.toMatch(/process\.exit\(1\)/);
    }
  });

  it('atom with no usages (Check 3 unused): impact returns result with zeros (exit 0)', () => {
    const {graph} = getSharedPipeline();
    const result = analyzeAtomImpact(graph, 'selectPurposeModalState');

    // Even an unused atom returns a valid result (not null) with zeros
    expect(result).not.toBeNull();
    expect(result!.summary.totalFiles).toBe(0);
    expect(result!.summary.totalComponents).toBe(0);
    expect(result!.summary.totalSelectors).toBe(0);
    // The CLI would format and print this, then exit 0
  });
});

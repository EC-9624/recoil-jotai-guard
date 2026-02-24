import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {runChecks} from '../src/checks.js';
import {collectUsages} from '../src/collect-usages.js';
import {extractDefinitions} from '../src/extract.js';
import {resolveUsages} from '../src/resolve.js';
import type {ExtractionResult, ResolvedUsage} from '../src/types.js';

const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');

function fixture(...names: string[]): string[] {
  return names.map((n) => path.join(fixturesDir, n));
}

function runPipeline(files: string[]) {
  const extraction = extractDefinitions(files);
  const usages = collectUsages(files, extraction);
  const resolved = resolveUsages(files, extraction, usages);
  const violations = runChecks(extraction, resolved);
  return {extraction, usages, resolved, violations};
}

describe('Check 1: Cross-System Boundary', () => {
  it('detects Jotai atom name in standalone selector body', () => {
    const {violations} = runPipeline(fixture('cross-system.ts'));
    const check1 = violations.filter((v) => v.check === 1);

    // badSelector references myJotaiAtom (Jotai atom name) and jotaiStore (Jotai import)
    expect(check1.length).toBeGreaterThanOrEqual(1);

    const myJotaiAtomViolation = check1.find(
      (v) =>
        v.atomOrSelectorName === 'badSelector' &&
        v.message.includes('myJotaiAtom'),
    );
    expect(myJotaiAtomViolation).toBeDefined();
  });

  it('detects Jotai atom name in inline default selector body', () => {
    const {violations} = runPipeline(fixture('cross-system-inline.ts'));
    const check1 = violations.filter((v) => v.check === 1);

    expect(check1.length).toBeGreaterThanOrEqual(1);

    const violation = check1.find(
      (v) => v.atomOrSelectorName === 'atomWithBadDefault',
    );
    expect(violation).toBeDefined();
    expect(violation!.message).toContain('jotaiFlag');
  });

  it('detects Jotai store import referenced in selector body', () => {
    const {violations} = runPipeline(fixture('cross-system.ts'));
    const check1 = violations.filter((v) => v.check === 1);

    const storeViolation = check1.find(
      (v) =>
        v.atomOrSelectorName === 'badSelector' &&
        v.message.includes('jotaiStore'),
    );
    expect(storeViolation).toBeDefined();
  });

  it('does NOT flag the selector own get parameter name', () => {
    const {violations} = runPipeline(fixture('recoil-basic.ts'));
    const check1 = violations.filter((v) => v.check === 1);
    // recoil-basic has selector with get({get}) => get(myAtom)
    // 'get' should not be flagged even if it matches something
    expect(check1).toHaveLength(0);
  });

  it('does NOT flag identifiers that happen to match Jotai names but are local variables', () => {
    const {violations} = runPipeline(fixture('cross-system.ts'));
    const check1 = violations.filter((v) => v.check === 1);

    // In badSelector: `const jotaiVal = jotaiStore.get(myJotaiAtom)`
    // 'jotaiVal' is a local variable -- it should NOT be flagged
    const jotaiValueViolation = check1.find((v) =>
      v.message.includes('jotaiVal'),
    );
    expect(jotaiValueViolation).toBeUndefined();
  });
});

describe('Check 2: Orphaned Atom', () => {
  it('flags atom with readers and 0 runtime setters', () => {
    // Build a scenario: atom with readers but no setters
    const filePath = path.join(fixturesDir, 'orphan-test.ts');
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        {
          name: 'orphanAtom',
          kind: 'atom',
          file: filePath,
          line: 1,
          getBodyAst: null,
          inlineDefaultGetBody: null,
        },
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      {
        atomName: 'orphanAtom',
        localName: 'orphanAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer1.tsx',
        line: 10,
        resolvedName: 'orphanAtom',
        definitionFile: filePath,
      },
      {
        atomName: 'orphanAtom',
        localName: 'orphanAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer2.tsx',
        line: 20,
        resolvedName: 'orphanAtom',
        definitionFile: filePath,
      },
      {
        atomName: 'orphanAtom',
        localName: 'orphanAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer3.tsx',
        line: 30,
        resolvedName: 'orphanAtom',
        definitionFile: filePath,
      },
    ];

    const violations = runChecks(extraction, resolvedUsages);
    const check2 = violations.filter((v) => v.check === 2);

    expect(check2).toHaveLength(1);
    expect(check2[0].atomOrSelectorName).toBe('orphanAtom');
    expect(check2[0].severity).toBe('error');
    expect(check2[0].details).toHaveLength(3);
  });

  it('does NOT flag atom with readers and 1 runtime setter', () => {
    const filePath = path.join(fixturesDir, 'not-orphan.ts');
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        {
          name: 'healthyAtom',
          kind: 'atom',
          file: filePath,
          line: 1,
          getBodyAst: null,
          inlineDefaultGetBody: null,
        },
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      {
        atomName: 'healthyAtom',
        localName: 'healthyAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer.tsx',
        line: 10,
        resolvedName: 'healthyAtom',
        definitionFile: filePath,
      },
      {
        atomName: 'healthyAtom',
        localName: 'healthyAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer2.tsx',
        line: 20,
        resolvedName: 'healthyAtom',
        definitionFile: filePath,
      },
      {
        atomName: 'healthyAtom',
        localName: 'healthyAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer3.tsx',
        line: 30,
        resolvedName: 'healthyAtom',
        definitionFile: filePath,
      },
      {
        atomName: 'healthyAtom',
        localName: 'healthyAtom',
        type: 'setter',
        hook: 'useSetRecoilState',
        file: '/setter.tsx',
        line: 15,
        resolvedName: 'healthyAtom',
        definitionFile: filePath,
      },
    ];

    const violations = runChecks(extraction, resolvedUsages);
    const check2 = violations.filter((v) => v.check === 2);
    expect(check2).toHaveLength(0);
  });

  it('does NOT count initializers as runtime setters', () => {
    const filePath = path.join(fixturesDir, 'init-only.ts');
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        {
          name: 'initOnlyAtom',
          kind: 'atom',
          file: filePath,
          line: 1,
          getBodyAst: null,
          inlineDefaultGetBody: null,
        },
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      {
        atomName: 'initOnlyAtom',
        localName: 'initOnlyAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer.tsx',
        line: 10,
        resolvedName: 'initOnlyAtom',
        definitionFile: filePath,
      },
      {
        atomName: 'initOnlyAtom',
        localName: 'initOnlyAtom',
        type: 'initializer',
        hook: 'set(initializer)',
        file: '/init.ts',
        line: 5,
        resolvedName: 'initOnlyAtom',
        definitionFile: filePath,
      },
    ];

    const violations = runChecks(extraction, resolvedUsages);
    const check2 = violations.filter((v) => v.check === 2);

    // Should be flagged as orphaned because the only setter is an initializer
    expect(check2).toHaveLength(1);
    expect(check2[0].atomOrSelectorName).toBe('initOnlyAtom');
  });

  it('includes reader locations in violation details', () => {
    const filePath = path.join(fixturesDir, 'orphan-test.ts');
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        {
          name: 'orphanAtom',
          kind: 'atom',
          file: filePath,
          line: 1,
          getBodyAst: null,
          inlineDefaultGetBody: null,
        },
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const resolvedUsages: ResolvedUsage[] = [
      {
        atomName: 'orphanAtom',
        localName: 'orphanAtom',
        type: 'reader',
        hook: 'useRecoilValue',
        file: '/consumer1.tsx',
        line: 10,
        resolvedName: 'orphanAtom',
        definitionFile: filePath,
      },
    ];

    const violations = runChecks(extraction, resolvedUsages);
    const check2 = violations.filter((v) => v.check === 2);

    expect(check2).toHaveLength(1);
    expect(check2[0].details).toHaveLength(1);
    expect(check2[0].details[0]).toContain('/consumer1.tsx:10');
  });
});

describe('Check 3: Unused Atom', () => {
  it('flags atom with 0 readers and 0 setters', () => {
    const filePath = path.join(fixturesDir, 'unused-test.ts');
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        {
          name: 'unusedAtom',
          kind: 'atom',
          file: filePath,
          line: 1,
          getBodyAst: null,
          inlineDefaultGetBody: null,
        },
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const violations = runChecks(extraction, []);
    const check3 = violations.filter((v) => v.check === 3);

    expect(check3).toHaveLength(1);
    expect(check3[0].atomOrSelectorName).toBe('unusedAtom');
  });

  it('does NOT flag atom that is a selector dependency (inline default)', () => {
    // Use inline-default-selector.ts which has someOtherAtom read in a selector body
    const files = fixture('inline-default-selector.ts');
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);
    const violations = runChecks(extraction, resolved);

    const check3 = violations.filter((v) => v.check === 3);
    // someOtherAtom and initListAtom are read in selector get() bodies
    // so they should NOT be flagged as unused
    const someOtherAtomUnused = check3.find(
      (v) => v.atomOrSelectorName === 'someOtherAtom',
    );
    expect(someOtherAtomUnused).toBeUndefined();

    const initListUnused = check3.find(
      (v) => v.atomOrSelectorName === 'initListAtom',
    );
    expect(initListUnused).toBeUndefined();
  });

  it('does NOT flag atom only read inside standalone selector get() body', () => {
    // recoil-basic.ts: mySelector reads myAtom via get(myAtom)
    const files = fixture('recoil-basic.ts');
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);
    const violations = runChecks(extraction, resolved);

    const check3 = violations.filter((v) => v.check === 3);
    const myAtomUnused = check3.find((v) => v.atomOrSelectorName === 'myAtom');
    expect(myAtomUnused).toBeUndefined();
  });

  it('emits as warning (not error)', () => {
    const filePath = path.join(fixturesDir, 'unused-test.ts');
    const extraction: ExtractionResult = {
      recoilDefinitions: [
        {
          name: 'unusedAtom',
          kind: 'atom',
          file: filePath,
          line: 1,
          getBodyAst: null,
          inlineDefaultGetBody: null,
        },
      ],
      jotaiDefinitions: [],
      jotaiImports: [],
    };

    const violations = runChecks(extraction, []);
    const check3 = violations.filter((v) => v.check === 3);

    expect(check3).toHaveLength(1);
    expect(check3[0].severity).toBe('warning');
  });
});

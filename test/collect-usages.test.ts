import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {collectUsages} from '../src/collect-usages.js';
import {extractDefinitions} from '../src/extract.js';
import type {ExtractionResult} from '../src/types.js';

const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');

function fixture(...names: string[]): string[] {
  return names.map((n) => path.join(fixturesDir, n));
}

/** Empty extraction result for tests that don't need it. */
function emptyExtraction(): ExtractionResult {
  return {
    recoilDefinitions: [],
    jotaiDefinitions: [],
    jotaiImports: [],
  };
}

describe('collectUsages', () => {
  it('counts correct number of readers/setters per atom', () => {
    const files = fixture('hook-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const myAtomUsages = result.usages.filter((u) => u.atomName === 'myAtom');
    const readers = myAtomUsages.filter((u) => u.type === 'reader');
    const setters = myAtomUsages.filter((u) => u.type === 'setter');

    // useRecoilValue -> 1 reader
    // useSetRecoilState -> 1 setter
    // useRecoilState -> 1 reader + 1 setter
    // useResetRecoilState -> 1 setter
    expect(readers).toHaveLength(2);
    expect(setters).toHaveLength(3);
  });

  it('useRecoilState emits both a reader and a setter', () => {
    const files = fixture('hook-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const recoilStateUsages = result.usages.filter(
      (u) => u.hook === 'useRecoilState',
    );
    expect(recoilStateUsages).toHaveLength(2);

    const types = recoilStateUsages.map((u) => u.type).sort();
    expect(types).toEqual(['reader', 'setter']);
  });

  it('useRecoilCallback set() classified as setter', () => {
    const files = fixture('callback-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const setUsages = result.usages.filter(
      (u) => u.hook === 'set(callback)' && u.type === 'setter',
    );
    // Style A: set(myAtom, 'new') -- 1
    // Style B: set(otherAtom, val) -- 1
    expect(setUsages).toHaveLength(2);
  });

  it('useRecoilCallback getPromise() via inline nested destructuring classified as reader', () => {
    const files = fixture('callback-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const getPromiseUsages = result.usages.filter(
      (u) =>
        u.hook === 'getPromise(callback)' &&
        u.type === 'reader' &&
        u.atomName === 'myAtom',
    );
    // Style A: getPromise(myAtom) -- 1
    expect(getPromiseUsages).toHaveLength(1);
  });

  it('useRecoilCallback snapshot.getPromise() via variable reference classified as reader', () => {
    const files = fixture('callback-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const snapshotGetPromiseUsages = result.usages.filter(
      (u) =>
        u.hook === 'getPromise(callback)' &&
        u.type === 'reader' &&
        u.atomName === 'otherAtom',
    );
    // Style B: snapshot.getPromise(otherAtom) -- 1
    expect(snapshotGetPromiseUsages).toHaveLength(1);
  });

  it('initialize* function set() classified as initializer (not runtime setter)', () => {
    const files = fixture('initializer.ts');
    const result = collectUsages(files, emptyExtraction());

    const initializerUsages = result.usages.filter(
      (u) => u.type === 'initializer',
    );
    expect(initializerUsages).toHaveLength(1);
    expect(initializerUsages[0].atomName).toBe('myAtom');
  });

  it('atomFamily variant useRecoilValue(myFamily(id)) resolved to family name', () => {
    const files = fixture('hook-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const familyUsages = result.usages.filter((u) => u.atomName === 'myFamily');
    expect(familyUsages).toHaveLength(1);
    expect(familyUsages[0].type).toBe('reader');
    expect(familyUsages[0].hook).toBe('useRecoilValue');
  });

  it('get(X) calls inside inlineDefaultGetBody counted as readers', () => {
    const files = fixture('inline-default-selector.ts');
    const extraction = extractDefinitions(files);
    const result = collectUsages(files, extraction);

    // The inline default selector bodies read someOtherAtom and initListAtom via get()
    const selectorReaders = result.usages.filter(
      (u) => u.hook === 'get(selector)',
    );
    expect(selectorReaders.length).toBeGreaterThanOrEqual(2);

    // Check that someOtherAtom is read from the inline default of myAtomWithDefault
    const someOtherAtomReaders = selectorReaders.filter(
      (u) => u.atomName === 'someOtherAtom',
    );
    expect(someOtherAtomReaders).toHaveLength(1);

    // Check that initListAtom is read from the inline default of myFamilyWithDefault
    const initListReaders = selectorReaders.filter(
      (u) => u.atomName === 'initListAtom',
    );
    expect(initListReaders).toHaveLength(1);
  });

  it('reset() inside useRecoilCallback classified as setter', () => {
    const files = fixture('callback-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    const resetUsages = result.usages.filter(
      (u) => u.hook === 'reset(callback)' && u.type === 'setter',
    );
    // cb3: reset(myAtom) -- 1
    expect(resetUsages).toHaveLength(1);
    expect(resetUsages[0].atomName).toBe('myAtom');
  });

  it('get(X) calls inside standalone selector get() body counted as readers', () => {
    const files = fixture('recoil-basic.ts');
    const extraction = extractDefinitions(files);
    const result = collectUsages(files, extraction);

    // mySelector has get: ({get}) => get(myAtom)
    const selectorReaders = result.usages.filter(
      (u) => u.hook === 'get(selector)' && u.atomName === 'myAtom',
    );
    expect(selectorReaders).toHaveLength(1);
  });

  it('standalone selector get() usage has enclosingDefinition set to selector name', () => {
    const files = fixture('recoil-basic.ts');
    const extraction = extractDefinitions(files);
    const result = collectUsages(files, extraction);

    // mySelector reads myAtom via get(myAtom) -> enclosingDefinition should be 'mySelector'
    const selectorReaders = result.usages.filter(
      (u) => u.hook === 'get(selector)' && u.atomName === 'myAtom',
    );
    expect(selectorReaders).toHaveLength(1);
    expect(selectorReaders[0].enclosingDefinition).toBe('mySelector');
  });

  it('inline default selector get() usage has enclosingDefinition set to parent atom name', () => {
    const files = fixture('inline-default-selector.ts');
    const extraction = extractDefinitions(files);
    const result = collectUsages(files, extraction);

    // myAtomWithDefault has inline default: selector({ get({get}) { return get(someOtherAtom) } })
    // enclosingDefinition should be 'myAtomWithDefault' (the parent atom name)
    const someOtherAtomReaders = result.usages.filter(
      (u) => u.hook === 'get(selector)' && u.atomName === 'someOtherAtom',
    );
    expect(someOtherAtomReaders).toHaveLength(1);
    expect(someOtherAtomReaders[0].enclosingDefinition).toBe(
      'myAtomWithDefault',
    );

    // myFamilyWithDefault has inline default: selectorFamily({ get: (id) => ({get}) => get(initListAtom)... })
    // enclosingDefinition should be 'myFamilyWithDefault' (the parent atomFamily name)
    const initListReaders = result.usages.filter(
      (u) => u.hook === 'get(selector)' && u.atomName === 'initListAtom',
    );
    expect(initListReaders).toHaveLength(1);
    expect(initListReaders[0].enclosingDefinition).toBe('myFamilyWithDefault');
  });

  it('hook-based usages do not have enclosingDefinition set', () => {
    const files = fixture('hook-usages.tsx');
    const result = collectUsages(files, emptyExtraction());

    // All hook-based usages should have enclosingDefinition as undefined
    for (const usage of result.usages) {
      expect(usage.enclosingDefinition).toBeUndefined();
    }
  });
});

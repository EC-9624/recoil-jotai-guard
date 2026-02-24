import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {collectRuntimeWriteCallsites} from '../src/setter-callsites.js';
import {buildSetterBindings} from '../src/setter-bindings.js';
import type {ExtractionResult, SetterBindingMap} from '../src/types.js';

const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');
const wrapperDir = path.resolve(fixturesDir, 'wrapper-hooks');

function fixture(...names: string[]): string[] {
  return names.map((n) => path.join(wrapperDir, n));
}

function emptyExtraction(): ExtractionResult {
  return {
    recoilDefinitions: [],
    jotaiDefinitions: [],
    jotaiImports: [],
  };
}

describe('collectRuntimeWriteCallsites', () => {
  it('Direct setter invocation detected', () => {
    const files = fixture('direct-hook.tsx');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const callsites = collectRuntimeWriteCallsites(files, setterBindings);

    // direct-hook.tsx has: setFoo('direct'), setBar(42), resetFoo()
    const fooCallsites = callsites.filter(
      (c) => c.calleeName === 'setFoo' && c.atomName === 'fooState',
    );
    expect(fooCallsites.length).toBe(1);
    expect(fooCallsites[0].file).toContain('direct-hook.tsx');
    expect(fooCallsites[0].line).toBeGreaterThan(0);
  });

  it('Non-setter call ignored', () => {
    const files = fixture('non-hook.ts');
    const setterBindings: SetterBindingMap = new Map();

    const callsites = collectRuntimeWriteCallsites(files, setterBindings);
    expect(callsites.length).toBe(0);
  });

  it('Multiple callsites for same setter', () => {
    // consumer.tsx has DirectConsumer with setFoo('hello') and TupleConsumer with setFoo('world')
    const files = fixture(
      'wrapper-arrow.ts',
      'wrapper-tuple.ts',
      'consumer.tsx',
    );
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const callsites = collectRuntimeWriteCallsites(files, setterBindings);

    // Both DirectConsumer and TupleConsumer call setFoo
    const consumerFile = fixture('consumer.tsx')[0];
    const consumerCallsites = callsites.filter((c) => c.file === consumerFile);
    expect(consumerCallsites.length).toBe(2);

    // One from DirectConsumer (setFoo('hello')), one from TupleConsumer (setFoo('world'))
    const fooCallsites = consumerCallsites.filter(
      (c) => c.atomName === 'fooState',
    );
    expect(fooCallsites.length).toBe(2);
  });

  it('Tuple-destructured setter callsite', () => {
    // consumer.tsx has both DirectConsumer (useSetFoo from wrapper-arrow)
    // and TupleConsumer (useFoo from wrapper-tuple). Both bind `setFoo`.
    // Since "file:setFoo" is a single key, the second binding overwrites
    // the first -- but both resolve to fooState anyway.
    // Include both wrappers so both resolve correctly.
    const files = fixture(
      'wrapper-arrow.ts',
      'wrapper-tuple.ts',
      'consumer.tsx',
    );
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const callsites = collectRuntimeWriteCallsites(files, setterBindings);
    const consumerFile = fixture('consumer.tsx')[0];

    // Both setFoo('hello') and setFoo('world') are detected
    const tupleCallsites = callsites.filter(
      (c) =>
        c.file === consumerFile &&
        c.calleeName === 'setFoo' &&
        c.atomName === 'fooState',
    );
    expect(tupleCallsites.length).toBe(2);

    // Verify at least one comes from the tuple consumer section
    const lines = tupleCallsites.map((c) => c.line);
    expect(lines.length).toBe(2);
    // Both should have different lines (setFoo('hello') vs setFoo('world'))
    expect(lines[0]).not.toBe(lines[1]);
  });
});

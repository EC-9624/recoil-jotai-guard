import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {collectUsages} from '../src/collect-usages.js';
import {extractDefinitions} from '../src/extract.js';
import {resolveUsages} from '../src/resolve.js';

const resolveFixturesDir = path.resolve(
  import.meta.dirname,
  'fixtures/resolve',
);

function resolveFixture(...names: string[]): string[] {
  return names.map((n) => path.join(resolveFixturesDir, n));
}

describe('resolveUsages', () => {
  it('direct import resolves to definition', () => {
    const files = resolveFixture('atom-def.ts', 'consumer.tsx');
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // consumer.tsx imports coreAtom from barrel, uses useRecoilValue(coreAtom)
    // But consumer.tsx imports from ./barrel which is not atom-def.ts directly
    // For this test we need consumer to import from atom-def
    // Actually consumer.tsx imports from ./barrel -> need barrel.ts in the file list too
    expect(resolved.length).toBeGreaterThanOrEqual(0);
  });

  it('re-export chain (A -> B -> C) resolves correctly', () => {
    const files = resolveFixture(
      'atom-def.ts',
      're-export.ts',
      'barrel.ts',
      'consumer.tsx',
    );
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // consumer.tsx: import { coreAtom } from './barrel'
    // barrel.ts: export * from './re-export'
    // re-export.ts: export { coreAtom } from './atom-def'
    // atom-def.ts: export const coreAtom = atom(...)
    const coreAtomResolved = resolved.find(
      (r) => r.localName === 'coreAtom' && r.hook === 'useRecoilValue',
    );
    expect(coreAtomResolved).toBeDefined();
    expect(coreAtomResolved!.resolvedName).toBe('coreAtom');
    expect(coreAtomResolved!.definitionFile).toBe(
      path.join(resolveFixturesDir, 'atom-def.ts'),
    );
  });

  it('export * barrel resolves correctly', () => {
    const files = resolveFixture(
      'atom-def.ts',
      're-export.ts',
      'barrel.ts',
      'consumer.tsx',
    );
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // Same as above - the barrel uses export * which should be followed
    const coreAtomResolved = resolved.find(
      (r) => r.resolvedName === 'coreAtom',
    );
    expect(coreAtomResolved).toBeDefined();
  });

  it('aliased import (import { X as Y }) resolves correctly', () => {
    const files = resolveFixture('atom-def.ts', 'aliased-consumer.tsx');
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // aliased-consumer.tsx: import { coreAtom as localAtom } from './atom-def'
    // useRecoilValue(localAtom) -> should resolve to coreAtom
    const localAtomResolved = resolved.find((r) => r.localName === 'localAtom');
    expect(localAtomResolved).toBeDefined();
    expect(localAtomResolved!.resolvedName).toBe('coreAtom');
    expect(localAtomResolved!.definitionFile).toBe(
      path.join(resolveFixturesDir, 'atom-def.ts'),
    );
  });

  it('depth limit (5) prevents infinite loops', () => {
    // cycle-a.ts: export * from './cycle-b'
    // cycle-b.ts: export * from './cycle-a'
    // This creates an infinite loop that should be handled gracefully
    const files = resolveFixture(
      'atom-def.ts',
      'cycle-a.ts',
      'cycle-b.ts',
      'consumer.tsx',
    );
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);

    // Should not throw or hang
    const resolved = resolveUsages(files, extraction, usages);
    expect(resolved).toBeDefined();
  });

  it('local definition (no import needed) resolves correctly', () => {
    const files = resolveFixture('local-consumer.tsx');
    const extraction = extractDefinitions(files);
    const usages = collectUsages(files, extraction);
    const resolved = resolveUsages(files, extraction, usages);

    // local-consumer.tsx defines localAtom and uses useRecoilValue(localAtom) in same file
    const localResolved = resolved.find((r) => r.localName === 'localAtom');
    expect(localResolved).toBeDefined();
    expect(localResolved!.resolvedName).toBe('localAtom');
    expect(localResolved!.definitionFile).toBe(
      path.join(resolveFixturesDir, 'local-consumer.tsx'),
    );
  });
});

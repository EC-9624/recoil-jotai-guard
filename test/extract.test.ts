import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {extractDefinitions} from '../src/extract.js';

const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');

function fixture(...names: string[]): string[] {
  return names.map((n) => path.join(fixturesDir, n));
}

describe('extractDefinitions', () => {
  it('extracts correct count of atoms/selectors from fixture files', () => {
    const result = extractDefinitions(fixture('recoil-basic.ts'));
    expect(result.recoilDefinitions).toHaveLength(2);

    const atomDef = result.recoilDefinitions.find((d) => d.name === 'myAtom');
    expect(atomDef).toBeDefined();
    expect(atomDef!.kind).toBe('atom');

    const selectorDef = result.recoilDefinitions.find(
      (d) => d.name === 'mySelector',
    );
    expect(selectorDef).toBeDefined();
    expect(selectorDef!.kind).toBe('selector');
  });

  it('captures selector get() body AST (non-null)', () => {
    const result = extractDefinitions(fixture('recoil-basic.ts'));
    const selectorDef = result.recoilDefinitions.find(
      (d) => d.name === 'mySelector',
    );
    expect(selectorDef).toBeDefined();
    expect(selectorDef!.getBodyAst).not.toBeNull();
  });

  it('captures inlineDefaultGetBody for atom({ default: selector() })', () => {
    const result = extractDefinitions(fixture('inline-default-selector.ts'));
    const atomDef = result.recoilDefinitions.find(
      (d) => d.name === 'myAtomWithDefault',
    );
    expect(atomDef).toBeDefined();
    expect(atomDef!.kind).toBe('atom');
    expect(atomDef!.inlineDefaultGetBody).not.toBeNull();
  });

  it('captures inlineDefaultGetBody for atomFamily({ default: selectorFamily() })', () => {
    const result = extractDefinitions(fixture('inline-default-selector.ts'));
    const familyDef = result.recoilDefinitions.find(
      (d) => d.name === 'myFamilyWithDefault',
    );
    expect(familyDef).toBeDefined();
    expect(familyDef!.kind).toBe('atomFamily');
    expect(familyDef!.inlineDefaultGetBody).not.toBeNull();
  });

  it('does NOT create a separate RecoilDefinition for the inline selector', () => {
    const result = extractDefinitions(fixture('inline-default-selector.ts'));
    // Should have: someOtherAtom, initListAtom, myAtomWithDefault, myFamilyWithDefault
    // Should NOT have a separate definition for the inline selectors
    const names = result.recoilDefinitions.map((d) => d.name);
    expect(names).toContain('someOtherAtom');
    expect(names).toContain('initListAtom');
    expect(names).toContain('myAtomWithDefault');
    expect(names).toContain('myFamilyWithDefault');
    expect(result.recoilDefinitions).toHaveLength(4);
  });

  it('handles aliased imports', () => {
    const result = extractDefinitions(fixture('aliased-imports.ts'));
    expect(result.recoilDefinitions).toHaveLength(1);
    expect(result.recoilDefinitions[0].name).toBe('myAtom');
    expect(result.recoilDefinitions[0].kind).toBe('atom');
  });

  it('detects Jotai imports with correct source paths', () => {
    const result = extractDefinitions(fixture('jotai-basic.ts'));
    expect(result.jotaiImports).toHaveLength(1);
    expect(result.jotaiImports[0].localName).toBe('atom');
    expect(result.jotaiImports[0].importedName).toBe('atom');
    expect(result.jotaiImports[0].source).toBe('jotai');
  });

  it('detects Jotai atom definitions', () => {
    const result = extractDefinitions(fixture('jotai-basic.ts'));
    expect(result.jotaiDefinitions).toHaveLength(1);
    expect(result.jotaiDefinitions[0].name).toBe('myJotaiAtom');
  });

  it('skips type-only imports from jotai', () => {
    const result = extractDefinitions(fixture('jotai-type-only.ts'));
    expect(result.jotaiImports).toHaveLength(0);
  });

  it('ignores non-state CallExpression nodes', () => {
    const result = extractDefinitions(fixture('non-state-calls.ts'));
    expect(result.recoilDefinitions).toHaveLength(0);
    expect(result.jotaiDefinitions).toHaveLength(0);
  });
});

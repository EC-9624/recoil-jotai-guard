import * as path from 'node:path';
import * as fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {parseSync} from 'oxc-parser';
import {walk} from 'oxc-walker';
import {
  buildSetterBindings,
  resolveDirectHookWriteBinding,
  resolveCalleeToFunctionDefinition,
  analyzeWrapperReturnExpression,
  resolveHookWriteBinding,
  bindSetterIdentifiers,
} from '../src/setter-bindings.js';
import {extractDefinitions} from '../src/extract.js';
import type {ExtractionResult, HookWriteBinding} from '../src/types.js';

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

/**
 * Helper: parse a fixture file and get hook aliases + first VariableDeclarator
 * with a CallExpression init.
 */
function parseFixtureForCallExprs(filePath: string) {
  const source = fs.readFileSync(filePath, 'utf8');
  const ast = parseSync(filePath, source, {
    sourceType: 'module',
    lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
  });

  // Collect hook aliases
  const hookAliases = new Map<string, string>();
  const allSetterHooks = new Set([
    'useSetRecoilState',
    'useResetRecoilState',
    'useRecoilState',
  ]);

  const callExprs: any[] = [];
  const declarators: any[] = [];

  walk(ast.program, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as any;
        if (importNode.source?.value !== 'recoil') {
          return;
        }

        const specifiers = importNode.specifiers as any[] | undefined;
        if (!specifiers) {
          return;
        }

        for (const spec of specifiers) {
          if (spec.type !== 'ImportSpecifier') {
            continue;
          }

          const imported = spec.imported?.name as string | undefined;
          const local = spec.local?.name as string | undefined;
          if (imported && local && allSetterHooks.has(imported)) {
            hookAliases.set(local, imported);
          }
        }

        return;
      }

      if (
        node.type === 'VariableDeclarator' &&
        (node as any).init?.type === 'CallExpression'
      ) {
        declarators.push(node);
        callExprs.push((node as any).init);
      }
    },
  });

  return {hookAliases, callExprs, declarators, ast: ast.program, source};
}

describe('resolveDirectHookWriteBinding', () => {
  it('Direct useSetRecoilState binding: simple identifier', () => {
    const filePath = fixture('direct-hook.tsx')[0];
    const {hookAliases, callExprs} = parseFixtureForCallExprs(filePath);

    // First call expr: useSetRecoilState(fooState)
    const binding = resolveDirectHookWriteBinding(callExprs[0], hookAliases);
    expect(binding).toBeDefined();
    expect(binding!.kind).toBe('setter');
    expect(binding!.stateId).toBe('fooState');
  });

  it('Direct useRecoilState binding: tuple destructuring', () => {
    const filePath = fixture('direct-hook.tsx')[0];
    const {hookAliases, callExprs} = parseFixtureForCallExprs(filePath);

    // Second call expr: useRecoilState(barState)
    const binding = resolveDirectHookWriteBinding(callExprs[1], hookAliases);
    expect(binding).toBeDefined();
    expect(binding!.kind).toBe('tuple');
    expect(binding!.stateId).toBe('barState');
  });

  it('Direct useResetRecoilState binding', () => {
    const filePath = fixture('direct-hook.tsx')[0];
    const {hookAliases, callExprs} = parseFixtureForCallExprs(filePath);

    // Third call expr: useResetRecoilState(fooState)
    const binding = resolveDirectHookWriteBinding(callExprs[2], hookAliases);
    expect(binding).toBeDefined();
    expect(binding!.kind).toBe('setter');
    expect(binding!.stateId).toBe('fooState');
  });

  it('Non-hook function returns undefined', () => {
    const filePath = fixture('non-hook.ts')[0];
    const {hookAliases, callExprs} = parseFixtureForCallExprs(filePath);

    // someUtilityFunction() -- not a hook
    if (callExprs.length > 0) {
      const binding = resolveDirectHookWriteBinding(callExprs[0], hookAliases);
      expect(binding).toBeUndefined();
    }
  });
});

describe('resolveCalleeToFunctionDefinition', () => {
  it('resolves arrow shorthand wrapper in another file', () => {
    const consumerFile = fixture('consumer.tsx')[0];
    const result = resolveCalleeToFunctionDefinition('useSetFoo', consumerFile);
    expect(result).toBeDefined();
    expect(result!.file).toContain('wrapper-arrow.ts');
    expect(result!.isArrowShorthand).toBe(true);
  });

  it('resolves return statement wrapper in another file', () => {
    const wrapperReturnFile = fixture('wrapper-return.ts')[0];
    // useSetFoo is defined in the same file (wrapper-return.ts)
    const result = resolveCalleeToFunctionDefinition(
      'useSetFoo',
      wrapperReturnFile,
    );
    expect(result).toBeDefined();
    expect(result!.file).toContain('wrapper-return.ts');
    expect(result!.isArrowShorthand).toBe(false);
  });

  it('returns undefined for non-existent function', () => {
    const consumerFile = fixture('consumer.tsx')[0];
    const result = resolveCalleeToFunctionDefinition(
      'nonExistentHook',
      consumerFile,
    );
    expect(result).toBeUndefined();
  });
});

describe('analyzeWrapperReturnExpression', () => {
  it('resolves arrow shorthand wrapper (Pattern W1)', () => {
    const wrapperFile = fixture('wrapper-arrow.ts')[0];
    const funcDef = resolveCalleeToFunctionDefinition('useSetFoo', wrapperFile);
    expect(funcDef).toBeDefined();

    const binding = analyzeWrapperReturnExpression(funcDef!);
    expect(binding).toBeDefined();
    expect(binding!.kind).toBe('setter');
    expect(binding!.stateId).toBe('fooState');
  });

  it('resolves return statement wrapper (Pattern W2)', () => {
    const wrapperFile = fixture('wrapper-return.ts')[0];
    const funcDef = resolveCalleeToFunctionDefinition('useSetFoo', wrapperFile);
    expect(funcDef).toBeDefined();

    const binding = analyzeWrapperReturnExpression(funcDef!);
    expect(binding).toBeDefined();
    expect(binding!.kind).toBe('setter');
    expect(binding!.stateId).toBe('fooState');
  });

  it('resolves tuple wrapper (Pattern W4)', () => {
    const wrapperFile = fixture('wrapper-tuple.ts')[0];
    const funcDef = resolveCalleeToFunctionDefinition('useFoo', wrapperFile);
    expect(funcDef).toBeDefined();

    const binding = analyzeWrapperReturnExpression(funcDef!);
    expect(binding).toBeDefined();
    expect(binding!.kind).toBe('tuple');
    expect(binding!.stateId).toBe('fooState');
  });

  it('returns undefined for non-hook wrapper', () => {
    const nonHookFile = fixture('non-hook.ts')[0];
    const funcDef = resolveCalleeToFunctionDefinition(
      'someUtilityFunction',
      nonHookFile,
    );
    expect(funcDef).toBeDefined();

    const binding = analyzeWrapperReturnExpression(funcDef!);
    expect(binding).toBeUndefined();
  });
});

describe('buildSetterBindings', () => {
  it('Direct useSetRecoilState binding: simple identifier', () => {
    const files = fixture('direct-hook.tsx');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const directHookFile = files[0];
    expect(setterBindings.get(`${directHookFile}:setFoo`)).toBe('fooState');
  });

  it('Direct useRecoilState binding: tuple destructuring', () => {
    const files = fixture('direct-hook.tsx');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const directHookFile = files[0];
    expect(setterBindings.get(`${directHookFile}:setBar`)).toBe('barState');
  });

  it('Arrow shorthand wrapper (Pattern W1)', () => {
    const files = fixture('wrapper-arrow.ts', 'consumer.tsx');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const consumerFile = files[1];
    expect(setterBindings.get(`${consumerFile}:setFoo`)).toBe('fooState');
  });

  it('Return statement wrapper (Pattern W2)', () => {
    // Need consumer that imports from wrapper-return
    const consumerPath = path.join(wrapperDir, 'consumer-return.tsx');
    // Create a temporary consumer file for wrapper-return
    fs.writeFileSync(
      consumerPath,
      `import {useSetFoo} from './wrapper-return';
export function Comp() {
  const setFoo = useSetFoo();
  setFoo('hello');
  return null;
}
`,
    );
    try {
      const files = [path.join(wrapperDir, 'wrapper-return.ts'), consumerPath];
      const {setterBindings} = buildSetterBindings(files, emptyExtraction());
      expect(setterBindings.get(`${consumerPath}:setFoo`)).toBe('fooState');
    } finally {
      fs.unlinkSync(consumerPath);
    }
  });

  it('Tuple wrapper (Pattern W4)', () => {
    const files = fixture('wrapper-tuple.ts', 'consumer.tsx');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const consumerFile = files[1];
    expect(setterBindings.get(`${consumerFile}:setFoo`)).toBe('fooState');
  });

  it('Non-hook function returns undefined', () => {
    const files = fixture('non-hook.ts');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    expect(setterBindings.size).toBe(0);
  });

  it('Direct useResetRecoilState binding', () => {
    const files = fixture('direct-hook.tsx');
    const {setterBindings} = buildSetterBindings(files, emptyExtraction());

    const directHookFile = files[0];
    expect(setterBindings.get(`${directHookFile}:resetFoo`)).toBe('fooState');
  });

  it('Cache prevents duplicate analysis', () => {
    // Create two consumer files that both import from the same wrapper
    const consumer1Path = path.join(wrapperDir, 'consumer1-tmp.tsx');
    const consumer2Path = path.join(wrapperDir, 'consumer2-tmp.tsx');
    fs.writeFileSync(
      consumer1Path,
      `import {useSetFoo} from './wrapper-arrow';
export function Comp1() {
  const setFoo = useSetFoo();
  setFoo('a');
  return null;
}
`,
    );
    fs.writeFileSync(
      consumer2Path,
      `import {useSetFoo} from './wrapper-arrow';
export function Comp2() {
  const setFoo = useSetFoo();
  setFoo('b');
  return null;
}
`,
    );
    try {
      const files = [
        path.join(wrapperDir, 'wrapper-arrow.ts'),
        consumer1Path,
        consumer2Path,
      ];
      const {setterBindings} = buildSetterBindings(files, emptyExtraction());

      // Both consumers should have their setter bound
      expect(setterBindings.get(`${consumer1Path}:setFoo`)).toBe('fooState');
      expect(setterBindings.get(`${consumer2Path}:setFoo`)).toBe('fooState');
    } finally {
      fs.unlinkSync(consumer1Path);
      fs.unlinkSync(consumer2Path);
    }
  });
});

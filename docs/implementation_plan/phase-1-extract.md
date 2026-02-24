# Phase 1: Definition Extraction (`extract.ts`)

**Duration**: 0.5 day
**Depends on**: Phase 0
**Blocks**: Phase 2, Phase 3

## Goal

Parse all files with `oxc-walker` to collect every Recoil and Jotai state definition, including inline default selectors.

## Tasks

- [x] **Recoil import alias tracking**
  - Detect `import { atom, selector, atomFamily, selectorFamily } from 'recoil'`
  - Handle aliased imports (`import { atom as myAtom }`)
  - Store local alias mapping: `localNames[importedName] = localName`

- [x] **Recoil definition extraction**

  For each `CallExpression` where the callee matches a tracked Recoil alias and the parent is a `VariableDeclarator`:

  | Call               | Record as                | Capture                        |
  | ------------------ | ------------------------ | ------------------------------ |
  | `atom()`           | `kind: 'atom'`           | name, file, line               |
  | `selector()`       | `kind: 'selector'`       | name, file, line, `getBodyAst` |
  | `atomFamily()`     | `kind: 'atomFamily'`     | name, file, line               |
  | `selectorFamily()` | `kind: 'selectorFamily'` | name, file, line, `getBodyAst` |

  **Selector `get()` body capture** -- see [spec.md section 1.2](../spec.md#12-extractts----pass-1-definition-extraction) for full AST patterns.

- [x] **Inline default selector extraction**

  For `atom()` and `atomFamily()` definitions, inspect the `default` property:

  **Sub-pattern A**: `atom({ default: selector({ get({get}) { ... } }) })`
  - 3 instances: `core.ts`, `files.ts`, `images.ts`
  - Capture the `get()` function body as `inlineDefaultGetBody`

  **Sub-pattern B**: `atomFamily({ default: selectorFamily({ get: (id) => ({get}) => ... }) })`
  - 4 instances: all in `images.ts`
  - Navigate through the outer arrow function (param) to the inner arrow function (`{get}`)
  - Capture the inner function body as `inlineDefaultGetBody`

  The inline selector is NOT recorded as a separate `RecoilDefinition` -- only stored on the parent atom.

- [x] **Jotai import tracking**

  Detect imports where the source matches any of:
  - `'jotai'`
  - Starts with `'jotai/'`
  - Contains `'/jotai/'`

  **Skip type-only imports** to prevent false positives in Check 1:
  - Skip entire `import type {...} from 'jotai'` (`ImportDeclaration.importKind === 'type'`)
  - Skip individual `import { type Foo } from 'jotai'` (`ImportSpecifier.importKind === 'type'`)

  Record each non-type specifier as a `JotaiImport { localName, importedName, source, file }`.

- [x] **Jotai definition extraction**

  Track atoms from:
  - `import { atom } from 'jotai'`
  - `import { atomFamily, atomWithDefault, atomWithReset, atomWithStorage } from 'jotai/utils'`

  Same `CallExpression` + `VariableDeclarator` pattern as Recoil.

## Test Fixtures

```typescript
// test/fixtures/recoil-basic.ts
import { atom, selector } from 'recoil';
export const myAtom = atom({ key: 'myAtom', default: '' });
export const mySelector = selector({
  key: 'mySelector',
  get: ({ get }) => get(myAtom),
});

// test/fixtures/jotai-basic.ts
import { atom } from 'jotai';
export const myJotaiAtom = atom('');

// test/fixtures/aliased-imports.ts
import { atom as recoilAtom } from 'recoil';
export const myAtom = recoilAtom({ key: 'x', default: 0 });

// test/fixtures/inline-default-selector.ts
import { atom, selector, atomFamily, selectorFamily } from 'recoil';

export const myAtomWithDefault = atom({
  key: 'myAtomWithDefault',
  default: selector({
    key: 'myAtomWithDefault/default',
    get({ get }) {
      return get(someOtherAtom);
    },
  }),
});

export const myFamilyWithDefault = atomFamily({
  key: 'myFamilyWithDefault',
  default: selectorFamily({
    key: 'myFamilyWithDefault/default',
    get:
      (id) =>
      ({ get }) => {
        return get(initListAtom).find((item) => item.id === id);
      },
  }),
});
```

## Tests

- [x] Extracts correct count of atoms/selectors from fixture files
- [x] Captures selector `get()` body AST (non-null)
- [x] Captures `inlineDefaultGetBody` for `atom({ default: selector() })` (non-null)
- [x] Captures `inlineDefaultGetBody` for `atomFamily({ default: selectorFamily() })` (non-null)
- [x] Does NOT create a separate RecoilDefinition for the inline selector
- [x] Handles aliased imports
- [x] Detects Jotai imports with correct source paths
- [x] Ignores non-state `CallExpression` nodes

## Verification

Run against real codebase:

```bash
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
# Should print: Found X Recoil atoms, Y selectors, Z Jotai atoms
```

Compare counts against the known inventory:

- Expected: ~57 Recoil atoms, ~20 selectors, ~6 atomFamilies, ~10 selectorFamilies, ~29 Jotai atoms
- Expected: 7 definitions with non-null `inlineDefaultGetBody`

# Phase 2: Usage Collection (`collect-usages.ts`)

**Duration**: 1.5 days
**Depends on**: Phase 1 (needs extraction results for inline default body walking)
**Blocks**: Phase 4 (with Phase 3)

## Goal

Scan all files for Recoil hook calls and `set`/`get`/`reset` calls. Build a complete map of readers, setters, and initializers for every atom.

## Tasks

### Simple hook patterns

- [x] `useRecoilValue(X)` -- reader (direct atom reference)
- [x] `useRecoilValue(atomFamily(id))` -- reader (`X` is a `CallExpression` whose callee is the family name)
- [x] `useSetRecoilState(X)` -- setter (same atom/atomFamily handling)
- [x] `useRecoilState(X)` -- reader + setter (emit two usages)
- [x] `useResetRecoilState(X)` -- setter
- [x] Track Recoil hook import aliases (`import { useRecoilValue as useRV }` etc.)

### `useRecoilCallback` patterns

- [x] **Detect `useRecoilCallback(callbackFn)` calls**

- [x] **Parse callback destructured parameter -- two styles:**

  **Style A: Inline nested destructuring** (~25 instances in codebase)

  ```typescript
  useRecoilCallback(({set, snapshot: {getPromise}}) => async () => { ... })
  ```

  AST: The `snapshot` property's value is an `ObjectPattern` (nested destructuring), not an `Identifier`. Extract `getPromise` alias from the inner `ObjectPattern`.

  **Style B: Snapshot as variable** (~10 instances in codebase)

  ```typescript
  useRecoilCallback(({set, snapshot}) => async () => { ... })
  ```

  AST: The `snapshot` property's value is an `Identifier`. Track it for `snapshot.getPromise()` member expression calls.

- [x] Walk callback body for `set(X, ...)` -- setter
- [x] Walk callback body for `reset(X)` -- setter
- [x] Walk callback body for `getPromise(X)` (Style A, sub-pattern 1) -- reader
- [x] Walk callback body for `snapshot.getPromise(X)` (Style B, sub-pattern 2) -- reader

### Initializer and selector-body detection

- [x] Classify `set()` as **initializer** when inside a function whose name matches `/^initialize/i`
- [x] Walk selector `get()` bodies (from `getBodyAst`) and inline default selector bodies (from `inlineDefaultGetBody`) for `get(X)` calls -- reader

See [spec.md section 1.3](../spec.md#13-collect-usagests----pass-2-usage-collection) for full AST node patterns.

## Test Fixtures

```typescript
// test/fixtures/hook-usages.tsx
import { useRecoilValue, useSetRecoilState, useRecoilState } from 'recoil';
import { myAtom, myFamily } from './recoil-basic';

function Component() {
  const val = useRecoilValue(myAtom); // reader
  const setVal = useSetRecoilState(myAtom); // setter
  const [state, setState] = useRecoilState(myAtom); // reader + setter
  const familyVal = useRecoilValue(myFamily('id')); // reader (family)
}

// test/fixtures/callback-usages.tsx
import { useRecoilCallback } from 'recoil';
import { myAtom, otherAtom } from './recoil-basic';

function Component() {
  // Style A: inline nested destructuring
  const cb = useRecoilCallback(
    ({ set, snapshot: { getPromise } }) =>
      async () => {
        const val = await getPromise(myAtom); // reader (sub-pattern 1)
        set(myAtom, 'new'); // setter
      },
  );

  // Style B: snapshot as variable
  const cb2 = useRecoilCallback(({ set, snapshot }) => async () => {
    const val = await snapshot.getPromise(otherAtom); // reader (sub-pattern 2)
    set(otherAtom, val); // setter
  });
}

// test/fixtures/initializer.ts
import type { SetRecoilState } from 'recoil';
import { myAtom } from './recoil-basic';

export function initializeMyState(set: SetRecoilState) {
  set(myAtom, 'initial'); // initializer (NOT setter)
}
```

## Tests

- [x] Counts correct number of readers/setters per atom
- [x] `useRecoilState` emits both a reader and a setter
- [x] `useRecoilCallback` `set()` classified as setter
- [x] `useRecoilCallback` `getPromise()` via inline nested destructuring (`{snapshot: {getPromise}}`) classified as reader
- [x] `useRecoilCallback` `snapshot.getPromise()` via variable reference classified as reader
- [x] `initialize*` function `set()` classified as initializer (not runtime setter)
- [x] atomFamily variant (`useRecoilValue(myFamily(id))`) resolved to family name
- [x] `get(X)` calls inside `inlineDefaultGetBody` counted as readers

## Verification

Run against real codebase, print usage summary per atom:

```
pressReleaseTitleState: 8 readers, 2 setters, 1 initializer
releaseIdState: 5 readers, 3 setters, 1 initializer
pressReleaseImageInitialValueList: 4 readers (from inline defaults), 1 setter, 1 initializer
...
```

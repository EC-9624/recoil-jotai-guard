# Phase 13: Wrapper-Aware Setter Tracking V1 (Coverage-First Writers)

**Duration**: 3.25 days
**Depends on**: Phase 12
**Blocks**: None (standalone enhancement)

## Goal

Change the `impact` command's default setter output from factory-only to **coverage-first**: resolved wrappers show runtime callsites (labeled `runtime`), unresolved wrappers keep their factory sites (labeled `fallback`). This ensures full impact coverage with no silent gaps.

A hidden `--writer-mode legacy` flag restores pre-Phase-13 factory-only output for backward compatibility.

## V1 Scope

V1 resolves single-level wrapper patterns:

- **W1**: Arrow shorthand `() => useSetRecoilState(atom)`
- **W2**: Return statement `function useSetX() { return useSetRecoilState(atom); }`
- **W4**: Tuple `() => useRecoilState(atom)`

V1 does NOT resolve (deferred to V2 -- these appear as `fallback` in output):

- Object-returning wrappers (`return { setFoo, setBar }`)
- Nested wrappers (wrapper calling wrapper)

## Background

The current `impact` command reports setter locations at **factory sites** (where `useSetRecoilState(atom)` is called). The codebase uses ~20+ wrapper hooks that encapsulate setter creation:

```typescript
// Factory site (states/contents.ts:124) -- currently reported
export const useSetPressReleaseBodyJson = () =>
  useSetRecoilState(pressReleaseBodyJsonState);

// Consumer (pages/step1/Header/index.tsx:67)
const setPressReleaseBodyJson = useSetPressReleaseBodyJson();

// Runtime write site (pages/step1/Header/index.tsx:108) -- what we want to report
setPressReleaseBodyJson(editor.getJSON());
```

After Phase 13, the default output shows both runtime callsites and unresolved factory fallbacks:

```
WRITERS (3 runtime, 1 fallback):
  hooks/use-editor/index.ts:102      runtime    setter call
  hooks/use-editor/index.ts:122      runtime    setter call
  pages/step1/Header/index.tsx:108   runtime    setter call
  states/contents.ts:125             fallback   useSetRecoilState
```

See [PRD section 8](../PRD.md) for full motivation and [spec.md sections 1.13-1.15](../spec.md) for types and algorithms.

## Tasks

### Task 1: New types in `types.ts`

- [x] **Add `HookWriteBinding` type**

  ```typescript
  type HookWriteBindingKind = 'setter' | 'tuple';

  type HookWriteBinding = {
    kind: HookWriteBindingKind;
    stateId: string;
  };
  ```

- [x] **Add `SetterBindingMap` type alias**

  ```typescript
  type SetterBindingMap = Map<string, string>; // "file:identifierName" -> atomName
  ```

- [x] **Add `RuntimeWriteCallsite` type**

  ```typescript
  type RuntimeWriteCallsite = {
    atomName: string;
    file: string;
    line: number;
    calleeName: string;
  };
  ```

- [x] **Add `WriterKind` type**

  ```typescript
  type WriterKind = 'runtime' | 'fallback';
  ```

### Task 2: Implement `setter-bindings.ts`

- [x] **Implement `resolveDirectHookWriteBinding(callExpr, file)`**

  Checks if a `CallExpression` is a direct `useSetRecoilState`, `useResetRecoilState`, or `useRecoilState` call. Returns a `HookWriteBinding` with the atom name resolved from the first argument.

  See [spec.md section 1.13, `resolveDirectHookWriteBinding` algorithm](../spec.md).
  - Must handle both `Identifier` and `CallExpression` (atomFamily) arguments
  - Must use local import aliases for Recoil hook names (reuse pattern from `collect-usages.ts`)

- [x] **Implement `resolveCalleeToFunctionDefinition(calleeName, file, importMap)`**

  Given a callee identifier name and the file it appears in, resolve to the function definition AST. For same-file definitions, scan the file AST. For imported identifiers, use the import resolution data from Pass 3 to find the source file and exported function.

  Requirements:
  - Handle `FunctionDeclaration` exports
  - Handle `VariableDeclarator` with `ArrowFunctionExpression` or `FunctionExpression` init
  - Handle re-exports (follow chain via `resolve.ts` machinery, depth-capped at 5)
  - Return the function body AST node and file path, or `undefined` if not found

- [x] **Implement `analyzeWrapperReturnExpression(functionDef)`**

  Extract the return expression from the wrapper function and check if it is a direct hook call. This is the V1 simplification: no local variable tracking, no recursive resolution, no object returns.

  See [spec.md section 1.13, `analyzeWrapperReturnExpression` algorithm](../spec.md).

  Two cases:
  - Arrow shorthand: body IS the return expression
  - Block body: find the first `ReturnStatement` in the function's own scope (skip nested functions)

  The return expression must be a `CallExpression` that `resolveDirectHookWriteBinding` can resolve. Otherwise return `undefined`.

- [x] **Implement `resolveHookWriteBinding(callExpr, file, ...)`**

  The main entry point. Tries direct resolution first, then single-level wrapper resolution via callee-to-function lookup + `analyzeWrapperReturnExpression`.

  Requirements:
  - Cache results by `"file:line"` key to avoid re-analyzing the same wrapper function
  - Return `undefined` for non-hook/non-wrapper calls

- [x] **Implement `bindSetterIdentifiers(declarator, binding, file, setterBindings)`**

  Map declared variable names to atom names in the binding map:
  - Simple `Identifier`: `const setFoo = useSetFoo()` -> `"file:setFoo"` -> atomName
  - `ArrayPattern` (tuple): `const [val, setFoo] = useFoo()` -> `"file:setFoo"` -> atomName (second element)

- [x] **Implement `buildSetterBindings(files, extraction, importMap)` orchestrator**

  Walk all files, find `VariableDeclarator` nodes with `CallExpression` initializers, run the resolution pipeline, build and return the `SetterBindingMap`.

  Additionally, track which factory sites (file:line of `useSetRecoilState` calls) were **resolved** -- meaning the wrapper containing them was successfully analyzed. This is needed for the coverage merge in `impact.ts` to know which factory sites to exclude (superseded by runtime callsites) vs keep as fallback.

### Task 3: Implement `setter-callsites.ts`

- [x] **Implement `collectRuntimeWriteCallsites(files, setterBindings)`**

  Walk all files for `CallExpression` nodes whose callee is an `Identifier`. Look up `"file:callee.name"` in the setter binding map. If found, emit a `RuntimeWriteCallsite`.

  See [spec.md section 1.14](../spec.md).

### Task 4: Integrate with `impact-cli.ts`

- [x] **Run setter binding pipeline by default (always)**

  After Pass 3, always run:
  1. `buildSetterBindings(files, extraction, importMap)`
  2. `collectRuntimeWriteCallsites(files, setterBindings)`
  3. Pass both runtime callsites AND resolved-factory-site info to `analyzeAtomImpact`

- [x] **Add hidden `--writer-mode legacy` flag**

  When `--writer-mode legacy` is passed, skip the setter binding pipeline and use factory-only output. This flag is NOT shown in `--help` output.

### Task 5: Update `impact.ts`

- [x] **Implement coverage merge in `analyzeAtomImpact`**

  Default behavior (no `--writer-mode legacy`):
  1. Collect factory-site setters from the dependency graph (existing behavior)
  2. Collect runtime callsites filtered for this atom
  3. Determine which factory sites are "resolved" (their wrapper was traced to runtime callsites)
  4. Output = runtime callsites (labeled `runtime`) + unresolved factory sites (labeled `fallback`)

  When `--writer-mode legacy`: output = factory-site setters only (identical to pre-Phase-13).

  See [spec.md section 1.15](../spec.md) for the full coverage merge algorithm.

### Task 6: Update `impact-reporter.ts`

- [x] **Update text formatter for coverage-first display**

  Default: section header "WRITERS (N runtime, M fallback)". Runtime entries listed first with `runtime` label, then fallback entries with `fallback` label.

  Legacy mode: section header "SETTERS" (unchanged from pre-Phase-13).

- [x] **Update JSON formatter**

  Default: setter entries gain `"writerKind": "runtime"` or `"writerKind": "fallback"` field.

  Legacy mode: no `writerKind` field (unchanged).

## Test Fixtures

Create `test/fixtures/wrapper-hooks/` directory with these files:

```typescript
// test/fixtures/wrapper-hooks/atoms.ts
import { atom } from 'recoil';
export const fooState = atom({ key: 'fooState', default: '' });

// test/fixtures/wrapper-hooks/wrapper-arrow.ts (Pattern W1)
import { useSetRecoilState } from 'recoil';
import { fooState } from './atoms';
export const useSetFoo = () => useSetRecoilState(fooState);

// test/fixtures/wrapper-hooks/wrapper-return.ts (Pattern W2)
import { useSetRecoilState } from 'recoil';
import { fooState } from './atoms';
export function useSetFoo() {
  return useSetRecoilState(fooState);
}

// test/fixtures/wrapper-hooks/wrapper-tuple.ts (Pattern W4)
import { useRecoilState } from 'recoil';
import { fooState } from './atoms';
export const useFoo = () => useRecoilState(fooState);

// test/fixtures/wrapper-hooks/consumer.tsx
import { useSetFoo } from './wrapper-arrow';
import { useFoo } from './wrapper-tuple';

export function DirectConsumer() {
  const setFoo = useSetFoo();
  setFoo('hello');         // runtime write callsite
  return <div />;
}

export function TupleConsumer() {
  const [foo, setFoo] = useFoo();
  setFoo('world');         // runtime write callsite
  return <div>{foo}</div>;
}
```

## Tests

### `test/setter-bindings.test.ts`

- [x] **Direct `useSetRecoilState` binding: simple identifier**

  `const setFoo = useSetRecoilState(fooState)` -> binding map has `"file:setFoo" -> "fooState"`.

- [x] **Direct `useRecoilState` binding: tuple destructuring**

  `const [foo, setFoo] = useRecoilState(fooState)` -> binding map has `"file:setFoo" -> "fooState"`.

- [x] **Arrow shorthand wrapper (Pattern W1)**

  `useSetFoo = () => useSetRecoilState(fooState)`, consumer: `const setFoo = useSetFoo()` -> `"file:setFoo" -> "fooState"`.

- [x] **Return statement wrapper (Pattern W2)**

  `function useSetFoo() { return useSetRecoilState(fooState); }` -> same binding.

- [x] **Tuple wrapper (Pattern W4)**

  `useFoo = () => useRecoilState(fooState)`, consumer: `const [val, setter] = useFoo()` -> `"file:setter" -> "fooState"`.

- [x] **Non-hook function returns undefined**

  `const result = someUtilityFunction()` -> no binding created, not in map.

- [x] **Cache prevents duplicate analysis**

  Same wrapper function referenced from two consumers. Verify the wrapper function body is analyzed only once (check via cache state or spy).

### `test/setter-callsites.test.ts`

- [x] **Direct setter invocation detected**

  `setFoo('hello')` where `setFoo` is in the binding map -> `RuntimeWriteCallsite` emitted with correct file:line and atomName.

- [x] **Non-setter call ignored**

  `someOtherFunction('hello')` where `someOtherFunction` is NOT in the binding map -> no callsite emitted.

- [x] **Multiple callsites for same setter**

  `setFoo('a'); setFoo('b');` -> two callsites emitted.

- [x] **Tuple-destructured setter callsite**

  `const [val, setFoo] = useFoo(); setFoo('x');` -> callsite detected.

### Coverage merge tests

- [x] **Resolved wrapper: factory site excluded, runtime callsites shown**

  Wrapper `useSetFoo` (W1) resolved -> factory site NOT in output, runtime `setFoo('x')` callsite shown as `runtime`.

- [x] **Unresolved wrapper: factory site kept as fallback**

  Wrapper pattern not supported by V1 (e.g., object return) -> factory site shown with `writerKind: 'fallback'`.

- [x] **Direct hook in component (no wrapper): shown as runtime**

  `useSetRecoilState(fooState)` directly in a component, then `setFoo(...)` called -> shown as `runtime`.

### Integration tests (against real codebase)

- [x] **Verify default output shows coverage-first writers**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --atom pressReleaseBodyJsonState
  ```

  Verify:
  - Runtime callsites from `hooks/use-editor/index.ts` and `pages/step1/Header/index.tsx` are labeled `runtime`
  - Any unresolved factory sites are labeled `fallback`
  - No write site is silently dropped

- [x] **Verify hidden `--writer-mode legacy` restores old output**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --atom pressReleaseBodyJsonState --writer-mode legacy
  ```

  Output must be identical to pre-Phase-13 behavior (factory-only, "SETTERS" header).

- [x] **Verify JSON output has `writerKind` field**

  Parse the JSON output and verify setter entries have `"writerKind": "runtime"` or `"writerKind": "fallback"`.

- [x] **Verify `check` command is unaffected**

  Run `pnpm check` and confirm output is identical to before this phase.

- [x] **Verify all existing unit tests still pass**

  ```bash
  pnpm test
  ```

## Verification

```bash
# Run all unit tests
pnpm test

# Integration: default coverage-first output
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseBodyJsonState

# Integration: hidden legacy mode
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseBodyJsonState --writer-mode legacy

# Integration: JSON output
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseBodyJsonState --json

# Integration: check command unaffected
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
```

## Deliverable

- `setter-bindings.ts` with single-level wrapper-aware setter binding resolution
- `setter-callsites.ts` with runtime write callsite classification
- Updated `types.ts`, `impact-cli.ts`, `impact.ts`, `impact-reporter.ts`
- Coverage merge logic (runtime + fallback) as default
- Hidden `--writer-mode legacy` for backward compatibility
- Test coverage in `setter-bindings.test.ts` and `setter-callsites.test.ts`
- Integration validation against real codebase

# recoil-jotai-guard

Static guard for mixed Recoil/Jotai code.

It scans TypeScript source and provides:

- `check`: boundary and lifecycle violations
- `impact`: blast-radius analysis for Recoil definitions

## What `check` validates

1. Cross-system boundary (`error`)

- Detects Jotai identifiers inside Recoil selector `get()` bodies.
- Includes inline default selectors in `atom/atomFamily`.

2. Orphaned atom (`error`)

- Detects Recoil `atom/atomFamily` with reader usages but no runtime setters.
- `initialize*` writes and `RecoilRoot initializeState` writes are treated as initializers, not runtime setters.

3. Unused atom (`warning`)

- Detects Recoil `atom/atomFamily` with no readers, no setters, and no selector dependencies.

## Check pattern reference

`check` mode uses these patterns when classifying usage:

- Readers
  - `useRecoilValue(X)`
  - `useRecoilState(X)` (reader side)
  - `getPromise(X)` / `snapshot.getPromise(X)` inside `useRecoilCallback`
  - `get(X)` inside Recoil `selector/selectorFamily` `get()` bodies
- Runtime setters
  - `useSetRecoilState(X)`
  - `useResetRecoilState(X)`
  - `useRecoilState(X)` (setter side)
  - `set(X, ...)` / `reset(X)` inside `useRecoilCallback`
- Initializers (not counted as runtime setters)
  - `set(X, ...)` inside functions whose name starts with `initialize*`
  - `set(X, ...)` inside `RecoilRoot initializeState`

Cross-system boundary (Check 1) scans:

- Recoil `selector/selectorFamily` `get()` bodies
- inline default selectors in `atom/atomFamily`

It reports an error when those bodies reference Jotai definition names or Jotai-imported local identifiers.

Note: wrapper-writer runtime tracing (`runtime` vs `fallback`) is an `impact` feature, not a `check` rule.

## Patterns covered

Definitions:

- `const x = atom(...)`
- `const x = selector(...)`
- `const x = atomFamily(...)`
- `const x = selectorFamily(...)`
- `default: selector(...)` and `default: selectorFamily(...)` inside atom/atomFamily

Usages:

- `useRecoilValue`
- `useSetRecoilState`
- `useResetRecoilState`
- `useRecoilState` (reader + setter)
- `useRecoilCallback` with both:
  - `({set, reset, snapshot: {getPromise}}) => ...`
  - `({set, reset, snapshot}) => ... snapshot.getPromise(...)`
- selector `get(...)` dependency reads

Resolution:

- same-file definitions
- imports
- named/star re-exports
- `@/` alias
- max chain depth: 5

Scan scope:

- includes `.ts/.tsx`
- excludes `node_modules`, `__tests__`, `__storybook__`, `*.test.ts(x)`, `*.stories.tsx`

## CLI usage

Run from repo root.

```bash
pnpm --dir scripts/recoil-jotai-guard check <target-directory>
```

```bash
pnpm --dir scripts/recoil-jotai-guard check <target-directory> --verbose
```

```bash
pnpm --dir scripts/recoil-jotai-guard impact <target-directory> --atom <name>
```

```bash
pnpm --dir scripts/recoil-jotai-guard impact <target-directory> --file <path>
```

```bash
pnpm --dir scripts/recoil-jotai-guard impact <target-directory> --git
```

```bash
pnpm --dir scripts/recoil-jotai-guard impact <target-directory> --atom <name> --json
```

Impact writer mode (optional):

```bash
pnpm --dir scripts/recoil-jotai-guard impact <target-directory> --atom <name> --writer-mode legacy
```

## Exit codes

- `check`
  - `1`: any `error` violation (Check 1 or 2)
  - `0`: clean or warnings only
- `impact`
  - `0`: successful analysis (including no-result cases)
  - `1`: CLI/argument/runtime setup error (for example invalid args or git diff failure)

## Known limits

- Dynamic parameterized state references like `useRecoilState(recoilStateParam)` are collected but may not resolve to a concrete definition.
- Impact writer tracing uses direct hooks and single-level wrapper return tracing; unresolved wrapper paths remain as fallback writer entries.

# PRD: recoil-jotai-guard

## 1. Overview

A standalone CLI toolset that statically analyzes TypeScript/React source files during the Recoil-to-Jotai state management migration. It uses `oxc-parser` and `oxc-walker` (Rust-based AST parsing) for fast, cross-file analysis.

The toolset provides two commands:

1. **`check`** -- Detects unsafe migration patterns (cross-system boundary violations, orphaned atoms, unused atoms). Designed to run in CI alongside lint and typecheck. Exit code 1 on errors.
2. **`impact`** -- Analyzes the scope of impact for specific atoms, files, or git-changed files. Shows direct and transitive dependency chains across selectors and components. Informational output (always exit code 0).

## 2. Problem Statement

During the incremental migration from Recoil to Jotai in the `press-release-editor-v3` feature, three classes of bugs can occur silently -- they produce no compile errors, no runtime errors, and no test failures, but cause incorrect UI behavior.

### 2.1 Cross-System Boundary Violation

A Recoil `selector`'s `get()` function reads Jotai state (e.g., via `pressReleaseEditorStore.get(jotaiAtom)`). Recoil's dependency tracking cannot see this dependency. When the Jotai atom changes, the selector does not re-evaluate, serving stale data.

### 2.2 Orphaned Atom

A Recoil atom's setters are migrated to Jotai, but some component files still read the old Recoil atom directly via `useRecoilValue()`. Since no runtime setter writes to the Recoil atom anymore, it is permanently stuck at its initial value.

### 2.3 Unused Atom

A Recoil atom has been fully migrated -- all readers and setters now use Jotai -- but the old Recoil atom definition and its initialization code were never cleaned up. This is dead code.

## 3. Command: `check`

| #   | Name                  | Detects                                             | Severity | Exit Code |
| --- | --------------------- | --------------------------------------------------- | -------- | --------- |
| 1   | Cross-system boundary | Recoil selector `get()` body references Jotai state | Error    | 1         |
| 2   | Orphaned atom         | Recoil atom has readers but zero runtime setters    | Error    | 1         |
| 3   | Unused atom           | Recoil atom has zero readers and zero setters       | Warning  | 0         |

### 3.1 Check 1: Cross-System Boundary

**Trigger**: A Recoil `selector` or `selectorFamily` definition whose `get()` function body contains any of:

- An identifier matching a known Jotai atom name
- An identifier imported from a `'jotai'` or `'jotai/*'` module
- An identifier imported from a file path containing `/jotai/` (e.g., the Jotai store)

**Scope**: Only the `get()` function body of `selector()` and `selectorFamily()` calls. React hooks that combine both systems via `useRecoilValue` + `useAtomValue` are safe and are not flagged.

**Not in scope**: Indirect cross-system access via helper functions in other files (two-pass tainted function analysis). This may be added in a future iteration.

### 3.2 Check 2: Orphaned Atom

**Trigger**: A Recoil `atom` or `atomFamily` definition where:

- Reader count > 0 (any `useRecoilValue`, `useRecoilState`, `get()` in selectors, or `snapshot.getPromise()` references)
- Runtime setter count == 0 (no `useSetRecoilState`, no `useRecoilState`, no `set()` in `useRecoilCallback`, no `reset()` calls)

**Exclusion**: `set()` calls inside functions named `initialize*` or inside `RecoilRoot`'s `initializeState` callback are classified as initialization-only setters and do not count as runtime setters.

**Output**: Lists all reader locations (file:line) so the developer knows which call sites need to be updated.

### 3.3 Check 3: Unused Atom

**Trigger**: A Recoil `atom` or `atomFamily` definition where:

- Reader count == 0
- Setter count == 0 (including initialization)
- Not referenced as a dependency by any Recoil selector

**Output**: Lists the atom definition location. These can be safely deleted along with their initialization code.

## 4. Command: `impact`

### 4.1 Problem Statement

During migration, developers need to answer: "If I change this atom, what else is affected?" Currently this requires manually tracing import chains, selector dependencies, and component usages across dozens of files. This is error-prone and time-consuming.

### 4.2 Purpose

The `impact` command builds a dependency graph from the existing 3-pass pipeline output and traverses it transitively to show the full scope of impact for a given atom, file, or set of git-changed files.

### 4.3 Input Modes

| Mode           | Flag            | Description                                                                                   |
| -------------- | --------------- | --------------------------------------------------------------------------------------------- |
| By atom name   | `--atom <name>` | Show impact of a specific Recoil atom/selector                                                |
| By file path   | `--file <path>` | Show impact of all atoms defined in the given file                                            |
| By git changes | `--git`         | Auto-detect changed files from `git diff` and show impact of all atoms defined in those files |

All modes require a `<target-directory>` positional argument. The entire directory is scanned (full pipeline), but output is filtered to the queried atoms.

### 4.4 Transitive Dependency Traversal

Given an atom `A`, the tool traces:

1. **Direct dependents**: components that `useRecoilValue(A)` / `useSetRecoilState(A)` / etc., and selectors whose `get()` body calls `get(A)`.
2. **Transitive dependents**: for each dependent selector `S`, recursively find components that use `S` and selectors that depend on `S`, and so on.

Traversal is depth-limited (max 5 hops, matching the existing import chain resolution convention) to prevent infinite loops from circular selector dependencies.

### 4.5 Output Formats

| Format         | Flag     | Description                                                  |
| -------------- | -------- | ------------------------------------------------------------ |
| Text (default) | _(none)_ | Terminal-friendly grouped output with file:line references   |
| JSON           | `--json` | Machine-readable structured output for piping to other tools |

### 4.6 Exit Code

Always `0`. The `impact` command is informational, not a CI gate.

### 4.7 Impact Output Format

**Text output:**

```
Impact: myAtom (atom)
Defined at: states/core.ts:15

  Direct:
    READERS (2):
      components/title/index.tsx:23       useRecoilValue
      states/selectors.ts:8              get(selector) in mySelector
    SETTERS (1):
      hooks/use-update.ts:12             useSetRecoilState
    INITIALIZERS (1):
      states/initialize.ts:5             set(initializer)

  Transitive (via selectors):
    mySelector (states/selectors.ts:8) [depth 1]:
      components/preview/index.tsx:15     useRecoilValue
    derivedSelector (states/selectors.ts:20) [depth 2]:
      components/summary/index.tsx:8      useRecoilValue

  Summary: 5 files, 3 components, 2 selectors
```

**JSON output:**

```json
{
  "target": {
    "name": "myAtom",
    "kind": "atom",
    "file": "states/core.ts",
    "line": 15
  },
  "direct": {
    "readers": [
      {
        "file": "components/title/index.tsx",
        "line": 23,
        "hook": "useRecoilValue"
      }
    ],
    "setters": [
      { "file": "hooks/use-update.ts", "line": 12, "hook": "useSetRecoilState" }
    ],
    "initializers": [
      { "file": "states/initialize.ts", "line": 5, "hook": "set(initializer)" }
    ]
  },
  "transitive": [
    {
      "via": "mySelector",
      "viaDefinition": {
        "file": "states/selectors.ts",
        "line": 8,
        "kind": "selector"
      },
      "depth": 1,
      "readers": [
        {
          "file": "components/preview/index.tsx",
          "line": 15,
          "hook": "useRecoilValue"
        }
      ],
      "setters": []
    }
  ],
  "summary": {
    "totalFiles": 5,
    "totalComponents": 3,
    "totalSelectors": 2
  }
}
```

## 5. Architecture

### 5.1 Dependencies

| Package      | Version | Purpose                                        |
| ------------ | ------- | ---------------------------------------------- |
| `oxc-parser` | ^0.72.0 | Rust-based TypeScript/JSX parser               |
| `oxc-walker` | ^0.2.0  | AST walker with `parseAndWalk` and `walk` APIs |

No other runtime dependencies.

### 5.2 Data Flow

The 3-pass pipeline (extract, collect usages, resolve) is shared by both commands. Each command branches after Pass 3.

```
                          +----------------+
                          |  File system   |
                          |  (glob *.tsx)  |
                          +-------+--------+
                                  |
                     +------------v------------+
                     |  Pass 1: extract.ts     |
                     |  Extract definitions    |
                     |  - Recoil atoms         |
                     |  - Recoil selectors     |
                     |  - Recoil atomFamilies  |
                     |  - Recoil selectorFams  |
                     |  - Jotai atoms          |
                     |  - Jotai imports/file   |
                     +------------+------------+
                                  |
                     +------------v------------+
                     |  Pass 2: usages.ts      |
                     |  Collect usages         |
                     |  - Readers (per atom)   |
                     |  - Setters (per atom)   |
                     |  - Initializers         |
                     |  - Jotai refs in sels   |
                     |  + enclosingDefinition  |
                     +------------+------------+
                                  |
                     +------------v------------+
                     |  Pass 3: resolve.ts     |
                     |  Resolve identifiers    |
                     |  - Import chains        |
                     |  - Re-exports           |
                     |  - Aliased imports      |
                     +------------+------------+
                                  |
              +-------------------+-------------------+
              |                                       |
    +---------v---------+               +-------------v-----------+
    |  `check` command  |               |   `impact` command      |
    +---------+---------+               +-------------+-----------+
              |                                       |
   +----+----+----+                     +-------------v-----------+
   |    |         |                     |  graph.ts               |
   v    v         v                     |  Build dependency graph |
  C1   C2        C3                     |  - selector deps        |
   |    |         |                     |  - component usages     |
   +----+----+----+                     +-------------+-----------+
              |                                       |
   +----------v----------+             +--------------v-----------+
   |  reporter.ts        |             |  impact.ts               |
   |  Format & output    |             |  Transitive BFS          |
   |  Exit code 0 or 1   |             |  - by atom / file / git  |
   +----------------------+             +--------------+-----------+
                                                      |
                                        +--------------v-----------+
                                        |  impact-reporter.ts      |
                                        |  Text or JSON output     |
                                        |  Exit code 0             |
                                        +--------------------------+
```

### 5.3 File Structure

```
scripts/
  recoil-jotai-guard/
    package.json
    tsconfig.json
    src/
      index.ts              # `check` CLI entry point, orchestrate
      impact-cli.ts         # `impact` CLI entry point
      files.ts              # Shared file globbing and exclusion patterns
      extract.ts            # Pass 1: find Recoil + Jotai definitions
      collect-usages.ts     # Pass 2: find all hook calls, set/get usages
      resolve.ts            # Pass 3: map imported identifiers -> definitions
      checks.ts             # Check 1, 2, 3 logic
      reporter.ts           # Format check violations for terminal output
      graph.ts              # Build dependency graph from resolved usages
      impact.ts             # Impact analysis with transitive traversal
      impact-reporter.ts    # Format impact results (text + JSON)
      types.ts              # Shared type definitions
    test/
      fixtures/             # Minimal .tsx files with known patterns
      extract.test.ts
      collect-usages.test.ts
      resolve.test.ts
      checks.test.ts
      reporter.test.ts
      graph.test.ts
      impact.test.ts
      impact-reporter.test.ts
```

## 6. Usage

### 6.1 `check` CLI

```bash
# Run migration safety checks on a directory
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3

# With verbose output (definition and usage counts)
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3 --verbose
```

### 6.2 `impact` CLI

```bash
# Show impact of a specific atom
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseTitleState

# Show impact of all atoms defined in a file
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --file states/core.ts

# Show impact of atoms in git-changed files (vs current branch)
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --git

# Output as JSON (for piping to other tools)
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseTitleState --json

# Combine with verbose for debugging
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --file states/core.ts --verbose

# Default output now shows coverage-first writers (runtime + fallback)
# No flag needed -- this is the default after Phase 13
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseBodyJsonState

# Hidden: restore pre-Phase-13 factory-only output
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
  --atom pressReleaseBodyJsonState --writer-mode legacy
```

### 6.3 CI (GitHub Actions)

```yaml
- name: recoil-jotai-guard check
  run: |
    npx tsx scripts/recoil-jotai-guard/src/index.ts \
      ./apps/prtimes/src/features/press-release-editor-v3
```

### 6.4 Pre-push Hook

The `check` command can be added alongside existing lint/typecheck hooks. The `impact` command is intended for local developer use, not CI gates.

## 7. Check Output Format

```
[ERROR] Cross-system boundary violations:

  states/medialists.ts:132
  Recoil selector 'isManualMediaListSelectionValidState' references
  Jotai atom 'releaseAdditionalFaxFlgAtom' via store.get()

[ERROR] Orphaned atoms (readers but no runtime setter):

  states/delivery-settings.ts:27 -> releaseAdditionalHeadlineFlgState
  Readers (3):
    pages/step4/component.tsx:15      useRecoilValue
    validations/step4/index.ts:81     useRecoilValue
    hooks/api/use-auto-save.tsx:302   useRecoilValue
  Runtime setters: none

[WARN] Unused atoms (safe to delete):

  states/old-feature.ts:10 -> someOldAtom

Summary: 1 error, 1 warning
```

Exit code: `1` if any errors (Check 1 or Check 2), `0` if only warnings or clean.

## 8. Feature: Wrapper-Aware Setter Tracking (Coverage-First Writers)

### 8.1 Problem Statement

The current `impact` command reports setter locations at the **factory site** -- where `useSetRecoilState(atom)` is called to create a setter function. This is inaccurate because the codebase extensively uses **wrapper hooks** that encapsulate setter creation. The reported location is where the setter is manufactured, not where it is actually invoked at runtime.

**Current output for `pressReleaseBodyJsonState`:**

```
SETTERS (2):
  hooks/use-editor/index.ts:43       useSetRecoilState     ← factory site
  states/contents.ts:125             useSetRecoilState     ← factory site (inside wrapper)
```

**Desired output (coverage-first writers):**

```
WRITERS (2 runtime, 1 fallback):
  hooks/use-editor/index.ts:102      runtime    setter call
  hooks/use-editor/index.ts:122      runtime    setter call
  pages/step1/Header/index.tsx:108   runtime    setter call
  states/contents.ts:125             fallback   useSetRecoilState (unresolved wrapper)
```

The wrapper pattern is pervasive in the codebase (~20+ wrapper hooks in `press-release-editor-v3`):

```typescript
// Definition site: states/contents.ts:124
export const useSetPressReleaseBodyJson = () =>
  useSetRecoilState(pressReleaseBodyJsonState);

// Consumer site: pages/step1/Header/index.tsx:67
const setPressReleaseBodyJson = useSetPressReleaseBodyJson();

// Runtime write site: pages/step1/Header/index.tsx:108
setPressReleaseBodyJson(editor.getJSON()); // ← THIS is the real impact site
```

The factory-site report tells you "someone created a setter" but not "where the state is actually mutated at runtime." For migration impact analysis, the runtime callsite is the actionable information. But dropping unresolved factory sites would lose coverage -- so we show both with clear labels.

### 8.2 Solution: Coverage-First Default

The `impact` command's default setter output changes from factory-only to **coverage-first**: runtime callsites are shown first, and any factory sites whose wrappers could not be resolved to callsites are kept as labeled fallbacks. This ensures no impact coverage is lost.

```bash
# Default behavior after Phase 13: coverage-first writers
pnpm impact <dir> --atom myAtom
```

A hidden `--writer-mode legacy` flag is available for backward compatibility. It restores the pre-Phase-13 factory-only output. This flag is not documented in `--help` and is intended only for existing scripts during the transition period.

```bash
# Hidden: restore old factory-only output
pnpm impact <dir> --atom myAtom --writer-mode legacy
```

### 8.3 Algorithm Overview

The coverage-first writer tracking works in three stages:

1. **Build setter binding map**: For each `VariableDeclaration` with a `CallExpression` initializer, check if it is a direct setter hook call or a single-level wrapper that returns a setter hook call. Map the resulting setter variable identifier to the atom it writes to.

2. **Callsite classification**: For each `CallExpression` in the codebase, check if the callee identifier is in the setter binding map. If so, that call is a runtime write site for the mapped atom.

3. **Coverage merge**: Combine runtime callsites with factory-site fallbacks. A factory site is a "fallback" if its wrapper was not successfully resolved to any runtime callsite. Factory sites whose wrappers WERE resolved are excluded (they are superseded by the runtime callsites). This produces a union of both sources with no gaps in coverage.

### 8.4 Wrapper Patterns to Support (V1)

V1 handles the most common single-level wrapper patterns. These cover the vast majority of wrapper hooks in the codebase.

**Pattern W1: Arrow shorthand wrapper**

```typescript
export const useSetFoo = () => useSetRecoilState(fooState);
// Consumer: const setFoo = useSetFoo(); setFoo(newValue);
```

**Pattern W2: Return statement wrapper**

```typescript
export function useSetFoo() {
  return useSetRecoilState(fooState);
}
```

**Pattern W4: Tuple wrapper (`useRecoilState`)**

```typescript
export const useFoo = () => useRecoilState(fooState);
// Consumer: const [foo, setFoo] = useFoo();
```

### 8.5 Deferred to V2

The following patterns are out of scope for V1. They can be added incrementally later.

**Pattern W3: Wrapper returning object with setter properties**

```typescript
export function useFooActions() {
  const setFoo = useSetRecoilState(fooState);
  const setBar = useSetRecoilState(barState);
  return { setFoo, setBar };
}
// Consumer: const { setFoo, setBar } = useFooActions();
```

**Pattern W5: Nested wrapper (wrapper calling wrapper)**

```typescript
export const useSetFoo = () => useSetRecoilState(fooState);
export function useEditorActions() {
  const setFoo = useSetFoo();
  return { setFoo };
}
```

### 8.6 Adaptation from Reference Implementation

A reference implementation exists in `state-audit-poc` using `ts-morph`. V1 adapts a simplified subset to `oxc-parser`/`oxc-walker`:

| ts-morph concept             | oxc-parser equivalent                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `Symbol`-based tracking      | File-path + identifier-name based tracking (no symbol table) |
| `getDeclarations()`          | Walk AST to find matching `VariableDeclarator` nodes         |
| `getDescendantsOfKind()`     | `oxc-walker` enter/leave callbacks with node type checks     |
| `getInitializerIfKind()`     | Check `VariableDeclarator.init` node type                    |
| Type-aware callee resolution | Import-chain resolution via existing `resolve.ts` machinery  |

Key difference: `oxc-parser` provides no symbol table, so wrapper resolution must use the existing import resolution infrastructure in `resolve.ts` to follow function definitions across files. Within a single file, identifier-name matching within scope is sufficient.

V1 does not need the full recursive wrapper analysis from the reference implementation. It only resolves single-level wrappers whose return expression is a direct hook call.

### 8.7 Success Criteria (V1)

- [ ] Default output shows coverage-first writers: runtime callsites labeled `runtime`, unresolved factory sites labeled `fallback`
- [ ] Arrow shorthand wrappers (W1) are resolved to runtime callsites
- [ ] Return-statement wrappers (W2) are resolved to runtime callsites
- [ ] Tuple wrappers (W4) are resolved to runtime callsites
- [ ] For `pressReleaseBodyJsonState`, resolved wrappers show runtime callsites; unresolved wrappers (e.g., W3/W5 patterns) appear as fallback
- [ ] No factory site is silently dropped -- unresolved wrappers always appear as fallback
- [ ] Hidden `--writer-mode legacy` produces identical output to pre-Phase-13 behavior
- [ ] Performance: coverage-first mode adds no more than 1 second overhead to the full pipeline
- [ ] No breaking changes to the `check` command

## 9. Scope Boundaries

### In Scope

- Recoil `atom`, `selector`, `atomFamily`, `selectorFamily` definitions
- Inline default selectors: `atom({ default: selector() })` and `atomFamily({ default: selectorFamily() })`
- Jotai `atom` definitions (including `atomFamily`, `atomWithDefault` from `jotai/utils`)
- Hook-based usage detection (`useRecoilValue`, `useSetRecoilState`, `useRecoilState`, `useRecoilCallback`)
- `set()`/`reset()`/`snapshot.getPromise()` inside `useRecoilCallback` bodies (both inline nested destructuring `{snapshot: {getPromise}}` and variable-style `snapshot.getPromise()`)
- Cross-file import resolution (including re-exports and barrel files)
- Aliased imports (`import { atom as myAtom }`)
- Impact analysis: direct and transitive dependency chains for atoms/selectors
- Impact query by atom name, file path, or git-changed files
- Impact output in text and JSON formats
- Wrapper-aware setter tracking V1: coverage-first writers as default -- runtime callsites for resolved single-level wrappers (W1/W2/W4), fallback factory sites for unresolved wrappers

### Out of Scope (Future / V2)

- Wrapper-aware setter tracking V2: object-returning wrappers (Pattern W3), nested wrappers (Pattern W5)
- Two-pass tainted function detection (helper functions that wrap Jotai reads in other files)
- Jotai-side equivalent checks (Jotai derived atom reading Recoil state)
- Jotai-side impact analysis (tracing Jotai atom dependencies)
- Auto-fix capabilities
- SVG/graph visualization (use `state-tracer` for that)
- Detection across workspace package boundaries (only works within the target directory)

## 10. Estimates

### `check` command (completed)

| Module                                    | Lines of Code | Time        | Status |
| ----------------------------------------- | ------------- | ----------- | ------ |
| `index.ts`                                | ~40           | 0.25 day    | Done   |
| `types.ts`                                | ~40           | 0.25 day    | Done   |
| `extract.ts`                              | ~120          | 0.5 day     | Done   |
| `collect-usages.ts`                       | ~250          | 1.5 days    | Done   |
| `resolve.ts`                              | ~150          | 1 day       | Done   |
| `checks.ts`                               | ~120          | 0.5 day     | Done   |
| `reporter.ts`                             | ~60           | 0.25 day    | Done   |
| Tests                                     | ~200          | 0.75 day    | Done   |
| Integration testing against real codebase | --            | 1 day       | Done   |
| **Subtotal**                              | **~980**      | **~6 days** |        |

### `impact` command (planned)

| Module                                           | Lines of Code | Time           |
| ------------------------------------------------ | ------------- | -------------- |
| `types.ts` updates (new types + enrichment)      | ~50           | 0.25 day       |
| `collect-usages.ts` update (enclosingDefinition) | ~10           | 0.25 day       |
| `files.ts` (extract shared glob)                 | ~40           | 0.25 day       |
| `graph.ts` (dependency graph builder)            | ~80           | 0.5 day        |
| `impact.ts` (transitive BFS analysis)            | ~120          | 0.75 day       |
| `impact-reporter.ts` (text + JSON formatters)    | ~120          | 0.5 day        |
| `impact-cli.ts` (CLI entry point)                | ~80           | 0.5 day        |
| Tests                                            | ~250          | 1 day          |
| Integration testing against real codebase        | --            | 0.75 day       |
| **Subtotal**                                     | **~750**      | **~4.75 days** |

### Wrapper-aware setter tracking V1 (planned)

| Module                                                             | Lines of Code | Time           |
| ------------------------------------------------------------------ | ------------- | -------------- |
| `types.ts` updates (new types for setter bindings)                 | ~30           | 0.25 day       |
| `setter-bindings.ts` (binding map + single-level wrapper resolver) | ~120          | 0.75 day       |
| `setter-callsites.ts` (callsite classification)                    | ~60           | 0.25 day       |
| `impact.ts` + `impact-cli.ts` updates (coverage merge)             | ~50           | 0.5 day        |
| `impact-reporter.ts` updates (coverage-first display)              | ~20           | 0.25 day       |
| Tests                                                              | ~150          | 0.75 day       |
| Integration testing against real codebase                          | --            | 0.5 day        |
| **Subtotal**                                                       | **~430**      | **~3.25 days** |

### Combined total: ~2160 lines, ~14 days

## 11. Success Criteria

### `check` command

- [x] Check 1 detects the known `medialists.ts:132` cross-system boundary violation
- [x] Check 2 correctly identifies atoms with readers but no runtime setters
- [x] Check 3 correctly identifies atoms with no references at all
- [x] Initialization-only setters are excluded from Check 2's runtime setter count
- [x] `atomFamily` usages (e.g., `useRecoilValue(myFamily(id))`) are resolved correctly
- [x] Import aliases and re-exports are resolved across files
- [x] Tool runs in under 5 seconds on the `press-release-editor-v3` directory
- [x] Zero false positives on the current codebase (aside from known violations)
- [x] Exits with code 1 on Check 1 or Check 2 violations, 0 otherwise

### `impact` command

- [ ] `--atom` mode correctly identifies all direct readers, setters, and initializers for a named atom
- [ ] Transitive dependency chains through selectors are traced correctly (e.g., atom -> selector -> component)
- [ ] Multi-level chains are traced (atom -> selector A -> selector B -> component)
- [ ] Circular selector dependencies do not cause infinite loops (depth-limited)
- [ ] `--file` mode finds all atom definitions in the given file and shows impact for each
- [ ] `--git` mode correctly reads changed files from `git diff` and finds atoms in those files
- [ ] JSON output (`--json`) is valid JSON and matches the `ImpactResult` schema
- [ ] Text output shows correct file:line references relative to the target directory
- [ ] Impact analysis reuses the existing 3-pass pipeline without modifying its output
- [ ] Tool runs in under 5 seconds on the `press-release-editor-v3` directory (including graph building)
- [ ] Always exits with code 0

### Wrapper-aware setter tracking (V1)

- [ ] Default impact output shows coverage-first writers (runtime + fallback labels)
- [ ] Arrow shorthand wrappers (W1) resolved to runtime callsites
- [ ] Return-statement wrappers (W2) resolved to runtime callsites
- [ ] Tuple wrappers (W4) resolved to runtime callsites
- [ ] Unresolved factory sites appear as labeled fallback (no silent coverage loss)
- [ ] Hidden `--writer-mode legacy` restores pre-Phase-13 factory-only output
- [ ] Coverage-first mode adds no more than 1 second overhead
- [ ] No breaking changes to `check` command

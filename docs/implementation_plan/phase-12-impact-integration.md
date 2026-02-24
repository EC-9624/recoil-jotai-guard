# Phase 12: Impact Integration Testing

**Duration**: 0.75 day
**Depends on**: Phase 11

## Goal

Validate the `impact` command against the real `press-release-editor-v3` codebase. Verify transitive chains, all three input modes, both output formats, and edge cases.

## Tasks

### `--atom` mode validation

- [x] **Test with a well-known atom**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --atom pressReleaseTitleState --verbose
  ```

  Manually verify:
  - All direct readers and setters are listed
  - Selectors that read this atom via `get()` are shown in transitive section
  - Components that use those selectors are shown at the correct depth
  - File paths and line numbers are accurate (spot-check 3-5 references)

- [x] **Test with an atom that has inline default selector deps**

  Pick an `atomFamily` with `default: selectorFamily({...})` from `images.ts`. Verify the inline selector's `get()` dependencies are reflected in the graph.

- [x] **Test with an atom that has no usages**

  Pick an atom flagged by Check 3 (unused). Verify the impact command shows empty results with zeros in summary.

- [x] **Test with an unknown atom name**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --atom nonExistentAtom
  ```

  Verify: prints "No Recoil definition found for 'nonExistentAtom'" and exits 0.

### `--file` mode validation

- [x] **Test with a file containing multiple atoms**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --file states/core.ts
  ```

  Verify: output shows impact for each atom defined in that file, separated by `---`.

- [x] **Test with a file containing no atoms**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --file pages/step1/component.tsx
  ```

  Verify: prints "No Recoil definitions found in ..." and exits 0.

- [x] **Test with relative path resolution**

  Verify that `--file states/core.ts` (relative to target dir) works the same as `--file` with the full absolute path.

### `--git` mode validation

- [x] **Test with uncommitted changes**

  Make a trivial change to a file containing Recoil atoms, then run:

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --git
  ```

  Verify: shows impact for atoms in the changed file(s).

- [x] **Test with no changes**

  Ensure working tree is clean, then run:

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --git
  ```

  Verify: prints "No changed files with Recoil definitions" and exits 0.

### JSON output validation

- [x] **Verify JSON is valid and parseable**

  ```bash
  pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --atom pressReleaseTitleState --json | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"
  ```

  Verify: no parse error.

- [x] **Verify JSON structure matches schema**

  Spot-check that the JSON output contains:
  - `target` with `name`, `kind`, `file`, `line`
  - `direct` with `readers`, `setters`, `initializers` arrays
  - `transitive` array with `via`, `viaDefinition`, `depth`, `readers`, `setters`
  - `summary` with `totalFiles`, `totalComponents`, `totalSelectors`

- [x] **Verify file paths in JSON are relative**

  All `file` fields should be relative to the target directory, not absolute paths.

### Performance validation

- [x] **Verify impact command runs in under 5 seconds**

  ```bash
  time pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 \
    --atom pressReleaseTitleState
  ```

  The impact command reuses the same 3-pass pipeline as `check`, plus graph building and BFS traversal. The additional overhead should be negligible.

### Cross-check with `check` command

- [x] **Verify `check` command is unaffected**

  ```bash
  pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
  ```

  Output should be identical to before the impact feature was added.

- [x] **All unit tests pass**

  ```bash
  pnpm test
  ```

## Acceptance Criteria

From [PRD section 10](../PRD.md):

- [x] `--atom` mode correctly identifies all direct readers, setters, and initializers for a named atom
- [x] Transitive dependency chains through selectors are traced correctly
- [x] Multi-level chains are traced (atom -> selector A -> selector B -> component)
- [x] Circular selector dependencies do not cause infinite loops
- [x] `--file` mode finds all atom definitions in the given file and shows impact for each
- [x] `--git` mode correctly reads changed files from `git diff` and finds atoms in those files
- [x] JSON output (`--json`) is valid JSON and matches the `ImpactResult` schema
- [x] Text output shows correct file:line references relative to the target directory
- [x] Impact analysis reuses the existing 3-pass pipeline without modifying its output
- [x] Tool runs in under 5 seconds on the `press-release-editor-v3` directory
- [x] Always exits with code 0

# Phase 4: Check Implementation (`checks.ts`)

**Duration**: 0.5 day
**Depends on**: Phase 2, Phase 3
**Blocks**: Phase 5

## Goal

Implement the three detection checks using the extracted definitions and resolved usages.

## Tasks

- [x] **Check 1: Cross-System Boundary**

  Detect Recoil selector `get()` bodies that reference Jotai state.

  **Algorithm:**
  1. Collect all `get()` bodies to walk:
     - Standalone selectors/selectorFamilies: `getBodyAst`
     - Inline default selectors in atoms/atomFamilies: `inlineDefaultGetBody`
  2. Build reference sets:
     - `jotaiNames`: all `JotaiDefinition[].name` (global across all files)
     - `jotaiLocalNames`: `JotaiImport[].localName` scoped to the definition's file
  3. Walk each body with `oxc-walker`'s `walk()`:
     - If any `Identifier.name` matches `jotaiNames` or `jotaiLocalNames` -> **violation**
  4. Exclude the selector's own `get` parameter name from matching (false positive prevention)

  **Known violation to detect:** `medialists.ts:132` -- `isManualMediaListSelectionValidState` references `releaseAdditionalFaxFlgAtom` via `pressReleaseEditorStore.get()`.

- [x] **Check 2: Orphaned Atom**

  Detect Recoil atoms that have readers but no runtime setters (stuck at initial value).

  **Algorithm:**

  For each `RecoilDefinition` where `kind` is `'atom'` or `'atomFamily'`:

  ```
  readers = resolvedUsages.filter(u => u.resolvedName === name AND u.type === 'reader')
  runtimeSetters = resolvedUsages.filter(u => u.resolvedName === name AND u.type === 'setter')
  // Note: usages with type === 'initializer' are excluded from runtimeSetters

  IF readers.length > 0 AND runtimeSetters.length === 0:
    -> Emit error violation with all reader locations as details
  ```

  Readers include `get(X)` calls found inside `inlineDefaultGetBody` ASTs.

- [x] **Check 3: Unused Atom**

  Detect Recoil atoms with no readers, no setters, and no selector dependencies (dead code).

  **Algorithm:**

  For each `RecoilDefinition` where `kind` is `'atom'` or `'atomFamily'`:

  ```
  allUsages = resolvedUsages.filter(u => u.resolvedName === name)
  selectorDeps = atoms referenced in any selector get() body
                 (both standalone getBodyAst AND inlineDefaultGetBody)

  IF allUsages.length === 0 AND name NOT in selectorDeps:
    -> Emit warning violation
  ```

## Tests

### Check 1

- [x] Detects Jotai atom name in standalone selector body
- [x] Detects Jotai atom name in inline default selector body (`atom({ default: selector() })`)
- [x] Detects Jotai store import referenced in selector body
- [x] Does NOT flag the selector's own `get` parameter name
- [x] Does NOT flag identifiers that happen to match Jotai names but are local variables

### Check 2

- [x] Flags atom with 3 readers and 0 runtime setters
- [x] Does NOT flag atom with 3 readers and 1 runtime setter
- [x] Does NOT count initializers (`initialize*` function `set()`) as runtime setters
- [x] Includes reader locations in violation details

### Check 3

- [x] Flags atom with 0 readers and 0 setters
- [x] Does NOT flag atom that is only read inside an inline default selector (it IS a dependency)
- [x] Does NOT flag atom that is only read inside a standalone selector's `get()` body
- [x] Emits as warning (not error)

## Verification

Run against real codebase. Verify:

- Check 1 detects `medialists.ts:132` (the known violation)
- Check 2 results are manually verified -- each flagged atom truly has no runtime setter
- Check 3 results are genuinely unused atoms that can be safely deleted

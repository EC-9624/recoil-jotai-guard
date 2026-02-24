# Phase 5: Reporter and CLI (`reporter.ts`, `index.ts`)

**Duration**: 0.25 day
**Depends on**: Phase 4
**Blocks**: Phase 6

## Goal

Format violation output for terminal display and wire all modules together into the CLI entry point.

## Tasks

- [x] **Implement `reporter.ts`**

  **Grouping and ordering:**
  1. Check 1 violations (errors) -- `[ERROR] Cross-system boundary violations`
  2. Check 2 violations (errors) -- `[ERROR] Orphaned atoms`
  3. Check 3 violations (warnings) -- `[WARN] Unused atoms`
  4. Summary line

  **Output format:**

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

  **Exit code logic:**
  - Any Check 1 or Check 2 violations: exit `1`
  - Only Check 3 warnings or no violations: exit `0`

- [x] **Complete `index.ts` orchestration**

  ```
  1. Parse CLI arguments: target directory (required)
  2. Glob all .ts/.tsx files (recursive, excluding tests/stories)
  3. Run extract.ts on all files -> ExtractionResult
  4. Run collect-usages.ts on all files -> UsageCollectionResult
  5. Run resolve.ts to resolve identifiers -> ResolvedUsage[]
  6. Run checks.ts with all data -> Violation[]
  7. Run reporter.ts to format and print
  8. process.exit() with appropriate code
  ```

  **Additional flags:**
  - `--verbose`: Print all definitions and usages (debugging)
  - Error handling: Graceful file read failures, parse failures (log and continue)

## Tests

- [x] Reporter formats violations correctly (snapshot test)
- [x] Exit code is `1` when errors exist (Check 1 or Check 2)
- [x] Exit code is `0` when only warnings exist (Check 3 only)
- [x] Exit code is `0` when clean (no violations)
- [x] `--verbose` flag prints definition and usage counts

## Verification

Full end-to-end run:

```bash
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
```

Verify output matches expected format and exit code.

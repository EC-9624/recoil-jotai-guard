# Phase 6: Integration Testing

**Duration**: 1 day
**Depends on**: Phase 5

## Goal

Validate the tool against the real `press-release-editor-v3` codebase. Eliminate false positives. Confirm all known violations are detected.

## Tasks

- [x] **Full codebase run**

  ```bash
  pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
  ```

- [x] **Verify Check 1 results**

  **Must detect:**
  - `states/medialists.ts:132` -- `isManualMediaListSelectionValidState` references `releaseAdditionalFaxFlgAtom` via `pressReleaseEditorStore.get()`

  **Must NOT flag (safe cross-system usages):**
  - `states/delivery-settings.ts` -- Jotai hook used inside a React hook (not a selector)
  - `states/contents.ts` -- Pure Jotai re-export
  - `hooks/api/use-auto-save.tsx` -- Jotai setter as side-effect in `useRecoilCallback`
  - `hooks/use-analyze-press-release-location.ts` -- Both systems via React hooks

- [x] **Verify Check 2 results**

  For each flagged orphaned atom:
  - Confirm no runtime setter exists across ALL files
  - Confirm initialization-only setters were correctly excluded
  - If a flagged atom is intentionally read-only (set only during init), document as known exception

- [x] **Verify Check 3 results**

  For each flagged unused atom:
  - Confirm no readers, no setters, no selector dependencies
  - Confirm the atom is genuinely dead code
  - Verify atoms read only inside inline default selectors are NOT flagged (they have selector dependencies)

- [x] **Investigate false positives**

  Common causes:
  - Import resolution failure (barrel file edge case, path alias not resolved)
  - `atomFamily` not recognized (missing `CallExpression` inside hook argument)
  - Initializer not classified (function name doesn't match `initialize*` pattern)
  - Inline default selector body not captured (AST structure mismatch)

  Fix any issues found, re-run, and iterate.

- [x] **Document exceptions**

  If any results are technically correct but contextually expected (e.g., an atom that is intentionally init-only), document them so the team can add `// recoil-jotai-guard-ignore` comments or a config allowlist in a future iteration.

## Acceptance Criteria

From [PRD section 9](../PRD.md#9-success-criteria):

- [x] Check 1 detects the known `medialists.ts:132` cross-system boundary violation
- [x] Check 2 correctly identifies atoms with readers but no runtime setters
- [x] Check 3 correctly identifies atoms with no references at all
- [x] Initialization-only setters are excluded from Check 2's runtime setter count
- [x] `atomFamily` usages (e.g., `useRecoilValue(myFamily(id))`) are resolved correctly
- [x] Import aliases and re-exports are resolved across files
- [x] Tool runs in under 5 seconds on the `press-release-editor-v3` directory
- [x] Zero false positives on the current codebase (aside from known violations)
- [x] Exits with code 1 on Check 1 or Check 2 violations, 0 otherwise

## CI Integration (post-acceptance)

Once validated, add to GitHub Actions:

```yaml
- name: recoil-jotai-guard
  run: |
    npx tsx scripts/recoil-jotai-guard/src/index.ts \
      ./apps/prtimes/src/features/press-release-editor-v3
```

And optionally to the pre-push hook alongside lint/typecheck.

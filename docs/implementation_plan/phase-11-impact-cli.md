# Phase 11: Impact CLI (`impact-cli.ts`)

**Duration**: 0.5 day
**Depends on**: Phase 10
**Blocks**: Phase 12

## Goal

Wire all impact modules together into a CLI entry point. Support three input modes (`--atom`, `--file`, `--git`) and two output formats (text, JSON).

## Tasks

- [x] **Create `src/impact-cli.ts`**

  CLI interface:

  ```
  Usage:
    tsx src/impact-cli.ts <target-directory> --atom <name> [--json] [--verbose]
    tsx src/impact-cli.ts <target-directory> --file <path> [--json] [--verbose]
    tsx src/impact-cli.ts <target-directory> --git [--json] [--verbose]
  ```

  Orchestration flow:

  ```
  1. Parse CLI arguments
  2. Validate: exactly one of --atom, --file, --git must be provided
  3. Glob all files in target directory (via files.ts)
  4. Run Pass 1: extractDefinitions(files)
  5. Run Pass 2: collectUsages(files, extraction)
  6. Run Pass 3: resolveUsages(files, extraction, usages)
  7. Build dependency graph: buildDependencyGraph(extraction, resolved)
  8. Determine target and run analysis:
     - --atom <name>: analyzeAtomImpact(graph, name)
     - --file <path>: analyzeFileImpact(graph, resolvedPath, extraction)
     - --git: get changed files, analyzeGitImpact(graph, changedFiles, extraction)
  9. Format output:
     - --json: formatImpactJson(results, targetDir)
     - default: formatImpactText(results, targetDir)
  10. Print output
  11. Exit 0
  ```

- [x] **Implement argument parsing**

  Parse `process.argv.slice(2)`:
  - Positional arg: target directory (required)
  - `--atom <name>`: next arg is the atom name
  - `--file <path>`: next arg is the file path
  - `--git`: no value argument
  - `--json`: boolean flag
  - `--verbose`: boolean flag

  Validation:
  - Target directory must exist
  - Exactly one of `--atom`, `--file`, `--git` must be provided
  - `--atom` requires a non-empty name value
  - `--file` requires a non-empty path value

- [x] **Implement `--file` path resolution**

  The `--file` path can be:
  - Absolute: use as-is
  - Relative to CWD: resolve against `process.cwd()`
  - Relative to target directory: resolve against the target dir

  Try both resolutions and use whichever exists. If neither exists, error and exit 1.

- [x] **Implement `--git` mode**

  ```typescript
  import { execSync } from 'node:child_process';

  function getGitChangedFiles(targetDir: string): string[] {
    const output = execSync('git diff --name-only HEAD', {
      cwd: targetDir,
      encoding: 'utf8',
    });

    return output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => /\.tsx?$/.test(line))
      .map((line) => path.resolve(targetDir, line));
  }
  ```

  If `git diff` fails (not a git repo, etc.), print error and exit 1.
  If no changed files contain Recoil definitions, print "No changed files with Recoil definitions" and exit 0.

- [x] **Implement `--verbose` output**

  When `--verbose` is set, print pipeline statistics before the impact output (same pattern as `index.ts`):

  ```
  Found 142 files
  Extracted: 57 Recoil definitions, 29 Jotai definitions, 15 Jotai imports
  Collected 340 usages
  Resolved 312 of 340 usages
  Built dependency graph: 45 atoms with deps, 120 component usages
  ```

- [x] **Implement error messages for empty results**

  | Scenario           | Message                                    |
  | ------------------ | ------------------------------------------ |
  | `--atom` not found | `No Recoil definition found for '{name}'`  |
  | `--file` no atoms  | `No Recoil definitions found in {path}`    |
  | `--git` no changes | `No changed files with Recoil definitions` |

  All exit with code 0 (informational).

- [x] **Update `package.json`**

  Add the `impact` script:

  ```json
  {
    "scripts": {
      "check": "tsx src/index.ts",
      "impact": "tsx src/impact-cli.ts",
      "test": "vitest run"
    }
  }
  ```

## Tests

No unit tests for the CLI itself (it's orchestration glue). Tested via integration in Phase 12.

Verify argument parsing manually:

```bash
# Should print usage and exit 1 (no mode flag)
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3

# Should print usage and exit 1 (multiple mode flags)
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --atom foo --file bar.ts

# Should work
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --atom pressReleaseTitleState
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --atom pressReleaseTitleState --json
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --file states/core.ts
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --git
```

## Verification

```bash
# All tests still pass
pnpm test

# check command unchanged
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3

# impact command works
pnpm impact ../../apps/prtimes/src/features/press-release-editor-v3 --atom pressReleaseTitleState
```

## Deliverable

Working `impact` CLI with all three input modes and both output formats. `package.json` updated with `impact` script.

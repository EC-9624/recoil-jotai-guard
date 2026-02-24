# Phase 0: Project Scaffold

**Duration**: 0.25 day
**Depends on**: Nothing
**Blocks**: Phase 1

## Goal

Set up the project structure, install dependencies, and verify that the CLI can find target files.

## Tasks

- [x] **Create directory structure**

  ```
  scripts/recoil-jotai-guard/
    package.json
    tsconfig.json
    src/
      index.ts
      types.ts
      extract.ts
      collect-usages.ts
      resolve.ts
      checks.ts
      reporter.ts
    test/
      fixtures/
  ```

- [x] **Initialize `package.json`**

  ```json
  {
    "name": "recoil-jotai-guard",
    "private": true,
    "type": "module",
    "dependencies": {
      "oxc-parser": "^0.72.0",
      "oxc-walker": "^0.2.0"
    },
    "devDependencies": {
      "vitest": "^3.0.0",
      "typescript": "^5.8.0"
    },
    "scripts": {
      "check": "tsx src/index.ts",
      "test": "vitest run"
    }
  }
  ```

- [x] **Write `types.ts`**

  All shared type definitions from [spec.md section 1.1](../spec.md#11-typests):
  - `RecoilDefinition` (with `getBodyAst` and `inlineDefaultGetBody`)
  - `JotaiDefinition`
  - `JotaiImport`
  - `Usage`
  - `ImportMapping`
  - `Violation`

- [x] **Write minimal `index.ts`**

  Glob all `.ts`/`.tsx` files in the target directory (recursive). Exclude:
  - `node_modules`
  - `__tests__`
  - `__storybook__`
  - `*.test.ts(x)`
  - `*.stories.tsx`

  Print the file count for verification.

## Verification

```bash
pnpm install
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
# Should print: Found N files
```

## Deliverable

Working project scaffold that can find and list target files.

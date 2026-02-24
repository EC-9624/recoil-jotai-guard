# Phase 8: Shared File Glob + Dependency Graph (`files.ts`, `graph.ts`)

**Duration**: 0.75 day
**Depends on**: Phase 7
**Blocks**: Phase 9

## Goal

1. Extract the file globbing logic into a shared module so both `check` and `impact` commands can reuse it.
2. Implement the dependency graph builder that partitions resolved usages into selector dependencies and component usages.

## Tasks

### `files.ts` -- Shared File Globbing

- [x] **Create `src/files.ts`**

  Extract `globFiles()` and `excludePatterns` from `src/index.ts`:

  ```typescript
  const excludePatterns = [
    /node_modules/,
    /__tests__/,
    /__storybook__/,
    /\.test\.tsx?$/,
    /\.stories\.tsx$/,
  ];

  export function globFiles(dir: string): string[] {
    // Recursive directory traversal, same logic as current index.ts
  }
  ```

- [x] **Refactor `src/index.ts`**

  Replace the inline `globFiles` function and `excludePatterns` with an import:

  ```typescript
  import { globFiles } from './files.js';
  ```

  Verify `check` command still works identically.

### `graph.ts` -- Dependency Graph Builder

- [x] **Create `src/graph.ts`**

  Implement `buildDependencyGraph()` per [spec.md section 1.9](../spec.md):

  ```typescript
  import type {
    DependencyGraph,
    ExtractionResult,
    ResolvedUsage,
  } from './types.js';

  export function buildDependencyGraph(
    extraction: ExtractionResult,
    resolvedUsages: ResolvedUsage[],
  ): DependencyGraph {
    const definitions = new Map();
    const dependentSelectors = new Map();
    const componentUsages = new Map();

    // Index definitions by name
    for (const def of extraction.recoilDefinitions) {
      definitions.set(def.name, def);
    }

    // Partition resolved usages
    for (const usage of resolvedUsages) {
      if (usage.hook === 'get(selector)' && usage.enclosingDefinition) {
        // Selector dependency: enclosingDefinition reads usage.resolvedName
        if (!dependentSelectors.has(usage.resolvedName)) {
          dependentSelectors.set(usage.resolvedName, new Set());
        }
        dependentSelectors
          .get(usage.resolvedName)
          .add(usage.enclosingDefinition);
      } else {
        // Component/hook usage
        if (!componentUsages.has(usage.resolvedName)) {
          componentUsages.set(usage.resolvedName, []);
        }
        componentUsages.get(usage.resolvedName).push(usage);
      }
    }

    return { definitions, dependentSelectors, componentUsages };
  }
  ```

## Tests

### `files.ts`

No separate test file needed -- this is a pure extraction refactor. Existing `check` command integration testing covers it.

### `graph.ts`

- [x] **Create `test/graph.test.ts`**

- [x] **Correctly partitions selector deps vs component usages**

  Given resolved usages:
  - `{ resolvedName: 'atomA', hook: 'get(selector)', enclosingDefinition: 'selectorB' }` -> goes to `dependentSelectors`
  - `{ resolvedName: 'atomA', hook: 'useRecoilValue' }` -> goes to `componentUsages`

  Verify `dependentSelectors.get('atomA')` contains `'selectorB'` and `componentUsages.get('atomA')` contains the hook usage.

- [x] **Handles multiple selectors depending on the same atom**

  Given:
  - `{ resolvedName: 'atomA', hook: 'get(selector)', enclosingDefinition: 'selectorB' }`
  - `{ resolvedName: 'atomA', hook: 'get(selector)', enclosingDefinition: 'selectorC' }`

  Verify `dependentSelectors.get('atomA')` is `Set { 'selectorB', 'selectorC' }`.

- [x] **Handles atom with no usages**

  Atom exists in definitions but has zero resolved usages. Verify it appears in `definitions` map but not in `dependentSelectors` or `componentUsages`.

- [x] **Indexes all definitions correctly**

  Given extraction with 3 atoms and 2 selectors, verify `definitions` map has all 5 entries.

- [x] **Handles usages without enclosingDefinition**

  Usages with `hook === 'get(selector)'` but `enclosingDefinition` is `undefined` (shouldn't happen after Phase 7, but defensive). These should go to `componentUsages` rather than crash.

## Verification

```bash
# Tests pass
pnpm test

# check command unchanged
pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
```

## Deliverable

- `files.ts` with shared `globFiles()`, imported by `index.ts`
- `graph.ts` with `buildDependencyGraph()` and tests
- No behavioral change to the `check` command

# Phase 9: Impact Analysis (`impact.ts`)

**Duration**: 0.75 day
**Depends on**: Phase 8
**Blocks**: Phase 10

## Goal

Implement the core impact analysis logic: given a dependency graph and a target atom, compute the full scope of impact including transitive dependencies through selector chains via BFS.

## Tasks

- [x] **Implement `analyzeAtomImpact(graph, atomName)`**

  Core algorithm (BFS with depth tracking):

  ```
  1. Look up the atom definition in graph.definitions
     - If not found, return null
  2. Collect direct component usages from graph.componentUsages
     - Partition into readers, setters, initializers
  3. BFS through selector chain:
     a. Seed queue with graph.dependentSelectors.get(atomName), depth = 1
     b. While queue is not empty:
        - Dequeue { selectorName, depth }
        - Skip if depth > MAX_DEPTH (5) or already visited
        - Look up selector definition and component usages
        - Record as TransitiveDependency { via, viaDefinition, depth, readers, setters }
        - Enqueue selectors that depend on this selector (depth + 1)
  4. Compute summary (unique files, unique component files, selector count)
  5. Return ImpactResult
  ```

  See [spec.md section 1.10](../spec.md) for the full algorithm.

- [x] **Implement `analyzeFileImpact(graph, filePath, extraction)`**

  ```
  1. Resolve the file path to absolute
  2. Filter extraction.recoilDefinitions where def.file === resolvedPath
  3. For each definition, call analyzeAtomImpact(graph, def.name)
  4. Return array of non-null results
  ```

- [x] **Implement `analyzeGitImpact(graph, changedFiles, extraction)`**

  ```
  1. For each changed file path, call analyzeFileImpact()
  2. Flatten and return all results
  ```

## Test Fixtures

New fixtures may be needed for multi-level selector chains:

```typescript
// test/fixtures/impact/atoms.ts
import { atom, selector } from 'recoil';

export const baseAtom = atom({ key: 'baseAtom', default: '' });

export const middleSelector = selector({
  key: 'middleSelector',
  get: ({ get }) => get(baseAtom).toUpperCase(),
});

export const topSelector = selector({
  key: 'topSelector',
  get: ({ get }) => get(middleSelector) + '!',
});

// test/fixtures/impact/consumer.tsx
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { baseAtom, middleSelector, topSelector } from './atoms';

export function BaseReader() {
  const val = useRecoilValue(baseAtom);
  return <div>{val}</div>;
}

export function BaseSetter() {
  const set = useSetRecoilState(baseAtom);
  return <button onClick={() => set('new')}>Set</button>;
}

export function TopReader() {
  const val = useRecoilValue(topSelector);
  return <div>{val}</div>;
}
```

## Tests

- [x] **Create `test/impact.test.ts`**

- [x] **Direct impact only (atom with hook usages, no selector deps)**

  Atom has 2 readers and 1 setter via hooks, no selectors depending on it.
  Verify: direct.readers has 2 entries, direct.setters has 1, transitive is empty.

- [x] **Single-level transitive (atom -> selector -> component)**

  `baseAtom` is read by `middleSelector` via `get()`, and `middleSelector` is used by a component via `useRecoilValue`.
  Verify: transitive has 1 entry with `via: 'middleSelector'`, depth 1, with the component usage.

- [x] **Multi-level transitive (atom -> selectorA -> selectorB -> component)**

  `baseAtom` -> `middleSelector` -> `topSelector` -> component.
  Verify: transitive has 2 entries:
  - `middleSelector` at depth 1
  - `topSelector` at depth 2 with the component usage

- [x] **Circular selector dependencies do not hang**

  Create a scenario where selectorA depends on selectorB and selectorB depends on selectorA.
  Verify: function returns without infinite loop, each selector visited at most once.

- [x] **Depth limit respected**

  Create a chain of 6+ selectors. Verify selectors beyond depth 5 are not included in transitive.

- [x] **Atom with no usages**

  Atom exists but has zero usages and zero selector deps.
  Verify: returns ImpactResult with all empty arrays and summary all zeros.

- [x] **Unknown atom returns null**

  Call `analyzeAtomImpact` with a name not in the graph.
  Verify: returns null.

- [x] **`analyzeFileImpact` finds all atoms in file**

  File contains 2 atom definitions. Verify: returns array of 2 ImpactResults.

- [x] **`analyzeFileImpact` with file containing no atoms**

  File exists but has no Recoil definitions. Verify: returns empty array.

- [x] **Summary counts are correct**

  Verify `totalFiles` counts unique files across direct + transitive, `totalComponents` counts only non-selector usage files, `totalSelectors` counts transitive entries.

## Verification

```bash
pnpm test
```

## Deliverable

`impact.ts` with `analyzeAtomImpact()`, `analyzeFileImpact()`, `analyzeGitImpact()`, and full test coverage.

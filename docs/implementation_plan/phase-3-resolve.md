# Phase 3: Import Resolution (`resolve.ts`)

**Duration**: 1 day
**Depends on**: Phase 1 (needs extraction results)
**Blocks**: Phase 4 (with Phase 2)
**Can run in parallel with**: Phase 2

## Goal

Map every local identifier found in usages to its canonical definition name from the extraction results. Handle import chains, re-exports, barrel files, and aliased imports.

## Tasks

- [x] **Build per-file import map**

  Parse `ImportDeclaration` nodes in every file:

  ```typescript
  // import { myAtom } from './core';
  // -> (thisFile, 'myAtom') => ('./core', 'myAtom')

  // import { myAtom as localAtom } from './core';
  // -> (thisFile, 'localAtom') => ('./core', 'myAtom')
  ```

- [x] **Build re-export chains**

  Parse `ExportNamedDeclaration` with source:

  ```typescript
  // export { myAtom } from './core';
  // -> same as import + re-export
  ```

  Parse `ExportAllDeclaration`:

  ```typescript
  // export * from './core';
  // -> all exports from './core' are available in this file
  ```

- [x] **Resolve file paths**

  Convert relative import specifiers to absolute paths:
  - `./core` -> resolve against the importing file's directory
  - Try extensions in order: `.ts`, `.tsx`, `/index.ts`, `/index.tsx`

- [x] **Follow import chains**

  For each usage's `localName`:
  1. Look up `(usage.file, usage.localName)` in the import map
  2. Follow the chain until reaching a file that defines the atom (from extraction results)
  3. Set `resolvedName` to the canonical definition name
  4. Cap chain depth at 5 to avoid infinite loops from circular re-exports

- [x] **Handle local definitions**

  If the atom is defined in the same file as the usage, no import resolution is needed -- match directly by name.

See [spec.md section 1.4](../spec.md#14-resolvets----pass-3-import-resolution) for the full algorithm.

## Test Fixtures

```typescript
// test/fixtures/resolve/atom-def.ts
import { atom } from 'recoil';
export const coreAtom = atom({ key: 'core', default: '' });

// test/fixtures/resolve/re-export.ts
export { coreAtom } from './atom-def';

// test/fixtures/resolve/barrel.ts
export * from './re-export';

// test/fixtures/resolve/consumer.tsx
import { coreAtom } from './barrel';
import { useRecoilValue } from 'recoil';
const val = useRecoilValue(coreAtom);
// should resolve to 'coreAtom' in atom-def.ts
```

## Tests

- [x] Direct import resolves to definition
- [x] Re-export chain (`A -> B -> C`) resolves correctly
- [x] `export *` barrel resolves correctly
- [x] Aliased import (`import { X as Y }`) resolves correctly
- [x] Depth limit (5) prevents infinite loops
- [x] Local definition (no import needed) resolves correctly

## Edge Cases

- Barrel files (`export * from './core'`): follow recursively, cap at depth 5
- Aliased re-exports (`export { atom as renamedAtom }`): track the rename chain
- Default exports: not used in the codebase for atoms, can be skipped
- Dynamic imports: not used for state, can be skipped

## Verification

Run against real codebase. For each usage, print resolved name and definition file:

```
use-auto-save.tsx:123 getPromise(saveStatusState) -> saveStatusState @ states/core.ts:15
use-auto-save.tsx:302 useRecoilValue(isSystemAdminModeState) -> isSystemAdminModeState @ states/core.ts:42
...
```

Verify known usages resolve correctly.

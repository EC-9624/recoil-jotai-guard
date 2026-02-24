# Technical Specification: Migration Safety Check Tool

## 1. Module Specifications

### 1.1 `types.ts`

All shared type definitions used across modules.

```typescript
type StateKind = 'atom' | 'selector' | 'atomFamily' | 'selectorFamily';

type RecoilDefinition = {
  name: string;
  kind: StateKind;
  file: string;
  line: number;
  getBodyAst: Node | null; // selector/selectorFamily: their own get() body
  inlineDefaultGetBody: Node | null; // atom/atomFamily: the default selector/selectorFamily's get() body
};

type JotaiDefinition = {
  name: string;
  file: string;
  line: number;
};

type JotaiImport = {
  localName: string; // local identifier in the importing file
  importedName: string; // original export name
  source: string; // module specifier: 'jotai', './jotai/store', etc.
  file: string; // file containing the import
};

type UsageType = 'reader' | 'setter' | 'initializer';

type Usage = {
  atomName: string; // resolved canonical definition name
  localName: string; // identifier as it appears in the file
  type: UsageType;
  hook: string; // 'useRecoilValue' | 'useSetRecoilState' | 'useRecoilState'
  // | 'set(callback)' | 'reset(callback)' | 'getPromise(callback)'
  // | 'get(selector)' | 'set(initializer)'
  file: string;
  line: number;
  enclosingDefinition?: string; // name of the selector/atom that contains this get() call
  // (only set for usages with hook === 'get(selector)')
};

type ImportMapping = {
  localName: string; // name in the importing file
  canonicalName: string; // resolved definition name from extract.ts
  sourceFile: string; // resolved absolute file path
};

type ViolationSeverity = 'error' | 'warning';

type Violation = {
  check: 1 | 2 | 3;
  severity: ViolationSeverity;
  atomOrSelectorName: string;
  message: string;
  location: { file: string; line: number };
  details: string[]; // supporting info (e.g., reader locations for Check 2)
};

// --- Impact analysis types ---

type DependencyGraph = {
  // atom/selector name -> set of selector names that read it via get()
  dependentSelectors: Map<string, Set<string>>;
  // atom/selector name -> component/hook usages (non-selector)
  componentUsages: Map<string, ResolvedUsage[]>;
  // name -> definition (quick lookup)
  definitions: Map<string, RecoilDefinition>;
};

type ImpactResult = {
  target: {
    name: string;
    kind: StateKind;
    file: string;
    line: number;
  };
  direct: {
    readers: ResolvedUsage[];
    setters: ResolvedUsage[];
    initializers: ResolvedUsage[];
  };
  transitive: TransitiveDependency[];
  summary: ImpactSummary;
};

type TransitiveDependency = {
  via: string; // selector name in the dependency chain
  viaDefinition: { file: string; line: number; kind: StateKind };
  depth: number; // 1 = direct selector dependency, 2+ = chained
  readers: ResolvedUsage[];
  setters: ResolvedUsage[];
};

type ImpactSummary = {
  totalFiles: number; // unique files across all usages
  totalComponents: number; // unique files with hook usages (not selector get() calls)
  totalSelectors: number; // selectors in the transitive chain
};
```

---

### 1.2 `extract.ts` -- Pass 1: Definition Extraction

#### Purpose

Parse each file with `oxc-walker` to collect all Recoil and Jotai state definitions and all Jotai-related imports.

#### Input

- Array of absolute file paths (`.ts`, `.tsx`)

#### Output

```typescript
type ExtractionResult = {
  recoilDefinitions: RecoilDefinition[];
  jotaiDefinitions: JotaiDefinition[];
  jotaiImports: JotaiImport[]; // per-file Jotai import records
};
```

#### AST Patterns to Detect

**Recoil import tracking:**

```
ImportDeclaration where source.value === 'recoil'
  -> ImportSpecifier where imported.name in ['atom', 'selector', 'atomFamily', 'selectorFamily']
  -> Record local alias: localNames[imported.name] = local.name
```

Example AST match:

```typescript
import { atom as recoilAtom, selector } from 'recoil';
// localNames = { atom: 'recoilAtom', selector: 'selector', ... }
```

**Recoil definition extraction:**

```
CallExpression
  where callee.type === 'Identifier'
  and callee.name in Object.values(localNames)
  and parent.type === 'VariableDeclarator'
  and parent.id.type === 'Identifier'
  -> Record: { name: parent.id.name, kind: matchedKind, file, line }
```

**Selector `get()` body capture:**

For `selector()` calls, the first argument is an ObjectExpression with a `get` property. The value of `get` is the function whose body we need:

```
CallExpression (selector)
  -> arguments[0].type === 'ObjectExpression'
  -> properties.find(p => p.key.name === 'get')
  -> p.value is FunctionExpression or ArrowFunctionExpression
  -> Capture p.value.body as getBodyAst
```

For `selectorFamily()`, the `get` property's value is a function that returns a function:

```
CallExpression (selectorFamily)
  -> arguments[0].properties.find(p => p.key.name === 'get')
  -> p.value is ArrowFunctionExpression (outer: receives param)
  -> p.value.body is ArrowFunctionExpression (inner: receives {get})
  -> Capture inner.body as getBodyAst
```

**Inline default selector extraction (`atom({ default: selector() })`):**

When extracting an `atom()` or `atomFamily()` definition, also inspect the `default` property
of its config object for a nested `selector()` or `selectorFamily()` call. If found, capture
the inline selector's `get()` body and store it as `inlineDefaultGetBody` on the parent
atom's `RecoilDefinition`.

There are 7 instances in the codebase (3 `atom` + `selector`, 4 `atomFamily` + `selectorFamily`).

Sub-pattern A: `atom({ default: selector({ get({get}) { ... } }) })`

```
CallExpression (atom)
  -> arguments[0].type === 'ObjectExpression'
  -> properties.find(p => p.key.name === 'default')
  -> IF p.value.type === 'CallExpression'
     AND p.value.callee.name matches selector alias:
     -> p.value.arguments[0].properties.find(q => q.key.name === 'get')
     -> q.value is FunctionExpression (method shorthand: get({get}) { ... })
        or ArrowFunctionExpression
     -> Capture q.value.body as inlineDefaultGetBody
```

Real-world example from the codebase:

```typescript
// core.ts:91-103
export const shouldShowReleaseCountLimitAlertState = atom<boolean>({
  key: globalThis.crypto.randomUUID(),
  default: selector({
    // <-- nested selector
    key: globalThis.crypto.randomUUID(),
    async get({ get }) {
      // <-- capture this body
      if (get(pressReleaseEditModeState) !== ReleaseDeliveryStatus.Draft)
        return false;
      const response = await getPressReleaseShouldShowLimitAlert();
      return response.data.shouldShowLimitAlert;
    },
  }),
});
```

Sub-pattern B: `atomFamily({ default: selectorFamily({ get: (id) => ({get}) => ... }) })`

```
CallExpression (atomFamily)
  -> arguments[0].type === 'ObjectExpression'
  -> properties.find(p => p.key.name === 'default')
  -> IF p.value.type === 'CallExpression'
     AND p.value.callee.name matches selectorFamily alias:
     -> p.value.arguments[0].properties.find(q => q.key.name === 'get')
     -> q.value is ArrowFunctionExpression (outer: receives param)
     -> q.value.body is ArrowFunctionExpression (inner: receives {get})
     -> Capture inner.body as inlineDefaultGetBody
```

Real-world example from the codebase:

```typescript
// images.ts:112-128
export const pressReleaseImageFileNameState = atomFamily<...>({
  key: globalThis.crypto.randomUUID(),
  default: selectorFamily({                     // <-- nested selectorFamily
    key: globalThis.crypto.randomUUID(),
    get:
      (id) =>                                   // <-- outer function (param)
      ({get}) => {                              // <-- inner function (capture this body)
        const initValue = get(pressReleaseImageInitialValueList).find(
          (image) => image.atomId === id,
        );
        return initValue?.fileName || pressReleaseImageDefault.fileName;
      },
  }),
});
```

Note: The inline selector/selectorFamily is anonymous (no variable name). It is NOT recorded
as a separate `RecoilDefinition` -- it is only stored as the `inlineDefaultGetBody` on the
parent atom/atomFamily definition.

**Jotai import tracking:**

```
ImportDeclaration where:
  source.value === 'jotai'
  OR source.value starts with 'jotai/'
  OR source.value contains '/jotai/'

  SKIP if ImportDeclaration.importKind === 'type'  (import type {...} from 'jotai')

  -> For each ImportSpecifier:
     SKIP if specifier.importKind === 'type'       (import {type Foo} from 'jotai')
     -> Record JotaiImport
```

Type-only imports (e.g., `import type { SetStateAction } from 'jotai'`,
`import { type createStore } from 'jotai'`) must be excluded. They are not
runtime references and would cause false positives in Check 1 if treated
as Jotai identifiers.

**Jotai definition extraction:**

```
ImportDeclaration where source.value === 'jotai'
  -> ImportSpecifier where imported.name === 'atom'
  -> Track local alias

CallExpression
  where callee.name matches jotai atom alias
  and parent.type === 'VariableDeclarator'
  -> Record JotaiDefinition

Also detect from 'jotai/utils':
  atomFamily, atomWithDefault, atomWithReset, atomWithStorage, atomWithReducer
```

#### Edge Cases

- `atom()` with `default: selector({...})` inline -- handled above via `inlineDefaultGetBody` (3 instances in codebase)
- `atomFamily()` with `default: selectorFamily({...})` -- handled above via `inlineDefaultGetBody` (4 instances in codebase)
- Exported vs non-exported definitions -- both should be captured
- `crypto.randomUUID()` as key -- irrelevant to extraction, ignore
- `async get()` in inline default selectors (e.g., `core.ts:95`) -- the body is still captured the same way; async does not change the AST structure of the function body

---

### 1.3 `collect-usages.ts` -- Pass 2: Usage Collection

#### Purpose

Scan all files for Recoil hook calls and `set`/`get`/`reset` calls to build a complete map of readers, setters, and initializers for every atom.

#### Input

- Array of absolute file paths

#### Output

```typescript
type UsageCollectionResult = {
  usages: Usage[];
};
```

#### AST Patterns to Detect

**Pattern U1: `useRecoilValue(X)` -- Reader**

```
CallExpression
  where callee.type === 'Identifier'
  and callee.name === useRecoilValue local alias
  and arguments[0].type === 'Identifier'
  -> Usage { atomName: arguments[0].name, type: 'reader', hook: 'useRecoilValue' }
```

**Pattern U2: `useRecoilValue(atomFamily(id))` -- Reader (atomFamily variant)**

```
CallExpression (outer: useRecoilValue)
  where arguments[0].type === 'CallExpression'
  and arguments[0].callee.type === 'Identifier'
  -> Usage { atomName: arguments[0].callee.name, type: 'reader', hook: 'useRecoilValue' }
```

**Pattern U3: `useSetRecoilState(X)` -- Setter**

```
CallExpression
  where callee.name === useSetRecoilState local alias
  and arguments[0].type === 'Identifier' (or CallExpression for atomFamily)
  -> Usage { atomName: ..., type: 'setter', hook: 'useSetRecoilState' }
```

**Pattern U4: `useRecoilState(X)` -- Reader + Setter**

Emit two usages: one reader and one setter.

```
CallExpression
  where callee.name === useRecoilState local alias
  -> Usage { type: 'reader', hook: 'useRecoilState' }
  -> Usage { type: 'setter', hook: 'useRecoilState' }
```

**Pattern U5: `useResetRecoilState(X)` -- Setter**

```
CallExpression
  where callee.name === useResetRecoilState local alias
  -> Usage { type: 'setter', hook: 'useResetRecoilState' }
```

**Pattern U6: `useRecoilCallback(({set, snapshot, reset}) => ...)` -- Context-dependent**

This is the most complex pattern. Steps:

1. Detect `useRecoilCallback(callbackFn)` call
2. The callback function's first parameter is a destructured object: `{set, snapshot, reset}`
3. Track which names are bound to `set`, `snapshot`/`getPromise`, and `reset`
4. Walk the callback body for calls using those tracked names

**Detecting the destructured parameter:**

The codebase uses two distinct destructuring styles for the callback parameter.
Both must be handled.

**Style A: Inline nested destructuring (most common, ~25 instances)**

```typescript
useRecoilCallback(({ snapshot: { getPromise }, set }) => async () => {
  const val = await getPromise(someAtom);
  set(otherAtom, val);
});
```

AST structure:

```
CallExpression (useRecoilCallback)
  -> arguments[0] is ArrowFunctionExpression
  -> arguments[0].params[0].type === 'ObjectPattern'
  -> For each Property in ObjectPattern.properties:

     // Simple property (set, reset):
     IF property.key.name === 'set' AND property.value.type === 'Identifier':
       -> setAlias = property.value.name (or property.key.name if shorthand)
     IF property.key.name === 'reset' AND property.value.type === 'Identifier':
       -> resetAlias = property.value.name

     // Nested destructuring (snapshot: {getPromise}):
     IF property.key.name === 'snapshot' AND property.value.type === 'ObjectPattern':
       -> For each nested Property in property.value.properties:
          IF nested.key.name === 'getPromise':
            -> getPromiseAlias = nested.value.name (or nested.key.name if shorthand)
       -> snapshotAlias = null (snapshot itself is not bound to a variable)

     // Non-nested snapshot:
     IF property.key.name === 'snapshot' AND property.value.type === 'Identifier':
       -> snapshotAlias = property.value.name
```

**Style B: Snapshot as variable, method call (~10 instances)**

```typescript
useRecoilCallback(({ set, snapshot }) => async () => {
  const val = await snapshot.getPromise(someAtom);
  set(otherAtom, val);
});
```

AST structure: same as above but `snapshot` is bound to an `Identifier`, not
destructured into an `ObjectPattern`.

**Detecting `set(X, ...)` inside the callback:**

```
CallExpression inside callback body
  where callee.type === 'Identifier'
  and callee.name === setAlias
  and arguments[0].type === 'Identifier' (or CallExpression for atomFamily)
  -> Usage { type: 'setter', hook: 'set(callback)' }
```

**Detecting `reset(X)` inside the callback:**

```
CallExpression inside callback body
  where callee.name === resetAlias
  -> Usage { type: 'setter', hook: 'reset(callback)' }
```

**Detecting `snapshot.getPromise(X)` -- three sub-patterns:**

Sub-pattern 1: Inline nested destructuring `({snapshot: {getPromise}})` then `getPromise(X)`

```
// getPromiseAlias was extracted from the nested ObjectPattern above
CallExpression inside callback body
  where callee.type === 'Identifier'
  and callee.name === getPromiseAlias
  -> Usage { type: 'reader', hook: 'getPromise(callback)' }
```

Real-world example:

```typescript
// use-auto-save.tsx:117
useRecoilCallback(({ snapshot: { getPromise }, set }) => async () => {
  if ((await getPromise(saveStatusState)) === 'SAVING') return;
  //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^ sub-pattern 1
});
```

Sub-pattern 2: `snapshot` as variable, then `snapshot.getPromise(X)`

```
CallExpression inside callback body
  where callee.type === 'MemberExpression'
  and callee.object.name === snapshotAlias
  and callee.property.name === 'getPromise'
  -> Usage { type: 'reader', hook: 'getPromise(callback)' }
```

Real-world example:

```typescript
// use-proofreading-v3/index.ts:36-41
useRecoilCallback(({ set, reset, snapshot }) => async () => {
  const title = await snapshot.getPromise(pressReleaseTitleState);
  //                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ sub-pattern 2
});
```

Sub-pattern 3: `snapshot` destructured in the body `const {getPromise} = snapshot`

```
VariableDeclarator inside callback body
  where init.type === 'Identifier'
  and init.name === snapshotAlias
  and id.type === 'ObjectPattern'
  -> For each Property in id.properties:
     IF property.key.name === 'getPromise':
       -> track getPromise alias

CallExpression where callee.name === getPromiseAlias
  -> Usage { type: 'reader', hook: 'getPromise(callback)' }
```

Note: Sub-pattern 3 does not appear in the current codebase but is included for
completeness. Sub-patterns 1 and 2 cover all ~48 existing `getPromise` usages.

**Pattern U7: `get(X)` inside a Recoil selector -- Reader**

Inside a selector's `get()` function body (already captured in extract.ts), the `get` parameter is used to read atoms:

```
// The get() body is walked separately during Check 1
// For Check 2/3, we walk all selector get() bodies here:
CallExpression
  where callee.name === get parameter alias
  and arguments[0].type === 'Identifier'
  -> Usage {
       type: 'reader',
       hook: 'get(selector)',
       enclosingDefinition: parentDefinition.name  // the selector/atom that contains this get() body
     }
```

The `enclosingDefinition` field is set only for `get(selector)` usages. It records which selector (or atom with inline default selector) contains the `get()` call. This is required by the `impact` command to build the selector-to-atom dependency graph for transitive traversal.

Implementation: `collectFromSelectorBodies()` already iterates over `extraction.recoilDefinitions` and knows `def.name`. Pass `def.name` into `walkSelectorGetBody()` as a parameter and set `enclosingDefinition` on each produced `Usage`.

#### Initializer Detection

A setter is classified as an **initializer** (not a runtime setter) when it appears inside:

1. A function whose name matches `/^initialize/i`
2. A `RecoilRoot` `initializeState` callback

Detection:

```
// Walk up the parent chain from a set() call
// If any ancestor FunctionDeclaration/FunctionExpression/ArrowFunctionExpression
// has a name matching /^initialize/i -> mark as initializer

// For initializeState:
// The set() call is inside a callback passed to RecoilRoot's initializeState prop
// Pattern: JSXAttribute where name === 'initializeState' -> value is function
// set() calls inside that function -> initializer
```

Pragmatic approach: check if the enclosing function name starts with `initialize` (case-insensitive). This matches the codebase convention (`initializePressReleaseContents`, `initializePressReleaseFiles`, etc.).

---

### 1.4 `resolve.ts` -- Pass 3: Import Resolution

#### Purpose

Map each local identifier found in usages to its canonical definition name from the extraction results.

#### Input

- All file paths
- `ExtractionResult` from Pass 1
- `UsageCollectionResult` from Pass 2

#### Output

```typescript
type ResolvedUsage = Usage & {
  resolvedName: string; // canonical definition name
  definitionFile: string; // file where the atom/selector is defined
};
```

#### Algorithm

**Step 1: Build per-file import map**

For each file, parse `ImportDeclaration` nodes:

```typescript
// import { myAtom } from './core';
// -> (thisFile, 'myAtom') => ('./core', 'myAtom')

// import { myAtom as localAtom } from './core';
// -> (thisFile, 'localAtom') => ('./core', 'myAtom')
```

**Step 2: Build re-export chains**

For each file, parse:

```typescript
// export { myAtom } from './core';
// -> same as import + re-export

// export * from './core';
// -> all exports from './core' are available in this file
```

**Step 3: Resolve file paths**

Convert relative import specifiers to absolute paths:

- `./core` -> resolve against the importing file's directory
- Try extensions: `.ts`, `.tsx`, `/index.ts`, `/index.tsx`

**Step 4: Resolve usage identifiers**

For each `Usage`:

1. Look up `(usage.file, usage.localName)` in the import map
2. Follow the chain until reaching a file that defines the atom (from `ExtractionResult`)
3. Set `resolvedName` to the canonical definition name

**Step 5: Handle local definitions**

If the atom is defined in the same file as the usage, no import resolution is needed -- match directly by name.

#### Edge Cases

- Barrel files (`export * from './core'`): follow recursively, cap depth at 5 to avoid infinite loops
- Aliased re-exports (`export { atom as renamedAtom }`): track the rename chain
- Default exports: not used in the codebase for atoms, can be skipped
- Dynamic imports: not used for state, can be skipped

---

### 1.5 `checks.ts` -- Check Logic

#### Check 1: Cross-System Boundary

```
Input:
  recoilDefinitions (ALL -- selectors, selectorFamilies, atoms, atomFamilies)
  jotaiDefinitions (all names)
  jotaiImports (per-file)

Algorithm:
  jotaiNames = Set of all jotaiDefinitions[].name

  // Collect all get() bodies to walk (both standalone selectors and inline defaults)
  getBodiesToCheck = []

  For each RecoilDefinition:
    // Standalone selectors/selectorFamilies
    IF kind is 'selector' or 'selectorFamily' AND getBodyAst is not null:
      getBodiesToCheck.push({ ast: getBodyAst, definition })

    // Inline default selectors inside atoms/atomFamilies
    IF kind is 'atom' or 'atomFamily' AND inlineDefaultGetBody is not null:
      getBodiesToCheck.push({ ast: inlineDefaultGetBody, definition })

  For each { ast, definition } in getBodiesToCheck:
    jotaiLocalNames = Set of jotaiImports[].localName where file === definition.file

    walk(ast, {
      enter(node) {
        if node.type === 'Identifier':
          if node.name in jotaiNames -> violation
          if node.name in jotaiLocalNames -> violation
      }
    })
```

**False positive mitigation:**

- The Recoil `get` parameter itself is an Identifier -- exclude identifiers that match the selector's own `get` parameter name
- Exclude identifiers that match local variable declarations within the `get()` body (unless those locals are assigned from Jotai imports)

#### Check 2: Orphaned Atom

```
Input:
  recoilDefinitions (atoms and atomFamilies only)
  resolvedUsages

Algorithm:
  For each RecoilDefinition where kind is 'atom' or 'atomFamily':
    readers = resolvedUsages.filter(
      u => u.resolvedName === definition.name
      AND u.type === 'reader'
    )
    runtimeSetters = resolvedUsages.filter(
      u => u.resolvedName === definition.name
      AND u.type === 'setter'
    )

    IF readers.length > 0 AND runtimeSetters.length === 0:
      -> Emit violation with reader locations as details
```

#### Check 3: Unused Atom

```
Input:
  recoilDefinitions (atoms and atomFamilies only)
  resolvedUsages
  selectorDependencies (atoms referenced in selector get() bodies, INCLUDING inline default selectors)

Algorithm:
  For each RecoilDefinition where kind is 'atom' or 'atomFamily':
    allUsages = resolvedUsages.filter(u => u.resolvedName === definition.name)
    isSelectorDep = selectorDependencies includes definition.name

    IF allUsages.length === 0 AND NOT isSelectorDep:
      -> Emit warning
```

Note: `selectorDependencies` must include atoms read inside inline default selectors
(i.e., `inlineDefaultGetBody`), not just standalone selector `get()` bodies. For example,
`pressReleaseImageInitialValueList` is only read inside 4 inline `selectorFamily` defaults
in `images.ts`. Without this, it would be incorrectly flagged as unused.

---

### 1.6 `reporter.ts` -- Output Formatting

Groups violations by check number and severity. Prints file:line references for navigation.

**Ordering:**

1. Check 1 violations (errors)
2. Check 2 violations (errors)
3. Check 3 violations (warnings)
4. Summary line

**Exit code logic:**

- Any Check 1 or Check 2 violations: exit 1
- Only Check 3 warnings or no violations: exit 0

---

### 1.7 `index.ts` -- CLI Entry Point

```
1. Parse CLI arguments: target directory (required)
2. Glob all .ts and .tsx files in target directory (recursive)
   Exclude: node_modules, __tests__, __storybook__, *.test.ts(x), *.stories.tsx
3. Run extract.ts on all files -> ExtractionResult
4. Run collect-usages.ts on all files -> UsageCollectionResult
5. Run resolve.ts to resolve identifiers -> ResolvedUsage[]
6. Run checks.ts with all data -> Violation[]
7. Run reporter.ts to format and print
8. Exit with appropriate code
```

---

### 1.8 `files.ts` -- Shared File Globbing

#### Purpose

Extract the file globbing logic (currently inline in `index.ts`) into a shared module so both `index.ts` (`check` command) and `impact-cli.ts` (`impact` command) can reuse it.

#### Exports

```typescript
function globFiles(dir: string): string[];
```

#### Behavior

Recursively globs all `.ts` and `.tsx` files in the given directory. Excludes:

- `node_modules`
- `__tests__`
- `__storybook__`
- `*.test.ts(x)`
- `*.stories.tsx`

This is a pure extraction refactor -- no behavior change from the existing `globFiles` in `index.ts`.

---

### 1.9 `graph.ts` -- Dependency Graph Builder

#### Purpose

Build a dependency graph from the extraction results and resolved usages. The graph maps each atom/selector to its dependent selectors (via `get()` calls) and its component usages (via hooks).

#### Input

- `ExtractionResult` from Pass 1
- `ResolvedUsage[]` from Pass 3

#### Output

```typescript
type DependencyGraph = {
  dependentSelectors: Map<string, Set<string>>;
  componentUsages: Map<string, ResolvedUsage[]>;
  definitions: Map<string, RecoilDefinition>;
};
```

#### Algorithm

```
function buildDependencyGraph(extraction, resolvedUsages):
  graph = empty DependencyGraph

  // Index definitions by name
  For each def in extraction.recoilDefinitions:
    graph.definitions.set(def.name, def)

  // Partition resolved usages
  For each usage in resolvedUsages:
    IF usage.hook === 'get(selector)' AND usage.enclosingDefinition is set:
      // This is a selector dependency: enclosingDefinition reads usage.resolvedName
      graph.dependentSelectors
        .getOrCreate(usage.resolvedName)
        .add(usage.enclosingDefinition)
    ELSE:
      // This is a component/hook usage
      graph.componentUsages
        .getOrCreate(usage.resolvedName)
        .push(usage)

  return graph
```

The key insight: usages with `hook === 'get(selector)'` and a non-null `enclosingDefinition` represent selector-to-atom dependencies. The `enclosingDefinition` is the selector that reads the atom, and `resolvedName` is the atom being read. All other usages are component-level hook calls.

---

### 1.10 `impact.ts` -- Impact Analysis

#### Purpose

Given a dependency graph and a target atom/selector, compute the full scope of impact including transitive dependencies through selector chains.

#### Input

- `DependencyGraph` from `graph.ts`
- Target: atom name, file path, or list of file paths (from git)

#### Output

```typescript
type ImpactResult = {
  target: { name: string; kind: StateKind; file: string; line: number };
  direct: {
    readers: ResolvedUsage[];
    setters: ResolvedUsage[];
    initializers: ResolvedUsage[];
  };
  transitive: TransitiveDependency[];
  summary: ImpactSummary;
};
```

#### Algorithm: `analyzeAtomImpact(graph, atomName)`

Uses BFS to traverse the dependency graph with depth tracking:

```
function analyzeAtomImpact(graph, atomName):
  definition = graph.definitions.get(atomName)
  IF not found: return null

  // Direct component usages
  directUsages = graph.componentUsages.get(atomName) ?? []
  direct.readers = directUsages.filter(u => u.type === 'reader')
  direct.setters = directUsages.filter(u => u.type === 'setter')
  direct.initializers = directUsages.filter(u => u.type === 'initializer')

  // Transitive traversal via BFS
  transitive = []
  queue = []   // items: { selectorName, depth }
  visited = Set()

  // Seed the queue with direct dependent selectors
  directDependentSelectors = graph.dependentSelectors.get(atomName) ?? Set()
  For each selectorName in directDependentSelectors:
    queue.push({ selectorName, depth: 1 })

  WHILE queue is not empty:
    { selectorName, depth } = queue.shift()

    IF depth > MAX_DEPTH (5):
      continue
    IF visited.has(selectorName):
      continue
    visited.add(selectorName)

    selectorDef = graph.definitions.get(selectorName)
    selectorUsages = graph.componentUsages.get(selectorName) ?? []

    transitive.push({
      via: selectorName,
      viaDefinition: { file: selectorDef.file, line: selectorDef.line, kind: selectorDef.kind },
      depth,
      readers: selectorUsages.filter(u => u.type === 'reader'),
      setters: selectorUsages.filter(u => u.type === 'setter'),
    })

    // Follow the chain: which selectors depend on this selector?
    nextSelectors = graph.dependentSelectors.get(selectorName) ?? Set()
    For each nextSelector in nextSelectors:
      IF not visited.has(nextSelector):
        queue.push({ selectorName: nextSelector, depth: depth + 1 })

  // Compute summary
  allFiles = Set of all unique files across direct and transitive usages
  componentFiles = Set of files with non-selector hook usages
  summary = {
    totalFiles: allFiles.size,
    totalComponents: componentFiles.size,
    totalSelectors: transitive.length,
  }

  return { target: { name, kind, file, line }, direct, transitive, summary }
```

#### Helper: `analyzeFileImpact(graph, filePath, extraction)`

```
function analyzeFileImpact(graph, filePath, extraction):
  // Find all Recoil definitions in the given file
  atoms = extraction.recoilDefinitions.filter(d => d.file === resolvedFilePath)

  results = []
  For each atom in atoms:
    result = analyzeAtomImpact(graph, atom.name)
    IF result is not null:
      results.push(result)

  return results
```

#### Helper: `analyzeGitImpact(graph, changedFiles, extraction)`

```
function analyzeGitImpact(graph, changedFiles, extraction):
  results = []
  For each filePath in changedFiles:
    results.push(...analyzeFileImpact(graph, filePath, extraction))
  return results
```

#### Edge Cases

- Atom with no usages at all: return an `ImpactResult` with empty direct and transitive arrays, summary all zeros
- Circular selector dependencies (A depends on B depends on A): handled by the `visited` set in BFS -- each selector is visited at most once
- Depth limit exceeded: selectors beyond depth 5 are silently skipped (same convention as import chain resolution)
- Atom defined but not in graph definitions: return null (caller handles)

---

### 1.11 `impact-reporter.ts` -- Impact Output Formatting

#### Purpose

Format `ImpactResult` arrays for terminal display (text) or machine consumption (JSON).

#### Text Formatter: `formatImpactText(results, targetDir)`

For each `ImpactResult`:

```
Impact: {name} ({kind})
Defined at: {relativePath}:{line}

  Direct:
    READERS ({count}):
      {relativePath}:{line}    {hook}
      ...
    SETTERS ({count}):
      {relativePath}:{line}    {hook}
      ...
    INITIALIZERS ({count}):
      {relativePath}:{line}    {hook}
      ...

  Transitive (via selectors):
    {selectorName} ({relativePath}:{line}) [depth {n}]:
      {relativePath}:{line}    {hook}
      ...

  Summary: {totalFiles} files, {totalComponents} components, {totalSelectors} selectors
```

If a section is empty (e.g., no initializers, no transitive deps), omit it entirely.

When multiple `ImpactResult`s are shown (e.g., `--file` mode with multiple atoms in the file), separate them with a blank line and a horizontal rule (`---`).

#### JSON Formatter: `formatImpactJson(results, targetDir)`

Serialize the `ImpactResult[]` as JSON. File paths are made relative to `targetDir`. If there is exactly one result, output the single object (not an array). If multiple, output an array.

#### Shared

Both formatters reuse the `relativePath()` helper pattern from `reporter.ts`.

---

### 1.12 `impact-cli.ts` -- Impact CLI Entry Point

#### Purpose

CLI entry point for the `impact` command. Parses arguments, runs the shared 3-pass pipeline, builds the dependency graph, runs impact analysis, and formats output.

#### CLI Interface

```
Usage:
  tsx src/impact-cli.ts <target-directory> --atom <name> [--json] [--verbose]
  tsx src/impact-cli.ts <target-directory> --file <path> [--json] [--verbose]
  tsx src/impact-cli.ts <target-directory> --git [--json] [--verbose]

Arguments:
  <target-directory>    Directory to scan (required)

Options:
  --atom <name>         Analyze impact of a specific atom by name
  --file <path>         Analyze impact of all atoms defined in a file
  --git                 Analyze impact of atoms in git-changed files
  --json                Output as JSON instead of text
  --verbose             Print pipeline statistics (definition/usage counts)
```

Exactly one of `--atom`, `--file`, or `--git` must be provided. If none or multiple are given, print usage and exit 1.

#### `--git` Mode

Runs `git diff --name-only HEAD` (or a configurable base ref) from the target directory's git root. Filters results to `.ts`/`.tsx` files within the target directory. Then treats the result as if the user had passed `--file` for each changed file.

#### Orchestration Flow

```
1. Parse CLI arguments
2. Validate: exactly one of --atom, --file, --git
3. Glob all files in target directory (via files.ts)
4. Run Pass 1: extractDefinitions(files)
5. Run Pass 2: collectUsages(files, extraction)
6. Run Pass 3: resolveUsages(files, extraction, usages)
7. Build dependency graph: buildDependencyGraph(extraction, resolved)
8. Determine target atoms:
   - --atom: use directly
   - --file: resolve path, find definitions in that file
   - --git: get changed files, find definitions in those files
9. Run analyzeAtomImpact() for each target atom
10. Format output (text or JSON via impact-reporter.ts)
11. Print output
12. Exit 0
```

#### Error Handling

- Unknown atom name (`--atom`): print "No Recoil definition found for '{name}'" and exit 0
- No atoms in file (`--file`): print "No Recoil definitions found in {path}" and exit 0
- No git changes (`--git`): print "No changed files with Recoil definitions" and exit 0
- File not found (`--file`): print error and exit 1
- Git command failure (`--git`): print error and exit 1

---

### 1.13 `setter-bindings.ts` -- Setter Binding Map Builder (V1: Single-Level Wrappers)

#### Purpose

Build a map from setter variable identifiers to the state (atom) they write to. Handles direct hook calls (`useSetRecoilState(atom)`) and single-level wrapper hooks whose return expression is a direct hook call.

This module is only invoked when `--writer-mode runtime` is passed to the `impact` command.

#### V1 Scope

V1 handles three wrapper patterns:

- **W1**: Arrow shorthand `() => useSetRecoilState(atom)`
- **W2**: Return statement `function useSetX() { return useSetRecoilState(atom); }`
- **W4**: Tuple `() => useRecoilState(atom)`

V1 does NOT handle:

- Object-returning wrappers (`return { setFoo, setBar }`) -- deferred to V2
- Nested wrappers (wrapper calling wrapper) -- deferred to V2
- Recursive wrapper resolution is not needed in V1

#### Input

- Array of absolute file paths
- `ExtractionResult` from Pass 1
- Import resolution data from Pass 3 (to resolve wrapper function definitions across files)

#### Output

```typescript
type HookWriteBindingKind = 'setter' | 'tuple';

type HookWriteBinding = {
  kind: HookWriteBindingKind;
  stateId: string; // canonical atom name
};

// Main output: maps "file:identifierName" -> canonical atom name
type SetterBindingMap = Map<string, string>;
```

#### Algorithm: `buildSetterBindings(files, extraction, importMap)`

```
function buildSetterBindings(files, extraction, importMap):
  setterBindings = Map<string, string>()  // "file:name" -> atomName
  wrapperCache = Map<string, HookWriteBinding | null>()

  For each file in files:
    ast = parse(file)
    walk(ast, {
      enter(node) {
        IF node.type === 'VariableDeclarator'
        AND node.init?.type === 'CallExpression':
          binding = resolveHookWriteBinding(
            node.init, file, extraction, importMap, wrapperCache
          )
          IF binding:
            bindSetterIdentifiers(node, binding, file, setterBindings)
      }
    })

  return setterBindings
```

#### Algorithm: `resolveHookWriteBinding(callExpr, file, ...)`

Tries direct hook resolution first, then single-level wrapper resolution.

```
function resolveHookWriteBinding(callExpr, file, extraction, importMap, wrapperCache):
  // Step 1: Try direct resolution (is this useSetRecoilState/useRecoilState itself?)
  directBinding = resolveDirectHookWriteBinding(callExpr, file)
  IF directBinding:
    return directBinding

  // Step 2: Resolve callee to its function definition (single level only)
  calleeName = callExpr.callee.name  // e.g., "useSetPressReleaseBodyJson"
  functionDef = resolveCalleeToFunctionDefinition(calleeName, file, importMap)
  IF NOT functionDef:
    return undefined

  // Step 3: Check cache
  cacheKey = functionDef.file + ":" + functionDef.line
  cached = wrapperCache.get(cacheKey)
  IF cached !== undefined:
    return cached ?? undefined

  // Step 4: Analyze the wrapper's return expression
  binding = analyzeWrapperReturnExpression(functionDef)
  wrapperCache.set(cacheKey, binding ?? null)
  return binding
```

#### Algorithm: `resolveDirectHookWriteBinding(callExpr, file)`

Checks if the call is a direct Recoil setter/tuple hook.

```
function resolveDirectHookWriteBinding(callExpr, file):
  calleeName = callExpr.callee.name

  // Check against Recoil hook names (accounting for local aliases)
  recoilAliases = getRecoilImportAliases(file)  // from the file's import declarations

  IF calleeName matches recoilAliases['useSetRecoilState']:
    atomName = extractAtomName(callExpr.arguments[0])
    return { kind: 'setter', stateId: atomName }

  IF calleeName matches recoilAliases['useResetRecoilState']:
    atomName = extractAtomName(callExpr.arguments[0])
    return { kind: 'setter', stateId: atomName }

  IF calleeName matches recoilAliases['useRecoilState']:
    atomName = extractAtomName(callExpr.arguments[0])
    return { kind: 'tuple', stateId: atomName }

  return undefined
```

#### Algorithm: `analyzeWrapperReturnExpression(functionDef)`

Extracts the return expression from the wrapper function and checks if it is a direct hook call. This is the key simplification in V1: no local variable tracking, no recursive resolution, no object returns.

```
function analyzeWrapperReturnExpression(functionDef):
  returnExpr = getReturnExpression(functionDef)
  IF NOT returnExpr:
    return undefined

  // The return expression must be a direct hook call
  // e.g., () => useSetRecoilState(fooState)        (arrow shorthand)
  // e.g., return useSetRecoilState(fooState)        (return statement)
  // e.g., () => useRecoilState(fooState)            (tuple variant)
  IF returnExpr.type === 'CallExpression':
    return resolveDirectHookWriteBinding(returnExpr, functionDef.file)

  return undefined
```

Helper to get the return expression from a function:

```
function getReturnExpression(functionDef):
  // Arrow shorthand: () => expr
  IF functionDef is ArrowFunctionExpression AND body is NOT Block:
    return body  // the expression itself

  // Block body: find the first ReturnStatement in the function's own scope
  IF functionDef.body is Block:
    For each ReturnStatement in body (own scope only, skip nested functions):
      IF returnStatement.argument exists:
        return returnStatement.argument

  return undefined
```

#### Algorithm: `bindSetterIdentifiers(declarator, binding, file, setterBindings)`

Maps the declared variable names to atom names in the binding map.

```
function bindSetterIdentifiers(declarator, binding, file, setterBindings):
  // Case 1: Simple identifier -- const setFoo = useSetFoo()
  IF binding.kind === 'setter' AND declarator.id.type === 'Identifier':
    setterBindings.set(file + ":" + declarator.id.name, binding.stateId)

  // Case 2: Array destructuring -- const [foo, setFoo] = useFoo()
  IF binding.kind === 'tuple' AND declarator.id.type === 'ArrayPattern':
    setterElement = declarator.id.elements[1]  // second element is the setter
    IF setterElement?.type === 'Identifier':
      setterBindings.set(file + ":" + setterElement.name, binding.stateId)
```

#### Callee-to-Function Resolution

To follow wrapper hooks across files, the callee identifier must be resolved to its function definition. This leverages the existing import resolution infrastructure:

```
function resolveCalleeToFunctionDefinition(calleeName, file, importMap):
  // Step 1: Check if calleeName is defined in the same file
  //   (a VariableDeclarator or FunctionDeclaration whose name matches)
  localDef = findLocalFunctionDefinition(calleeName, file)
  IF localDef: return localDef

  // Step 2: Check imports
  importEntry = importMap.get(file + ":" + calleeName)
  IF importEntry:
    // Resolve to the source file and find the function definition there
    sourceDef = findExportedFunctionDefinition(importEntry.canonicalName, importEntry.sourceFile)
    IF sourceDef: return sourceDef
    // Handle re-exports: follow the chain (reuse resolve.ts logic, depth-capped)

  return undefined
```

A "function definition" here means either:

- A `FunctionDeclaration` with the matching name
- A `VariableDeclarator` whose `init` is an `ArrowFunctionExpression` or `FunctionExpression`

The resolved definition includes the file path and the AST node of the function body, which is then parsed for return expressions.

#### Edge Cases

- **Cache**: Each wrapper function definition is analyzed at most once per pipeline run; results are memoized by `"file:line"` key
- **Arrow shorthand**: `() => useSetRecoilState(X)` -- the "return expression" is the body itself (the `CallExpression`), not wrapped in a `ReturnStatement`
- **Non-hook wrappers**: Functions that don't return a setter hook call -- `analyzeWrapperReturnExpression` returns `undefined`, cached as `null`
- **Same-file wrappers**: Wrappers defined and consumed in the same file -- no import resolution needed, just AST lookup by name
- **Wrapper returning non-call expression**: If the return is an `Identifier` (e.g., `return localSetter`), V1 does not follow it -- this is a V2 pattern (nested wrappers)

---

### 1.14 `setter-callsites.ts` -- Runtime Write Callsite Classification

#### Purpose

Given a setter binding map, scan all files for `CallExpression` nodes whose callee is a known setter identifier. Each such call is classified as a runtime write site.

#### Input

- All file paths
- `SetterBindingMap` from `setter-bindings.ts`

#### Output

```typescript
type RuntimeWriteCallsite = {
  atomName: string; // canonical atom name being written
  file: string;
  line: number;
  calleeName: string; // the identifier name used at the callsite
};
```

#### Algorithm

```
function collectRuntimeWriteCallsites(files, setterBindings):
  callsites = []

  For each file in files:
    ast = parse(file)
    walk(ast, {
      enter(node) {
        IF node.type === 'CallExpression'
        AND node.callee.type === 'Identifier':
          key = file + ":" + node.callee.name
          atomName = setterBindings.get(key)
          IF atomName:
            callsites.push({
              atomName,
              file,
              line: node.callee.start line,
              calleeName: node.callee.name,
            })
      }
    })

  return callsites
```

#### False Positive Mitigation

The binding map uses `"file:identifierName"` keys, which scopes the lookup to the file where the setter was declared/imported. Since `oxc-parser` has no symbol table:

1. **Shadowed variables**: If a local variable shadows a setter name (e.g., `const setFoo = (x) => x + 1` inside a nested scope), it could be incorrectly classified. Mitigated by only binding setters from `VariableDeclarator` nodes whose initializer is a recognized hook call or wrapper.

2. **Callback parameters**: If a function takes a parameter named `setFoo`, calls to it would be false positives. Unlikely in practice (setter names are conventionally unique), but documented as a known limitation.

---

### 1.15 Impact Integration: Coverage-First Writers

#### Changes to `impact-cli.ts`

After the standard 3-pass pipeline, always run the setter binding pipeline:

```
1. Build setter bindings: buildSetterBindings(files, extraction, importMap)
2. Collect runtime write callsites: collectRuntimeWriteCallsites(files, setterBindings)
3. Pass both callsites AND original factory-site usages to impact analysis for coverage merge
```

A hidden `--writer-mode legacy` flag is accepted but not shown in `--help`. When present, skip steps 1-3 and use factory-only output (pre-Phase-13 behavior).

#### Changes to `impact.ts`

The `analyzeAtomImpact` function gains an optional `runtimeCallsites` parameter for coverage merge:

```
function analyzeAtomImpact(graph, atomName, options?):
  // ... existing code for direct.readers and transitive ...

  factorySetters = componentUsages.filter(u => u.type === 'setter')

  IF options?.runtimeCallsites:
    runtimeForAtom = options.runtimeCallsites.filter(c => c.atomName === atomName)

    // Determine which factory sites were resolved (their wrapper returned runtime callsites)
    resolvedFactoryFiles = Set of factory setter files whose wrapper was successfully traced
    // A factory site is "resolved" if buildSetterBindings resolved its wrapper function
    // to a binding, meaning runtime callsites exist for that wrapper path

    direct.setters = [
      ...runtimeForAtom.map(c => toResolvedUsage(c, 'runtime')),
      ...factorySetters
        .filter(f => NOT resolvedFactoryFiles.has(f))
        .map(f => markAs(f, 'fallback')),
    ]
  ELSE:
    // Legacy mode (hidden --writer-mode legacy)
    direct.setters = factorySetters
```

#### Resolved vs Fallback Classification

A factory site is classified as **resolved** (excluded from output) when:

- The `useSetRecoilState(atom)` call at that factory site was inside a wrapper function
- That wrapper function was successfully analyzed by `setter-bindings.ts`
- At least one runtime callsite was found for the resulting setter variable

A factory site is classified as **fallback** (kept in output) when:

- The wrapper function could NOT be resolved (e.g., W3/W5 patterns in V1)
- OR the factory site is a direct `useSetRecoilState` in a component (not inside a wrapper)
  and no runtime callsite was found for it in the same file

This ensures zero coverage loss: every write path is represented by either a runtime callsite or a fallback factory site.

#### Changes to `impact-reporter.ts`

The "SETTERS" section header changes to "WRITERS" and each entry is labeled:

```
  WRITERS (3 runtime, 1 fallback):
    hooks/use-editor/index.ts:102      runtime    setter call
    hooks/use-editor/index.ts:122      runtime    setter call
    pages/step1/Header/index.tsx:108   runtime    setter call
    states/contents.ts:125             fallback   useSetRecoilState
```

Runtime entries are listed first, then fallback entries. The summary count shows both.

In JSON output, setter entries in `direct.setters` gain a `writerKind` field:

```json
{
  "file": "hooks/use-editor/index.ts",
  "line": 102,
  "hook": "setter call",
  "writerKind": "runtime"
}
```

```json
{
  "file": "states/contents.ts",
  "line": 125,
  "hook": "useSetRecoilState",
  "writerKind": "fallback"
}
```

When `--writer-mode legacy` is used, the output is unchanged from pre-Phase-13: "SETTERS" header, no `writerKind` field.

---

### 1.16 Updated File Structure

```
scripts/
  recoil-jotai-guard/
    src/
      index.ts              # `check` CLI entry point
      impact-cli.ts         # `impact` CLI entry point (+ coverage-first writers)
      files.ts              # Shared file globbing
      extract.ts            # Pass 1: definitions
      collect-usages.ts     # Pass 2: hook usages
      resolve.ts            # Pass 3: import resolution
      checks.ts             # Check 1, 2, 3
      reporter.ts           # Check output formatting
      graph.ts              # Dependency graph builder
      impact.ts             # Impact analysis (+ coverage merge)
      impact-reporter.ts    # Impact output formatting (+ runtime/fallback display)
      setter-bindings.ts    # NEW: Setter binding map + wrapper resolution
      setter-callsites.ts   # NEW: Runtime write callsite classification
      types.ts              # Shared types (+ new setter binding types)
    test/
      setter-bindings.test.ts    # NEW
      setter-callsites.test.ts   # NEW
      fixtures/
        wrapper-hooks/           # NEW: fixtures for wrapper patterns
```

---

## 2. AST Node Types Reference

Key `oxc-parser` node types used in this tool:

| Node Type                 | Where Used               | What It Represents                       |
| ------------------------- | ------------------------ | ---------------------------------------- |
| `ImportDeclaration`       | extract, usages, resolve | `import { X } from 'Y'`                  |
| `ImportSpecifier`         | extract, resolve         | Individual named import `{ X as Y }`     |
| `ExportNamedDeclaration`  | resolve                  | `export { X } from 'Y'`                  |
| `ExportAllDeclaration`    | resolve                  | `export * from 'Y'`                      |
| `CallExpression`          | extract, usages          | Any function call `f(args)`              |
| `Identifier`              | all modules              | Any named reference `X`                  |
| `VariableDeclarator`      | extract                  | `const X = ...`                          |
| `ObjectExpression`        | extract                  | `{ key: value }` in atom/selector config |
| `ObjectPattern`           | usages                   | `({set, snapshot})` destructuring        |
| `ArrowFunctionExpression` | extract, usages          | `(x) => ...`                             |
| `FunctionExpression`      | extract, usages          | `function(x) { ... }`                    |
| `MemberExpression`        | usages                   | `snapshot.getPromise`                    |
| `ArrayPattern`            | setter-bindings          | `[val, setter] = useFoo()` destructuring |
| `ReturnStatement`         | setter-bindings          | `return expr` inside wrapper functions   |
| `FunctionDeclaration`     | setter-bindings          | `function useSetFoo() { ... }`           |

---

## 3. Known Limitations

### Shared (both commands)

1. **No cross-file function body analysis**: If a Recoil selector calls a helper function defined in another file, and that helper reads Jotai state internally, the tool will not detect it. Only direct references in the selector's own `get()` body are checked.

2. **String-based name matching**: Identifier resolution relies on name matching, not type-level analysis. If two different atoms in different files share the same export name, the tool may produce false positives or false negatives.

3. **Dynamic atom creation**: Atoms created inside functions at runtime (not at module scope) are not detected by the extractor.

4. **`useRecoilCallback` nesting**: If a `useRecoilCallback` contains another `useRecoilCallback` (unlikely but possible), only the outermost callback's destructured parameters are tracked.

5. **Re-export depth**: Import chain resolution is capped at depth 5 to prevent infinite loops from circular re-exports.

### Impact-specific

6. **Recoil-only dependency graph**: The impact analysis only traces Recoil atom/selector dependency chains. Jotai atoms and their derived atoms are not included in the graph. If a Recoil atom is consumed by Jotai code (outside the selector `get()` body), that usage is not shown.

7. **Transitive depth limit**: Selector dependency chains deeper than 5 levels are truncated. This is unlikely in practice but theoretically possible.

8. **`--git` mode depends on git state**: The `--git` mode compares against `HEAD` (unstaged/staged changes). It does not detect atoms affected by changes in other files (e.g., if you change a selector's logic but the atom it reads is in a different file that wasn't modified).

### Wrapper-aware setter tracking specific (`--writer-mode runtime`, V1)

9. **No symbol table**: Without `ts-morph`'s symbol table, setter binding resolution uses `"file:identifierName"` string keys. If two setter variables in the same file share a name in different scopes, only the last binding is kept. This is unlikely in practice.

10. **Single-level wrappers only (V1)**: V1 only resolves wrappers whose return expression is a direct hook call (`useSetRecoilState`, `useRecoilState`). Nested wrappers (wrapper calling wrapper) and object-returning wrappers (`return { setFoo }`) are not resolved. These are planned for V2.

11. **Computed property access**: Callsites using computed property access (e.g., `actions['setFoo']()`) are not detected. Only direct `Identifier` callees are matched.

12. **Setter passed as callback**: If a setter is passed as a callback to another function (e.g., `onChange(setFoo)`), the invocation site is inside the called function, which is not traced. Only direct `setFoo(value)` calls are classified as runtime writes.

13. **`useRecoilCallback` setters**: The `set` destructured from `useRecoilCallback(({set}) => ...)` is a different kind of setter (callback-scoped, not hook-returned). These are already handled by the existing `collect-usages.ts` patterns (U6) and are NOT duplicated by the wrapper tracking. The `--writer-mode runtime` flag only affects hook-returned setters (`useSetRecoilState`, `useRecoilState`).

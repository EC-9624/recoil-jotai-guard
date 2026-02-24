# Phase 7: Enrich Usages with `enclosingDefinition`

**Duration**: 0.5 day
**Depends on**: Phase 6 (all existing phases complete)
**Blocks**: Phase 8

## Goal

Add an `enclosingDefinition` field to the `Usage` type so that `get(selector)` usages record which selector/atom contains the `get()` call. This is required to build the selector-to-atom dependency graph for impact analysis.

## Tasks

- [x] **Update `types.ts`**

  Add optional field to `Usage`:

  ```typescript
  type Usage = {
    atomName: string;
    localName: string;
    type: UsageType;
    hook: string;
    file: string;
    line: number;
    enclosingDefinition?: string; // NEW
  };
  ```

  Add new types for the impact command (see [spec.md section 1.1](../spec.md#11-typests)):
  - `DependencyGraph`
  - `ImpactResult`
  - `TransitiveDependency`
  - `ImpactSummary`

- [x] **Update `collect-usages.ts` -- `walkSelectorGetBody()`**

  Add a `definitionName: string` parameter:

  ```typescript
  // Before:
  function walkSelectorGetBody(bodyNode, filePath, source, usages): void;

  // After:
  function walkSelectorGetBody(
    bodyNode,
    filePath,
    source,
    usages,
    definitionName,
  ): void;
  ```

  Set `enclosingDefinition` on each produced usage:

  ```typescript
  usages.push({
    atomName,
    localName: atomName,
    type: 'reader',
    hook: 'get(selector)',
    file: filePath,
    line,
    enclosingDefinition: definitionName, // NEW
  });
  ```

- [x] **Update `collect-usages.ts` -- `collectFromSelectorBodies()`**

  Pass `def.name` through to `walkSelectorGetBody()`:

  ```typescript
  // Standalone selector/selectorFamily get() body
  if (
    (def.kind === 'selector' || def.kind === 'selectorFamily') &&
    def.getBodyAst
  ) {
    walkSelectorGetBody(def.getBodyAst, def.file, source, usages, def.name);
  }

  // Inline default selector get() body
  if (
    (def.kind === 'atom' || def.kind === 'atomFamily') &&
    def.inlineDefaultGetBody
  ) {
    walkSelectorGetBody(
      def.inlineDefaultGetBody,
      def.file,
      source,
      usages,
      def.name,
    );
  }
  ```

  For inline default selectors, the `definitionName` is the parent atom/atomFamily name (since the inline selector is anonymous).

## Tests

- [x] **Update `test/collect-usages.test.ts`**

  Verify that usages with `hook === 'get(selector)'` have `enclosingDefinition` set:
  - Standalone selector `mySelector` reading `myAtom` via `get(myAtom)` should have `enclosingDefinition: 'mySelector'`
  - Inline default selector in `myAtomWithDefault` reading `someOtherAtom` should have `enclosingDefinition: 'myAtomWithDefault'`

- [x] **Verify existing tests still pass**

  The `enclosingDefinition` field is optional, so all existing usages (hook-based) will have it `undefined`. No existing test assertions should break.

  ```bash
  pnpm test
  ```

- [x] **Verify `check` command still works**

  The `checks.ts` module does not use `enclosingDefinition`, so the `check` command should produce identical output.

  ```bash
  pnpm check ../../apps/prtimes/src/features/press-release-editor-v3
  ```

## Verification

Run the full test suite and the `check` command against the real codebase. Both should produce identical results to before this change.

## Deliverable

`Usage` type enriched with `enclosingDefinition`. All existing tests passing. No behavioral change to the `check` command.

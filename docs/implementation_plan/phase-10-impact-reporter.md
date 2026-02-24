# Phase 10: Impact Reporter (`impact-reporter.ts`)

**Duration**: 0.5 day
**Depends on**: Phase 9
**Blocks**: Phase 11

## Goal

Implement text and JSON formatters for `ImpactResult` arrays. The text formatter produces terminal-friendly grouped output. The JSON formatter produces machine-readable structured output.

## Tasks

- [x] **Implement `formatImpactText(results, targetDir)`**

  For each `ImpactResult`, produce:

  ```
  Impact: {name} ({kind})
  Defined at: {relativePath}:{line}

    Direct:
      READERS ({count}):
        {relativePath}:{line}    {hook}
      SETTERS ({count}):
        {relativePath}:{line}    {hook}
      INITIALIZERS ({count}):
        {relativePath}:{line}    {hook}

    Transitive (via selectors):
      {selectorName} ({relativePath}:{line}) [depth {n}]:
        {relativePath}:{line}    {hook}

    Summary: {totalFiles} files, {totalComponents} components, {totalSelectors} selectors
  ```

  Rules:
  - Omit empty sections (e.g., if no initializers, skip that heading entirely)
  - Omit "Transitive" section if no transitive dependencies
  - File paths are relative to `targetDir`
  - Separate multiple results with `\n---\n`
  - If results array is empty, return "No impact found."

- [x] **Implement `formatImpactJson(results, targetDir)`**

  Serialize `ImpactResult[]` as JSON with the following rules:
  - File paths are made relative to `targetDir`
  - If exactly one result, output the single object (not wrapped in array)
  - If multiple results, output as JSON array
  - `ResolvedUsage` objects are simplified to `{ file, line, hook, type }` (drop internal fields like `atomName`, `localName`, `resolvedName`, `definitionFile`)
  - Pretty-print with 2-space indentation

  Simplified usage shape in JSON:

  ```typescript
  type JsonUsage = {
    file: string; // relative path
    line: number;
    hook: string;
    type: UsageType;
  };
  ```

- [x] **Reuse `relativePath()` helper**

  Import or duplicate the `path.relative()` pattern from `reporter.ts`. If both reporters need the same helper, consider extracting it to a shared utility (or inline it -- it's a one-liner).

## Tests

- [x] **Create `test/impact-reporter.test.ts`**

- [x] **Text formatter: single atom with direct and transitive deps**

  Given an ImpactResult with 2 direct readers, 1 setter, and 1 transitive selector chain.
  Verify output contains:
  - "Impact: myAtom (atom)"
  - "READERS (2):"
  - "SETTERS (1):"
  - "Transitive (via selectors):"
  - "Summary: X files, Y components, 1 selectors"

- [x] **Text formatter: omits empty sections**

  Given an ImpactResult with no initializers and no transitive deps.
  Verify output does NOT contain "INITIALIZERS" or "Transitive" headings.

- [x] **Text formatter: multiple results separated by ---**

  Given 2 ImpactResults. Verify they are separated by `---`.

- [x] **Text formatter: empty results**

  Given empty array. Verify output is "No impact found."

- [x] **Text formatter: relative paths**

  Given absolute file paths and a targetDir. Verify all paths in output are relative.

- [x] **JSON formatter: single result outputs object (not array)**

  Given 1 ImpactResult. Verify output is a JSON object (starts with `{`).
  Parse and verify structure matches schema.

- [x] **JSON formatter: multiple results outputs array**

  Given 2 ImpactResults. Verify output is a JSON array (starts with `[`).

- [x] **JSON formatter: relative paths in output**

  Verify all `file` fields in JSON output are relative to targetDir.

- [x] **JSON formatter: simplified usage shape**

  Verify usage objects in JSON only contain `file`, `line`, `hook`, `type` (no `atomName`, `resolvedName`, etc.).

## Verification

```bash
pnpm test
```

## Deliverable

`impact-reporter.ts` with `formatImpactText()` and `formatImpactJson()`, plus full test coverage.

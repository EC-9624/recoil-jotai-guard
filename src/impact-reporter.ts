import type {
  ImpactResult,
  ResolvedUsage,
  UsageType,
  WriterKind,
} from './types.js';
import {relativePath} from './utils.js';

/**
 * Format a single usage line: "  {relativePath}:{line}    {hook}"
 */
function formatUsageLine(
  usage: ResolvedUsage,
  targetDirectory: string,
): string {
  const relativeFile = relativePath(usage.file, targetDirectory);
  return `      ${relativeFile}:${usage.line}    ${usage.hook}`;
}

/**
 * Format a single writer line with writerKind label:
 * "  {relativePath}:{line}    {writerKind}    {hook}"
 */
function formatWriterLine(
  usage: ResolvedUsage,
  targetDirectory: string,
): string {
  const relativeFile = relativePath(usage.file, targetDirectory);
  const kind = usage.writerKind ?? 'fallback';
  return `      ${relativeFile}:${usage.line}    ${kind}    ${usage.hook}`;
}

/**
 * Determine whether setters use coverage-first mode (have writerKind set).
 * If ANY setter has writerKind, we use coverage-first display.
 */
function isCoverageMode(setters: readonly ResolvedUsage[]): boolean {
  return setters.some((s) => s.writerKind !== undefined);
}

/**
 * Format the setters/writers section lines for the text formatter.
 * Uses WRITERS header in coverage mode, SETTERS header in legacy mode.
 */
function formatSetterSection(
  setters: readonly ResolvedUsage[],
  targetDirectory: string,
): string[] {
  if (isCoverageMode(setters)) {
    const runtimeCount = setters.filter(
      (s) => s.writerKind === 'runtime',
    ).length;
    const fallbackCount = setters.filter(
      (s) => s.writerKind === 'fallback',
    ).length;
    const sectionLines = [
      `    WRITERS (${runtimeCount} runtime, ${fallbackCount} fallback):`,
    ];
    for (const usage of setters) {
      sectionLines.push(formatWriterLine(usage, targetDirectory));
    }

    return sectionLines;
  }

  const sectionLines = [`    SETTERS (${setters.length}):`];
  for (const usage of setters) {
    sectionLines.push(formatUsageLine(usage, targetDirectory));
  }

  return sectionLines;
}

/**
 * Format ImpactResult[] as terminal-friendly grouped text output.
 *
 * Rules:
 * - Omit empty sections (e.g., if no initializers, skip that heading entirely)
 * - Omit "Transitive" section if no transitive dependencies
 * - File paths are relative to targetDirectory
 * - Separate multiple results with \n---\n
 * - If results array is empty, return "No impact found."
 */
export function formatImpactText(
  results: ImpactResult[],
  targetDirectory: string,
): string {
  if (results.length === 0) {
    return 'No impact found.';
  }

  const blocks: string[] = [];

  for (const result of results) {
    const lines: string[] = [];

    // Header
    const relativeFile = relativePath(result.target.file, targetDirectory);
    lines.push(
      `Impact: ${result.target.name} (${result.target.kind})`,
      `Defined at: ${relativeFile}:${result.target.line}`,
    );

    // Direct section
    const hasReaders = result.direct.readers.length > 0;
    const hasSetters = result.direct.setters.length > 0;
    const hasInitializers = result.direct.initializers.length > 0;
    const hasDirect = hasReaders || hasSetters || hasInitializers;

    if (hasDirect) {
      lines.push('', '  Direct:');

      if (hasReaders) {
        lines.push(`    READERS (${result.direct.readers.length}):`);
        for (const usage of result.direct.readers) {
          lines.push(formatUsageLine(usage, targetDirectory));
        }
      }

      if (hasSetters) {
        lines.push(
          ...formatSetterSection(result.direct.setters, targetDirectory),
        );
      }

      if (hasInitializers) {
        lines.push(`    INITIALIZERS (${result.direct.initializers.length}):`);
        for (const usage of result.direct.initializers) {
          lines.push(formatUsageLine(usage, targetDirectory));
        }
      }
    }

    // Transitive section
    if (result.transitive.length > 0) {
      lines.push('', '  Transitive (via selectors):');

      for (const dep of result.transitive) {
        const depRelativeFile = relativePath(
          dep.viaDefinition.file,
          targetDirectory,
        );
        lines.push(
          `    ${dep.via} (${depRelativeFile}:${dep.viaDefinition.line}) [depth ${dep.depth}]:`,
        );

        const allUsages: ResolvedUsage[] = [...dep.readers, ...dep.setters];
        for (const usage of allUsages) {
          lines.push(formatUsageLine(usage, targetDirectory));
        }
      }
    }

    // Summary
    lines.push(
      '',
      `  Summary: ${result.summary.totalFiles} files, ${result.summary.totalComponents} components, ${result.summary.totalSelectors} selectors`,
    );

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n---\n\n');
}

/**
 * Simplified usage shape for JSON output.
 * Drops internal fields like atomName, localName, resolvedName, definitionFile.
 */
type JsonUsage = {
  file: string;
  line: number;
  hook: string;
  type: UsageType;
  writerKind?: WriterKind;
};

/**
 * Simplify a ResolvedUsage to the JSON-friendly shape with relative paths.
 * Includes writerKind only when present (coverage-first mode).
 */
function simplifyUsage(
  usage: ResolvedUsage,
  targetDirectory: string,
): JsonUsage {
  const base: JsonUsage = {
    file: relativePath(usage.file, targetDirectory),
    line: usage.line,
    hook: usage.hook,
    type: usage.type,
  };
  if (usage.writerKind) {
    base.writerKind = usage.writerKind;
  }

  return base;
}

/**
 * Convert an ImpactResult to a JSON-serializable object with relative paths
 * and simplified usage shapes.
 */
function toJsonObject(result: ImpactResult, targetDirectory: string) {
  return {
    target: {
      name: result.target.name,
      kind: result.target.kind,
      file: relativePath(result.target.file, targetDirectory),
      line: result.target.line,
    },
    direct: {
      readers: result.direct.readers.map((u) =>
        simplifyUsage(u, targetDirectory),
      ),
      setters: result.direct.setters.map((u) =>
        simplifyUsage(u, targetDirectory),
      ),
      initializers: result.direct.initializers.map((u) =>
        simplifyUsage(u, targetDirectory),
      ),
    },
    transitive: result.transitive.map((dep) => ({
      via: dep.via,
      viaDefinition: {
        file: relativePath(dep.viaDefinition.file, targetDirectory),
        line: dep.viaDefinition.line,
        kind: dep.viaDefinition.kind,
      },
      depth: dep.depth,
      readers: dep.readers.map((u) => simplifyUsage(u, targetDirectory)),
      setters: dep.setters.map((u) => simplifyUsage(u, targetDirectory)),
    })),
    summary: result.summary,
  };
}

/**
 * Serialize ImpactResult[] as JSON with the following rules:
 * - File paths are made relative to targetDirectory
 * - If exactly one result, output the single object (not wrapped in array)
 * - If multiple results, output as JSON array
 * - ResolvedUsage objects are simplified to { file, line, hook, type }
 * - Pretty-print with 2-space indentation
 */
export function formatImpactJson(
  results: ImpactResult[],
  targetDirectory: string,
): string {
  const jsonObjects = results.map((r) => toJsonObject(r, targetDirectory));

  const output = jsonObjects.length === 1 ? jsonObjects[0] : jsonObjects;

  return JSON.stringify(output, null, 2);
}

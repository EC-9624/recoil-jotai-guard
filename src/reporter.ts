import type {Violation} from './types.js';
import {relativePath} from './utils.js';

/**
 * Format violations for terminal output.
 *
 * Grouping order:
 * 1. Check 1 violations (errors) -- Cross-system boundary
 * 2. Check 2 violations (errors) -- Orphaned atoms
 * 3. Check 3 violations (warnings) -- Unused atoms
 * 4. Summary line
 */
export function formatViolations(
  violations: Violation[],
  targetDir: string,
): string {
  if (violations.length === 0) {
    return 'No violations found.';
  }

  const lines: string[] = [];

  const check1 = violations.filter((v) => v.check === 1);
  const check2 = violations.filter((v) => v.check === 2);
  const check3 = violations.filter((v) => v.check === 3);

  // Check 1: Cross-system boundary violations
  if (check1.length > 0) {
    lines.push('[ERROR] Cross-system boundary violations:', '');

    for (const v of check1) {
      const relFile = relativePath(v.location.file, targetDir);
      lines.push(`  ${relFile}:${v.location.line}`, `  ${v.message}`, '');
    }
  }

  // Check 2: Orphaned atoms
  if (check2.length > 0) {
    lines.push('[ERROR] Orphaned atoms (readers but no runtime setter):', '');

    for (const v of check2) {
      const relFile = relativePath(v.location.file, targetDir);
      lines.push(
        `  ${relFile}:${v.location.line} -> ${v.atomOrSelectorName}`,
        `  Readers (${v.details.length}):`,
      );
      for (const detail of v.details) {
        // Relativize any absolute paths in detail strings
        const relDetail = detail.replace(/\/[^\s:]+/, (match) =>
          relativePath(match, targetDir),
        );
        lines.push(`    ${relDetail}`);
      }

      lines.push('  Runtime setters: none', '');
    }
  }

  // Check 3: Unused atoms
  if (check3.length > 0) {
    lines.push('[WARN] Unused atoms (safe to delete):', '');

    for (const v of check3) {
      const relFile = relativePath(v.location.file, targetDir);
      lines.push(`  ${relFile}:${v.location.line} -> ${v.atomOrSelectorName}`);
    }

    lines.push('');
  }

  // Summary
  const errorCount = check1.length + check2.length;
  const warningCount = check3.length;
  const parts: string[] = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  }

  if (warningCount > 0) {
    parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  }

  lines.push(`Summary: ${parts.join(', ')}`);

  return lines.join('\n');
}

/**
 * Determine the CLI exit code based on violations.
 *
 * - Any Check 1 or Check 2 violations: exit 1
 * - Only Check 3 warnings or no violations: exit 0
 */
export function getExitCode(violations: Violation[]): number {
  return violations.some((v) => v.severity === 'error') ? 1 : 0;
}

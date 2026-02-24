import {describe, expect, it} from 'vitest';
import {formatViolations, getExitCode} from '../src/reporter.js';
import type {Violation} from '../src/types.js';

const targetDir = '/project/src/features/editor';

describe('reporter', () => {
  it('formats violations correctly', () => {
    const violations: Violation[] = [
      {
        check: 1,
        severity: 'error',
        atomOrSelectorName: 'badSelector',
        message:
          "Recoil selector 'badSelector' references Jotai identifier 'jotaiAtom'",
        location: {file: `${targetDir}/states/core.ts`, line: 42},
        details: ["Jotai identifier 'jotaiAtom' found in selector get() body"],
      },
      {
        check: 2,
        severity: 'error',
        atomOrSelectorName: 'orphanAtom',
        message:
          "Recoil atom 'orphanAtom' has 2 reader(s) but no runtime setters",
        location: {file: `${targetDir}/states/data.ts`, line: 10},
        details: [
          `${targetDir}/hooks/use-data.tsx:15  useRecoilValue`,
          `${targetDir}/hooks/use-other.tsx:30  useRecoilValue`,
        ],
      },
      {
        check: 3,
        severity: 'warning',
        atomOrSelectorName: 'unusedAtom',
        message: "Recoil atom 'unusedAtom' is unused",
        location: {file: `${targetDir}/states/old.ts`, line: 5},
        details: [],
      },
    ];

    const output = formatViolations(violations, targetDir);

    // Check structure
    expect(output).toContain('[ERROR] Cross-system boundary violations:');
    expect(output).toContain('[ERROR] Orphaned atoms');
    expect(output).toContain('[WARN] Unused atoms');
    expect(output).toContain('Summary:');
    expect(output).toContain('2 errors');
    expect(output).toContain('1 warning');

    // Check file references are relative
    expect(output).toContain('states/core.ts:42');
    expect(output).toContain('states/data.ts:10');
    expect(output).toContain('states/old.ts:5');
  });

  it('exit code is 1 when errors exist (Check 1)', () => {
    const violations: Violation[] = [
      {
        check: 1,
        severity: 'error',
        atomOrSelectorName: 'badSelector',
        message: 'violation',
        location: {file: 'file.ts', line: 1},
        details: [],
      },
    ];
    expect(getExitCode(violations)).toBe(1);
  });

  it('exit code is 1 when errors exist (Check 2)', () => {
    const violations: Violation[] = [
      {
        check: 2,
        severity: 'error',
        atomOrSelectorName: 'orphanAtom',
        message: 'violation',
        location: {file: 'file.ts', line: 1},
        details: [],
      },
    ];
    expect(getExitCode(violations)).toBe(1);
  });

  it('exit code is 0 when only warnings exist (Check 3 only)', () => {
    const violations: Violation[] = [
      {
        check: 3,
        severity: 'warning',
        atomOrSelectorName: 'unusedAtom',
        message: 'warning',
        location: {file: 'file.ts', line: 1},
        details: [],
      },
    ];
    expect(getExitCode(violations)).toBe(0);
  });

  it('exit code is 0 when clean (no violations)', () => {
    expect(getExitCode([])).toBe(0);
  });

  it('formats clean output when no violations', () => {
    const output = formatViolations([], targetDir);
    expect(output).toBe('No violations found.');
  });
});

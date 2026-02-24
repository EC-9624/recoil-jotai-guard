import * as fs from 'node:fs';
import * as path from 'node:path';
import {extractDefinitions} from './extract.js';
import {collectUsages} from './collect-usages.js';
import {resolveUsages} from './resolve.js';
import {runChecks} from './checks.js';
import {formatViolations, getExitCode} from './reporter.js';
import {globFiles} from './files.js';

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const targetDir = args.find((a) => !a.startsWith('--'));

  if (!targetDir) {
    console.error('Usage: tsx src/index.ts <target-directory> [--verbose]');
    process.exit(1);
  }

  const resolvedDir = path.resolve(targetDir);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const files = globFiles(resolvedDir);
  console.log(`Found ${files.length} files`);

  // Pass 1: Extract definitions
  const extraction = extractDefinitions(files);
  if (verbose) {
    console.log(
      `Extracted: ${extraction.recoilDefinitions.length} Recoil definitions, ` +
        `${extraction.jotaiDefinitions.length} Jotai definitions, ` +
        `${extraction.jotaiImports.length} Jotai imports`,
    );

    const atoms = extraction.recoilDefinitions.filter((d) => d.kind === 'atom');
    const selectors = extraction.recoilDefinitions.filter(
      (d) => d.kind === 'selector',
    );
    const atomFamilies = extraction.recoilDefinitions.filter(
      (d) => d.kind === 'atomFamily',
    );
    const selectorFamilies = extraction.recoilDefinitions.filter(
      (d) => d.kind === 'selectorFamily',
    );
    const inlineDefaults = extraction.recoilDefinitions.filter(
      (d) => d.inlineDefaultGetBody !== null,
    );
    console.log(
      `  Recoil: ${atoms.length} atoms, ${selectors.length} selectors, ` +
        `${atomFamilies.length} atomFamilies, ${selectorFamilies.length} selectorFamilies`,
    );
    console.log(`  Inline default get bodies: ${inlineDefaults.length}`);
  }

  // Pass 2: Collect usages
  const usages = collectUsages(files, extraction);
  if (verbose) {
    console.log(`Collected ${usages.usages.length} usages`);
    const readers = usages.usages.filter((u) => u.type === 'reader');
    const setters = usages.usages.filter((u) => u.type === 'setter');
    const initializers = usages.usages.filter((u) => u.type === 'initializer');
    console.log(
      `  ${readers.length} readers, ${setters.length} setters, ${initializers.length} initializers`,
    );
  }

  // Pass 3: Resolve identifiers
  const resolved = resolveUsages(files, extraction, usages);
  if (verbose) {
    console.log(
      `Resolved ${resolved.length} of ${usages.usages.length} usages`,
    );
  }

  // Run checks
  const violations = runChecks(extraction, resolved);

  // Format and output
  const output = formatViolations(violations, resolvedDir);
  console.log('');
  console.log(output);

  const exitCode = getExitCode(violations);
  process.exit(exitCode);
}

main();

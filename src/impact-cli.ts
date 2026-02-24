import {execSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {extractDefinitions} from './extract.js';
import {collectUsages} from './collect-usages.js';
import {resolveUsages} from './resolve.js';
import {buildDependencyGraph} from './graph.js';
import {
  analyzeAtomImpact,
  analyzeFileImpact,
  analyzeGitImpact,
} from './impact.js';
import {formatImpactText, formatImpactJson} from './impact-reporter.js';
import {globFiles} from './files.js';
import {buildSetterBindings} from './setter-bindings.js';
import {collectRuntimeWriteCallsites} from './setter-callsites.js';

const usageText = `Usage:
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
  --verbose             Print pipeline statistics (definition/usage counts)`;

type WriterMode = 'coverage' | 'legacy';

type ParsedArgs = {
  targetDir: string;
  mode: 'atom' | 'file' | 'git';
  atomName?: string;
  filePath?: string;
  json: boolean;
  verbose: boolean;
  writerMode: WriterMode;
};

/**
 * Parse CLI arguments from process.argv.slice(2).
 *
 * Returns parsed arguments or prints an error and exits.
 */
// eslint-disable-next-line complexity
function parseArgs(argv: string[]): ParsedArgs {
  let targetDir: string | undefined;
  let atomName: string | undefined;
  let filePath: string | undefined;
  let gitMode = false;
  let json = false;
  let verbose = false;
  let writerMode: WriterMode = 'coverage';

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    switch (argument) {
      case '--atom': {
        index++;
        atomName = argv[index];
        if (!atomName || atomName.startsWith('--')) {
          console.error('Error: --atom requires a non-empty name value');
          console.error('');
          console.error(usageText);
          process.exit(1);
        }

        break;
      }

      case '--file': {
        index++;
        filePath = argv[index];
        if (!filePath || filePath.startsWith('--')) {
          console.error('Error: --file requires a non-empty path value');
          console.error('');
          console.error(usageText);
          process.exit(1);
        }

        break;
      }

      case '--git': {
        gitMode = true;

        break;
      }

      case '--json': {
        json = true;

        break;
      }

      case '--verbose': {
        verbose = true;

        break;
      }

      case '--writer-mode': {
        index++;
        const modeValue = argv[index];
        if (modeValue === 'legacy') {
          writerMode = 'legacy';
        }

        break;
      }

      default: {
        if (!argument.startsWith('--')) {
          targetDir = argument;
        }
      }
    }
  }

  if (!targetDir) {
    console.error('Error: target directory is required');
    console.error('');
    console.error(usageText);
    process.exit(1);
  }

  // Count how many mode flags were provided
  const modeCount =
    (atomName === undefined ? 0 : 1) +
    (filePath === undefined ? 0 : 1) +
    (gitMode ? 1 : 0);

  if (modeCount === 0) {
    console.error(
      'Error: exactly one of --atom, --file, or --git must be provided',
    );
    console.error('');
    console.error(usageText);
    process.exit(1);
  }

  if (modeCount > 1) {
    console.error(
      'Error: exactly one of --atom, --file, or --git must be provided',
    );
    console.error('');
    console.error(usageText);
    process.exit(1);
  }

  const resolvedDir = path.resolve(targetDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`Error: directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  let mode: 'atom' | 'file' | 'git';
  if (atomName !== undefined) {
    mode = 'atom';
  } else if (filePath === undefined) {
    mode = 'git';
  } else {
    mode = 'file';
  }

  return {
    targetDir: resolvedDir,
    mode,
    atomName,
    filePath,
    json,
    verbose,
    writerMode,
  };
}

/**
 * Resolve the --file path, trying multiple resolution strategies:
 * 1. Absolute path: use as-is
 * 2. Relative to CWD: resolve against process.cwd()
 * 3. Relative to target directory: resolve against targetDir
 *
 * Returns the resolved absolute path, or exits with error if not found.
 */
function resolveFilePath(rawPath: string, targetDir: string): string {
  // Try absolute
  if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
    return rawPath;
  }

  // Try relative to CWD
  const cwdResolved = path.resolve(process.cwd(), rawPath);
  if (fs.existsSync(cwdResolved)) {
    return cwdResolved;
  }

  // Try relative to target directory
  const targetResolved = path.resolve(targetDir, rawPath);
  if (fs.existsSync(targetResolved)) {
    return targetResolved;
  }

  console.error(
    `Error: file not found: ${rawPath} (tried CWD and target directory)`,
  );
  process.exit(1);
}

/**
 * Get git-changed .ts/.tsx files within the target directory.
 *
 * Runs `git diff --name-only HEAD` from the target directory.
 * Filters to .ts/.tsx files and resolves paths to absolute.
 */
function getGitChangedFiles(targetDir: string): string[] {
  let output: string;
  try {
    output = execSync('git diff --name-only HEAD', {
      cwd: targetDir,
      encoding: 'utf8',
    });
  } catch {
    console.error('Error: git diff failed. Is this a git repository?');
    process.exit(1);
  }

  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => /\.tsx?$/.test(line))
    .map((line) => path.resolve(targetDir, line));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Step 3: Glob all files
  const files = globFiles(args.targetDir);

  if (args.verbose) {
    console.log(`Found ${files.length} files`);
  }

  // Step 4: Pass 1 - Extract definitions
  const extraction = extractDefinitions(files);

  if (args.verbose) {
    console.log(
      `Extracted: ${extraction.recoilDefinitions.length} Recoil definitions, ` +
        `${extraction.jotaiDefinitions.length} Jotai definitions, ` +
        `${extraction.jotaiImports.length} Jotai imports`,
    );
  }

  // Step 5: Pass 2 - Collect usages
  const usages = collectUsages(files, extraction);

  if (args.verbose) {
    console.log(`Collected ${usages.usages.length} usages`);
  }

  // Step 6: Pass 3 - Resolve usages
  const resolved = resolveUsages(files, extraction, usages);

  if (args.verbose) {
    console.log(
      `Resolved ${resolved.length} of ${usages.usages.length} usages`,
    );
  }

  // Step 7: Build dependency graph
  const graph = buildDependencyGraph(extraction, resolved);

  if (args.verbose) {
    console.log(
      `Built dependency graph: ${graph.dependentSelectors.size} atoms with deps, ` +
        `${[...graph.componentUsages.values()].reduce((sum, usages) => sum + usages.length, 0)} component usages`,
    );
  }

  // Step 7b: Run setter binding pipeline (coverage-first writers)
  // Skip if --writer-mode legacy
  let runtimeCallsites:
    | Array<import('./types.js').RuntimeWriteCallsite>
    | undefined;
  let resolvedFactoryKeys: Set<string> | undefined;

  if (args.writerMode !== 'legacy') {
    const bindingResult = buildSetterBindings(files, extraction);
    runtimeCallsites = collectRuntimeWriteCallsites(
      files,
      bindingResult.setterBindings,
    );
    resolvedFactoryKeys = bindingResult.resolvedFactoryKeys;

    if (args.verbose) {
      console.log(
        `Setter bindings: ${bindingResult.setterBindings.size} bindings, ` +
          `${runtimeCallsites.length} runtime callsites, ` +
          `${resolvedFactoryKeys.size} resolved factory sites`,
      );
    }
  }

  // Build impact options for coverage merge
  const impactOptions =
    runtimeCallsites && resolvedFactoryKeys
      ? {runtimeCallsites, resolvedFactoryKeys}
      : undefined;

  // Step 8-9: Determine target and run analysis
  let results:
    | Array<ReturnType<typeof analyzeAtomImpact>>
    | ReturnType<typeof analyzeFileImpact>;

  if (args.mode === 'atom') {
    const result = analyzeAtomImpact(graph, args.atomName!, impactOptions);
    if (!result) {
      console.log(`No Recoil definition found for '${args.atomName}'`);
      process.exit(0);
    }

    results = [result];
  } else if (args.mode === 'file') {
    const resolvedPath = resolveFilePath(args.filePath!, args.targetDir);
    results = analyzeFileImpact(graph, resolvedPath, extraction, impactOptions);
    if (results.length === 0) {
      const displayPath = path.relative(args.targetDir, resolvedPath);
      console.log(`No Recoil definitions found in ${displayPath}`);
      process.exit(0);
    }
  } else {
    // --git mode
    const changedFiles = getGitChangedFiles(args.targetDir);
    results = analyzeGitImpact(graph, changedFiles, extraction, impactOptions);
    if (results.length === 0) {
      console.log('No changed files with Recoil definitions');
      process.exit(0);
    }
  }

  // Step 10-11: Format and print output
  const impactResults = results as Array<import('./types.js').ImpactResult>;
  const output = args.json
    ? formatImpactJson(impactResults, args.targetDir)
    : formatImpactText(impactResults, args.targetDir);

  console.log(output);
  process.exit(0);
}

main();

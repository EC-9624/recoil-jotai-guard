import * as fs from 'node:fs';
import {walk} from 'oxc-walker';
import type {
  ExtractionResult,
  RecoilDefinition,
  ResolvedUsage,
  Violation,
} from './types.js';

/**
 * Check 1: Cross-System Boundary
 *
 * Detect Recoil selector get() bodies that reference Jotai state.
 */
function checkCrossSystemBoundary(extraction: ExtractionResult): Violation[] {
  const violations: Violation[] = [];

  // Build global set of Jotai atom definition names
  const jotaiNames = new Set(extraction.jotaiDefinitions.map((d) => d.name));

  // Build per-file set of Jotai import local names
  const jotaiLocalNamesByFile = new Map<string, Set<string>>();
  for (const jotaiImport of extraction.jotaiImports) {
    if (!jotaiLocalNamesByFile.has(jotaiImport.file)) {
      jotaiLocalNamesByFile.set(jotaiImport.file, new Set());
    }

    jotaiLocalNamesByFile.get(jotaiImport.file)!.add(jotaiImport.localName);
  }

  // Collect all get() bodies to walk
  type BodyToCheck = {
    ast: import('oxc-parser').Node;
    definition: RecoilDefinition;
  };
  const bodiesToCheck: BodyToCheck[] = [];

  for (const def of extraction.recoilDefinitions) {
    // Standalone selectors/selectorFamilies
    if (
      (def.kind === 'selector' || def.kind === 'selectorFamily') &&
      def.getBodyAst
    ) {
      bodiesToCheck.push({ast: def.getBodyAst, definition: def});
    }

    // Inline default selectors inside atoms/atomFamilies
    if (
      (def.kind === 'atom' || def.kind === 'atomFamily') &&
      def.inlineDefaultGetBody
    ) {
      bodiesToCheck.push({ast: def.inlineDefaultGetBody, definition: def});
    }
  }

  for (const {ast, definition} of bodiesToCheck) {
    const jotaiLocalNames =
      jotaiLocalNamesByFile.get(definition.file) ?? new Set();

    // Track identifiers that are the selector's own get parameter or local variables
    // to avoid false positives
    const localVariableNames = new Set<string>();

    // The selector's get parameter is 'get' by convention but could be aliased
    // We'll exclude 'get' as a parameter name by default
    localVariableNames.add('get');

    // Read file source for line calculation
    let source = '';
    try {
      source = fs.readFileSync(definition.file, 'utf8');
    } catch {
      // Skip if file can't be read
    }

    walk(ast, {
      enter(node) {
        // Track variable declarations to exclude them from matching
        if (
          node.type === 'VariableDeclarator' &&
          (node as any).id?.type === 'Identifier'
        ) {
          // Only exclude if the init is NOT a Jotai import reference
          const initNode = (node as any).init;
          const variableName = (node as any).id.name as string;
          if (
            !initNode ||
            initNode.type !== 'Identifier' ||
            (!jotaiNames.has(initNode.name as string) &&
              !jotaiLocalNames.has(initNode.name as string))
          ) {
            localVariableNames.add(variableName);
          }
        }

        if (node.type !== 'Identifier') {
          return;
        }

        const name = (node as any).name as string;

        // Skip local variable names (including the 'get' parameter)
        if (localVariableNames.has(name)) {
          return;
        }

        // Check if the identifier matches a known Jotai atom name or import
        if (jotaiNames.has(name) || jotaiLocalNames.has(name)) {
          // Calculate line from node offset
          let {line} = definition;
          const offset = (node as any).start as number | undefined;
          if (offset !== undefined && source) {
            line = 1;
            for (
              let index = 0;
              index < offset && index < source.length;
              index++
            ) {
              if (source[index] === '\n') {
                line++;
              }
            }
          }

          violations.push({
            check: 1,
            severity: 'error',
            atomOrSelectorName: definition.name,
            message: `Recoil ${definition.kind} '${definition.name}' references Jotai identifier '${name}' in its get() body`,
            location: {file: definition.file, line},
            details: [
              `Jotai identifier '${name}' found in ${definition.kind} get() body`,
            ],
          });
        }
      },
    });
  }

  return violations;
}

/**
 * Check 2: Orphaned Atom
 *
 * Detect Recoil atoms that have readers but no runtime setters.
 */
function checkOrphanedAtom(
  extraction: ExtractionResult,
  resolvedUsages: ResolvedUsage[],
): Violation[] {
  const violations: Violation[] = [];

  for (const def of extraction.recoilDefinitions) {
    if (def.kind !== 'atom' && def.kind !== 'atomFamily') {
      continue;
    }

    const readers = resolvedUsages.filter(
      (u) => u.resolvedName === def.name && u.type === 'reader',
    );
    const runtimeSetters = resolvedUsages.filter(
      (u) => u.resolvedName === def.name && u.type === 'setter',
    );

    if (readers.length > 0 && runtimeSetters.length === 0) {
      const readerDetails = readers.map(
        (r) => `${r.file}:${r.line}  ${r.hook}`,
      );

      violations.push({
        check: 2,
        severity: 'error',
        atomOrSelectorName: def.name,
        message: `Recoil ${def.kind} '${def.name}' has ${readers.length} reader(s) but no runtime setters`,
        location: {file: def.file, line: def.line},
        details: readerDetails,
      });
    }
  }

  return violations;
}

/**
 * Check 3: Unused Atom
 *
 * Detect Recoil atoms with no readers, no setters, and no selector dependencies.
 */
function checkUnusedAtom(
  extraction: ExtractionResult,
  resolvedUsages: ResolvedUsage[],
): Violation[] {
  const violations: Violation[] = [];

  // Build the set of atoms that are dependencies of selectors
  // (referenced in get() bodies, including inline default get bodies)
  const selectorDependencies = new Set<string>();

  for (const def of extraction.recoilDefinitions) {
    // Standalone selectors/selectorFamilies
    if (
      (def.kind === 'selector' || def.kind === 'selectorFamily') &&
      def.getBodyAst
    ) {
      collectGetDependencies(def.getBodyAst, selectorDependencies);
    }

    // Inline default selectors
    if (
      (def.kind === 'atom' || def.kind === 'atomFamily') &&
      def.inlineDefaultGetBody
    ) {
      collectGetDependencies(def.inlineDefaultGetBody, selectorDependencies);
    }
  }

  for (const def of extraction.recoilDefinitions) {
    if (def.kind !== 'atom' && def.kind !== 'atomFamily') {
      continue;
    }

    const allUsages = resolvedUsages.filter((u) => u.resolvedName === def.name);
    const isSelectorDep = selectorDependencies.has(def.name);

    if (allUsages.length === 0 && !isSelectorDep) {
      violations.push({
        check: 3,
        severity: 'warning',
        atomOrSelectorName: def.name,
        message: `Recoil ${def.kind} '${def.name}' has no readers, no setters, and is not a selector dependency (safe to delete)`,
        location: {file: def.file, line: def.line},
        details: [],
      });
    }
  }

  return violations;
}

/**
 * Collect atom/selector names referenced by `get(X)` calls in a body AST.
 */
function collectGetDependencies(
  bodyAst: import('oxc-parser').Node,
  dependencies: Set<string>,
): void {
  walk(bodyAst, {
    enter(node) {
      if (node.type !== 'CallExpression') {
        return;
      }

      const callNode = node as any;
      const {callee} = callNode;
      if (callee?.type !== 'Identifier' || callee.name !== 'get') {
        return;
      }

      const argument = callNode.arguments?.[0];
      if (!argument) {
        return;
      }

      // Direct identifier: get(myAtom)
      if (argument.type === 'Identifier') {
        dependencies.add(argument.name as string);
      }

      // Family call: get(myFamily(id))
      if (
        argument.type === 'CallExpression' &&
        argument.callee?.type === 'Identifier'
      ) {
        dependencies.add(argument.callee.name as string);
      }
    },
  });
}

export function runChecks(
  extraction: ExtractionResult,
  resolvedUsages: ResolvedUsage[],
): Violation[] {
  const violations: Violation[] = [];

  violations.push(...checkCrossSystemBoundary(extraction));
  violations.push(...checkOrphanedAtom(extraction, resolvedUsages));
  violations.push(...checkUnusedAtom(extraction, resolvedUsages));

  return violations;
}

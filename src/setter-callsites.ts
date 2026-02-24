import * as fs from 'node:fs';
import {parseSync} from 'oxc-parser';
import {walk} from 'oxc-walker';
import type {RuntimeWriteCallsite, SetterBindingMap} from './types.js';

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source[index] === '\n') {
      line++;
    }
  }

  return line;
}

/**
 * Scan all files for `CallExpression` nodes whose callee is a known setter
 * identifier. Each such call is classified as a runtime write site.
 *
 * @param files - Array of absolute file paths to scan
 * @param setterBindings - Map of `"file:identifierName"` -> canonical atom name
 * @returns Array of `RuntimeWriteCallsite` entries
 */
export function collectRuntimeWriteCallsites(
  files: string[],
  setterBindings: SetterBindingMap,
): RuntimeWriteCallsite[] {
  const callsites: RuntimeWriteCallsite[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let ast: any;
    try {
      ast = parseSync(file, source, {
        sourceType: 'module',
        lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
      });
    } catch {
      continue;
    }

    walk(ast.program, {
      enter(node) {
        if (node.type !== 'CallExpression') {
          return;
        }

        const callNode = node as any;
        const {callee} = callNode;
        if (callee?.type !== 'Identifier') {
          return;
        }

        const calleeName = callee.name as string;
        const key = `${file}:${calleeName}`;
        const atomName = setterBindings.get(key);
        if (!atomName) {
          return;
        }

        callsites.push({
          atomName,
          file,
          line: offsetToLine(source, callee.start as number),
          calleeName,
        });
      },
    });
  }

  return callsites;
}

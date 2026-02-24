import * as path from 'node:path';

/**
 * Make file paths relative to the target directory for cleaner output.
 */
export function relativePath(filePath: string, targetDir: string): string {
  return path.relative(targetDir, filePath);
}

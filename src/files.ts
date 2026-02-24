import * as fs from 'node:fs';
import * as path from 'node:path';

const excludePatterns = [
  /node_modules/,
  /__tests__/,
  /__storybook__/,
  /\.test\.tsx?$/,
  /\.stories\.tsx$/,
];

export function globFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, {withFileTypes: true});

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludePatterns.some((p) => p.test(entry.name))) {
        continue;
      }

      results.push(...globFiles(fullPath));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      if (excludePatterns.some((p) => p.test(entry.name))) {
        continue;
      }

      results.push(fullPath);
    }
  }

  return results;
}

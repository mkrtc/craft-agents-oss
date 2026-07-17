import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const productionFiles = [
  resolve(import.meta.dir, '../watcher.ts'),
  resolve(import.meta.dir, '../watch-adapter.ts'),
  resolve(import.meta.dir, '../watch-broker.ts'),
  resolve(import.meta.dir, '../../../../server-core/src/handlers/rpc/sessions.ts'),
  resolve(import.meta.dir, '../../../../server-core/src/handlers/rpc/session-file-observer.ts'),
];

describe('production watcher guard', () => {
  it('contains no recursive fs.watch acquisition in owned production paths', () => {
    for (const path of productionFiles) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/\bwatch\s*\([^)]*\brecursive\s*:\s*true/s);
    }
  });
});

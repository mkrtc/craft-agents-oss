import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Import-boundary smoke test: the pure `contracts.ts` surface must never pull a
 * Node built-in (`fs`/`path`/`process`/`crypto`/…) into its transitive import
 * graph, so it stays safe to import from renderer/browser-facing code.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ENTRY = resolve(HERE, '..', 'contracts.ts');

const FORBIDDEN = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'path', 'node:path',
  'crypto', 'node:crypto',
  'os', 'node:os',
  'process', 'node:process',
  'child_process', 'node:child_process',
  'worker_threads', 'node:worker_threads',
  'net', 'node:net', 'tls', 'node:tls', 'http', 'node:http', 'https', 'node:https',
]);

function collectImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,        // import ... from 'x' / export ... from 'x'
    /\bimport\s+['"]([^'"]+)['"]/g,       // bare `import 'x'`
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specifiers.push(m[1]!);
  }
  return specifiers;
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

describe('project-memory/contracts import boundary', () => {
  test('the pure contract surface has no transitive Node built-in imports', () => {
    const visited = new Set<string>();
    const offenders: string[] = [];

    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      for (const spec of collectImports(source)) {
        if (isRelative(spec)) {
          const target = resolve(dirname(file), spec);
          walk(target);
        } else if (FORBIDDEN.has(spec)) {
          offenders.push(`${file} imports "${spec}"`);
        }
      }
    };

    walk(CONTRACTS_ENTRY);
    expect(offenders).toEqual([]);
    // Sanity: the walk actually traversed the contract modules.
    expect(visited.size).toBeGreaterThan(4);
  });
});

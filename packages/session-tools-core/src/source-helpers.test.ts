import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_SESSION_HEADER_BYTES } from '@craft-agent/core';
import { resolveSessionWorkingDirectory } from './source-helpers.ts';

const tempDirs: string[] = [];

function makeSessionFile(sessionId = 's1'): { workspace: string; sessionFile: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'session-tools-header-'));
  tempDirs.push(workspace);
  const sessionFile = join(workspace, 'sessions', sessionId, 'session.jsonl');
  mkdirSync(dirname(sessionFile), { recursive: true });
  return { workspace, sessionFile };
}

function headerAtEncodedBytes(targetBytes: number, workingDirectory: string): string {
  const header = { padding: '', workingDirectory };
  const baseBytes = Buffer.byteLength(JSON.stringify(header), 'utf8');
  if (baseBytes > targetBytes) throw new Error('target too small');
  header.padding = 'x'.repeat(targetBytes - baseBytes);
  const encoded = JSON.stringify(header);
  expect(Buffer.byteLength(encoded, 'utf8')).toBe(targetBytes);
  return encoded;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveSessionWorkingDirectory bounded production reader', () => {
  it('returns the persisted workingDirectory from a valid header larger than 8 KiB', () => {
    const { workspace, sessionFile } = makeSessionFile();
    writeFileSync(sessionFile, `${headerAtEncodedBytes(12 * 1024, '/persisted/large')}\n`);

    expect(resolveSessionWorkingDirectory(workspace, 's1')).toBe('/persisted/large');
  });

  it.each([
    ['near cap', MAX_SESSION_HEADER_BYTES - 1],
    ['exact cap', MAX_SESSION_HEADER_BYTES],
  ])('accepts a valid %s header', (_name, size) => {
    const { workspace, sessionFile } = makeSessionFile();
    writeFileSync(sessionFile, `${headerAtEncodedBytes(size, '/persisted/cap')}\n`);

    expect(resolveSessionWorkingDirectory(workspace, 's1')).toBe('/persisted/cap');
  });

  it('fails safely for an over-cap first line with no newline', () => {
    const { workspace, sessionFile } = makeSessionFile();
    writeFileSync(sessionFile, headerAtEncodedBytes(MAX_SESSION_HEADER_BYTES + 1, '/must-not-load'));

    expect(resolveSessionWorkingDirectory(workspace, 's1')).toBeUndefined();
  });

  it('accepts CRLF, including after an exact-cap header', () => {
    const { workspace, sessionFile } = makeSessionFile();
    writeFileSync(sessionFile, `${headerAtEncodedBytes(MAX_SESSION_HEADER_BYTES, '/persisted/crlf')}\r\n`);

    expect(resolveSessionWorkingDirectory(workspace, 's1')).toBe('/persisted/crlf');
  });

  it('decodes multibyte UTF-8 split across the 4 KiB read boundary', () => {
    const { workspace, sessionFile } = makeSessionFile();
    const prefix = '{"padding":"';
    const padding = 'x'.repeat(4095 - Buffer.byteLength(prefix, 'utf8'));
    const encoded = `${prefix}${padding}😀","workingDirectory":"/persisted/utf8"}`;
    expect(Buffer.byteLength(`${prefix}${padding}`, 'utf8')).toBe(4095);
    writeFileSync(sessionFile, `${encoded}\n`);

    expect(resolveSessionWorkingDirectory(workspace, 's1')).toBe('/persisted/utf8');
  });
});

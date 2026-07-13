import { existsSync, writeFileSync } from 'fs';
import { MemoryConnectionRepository } from '../repository.ts';

interface CreateRaceRequest {
  action: 'create';
  configDir: string;
  workerId: string;
  readyPrefix: string;
  startGate: string;
  afterLoadPrefix: string;
  releaseGate: string;
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function waitForFile(path: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for gate: ${path}`);
    sleepSync(5);
  }
}

const rawRequest = process.argv[2];
if (!rawRequest) throw new Error('missing worker request');
const request = JSON.parse(rawRequest) as CreateRaceRequest;
if (request.action !== 'create') throw new Error(`unsupported action: ${(request as { action?: string }).action ?? 'missing'}`);

writeFileSync(`${request.readyPrefix}.${request.workerId}`, 'ready');
waitForFile(request.startGate);

const repository = new MemoryConnectionRepository({
  configDir: request.configDir,
  now: () => {
    // createConnection calls the clock only after it loaded and accepted the
    // expected root revision. Holding both workers here makes a missing
    // cross-process transaction lock fail deterministically.
    writeFileSync(`${request.afterLoadPrefix}.${request.workerId}`, 'after-load');
    waitForFile(request.releaseGate);
    return request.workerId === 'a' ? 1_000 : 2_000;
  },
});

try {
  const connection = await repository.createConnection({
    name: `worker-${request.workerId}`,
    url: 'http://127.0.0.1:6333',
    collection: 'craft_memory',
    embedding: { model: 'craft-local-hash-v1', dimension: 384 },
  }, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, connectionId: connection.connectionId })}\n`);
} catch (error) {
  const candidate = error as { name?: string; code?: string; message?: string };
  process.stdout.write(`${JSON.stringify({
    ok: false,
    name: candidate.name ?? 'Error',
    code: candidate.code ?? null,
    message: candidate.message ?? String(error),
  })}\n`);
}

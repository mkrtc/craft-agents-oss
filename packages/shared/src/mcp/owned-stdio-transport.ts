import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Stream } from 'node:stream';
import process from 'node:process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const TERM_WAIT_MS = 1_500;
const KILL_WAIT_MS = 1_000;
const UNIX_GROUP_SUPERVISOR = `
child=''
terminate_group() {
  trap '' TERM INT
  kill -TERM -$$ 2>/dev/null || true
  sleep 0.25
  kill -KILL -$$ 2>/dev/null
}
hard_kill_group() {
  kill -KILL -$$ 2>/dev/null
}
trap terminate_group TERM INT
trap hard_kill_group USR1
# POSIX shells redirect stdin of asynchronous lists to /dev/null unless job
# control is enabled. Preserve the transport pipe on a dedicated descriptor.
exec 3<&0
"$@" <&3 >&1 2>&2 &
child=$!
exec 3<&-
wait "$child"
status=$?
# If the direct wrapper exits unexpectedly, remove any descendants before the
# supervisor/group leader exits and its process-group identity can be reused.
kill -KILL -$$ 2>/dev/null
exit "$status"
`;

/**
 * Stdio MCP transport that owns an exact Unix process group.
 *
 * The SDK transport kills only its direct wrapper process. npm/sh/node/native
 * descendants can therefore survive client close. This transport keeps the SDK
 * wire contract but starts the wrapper as a detached Unix group leader and
 * tears down only that exact group with bounded SIGTERM -> SIGKILL waits.
 */
export class OwnedStdioClientTransport implements Transport {
  private child: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  private closePromise: Promise<void> | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(private readonly server: StdioServerParameters) {
    this.stderrStream = server.stderr === 'pipe' || server.stderr === 'overlapped'
      ? new PassThrough()
      : null;
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    if (this.child) {
      return Promise.reject(new Error('OwnedStdioClientTransport already started'));
    }

    return new Promise((resolve, reject) => {
      // The group leader is a tiny supervisor rather than the MCP wrapper
      // itself. It stays alive until an explicit group teardown and atomically
      // kills the group if the direct wrapper exits unexpectedly, preventing a
      // stale numeric PGID from ever being retained after leader exit.
      const child = spawn('/bin/sh', [
        '-c',
        UNIX_GROUP_SUPERVISOR,
        'craft-mcp-supervisor',
        this.server.command,
        ...(this.server.args ?? []),
      ], {
        env: this.server.env,
        stdio: ['pipe', 'pipe', this.server.stderr ?? 'inherit'],
        shell: false,
        windowsHide: process.platform === 'win32',
        cwd: this.server.cwd,
        // A new session/process group is the ownership boundary used by close().
        detached: process.platform !== 'win32',
      });
      this.child = child;

      child.once('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once('spawn', resolve);
      child.once('close', () => {
        // The supervisor cannot exit without first killing its exact group, so
        // no stale/recyclable numeric process-group identity is retained here.
        if (this.child === child) this.child = undefined;
        this.onclose?.();
      });
      child.stdin?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('data', (chunk) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout?.on('error', (error) => this.onerror?.(error));
      if (this.stderrStream && child.stderr) {
        child.stderr.pipe(this.stderrStream);
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOwnedTree();
    return this.closePromise;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error('Not connected');
    const serialized = serializeMessage(message);
    if (stdin.write(serialized)) return;
    await new Promise<void>((resolve) => stdin.once('drain', resolve));
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async closeOwnedTree(): Promise<void> {
    const child = this.child;
    this.readBuffer.clear();
    if (!child) return;

    const pid = child.pid;
    const childClosed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode) {
        resolve();
        return;
      }
      child.once('close', () => resolve());
    });
    const waitBounded = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (observedExit: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(observedExit);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void childClosed.then(() => finish(true));
    });

    try {
      child.stdin?.end();
    } catch {
      // The stream may already be closed; supervisor teardown still runs below.
    }

    // Signal only the still-owned supervisor handle. It sends TERM to the MCP
    // wrapper, then KILLs its own group while it is still the live group leader.
    // The parent never signals or polls a bare numeric PGID after leader exit.
    this.signalSupervisor(child, 'SIGTERM');
    let exited = await waitBounded(TERM_WAIT_MS);
    if (!exited) {
      // Ask the live supervisor to perform an immediate exact group kill. USR1
      // avoids a parent-side negative-PID race with recycled process-group IDs.
      this.signalSupervisor(child, 'SIGUSR1');
      exited = await waitBounded(KILL_WAIT_MS);
    }

    if (this.child === child) this.child = undefined;
    if (!exited) {
      throw new Error(`Owned MCP stdio process tree ${pid ?? '(unknown pid)'} did not exit`);
    }
  }

  private signalSupervisor(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

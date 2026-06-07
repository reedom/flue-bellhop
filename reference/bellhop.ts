// flue-bellhop reference implementation.
// Wraps the `agentbus` CLI (agentbus >= 0.3); never touches the store files
// directly. Same machine as the bellhop fleet; Node runtime only.

import { execFile, type ExecFileException } from 'node:child_process';

// -- errors -----------------------------------------------------------------

/** The CLI exited non-zero (or emitted non-JSON where JSON was expected). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** bellhopd answered a control ask with an ErrorReply. */
export class BellhopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BellhopError';
  }
}

/** An ask expired; the reply stays retrievable via fleet.askResult(). */
export class AskTimeout extends Error {
  constructor(readonly requestId: string) {
    super(`ask ${requestId} timed out; a late reply is retrievable via askResult`);
    this.name = 'AskTimeout';
  }
}

// -- low-level runner ---------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the process failed to start (spawn error) or was killed by a signal. */
  failure?: string;
}

function spawnCli(
  bin: string,
  agentbusDir: string | undefined,
  args: string[],
  stdin?: string,
): Promise<RunResult> {
  const env = { ...process.env };
  if (agentbusDir !== undefined) {
    env['AGENTBUS_DIR'] = agentbusDir;
  }
  return new Promise((resolve) => {
    const child = execFile(bin, args, { env }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }

      const execErr: ExecFileException = err;

      // Signal kill: code is null/undefined and signal is set.
      if (execErr.signal != null) {
        resolve({ stdout, stderr, exitCode: -1, failure: execErr.signal });
        return;
      }

      // Spawn failure: code is a string (e.g. 'ENOENT'), not a number.
      if (typeof execErr.code === 'string') {
        resolve({ stdout, stderr, exitCode: -1, failure: execErr.code });
        return;
      }

      // Real non-zero exit: code is a number.
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin?.end(stdin ?? '');
  });
}

/** Run one agentbus verb; returns trimmed stdout or throws CliError. */
export async function runAgentbus(
  bin: string,
  agentbusDir: string | undefined,
  args: string[],
  stdin?: string,
): Promise<string> {
  const { stdout, stderr, exitCode, failure } = await spawnCli(bin, agentbusDir, args, stdin);

  if (failure !== undefined) {
    const verb = args[0] ?? '';
    throw new CliError(
      `agentbus ${verb} failed to start (${failure})`,
      `${stdout}\n${stderr}`.trim(),
      -1,
    );
  }

  if (exitCode !== 0) {
    throw new CliError(
      `agentbus ${args[0] ?? ''} failed (exit ${exitCode})`,
      `${stdout}\n${stderr}`.trim(),
      exitCode,
    );
  }

  return stdout.trim();
}

// -- helpers ------------------------------------------------------------------

/** Pull the request id out of a timed-out ask's CLI output (stderr hint:
 *  "retrieve a late reply with: agentbus ask-result <id>"). */
function extractRequestId(output: string): string | undefined {
  const m = output.match(/ask-result\s+(\S+)/);
  return m?.[1];
}

// -- fleet --------------------------------------------------------------------

export interface ConnectOptions {
  /** Bus identity of this orchestrator, e.g. "flue:issue-1234". */
  id: string;
  /** 'pid' (default): row dies with this process. 'persistent': survives it. */
  anchor?: 'pid' | 'persistent';
  agentbusBin?: string;
  /** Override the store dir (default: agentbus resolution / $AGENTBUS_DIR). */
  agentbusDir?: string;
  /** Timeout for control asks to bellhopd. */
  controlTimeoutMs?: number;
}

export interface Envelope {
  id: string;
  kind: 'message' | 'ask' | 'reply' | 'event';
  from: string;
  to?: string | null;
  request_id?: string | null;
  ts: string;
  payload: unknown;
}

export class Fleet {
  readonly id: string;
  private readonly bin: string;
  private readonly dir: string | undefined;
  private readonly controlTimeoutMs: number;

  constructor(options: ConnectOptions) {
    this.id = options.id;
    this.bin = options.agentbusBin ?? 'agentbus';
    this.dir = options.agentbusDir;
    this.controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
  }

  /** @internal */
  async registerSelf(anchor: 'pid' | 'persistent'): Promise<void> {
    const args =
      anchor === 'persistent'
        ? ['register', this.id, '--persistent']
        : ['register', this.id, '--pid', String(process.pid)];
    await this.cli(args);
  }

  async close(): Promise<void> {
    await this.cli(['unregister', this.id]);
  }

  private cli(args: string[], stdin?: string): Promise<string> {
    return runAgentbus(this.bin, this.dir, args, stdin);
  }

  private async cliJson<T>(args: string[], stdin?: string): Promise<T> {
    const out = await this.cli(args, stdin);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new CliError(`agentbus ${args[0] ?? ''}: expected JSON output`, out, 0);
    }
  }

  /** Fire-and-forget message to a registered instance. */
  async send(to: string, payload: unknown): Promise<void> {
    await this.cli(['send', to, '--from', this.id], JSON.stringify(payload));
  }

  /**
   * RPC: blocks until the recipient replies or timeoutMs elapses.
   * Default is generous (10 min): delivery may include a pane spawn plus a
   * full agent turn. On expiry throws AskTimeout carrying the requestId.
   */
  async ask(
    to: string,
    payload: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    try {
      const reply = await this.cliJson<{ request_id: string; payload: unknown }>(
        ['ask', to, '--from', this.id, '--timeout-ms', String(timeoutMs)],
        JSON.stringify(payload),
      );
      return reply.payload;
    } catch (err) {
      if (err instanceof CliError) {
        const requestId = extractRequestId(err.output);
        if (requestId !== undefined) {
          throw new AskTimeout(requestId);
        }
      }
      throw err;
    }
  }

  /** Yield inbound envelopes for this orchestrator, forever. */
  async *inbox(options: { idleTimeoutMs?: number } = {}): AsyncGenerator<Envelope> {
    const idle = options.idleTimeoutMs ?? 25_000;
    for (;;) {
      const batch = await this.cliJson<{ envelopes: Envelope[] }>([
        'await',
        this.id,
        '--timeout-ms',
        String(idle),
      ]);
      for (const envelope of batch.envelopes) {
        yield envelope;
      }
    }
  }
}

export async function connectBellhop(options: ConnectOptions): Promise<Fleet> {
  const fleet = new Fleet(options);
  await fleet.registerSelf(options.anchor ?? 'pid');
  return fleet;
}

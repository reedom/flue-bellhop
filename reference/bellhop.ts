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

  /**
   * Sends a control ask to bellhopd and unwraps the reply.
   *
   * Error contract (bellhop spec 6.1): a reply is an error iff it carries a
   * top-level `error` object; success payloads must not use that key.
   */
  private async control(payload: Record<string, unknown>): Promise<unknown> {
    const result = await this.ask('bellhop', payload, { timeoutMs: this.controlTimeoutMs });
    const error = (result as { error?: { code: string; message: string; retryable?: boolean } })
      ?.error;
    if (error !== undefined) {
      throw new BellhopError(error.code, error.message, error.retryable ?? false);
    }
    return result;
  }

  /**
   * Lifecycle ops (bellhop spec 6.1, agent.* family).
   *
   * Reply shapes are owned by bellhop spec 6.1, hence `Promise<unknown>` --
   * cast to the concrete type at the call site.
   */
  readonly agent = {
    create: (args: {
      name: string;
      /** Placement path workspace[/pane]; omitted = own workspace. */
      at?: string;
      /** Group used when the workspace is created on demand. */
      group?: string;
      /** Optional when the host workspace exists (cwd inherited). */
      cwd?: string;
      /** cmux display title; default: the agent name. */
      title?: string;
      /** Model id passed through to the agent harness; default: bellhopd's choice. */
      model?: string;
    }) => this.control({ op: 'agent.create', ...args }),
    wake: (name: string, options: { fresh?: boolean } = {}) =>
      this.control({ op: 'agent.activate', name, fresh: options.fresh ?? false }),
    deactivate: (name: string) => this.control({ op: 'agent.deactivate', name }),
    forget: (name: string) => this.control({ op: 'agent.forget', name }),
    list: () => this.control({ op: 'agent.list' }),
    status: (name: string) => this.control({ op: 'agent.status', name }),
  };

  /** cmux hierarchy ops (bellhop spec 6.1, ui.* family). Always optional --
   *  agent.create materializes missing containers on demand. */
  readonly ui = {
    group: {
      create: (args: { name: string; title?: string }) =>
        this.control({ op: 'ui.group.create', ...args }),
    },
    workspace: {
      create: (args: { name: string; cwd: string; group?: string; title?: string }) =>
        this.control({ op: 'ui.workspace.create', ...args }),
    },
    pane: {
      create: (args: { name: string; workspace: string; split?: string }) =>
        this.control({ op: 'ui.pane.create', ...args }),
    },
    tree: () => this.control({ op: 'ui.tree' }),
  };

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
        // Guard on exit code 2: that is the CLI's designated timeout exit code.
        // Other errors (e.g. unknown_instance, exit 1) may include "ask-result"
        // in their recovery hints in future agentbus versions; gating on exit 2
        // prevents misclassifying them as timeouts.
        if (err.exitCode === 2) {
          const requestId = extractRequestId(err.output);
          if (requestId !== undefined) {
            throw new AskTimeout(requestId);
          }
        }
      }
      throw err;
    }
  }

  /** Status of an earlier ask: the resume path for retried workflow steps. */
  async askResult(
    requestId: string,
  ): Promise<{ status: 'pending' | 'replied' | 'expired'; payload?: unknown }> {
    const out = await this.cliJson<{ status: string; payload?: unknown }>([
      'ask-result',
      requestId,
    ]);
    // agentbus 0.3 emits exactly these three lowercase statuses; anything else
    // means the CLI contract changed and silently guessing would corrupt the
    // resume path -- fail loudly instead.
    if (out.status !== 'pending' && out.status !== 'replied' && out.status !== 'expired') {
      throw new CliError(
        `agentbus ask-result: unexpected status "${out.status}"`,
        JSON.stringify(out),
        0,
      );
    }
    return { status: out.status, payload: out.payload };
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

  /** Tail the bus event log from a cursor (poll loop; never consumes inboxes). */
  async *events(
    options: { since?: number; intervalMs?: number } = {},
  ): AsyncGenerator<{ seq: number; envelope: Envelope }> {
    let cursor = options.since ?? 0;
    const interval = options.intervalMs ?? 500;
    for (;;) {
      const out = await this.cli(['events', '--since', String(cursor)]);
      for (const line of out.split('\n')) {
        if (line.length === 0) {
          continue;
        }
        const item = JSON.parse(line) as { seq: number; envelope: Envelope };
        // --since is exclusive (spike-verified): pass last-seen seq directly
        cursor = item.seq;
        yield item;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

export async function connectBellhop(options: ConnectOptions): Promise<Fleet> {
  const fleet = new Fleet(options);
  await fleet.registerSelf(options.anchor ?? 'pid');
  return fleet;
}

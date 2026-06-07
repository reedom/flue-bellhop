---
{ "category": "fleet", "website": "https://github.com/reedom/flue-bellhop" }
---

> **Note:** `fleet` is not yet a category supported by the flue connector
> registry, so this connector cannot be installed via `flue add`. Apply it
> by pointing your AI coding agent at this file. The category proposal is
> future work tracked in `reedom/flue-bellhop`.

# Add a Flue Connector: bellhop

You are an AI coding agent installing the bellhop fleet connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Bridges headless Flue workflows to a bellhop fleet: named, durable,
human-observable Claude Code agents living in cmux panes on the same
machine. It wraps the `agentbus` CLI -- every operation spawns the CLI with
the payload on stdin and parses JSON from stdout; the store contract is
never reimplemented. The user owns the fleet (bellhopd, cmux, the agents
themselves); this connector only talks to it.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then
`<root>/src/`, then `<root>/`. Write the connector to
`<source-dir>/connectors/bellhop.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask
the user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it -- it is tested against a
real agentbus store in `reedom/flue-bellhop`, and CI keeps this copy in
sync with the tested source.

<!-- BEGIN bellhop.ts -->
```ts
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

  /**
   * Tail the bus event log from a cursor (poll loop; never consumes inboxes).
   *
   * Resume contract: the cursor is generator-local and not persisted. To resume
   * after breaking the loop without replaying from seq 0, pass the last seen
   * `seq` as `since`.
   *
   * Break-during-sleep: breaking a for-await abandons the generator at the
   * current sleep; the pending setTimeout may keep the process alive for up to
   * `intervalMs` before it unwinds.
   */
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
```
<!-- END bellhop.ts -->

## Required dependencies

No npm dependencies -- the module uses only `node:` builtins. Do not run
`npm install` for this connector.

The runtime prerequisite is the `agentbus` CLI, version 0.3.0 or newer
(the connector relies on `register --pid`, added in 0.3.0):

```bash
cargo install agentbus-cli@^0.3
agentbus --version
```

## Authentication and runtime constraints

There are no credentials: access control is the filesystem. The bus is a
spool store on local disk (`~/.agentbus` by default, overridable with
`AGENTBUS_DIR`). That imposes hard constraints -- surface them to the user
if their setup does not match:

- **Same machine.** The Flue app must run on the machine where the fleet
  (bellhopd + cmux) runs. Remote and multi-machine setups are unsupported.
- **Node runtime only.** Cloudflare/edge deployments cannot reach the
  store and cannot spawn processes. This connector requires Flue's Node
  runtime.
- **Child processes must be allowed.** Flue's default virtual sandbox
  (just-bash) blocks `child_process`; the connector needs the Node runtime
  adapter so `execFile` works. Verify this before wiring it in.
- **bellhopd must be running** for control ops (`agent.*`, `ui.*`) to be
  answered. A plain `send` still spools while it is down and is delivered
  when it returns.

## Wiring it into a workflow

A workflow that takes one issue, places an orchestrator and two workers in
a worktree workspace, and waits for the orchestrator's verdict
(`.flue/workflows/fix-issue.ts`; adjust the import path to where you wrote
the connector):

```ts
import { connectBellhop } from '../connectors/bellhop.js';

const ISSUE = 'issue-1234';
const WT = `${process.env.HOME}/wt/${ISSUE}`;

const fleet = await connectBellhop({ id: `flue:${ISSUE}` });

// one workspace per worktree, materialized on demand via the first agent
await fleet.agent.create({ name: 'orch-a', at: 'repo-a', group: ISSUE, cwd: `${WT}/repo-a` });
await fleet.agent.create({ name: 'worker-a1', at: 'repo-a/workers' }); // cwd inherited
await fleet.agent.create({ name: 'worker-a2', at: 'repo-a/workers' });

console.log(JSON.stringify(await fleet.ui.tree(), null, 2));

const verdict = await fleet.ask(
  'orch-a',
  { prompt: `Plan the fix for ${ISSUE} in this worktree; delegate to worker-a1/a2 over agentbus.` },
  { timeoutMs: 1_800_000 },
);
console.log('orchestrator replied:', JSON.stringify(verdict));

await fleet.close();
```

The `at` placement path is the only addressing scheme:

| `at` | Meaning |
|---|---|
| omitted | the agent gets its own workspace, named after the agent |
| `repo-a` | into workspace `repo-a` (created on demand; pass `cwd` on first use) |
| `repo-a/workers` | into pane `workers` of workspace `repo-a` (both created on demand; `cwd` inherited from the workspace) |

For agent-initiated traffic back into Flue (an agent asking the
orchestrator something, progress notes), drain `fleet.inbox()` and feed
the envelopes into a Flue agent session via `dispatch(...)`:

```ts
import { dispatch } from '@flue/runtime';

for await (const envelope of fleet.inbox()) {
  await dispatch({ agent: 'supervisor', id: fleet.id, input: envelope });
}
```

## Failure modes

| Error | When | What to do |
|---|---|---|
| `CliError` with `failed to start (ENOENT)` | `agentbus` is not installed or not on PATH | `cargo install agentbus-cli@^0.3` |
| `CliError` with `error[unknown_instance]` in `.output` | the target id is not registered on the bus | check `agentbus ls`; create the agent first |
| `AskTimeout { requestId }` | the recipient did not reply within `timeoutMs` (bellhopd down, or the agent is busy) | the ask is not lost -- retrieve a late reply with `fleet.askResult(requestId)`; this is the resume path for retried workflow steps |
| `BellhopError { code: 'unknown_agent' }` | a control op named an agent bellhopd does not know | `fleet.agent.list()` to see what exists |
| `BellhopError { code: 'missing_container' }` | a placement path referenced a workspace/pane that cannot be materialized | inspect `fleet.ui.tree()` |

CLI errors carry the raw stderr in `.output` (format:
`error[<code>]: <message>`); nothing is silently swallowed.

## Verify

1. Typecheck the app (`npx tsc --noEmit`, or the project's typecheck
   command).
2. `agentbus --version` prints 0.3.0 or newer; `agentbus ls` answers.
3. Confirm bellhopd is running.
4. Run the workflow: `flue dev`, then `flue run fix-issue` -- the cmux
   session should show workspace `repo-a` appearing with the orchestrator
   and worker panes.

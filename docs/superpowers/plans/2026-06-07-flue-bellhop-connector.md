# flue-bellhop Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the flue-bellhop connector per `docs/superpowers/specs/2026-06-07-flue-bellhop-connector.md`: a reference TypeScript module wrapping the `agentbus` CLI with typed bellhop control ops, its test suite against a real agentbus store, the Flue-convention instruction doc that embeds it, and a drift check keeping the two in sync.

**Architecture:** Single reference module (`reference/bellhop.ts`) exposing `connectBellhop()` -> `Fleet` with `agent.*` / `ui.*` typed control ops, data-plane `ask`/`send`/`askResult`, and `inbox()`/`events()` async iterators. Every operation spawns the `agentbus` CLI (payloads on stdin, JSON on stdout) -- the store contract is never reimplemented. Tests run against a real store in a tempdir (`AGENTBUS_DIR`) with a bash stand-in answering control asks the way bellhopd would. The shipped product is `connectors/fleet--bellhop.md`, which embeds the reference source between markers; CI fails when they drift.

**Tech Stack:** TypeScript (Node 20+, ESM), pnpm, vitest, `node:child_process` (`execFile`), bash + jq test fixtures, `agentbus` CLI ^0.3 as the only runtime dependency.

**Conventions for this repo:**
- Numeric comparisons never use `>` or `>=`; write `a < b` / `a <= b` (flip operands when needed). In bash tests use `-lt` / `-le`.
- No emojis anywhere. Conventional commits, lowercase titles, max 50 chars.
- Node tooling is pnpm. Strong typing: no `any`; unknown payloads are `unknown`.

---

## File structure (locked in by this plan)

```
flue-bellhop/
  package.json                  pnpm scripts: build (tsc), test (vitest), check:drift
  tsconfig.json                 strict ESM config
  vitest.config.ts
  .gitignore
  reference/
    bellhop.ts                  the whole connector (embedded into the doc)
    bellhop.test.ts             vitest suite, real store in tempdir
    fixtures/fake-bellhopd.sh   answers control asks like bellhopd would
  examples/
    fix-issue.ts                issue/worktrees/orchestrator+workers walkthrough (typecheck only)
  connectors/
    fleet--bellhop.md           the product: instruction doc embedding reference/bellhop.ts
  scripts/
    check-drift.sh              fails when the doc's embedded source differs from reference
  .github/workflows/ci.yml      typecheck + drift (store tests run locally, gated on agentbus)
  docs/superpowers/             this plan, the spec, spike research
```

`reference/bellhop.ts` is deliberately a single file: the instruction doc must embed one self-contained module an AI agent can drop into a Flue app.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "flue-bellhop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "check:drift": "bash scripts/check-drift.sh"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5.6",
    "vitest": "^2"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["reference/**/*.ts", "examples/**/*.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['reference/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
```

- [ ] **Step 5: Install and verify**

Run: `pnpm install && pnpm build`
Expected: installs, tsc exits 0 (no inputs yet is fine; if tsc errors on empty include, add a placeholder `reference/bellhop.ts` with `export {};` and it gets replaced in Task 3).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold typescript project"
```

---

### Task 2: Verification spike -- agentbus CLI output shapes (spec open question 1)

The connector parses CLI stdout; this task pins the exact shapes. Produces a findings document, not code. If a finding contradicts the spec, STOP and surface it before continuing.

**Files:**
- Create: `docs/superpowers/research/2026-06-07-agentbus-cli-shapes.md`

- [ ] **Step 1: Record every verb's stdout/exit code in a scratch store**

```bash
export AGENTBUS_DIR=$(mktemp -d)
agentbus register spike --pid $$            # record stdout JSON
agentbus ls                                 # record: array? {instances:[...]}? field names incl. pid/alive
echo '{"n":1}' | agentbus send spike --from ext:spike   # record envelope-id output shape
agentbus check-inbox spike                  # record {"envelopes":[...]} and envelope field names
echo '{"q":1}' | agentbus ask spike --from ext:spike --timeout-ms 2000; echo "exit=$?"
                                            # TIMEOUT path: record exit code and where the
                                            # request_id appears (stdout JSON? stderr? text?)
agentbus ask-result <request-id>            # record Pending/Replied/Expired shape
echo '{"a":1}' | agentbus reply <request-id> spike      # record reply stdout; then ask-result again
echo '{"e":1}' | agentbus publish --from ext:spike
agentbus events --since 0                   # record line shape {"seq":N,"envelope":{...}} and
                                            # whether --since means "after seq" or "from seq"
agentbus await spike --timeout-ms 1000      # record empty-batch shape on timeout
agentbus ask nosuch --from ext:spike --timeout-ms 1000 < /dev/null; echo "exit=$?"
                                            # unknown_instance: record error format + exit code
```

- [ ] **Step 2: Write the findings document**

One section per verb: command, exact stdout/stderr, exit code, consequence for the reference implementation (ok / adjust). Explicitly answer: (a) is the timeout request_id machine-readable, (b) `--since` semantics, (c) error envelope format for store errors.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/research
git commit -m "docs: record agentbus cli output shapes"
```

---

### Task 3: CLI runner and error types

**Files:**
- Create: `reference/bellhop.ts` (sections: errors, runner)
- Create: `reference/bellhop.test.ts`

- [ ] **Step 1: Write the failing tests**

`reference/bellhop.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError, runAgentbus } from './bellhop.js';

const BIN = process.env.AGENTBUS_BIN ?? 'agentbus';

function haveAgentbus(): boolean {
  try {
    execFileSync(BIN, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function scratchStore(): string {
  return mkdtempSync(join(tmpdir(), 'flue-bellhop-'));
}

export const onBus = describe.skipIf(!haveAgentbus());

onBus('runAgentbus', () => {
  it('runs a verb and returns stdout', async () => {
    const dir = scratchStore();
    const out = await runAgentbus(BIN, dir, ['register', 'runner-a', '--persistent']);
    expect(JSON.parse(out)).toMatchObject({ ok: true }); // ADJUST to spike findings
  });

  it('passes payloads via stdin', async () => {
    const dir = scratchStore();
    await runAgentbus(BIN, dir, ['register', 'runner-b', '--persistent']);
    await runAgentbus(BIN, dir, ['send', 'runner-b', '--from', 'ext:test'], '{"n":1}');
    const batch = JSON.parse(await runAgentbus(BIN, dir, ['check-inbox', 'runner-b']));
    expect(batch.envelopes).toHaveLength(1);
    expect(batch.envelopes[0].payload).toEqual({ n: 1 });
  });

  it('throws CliError with output attached on failure', async () => {
    const dir = scratchStore();
    await expect(
      runAgentbus(BIN, dir, ['send', 'nosuch', '--from', 'ext:test'], '{}'),
    ).rejects.toBeInstanceOf(CliError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL (bellhop.ts does not export these).

- [ ] **Step 3: Implement the runner section**

`reference/bellhop.ts`:

```ts
// flue-bellhop reference implementation.
// Wraps the `agentbus` CLI (agentbus >= 0.3); never touches the store files
// directly. Same machine as the bellhop fleet; Node runtime only.

import { execFile } from 'node:child_process';

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
}

function spawnCli(
  bin: string,
  agentbusDir: string | undefined,
  args: string[],
  stdin?: string,
): Promise<RunResult> {
  const env = { ...process.env };
  if (agentbusDir !== undefined) {
    env.AGENTBUS_DIR = agentbusDir;
  }
  return new Promise((resolve) => {
    const child = execFile(bin, args, { env }, (err, stdout, stderr) => {
      const exitCode =
        err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
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
  const { stdout, stderr, exitCode } = await spawnCli(bin, agentbusDir, args, stdin);
  if (exitCode !== 0) {
    throw new CliError(
      `agentbus ${args[0] ?? ''} failed (exit ${exitCode})`,
      `${stdout}\n${stderr}`.trim(),
      exitCode,
    );
  }
  return stdout.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 3 passed. Adjust the `{ ok: true }` register assertion to the Task 2 findings if the shape differs.

- [ ] **Step 5: Commit**

```bash
git add reference
git commit -m "feat: agentbus cli runner with typed errors"
```

---

### Task 4: connectBellhop -- registration and close

**Files:**
- Modify: `reference/bellhop.ts` (add Fleet skeleton + connect)
- Modify: `reference/bellhop.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `reference/bellhop.test.ts`:

```ts
import { connectBellhop } from './bellhop.js';

onBus('connectBellhop', () => {
  it('registers a pid-anchored identity and unregisters on close', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({ id: 'flue:test-1', agentbusBin: BIN, agentbusDir: dir });
    const listed = JSON.parse(await runAgentbus(BIN, dir, ['ls']));
    // ADJUST list shape to spike findings; the contract under test:
    const row = listed.instances.find((r: { id: string }) => r.id === 'flue:test-1');
    expect(row.pid).toBe(process.pid);
    await fleet.close();
    const after = JSON.parse(await runAgentbus(BIN, dir, ['ls']));
    expect(after.instances.find((r: { id: string }) => r.id === 'flue:test-1')).toBeUndefined();
  });

  it('persistent anchor sets no pid', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({
      id: 'flue:durable',
      anchor: 'persistent',
      agentbusBin: BIN,
      agentbusDir: dir,
    });
    const listed = JSON.parse(await runAgentbus(BIN, dir, ['ls']));
    expect(listed.instances.find((r: { id: string }) => r.id === 'flue:durable').pid).toBeNull();
    await fleet.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL (connectBellhop not exported).

- [ ] **Step 3: Implement Fleet skeleton and registration**

Append to `reference/bellhop.ts`:

```ts
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
}

export async function connectBellhop(options: ConnectOptions): Promise<Fleet> {
  const fleet = new Fleet(options);
  await fleet.registerSelf(options.anchor ?? 'pid');
  return fleet;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 5 passed (cumulative).

- [ ] **Step 5: Commit**

```bash
git add reference
git commit -m "feat: fleet connect with pid and persistent anchors"
```

---

### Task 5: Data plane -- send, ask, inbox

**Files:**
- Modify: `reference/bellhop.ts`
- Modify: `reference/bellhop.test.ts`
- Create: `reference/fixtures/fake-bellhopd.sh`

- [ ] **Step 1: Write the responder fixture**

`reference/fixtures/fake-bellhopd.sh` -- registers an id and answers asks the way bellhopd would (echo control payloads back; canned error for `agent.status` of `ghost`):

```bash
#!/usr/bin/env bash
# Usage: fake-bellhopd.sh <instance-id> [rounds]
# Polls its inbox; replies {"echo": <payload>} to each ask, except
# payload.op == "agent.status" with name "ghost" -> canned ErrorReply.
set -euo pipefail
AGENTBUS="${AGENTBUS_BIN:-agentbus}"
ID="${1:?instance id}"
ROUNDS="${2:-50}"

"$AGENTBUS" register "$ID" --persistent 1>/dev/null

i=0
while [ "$i" -lt "$ROUNDS" ]; do
  BATCH=$("$AGENTBUS" check-inbox "$ID")
  COUNT=$(printf '%s' "$BATCH" | jq '.envelopes | length')
  if [ 0 -lt "$COUNT" ]; then
    printf '%s' "$BATCH" | jq -c '.envelopes[]' | while IFS= read -r env; do
      KIND=$(printf '%s' "$env" | jq -r '.kind')
      [ "$KIND" = "ask" ] || continue
      REQ=$(printf '%s' "$env" | jq -r '.request_id // .id')
      OP=$(printf '%s' "$env" | jq -r '.payload.op // "none"')
      NAME=$(printf '%s' "$env" | jq -r '.payload.name // "none"')
      if [ "$OP" = "agent.status" ] && [ "$NAME" = "ghost" ]; then
        printf '%s' '{"error":{"code":"unknown_agent","message":"no such agent","retryable":false}}' \
          | "$AGENTBUS" reply "$REQ" "$ID" 1>/dev/null
      else
        printf '%s' "$env" | jq -c '{echo: .payload}' | "$AGENTBUS" reply "$REQ" "$ID" 1>/dev/null
      fi
    done
    exit 0
  fi
  sleep 0.2
  i=$((i + 1))
done
exit 1
```

```bash
chmod +x reference/fixtures/fake-bellhopd.sh
```

- [ ] **Step 2: Write the failing tests**

Append to `reference/bellhop.test.ts`:

```ts
import { spawn } from 'node:child_process';

function startResponder(dir: string, id: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['reference/fixtures/fake-bellhopd.sh', id], {
      env: { ...process.env, AGENTBUS_DIR: dir, AGENTBUS_BIN: BIN },
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`responder exit ${code}`))));
  });
}

onBus('data plane', () => {
  it('send spools a message; inbox() yields it', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({ id: 'flue:dp-1', agentbusBin: BIN, agentbusDir: dir });
    await fleet.send('flue:dp-1', { note: 'hello self' });
    const iterator = fleet.inbox({ idleTimeoutMs: 2000 })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect((first.value as Envelope).payload).toEqual({ note: 'hello self' });
    await fleet.close();
  });

  it('ask blocks until the responder replies', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({ id: 'flue:dp-2', agentbusBin: BIN, agentbusDir: dir });
    const responder = startResponder(dir, 'peer');
    const reply = await fleet.ask('peer', { q: 'ready?' }, { timeoutMs: 15_000 });
    expect(reply).toEqual({ echo: { q: 'ready?' } });
    await responder;
    await fleet.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL (send/ask/inbox not implemented).

- [ ] **Step 4: Implement send, ask, inbox**

Append inside `class Fleet`:

```ts
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
```

And the helper at module level:

```ts
/** Pull the request id out of a timed-out ask's CLI output.
 *  ADJUST the pattern to the Task 2 spike findings. */
function extractRequestId(output: string): string | undefined {
  const m = output.match(/[a-z]*_?[0-9A-HJKMNP-TV-Z]{26}/i); // ULID-ish
  return m?.[0];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 7 passed (cumulative).

- [ ] **Step 6: Commit**

```bash
git add reference
git commit -m "feat: data plane send ask and inbox iterator"
```

---

### Task 6: Ask timeout and askResult resume

**Files:**
- Modify: `reference/bellhop.ts`
- Modify: `reference/bellhop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `reference/bellhop.test.ts`:

```ts
import { AskTimeout } from './bellhop.js';

onBus('ask timeout', () => {
  it('throws AskTimeout with requestId; late reply via askResult', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({ id: 'flue:to-1', agentbusBin: BIN, agentbusDir: dir });
    await runAgentbus(BIN, dir, ['register', 'silent', '--persistent']);

    let requestId = '';
    try {
      await fleet.ask('silent', { q: 1 }, { timeoutMs: 1500 });
      expect.unreachable('ask should have timed out');
    } catch (err) {
      expect(err).toBeInstanceOf(AskTimeout);
      requestId = (err as AskTimeout).requestId;
    }

    // the recipient answers late, straight via the CLI
    await runAgentbus(BIN, dir, ['reply', requestId, 'silent'], '{"late":true}');
    const result = await fleet.askResult(requestId);
    expect(result.status).toBe('replied');
    expect(result.payload).toEqual({ late: true });
    await fleet.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL (askResult not implemented).

- [ ] **Step 3: Implement askResult**

Append inside `class Fleet`:

```ts
  /** Status of an earlier ask: the resume path for retried workflow steps. */
  async askResult(
    requestId: string,
  ): Promise<{ status: 'pending' | 'replied' | 'expired'; payload?: unknown }> {
    // ADJUST field names to the Task 2 spike findings.
    const out = await this.cliJson<{ status: string; payload?: unknown }>([
      'ask-result',
      requestId,
    ]);
    const status = out.status.toLowerCase() as 'pending' | 'replied' | 'expired';
    return { status, payload: out.payload };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 8 passed (cumulative). If `extractRequestId` fails against the real timeout output, fix it now per the spike findings -- this test is the guard.

- [ ] **Step 5: Commit**

```bash
git add reference
git commit -m "feat: ask timeout with askresult resume"
```

---

### Task 7: Control plane -- typed agent.* and ui.* ops

**Files:**
- Modify: `reference/bellhop.ts`
- Modify: `reference/bellhop.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `reference/bellhop.test.ts`:

```ts
import { BellhopError } from './bellhop.js';

onBus('control plane', () => {
  it('agent.create carries placement fields', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({
      id: 'flue:cp-1',
      agentbusBin: BIN,
      agentbusDir: dir,
      controlTimeoutMs: 15_000,
    });
    const responder = startResponder(dir, 'bellhop');
    const echoed = (await fleet.agent.create({
      name: 'worker-a1',
      at: 'repo-a/workers',
      group: 'issue-1234',
    })) as { echo: Record<string, unknown> };
    expect(echoed.echo).toMatchObject({
      op: 'agent.create',
      name: 'worker-a1',
      at: 'repo-a/workers',
      group: 'issue-1234',
    });
    await responder;
    await fleet.close();
  });

  it('ui.workspace.create and ui.tree map to their ops', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({
      id: 'flue:cp-2',
      agentbusBin: BIN,
      agentbusDir: dir,
      controlTimeoutMs: 15_000,
    });
    const responder = startResponder(dir, 'bellhop');
    const echoed = (await fleet.ui.workspace.create({
      name: 'repo-a',
      cwd: '/wt/repo-a',
      group: 'issue-1234',
    })) as { echo: Record<string, unknown> };
    expect(echoed.echo.op).toBe('ui.workspace.create');
    await responder;
    await fleet.close();
  });

  it('ErrorReply payloads become BellhopError', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({
      id: 'flue:cp-3',
      agentbusBin: BIN,
      agentbusDir: dir,
      controlTimeoutMs: 15_000,
    });
    const responder = startResponder(dir, 'bellhop');
    await expect(fleet.agent.status('ghost')).rejects.toMatchObject({
      name: 'BellhopError',
      code: 'unknown_agent',
      retryable: false,
    });
    await responder;
    await fleet.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL (agent/ui not implemented).

- [ ] **Step 3: Implement the typed ops**

Append inside `class Fleet` (above the private helpers):

```ts
  /** Lifecycle ops (bellhop spec 6.1, agent.* family). */
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

  private async control(payload: Record<string, unknown>): Promise<unknown> {
    const result = await this.ask('bellhop', payload, { timeoutMs: this.controlTimeoutMs });
    const error = (result as { error?: { code: string; message: string; retryable?: boolean } })
      ?.error;
    if (error !== undefined) {
      throw new BellhopError(error.code, error.message, error.retryable ?? false);
    }
    return result;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 11 passed (cumulative).

- [ ] **Step 5: Commit**

```bash
git add reference
git commit -m "feat: typed agent and ui control ops"
```

---

### Task 8: events iterator

**Files:**
- Modify: `reference/bellhop.ts`
- Modify: `reference/bellhop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `reference/bellhop.test.ts`:

```ts
onBus('events', () => {
  it('yields published events after the cursor', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({ id: 'flue:ev-1', agentbusBin: BIN, agentbusDir: dir });
    await runAgentbus(BIN, dir, ['publish', '--from', 'ext:test'], '{"type":"bellhop.agent.created"}');
    const iterator = fleet.events({ since: 0, intervalMs: 100 })[Symbol.asyncIterator]();
    const first = await iterator.next();
    const item = first.value as { seq: number; envelope: Envelope };
    expect(item.envelope.kind).toBe('event');
    expect(0 < item.seq).toBe(true);
    await fleet.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL (events not implemented).

- [ ] **Step 3: Implement events**

Append inside `class Fleet`:

```ts
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
        cursor = item.seq; // ADJUST if --since means "from seq" (spike)
        yield item;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 12 passed (cumulative). Then `pnpm build` -- tsc clean.

- [ ] **Step 5: Commit**

```bash
git add reference
git commit -m "feat: event log iterator"
```

---

### Task 9: Example workflow (typecheck lane)

**Files:**
- Create: `examples/fix-issue.ts`

- [ ] **Step 1: Write the example**

`examples/fix-issue.ts` -- the spec's worked scenario; compiles under `pnpm build`, runs only manually against a real fleet:

```ts
// Manual-lane example: one issue, two worktrees, an orchestrator and a
// worker group per worktree. Requires bellhopd + cmux + agentbus running
// on this machine. Run: node --experimental-strip-types examples/fix-issue.ts
import { connectBellhop } from '../reference/bellhop.js';

const ISSUE = 'issue-1234';
const WT = `${process.env.HOME}/wt/${ISSUE}`;

const fleet = await connectBellhop({ id: `flue:${ISSUE}` });

// one workspace per worktree, on demand via the first agent
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

- [ ] **Step 2: Verify it typechecks, commit**

Run: `pnpm build`
Expected: tsc exits 0.

```bash
git add examples
git commit -m "docs: add fix-issue example workflow"
```

---

### Task 10: Instruction doc and drift check

**Files:**
- Modify: `connectors/fleet--bellhop.md` (replace the placeholder)
- Create: `scripts/check-drift.sh`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the drift check**

`scripts/check-drift.sh` -- the doc embeds the reference source between markers; fail when they differ:

```bash
#!/usr/bin/env bash
# The instruction doc embeds reference/bellhop.ts between BEGIN/END markers.
# Fail when the embedded copy drifts from the reference.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$ROOT/connectors/fleet--bellhop.md"
REF="$ROOT/reference/bellhop.ts"

EMBEDDED=$(awk '/<!-- BEGIN bellhop.ts -->/{flag=1;next}/<!-- END bellhop.ts -->/{flag=0}flag' "$DOC" \
  | sed '1{/^```/d}' | sed '${/^```/d}')
if [ -z "$EMBEDDED" ]; then
  echo "FAIL: no embedded source found in $DOC"
  exit 1
fi
if ! diff <(printf '%s\n' "$EMBEDDED") "$REF" 1>/dev/null; then
  echo "FAIL: connectors/fleet--bellhop.md drifted from reference/bellhop.ts"
  echo "Re-embed: update the doc's code block from the reference file."
  exit 1
fi
echo "ok: doc matches reference"
```

```bash
chmod +x scripts/check-drift.sh
```

- [ ] **Step 2: Write the instruction doc**

Replace `connectors/fleet--bellhop.md`. The body follows the flue connector
template (`withastro/flue` `connectors/README.md` "Body conventions";
`sandbox--daytona.md` is the reference shape). Write actual prose; the code
block is the verbatim reference source. Required structure, in order:

1. JSON frontmatter, fenced by `---` lines (flue parses with `JSON.parse()`):

   ```markdown
   ---
   { "category": "fleet", "website": "https://github.com/reedom/flue-bellhop" }
   ---
   ```

   Directly below it, a note: `fleet` is not yet a flue-supported category;
   until the category proposal lands, this doc is applied by pointing a
   coding agent at this file, not via `flue add`.

2. Title `# Add a Flue Connector: bellhop` and the template's framing
   sentence: "You are an AI coding agent installing the bellhop fleet
   connector for a Flue project. Follow these instructions exactly. Confirm
   with the user only when something is genuinely ambiguous."

3. **What this connector does** -- one paragraph: bridges headless Flue
   workflows to a bellhop fleet (named, durable, observable Claude Code
   agents in cmux panes) by wrapping the `agentbus` CLI; the user owns the
   fleet (bellhopd, cmux); this connector only spawns the CLI.

4. **Where to write the file** -- select the first existing source
   directory: `<root>/.flue/`, then `<root>/src/`, then `<root>/`; write to
   `<source-dir>/connectors/bellhop.ts`; ask the user when the layout is
   unusual; create missing parent directories.

5. **File contents** -- "Write this file verbatim. Do not improve it.",
   then the embedded source:

   ````markdown
   <!-- BEGIN bellhop.ts -->
   ```ts
   (verbatim copy of reference/bellhop.ts)
   ```
   <!-- END bellhop.ts -->
   ````

6. **Required dependencies** -- none from npm (the module uses only
   `node:` builtins). The runtime prerequisite is the `agentbus` CLI ^0.3:
   `cargo install agentbus-cli@^0.3`.

7. **Authentication and runtime constraints** (replaces the template's
   provider-auth section; the bus has no credentials): access control is
   the filesystem -- the store lives at `~/.agentbus` on disk. Hence: same
   machine as the fleet; `bellhopd` running; Node/local Flue runtime
   required (NOT Cloudflare/edge -- the store is unreachable there); the
   default virtual sandbox likely blocks child processes, so the Node
   runtime adapter is required.

8. **Wiring it into a workflow** -- the fix-issue example (verbatim from
   `examples/fix-issue.ts`), the three placement forms (`at` omitted /
   `ws` / `ws/pane`) in one short table, and a prose note on feeding
   `fleet.inbox()` envelopes into Flue's `dispatch(...)`.

9. **Failure modes** -- `AskTimeout` + `askResult` resume for retried
   workflow steps; `BellhopError` codes (`unknown_agent`,
   `missing_container`); `CliError` when the CLI is missing (install hint).

10. **Verify** -- typecheck the app, then the manual lane: `bellhopd`
    running, `agentbus ls` answers, run the example workflow, finish with
    `flue dev` / `flue run <workflow>`.

- [ ] **Step 3: Run the drift check**

Run: `pnpm check:drift`
Expected: `ok: doc matches reference`.

- [ ] **Step 4: Add minimal CI**

`.github/workflows/ci.yml` -- typecheck + drift; store-backed tests stay local (installing the Rust CLI in CI is out of scope for MVP):

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm check:drift
```

- [ ] **Step 5: Commit**

```bash
git add connectors scripts .github
git commit -m "docs: connector instruction doc with drift check"
```

---

### Task 11: README update and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Replace the "Status: design phase" line with: status (reference implementation + instruction doc available), a Quickstart pointing at `connectors/fleet--bellhop.md` ("point your coding agent at this file from your Flue app"), the local test instructions (`AGENTBUS_BIN=$(which agentbus) pnpm test`), and the same-machine/Node-only constraint. Keep the existing API snippet and disclaimer.

- [ ] **Step 2: Full verification gate**

Run: `pnpm build && pnpm test && pnpm check:drift`
Expected: all green (tests require `agentbus` installed; they self-skip otherwise -- run with it installed for this gate).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: usage and status in readme"
```

---

## Plan self-review results

- **Spec coverage:** spec sections 1-2 (summary/goals) map to Tasks 3-8; section 5 repo layout is the file structure above; section 6 (connector surface) is Tasks 4-8; section 7 (inbound) is Task 5's `inbox()` (the Flue `dispatch(...)` wiring is documented prose in Task 10's doc, not code -- it depends on the consuming app); section 8 (error handling) is Tasks 3, 6, 7; section 9 (testing incl. doc-drift) is the per-task tests plus Task 10; section 10 open question 1 is Task 2, questions 2-4 are documented constraints in Task 10's doc. Spec future work (category proposal, npm publish, remote) intentionally unplanned.
- **Known deferrals:** Flue-runtime spawn-permission verification (spec open question 2) cannot be tested without a Flue app; the instruction doc states the Node-adapter requirement and the example is the manual lane. `events --follow` long-lived child (open question 3) deferred -- the poll loop ships first.
- **Placeholder scan:** Task 10 step 2 specifies content requirements instead of full prose by design (the code block is verbatim `reference/bellhop.ts`, enforced by the drift check). Three `ADJUST` markers are deliberate spike-coupling points (register/ls output shapes, timeout request-id extraction, `--since` semantics) -- each sits next to the test that forces the fix.
- **Type consistency:** `Envelope`, `CliError`, `BellhopError`, `AskTimeout`, `runAgentbus` defined in Tasks 3-4 and reused unchanged in Tasks 5-8; `onBus`/`scratchStore`/`startResponder` test helpers defined once (Tasks 3, 5) and shared; op strings match the cmux-bellhop spec 6.1 exactly (`agent.create` ... `ui.tree`).

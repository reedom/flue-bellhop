# flue-bellhop connector design

- Date: 2026-06-07
- Status: draft, awaiting review
- Repo: `reedom/flue-bellhop` (new)
- Upstream contracts: agentbus 0.3 (spool store, CLI), cmux-bellhop
  (control plane `agent.*` / `ui.*`, placement model)
- Downstream convention: Flue connectors -- "a markdown file with
  installation instructions for an AI coding agent, not an npm package"

## 1. Summary

flue-bellhop lets a Flue workflow command a bellhop fleet: named, durable,
human-observable Claude Code agents living in cmux panes on the same
machine. The connector follows Flue's connector convention -- the product
is an instruction document that an AI coding agent applies to a Flue app,
generating an app-local `connectors/bellhop.ts`. That module wraps the
`agentbus` CLI (agentbus's skill-first primary surface) and types the
bellhop control plane: create agents with `at` placement paths, build the
cmux hierarchy, ask agents and collect replies.

The two agent worlds complement each other: Flue's own agents are headless
and ephemeral (virtual sandbox, scale lane); bellhop agents are
interactive, durable, and watchable (cmux TUI, human-takeover lane). The
connector is the bridge that lets a headless orchestrator delegate to --
and await -- the observable lane.

## 2. Goals

- Typed control plane: `agent.create/activate/deactivate/forget/list/
  status` and `ui.group/workspace/pane/tree`, with the `at` placement
  path (`workspace[/pane]`) as the only addressing scheme.
- Data plane: `ask(agent, payload, timeoutMs)` and `send(agent, payload)`
  with generous defaults; event-log subscription for fleet observation.
- Orchestrator identity: the Flue process registers itself on the bus
  (pid-anchored by default) so bellhop agents can reply to and ask it.
- Retry-safe by construction: placement paths and idempotent
  `agent.create` make re-run workflow steps converge; timed-out asks are
  resumable via `ask-result`.
- Zero new daemons, zero reimplementation: the store contract stays in
  the `agentbus` CLI; the connector only spawns it.

## 3. Non-goals

- Remote or multi-machine fleets. bellhop is same-machine (cmux +
  `~/.agentbus`); the connector targets Node/local Flue runtimes only.
  Cloudflare/edge deployments cannot reach the store -- documented
  loudly, not worked around.
- Upstreaming into `withastro/flue`. Their connector registry accepts
  only the `sandbox` category; a `messaging`/`fleet` category needs a
  prior discussion. This repo is the staging ground for that, later.
- An npm package (MVP). Flue connectors are instruction docs producing
  app-local code; a published client library can come later if the
  reference implementation stabilizes.
- The MCP shim path. CLI-wrapping is cheaper and matches agentbus fr:16.
- Driving cmux directly. All UI manipulation goes through bellhop's
  `ui.*` ops; the connector never talks to the cmux socket.

## 4. Background and constraints

- agentbus 0.3 is daemonless; the CLI verbs the connector wraps:
  `register <id> [--pid N | --persistent]`, `send <to> --from X`
  (payload on stdin), `ask <to> --from X --timeout-ms N`,
  `ask-result <request_id>`, `reply <request_id> <from>`,
  `check-inbox <id>`, `await <id> --timeout-ms N`, `publish --from X`,
  `events --follow --since N`, `ls`, `unregister <id>`.
- bellhop control ops ride `ask('bellhop', ...)`; placement semantics
  (on-demand containers, cwd inheritance, group as a field not a path
  segment) are owned by the cmux-bellhop spec section 6.1 -- this
  connector types them but never reinterprets them.
- Flue: workflows are TypeScript (`.flue/workflows/*.ts`) running under
  the Flue runtime; app-local connector code lives in `connectors/` of
  the user's app; `dispatch(...)` can inject asynchronous input into Flue
  agent sessions (the natural sink for bellhop replies/events).
- Flue connector docs use `<category>--<name>.md` naming; this repo uses
  `fleet--bellhop.md` in anticipation of a `fleet` category. The doc body
  follows flue's connector template (JSON frontmatter; framing sentence;
  what-it-does / where-to-write / verbatim file contents / dependencies /
  auth / wiring / verify), per `connectors/README.md` body conventions in
  `withastro/flue`, so a future registry PR is a copy, not a rewrite.

## 5. Architecture

```
+----------------------------- same machine ------------------------------+
|  Flue app (Node)                                                        |
|  .flue/workflows/fix-issue.ts                                           |
|        |  typed calls                                                   |
|  connectors/bellhop.ts  (generated from fleet--bellhop.md)              |
|        |  spawns `agentbus` CLI (stdin payload, JSON stdout)            |
|        v                                                                |
|  ~/.agentbus  (spool store) <---- bellhopd ----> cmux panes (the fleet) |
+--------------------------------------------------------------------------+
```

Repo layout:

```
flue-bellhop/
  connectors/fleet--bellhop.md   the product: instruction doc for AI agents
  reference/bellhop.ts           reference implementation (what the doc teaches)
  reference/bellhop.test.ts      tests against a tempdir agentbus store
  examples/fix-issue.ts          the issue/worktree/orchestrator+workers walkthrough
  docs/                          this spec, plans
```

The instruction doc and the reference implementation must not drift: the
doc embeds the reference source, and CI fails when they differ.

## 6. Connector surface (TypeScript)

```ts
const fleet = await connectBellhop({
  id: 'flue:issue-1234',          // bus identity of this orchestrator
  // anchor: 'pid' (default) registers --pid process.pid; 'persistent'
  // survives the Flue process for long-lived orchestrators
});

// ui.* -- optional pre-building / inspection
await fleet.ui.workspace.create({ name: 'repo-a', cwd: wt, group: 'issue-1234' });
const tree = await fleet.ui.tree();

// agent.* -- lifecycle with placement
await fleet.agent.create({ name: 'orch-a', at: 'repo-a', group: 'issue-1234', cwd: wt });
await fleet.agent.create({ name: 'worker-a1', at: 'repo-a/workers' }); // cwd inherited

// data plane
const r = await fleet.ask('orch-a', { prompt }, { timeoutMs: 1_800_000 });
await fleet.send('worker-a1', { note: 'deploy finished' });

// observation
for await (const ev of fleet.events({ filter: 'bellhop.' })) { ... }

await fleet.close();              // unregister (pid anchor dies anyway)
```

- Every call shells `agentbus` with `AGENTBUS_DIR` passed through;
  payloads go via stdin, results parse from stdout JSON.
- `ask` exposes the envelope id; on timeout the error carries
  `requestId`, and `fleet.askResult(requestId)` retrieves a late reply --
  the resume path for retried Flue workflow steps (agentbus fr:04 keeps
  the asks row).
- Control-plane errors (`{"error":{code,...}}` with exit 1) surface as
  typed exceptions (`UnknownAgent`, `MissingContainer`, ...).

## 7. Inbound: agents talking back to the orchestrator

- bellhop agents reply to asks via `agentbus reply` (no registration
  needed) -- the blocking `fleet.ask` covers the common case.
- For agent-initiated asks/messages TO the orchestrator, the connector
  offers `fleet.inbox()`: an async iterator over `await`/`check-inbox`
  batches for the orchestrator's id. The instruction doc shows wiring it
  into Flue's `dispatch(...)` so inbound envelopes become input to a Flue
  agent session.
- The orchestrator id must be registered for this to work (goal above);
  `ext:` senders cannot be addressed.

## 8. Error handling

| Failure | Behavior |
|---|---|
| `agentbus` binary missing | constructor fails fast with install hint (`cargo install agentbus-cli@^0.3`) |
| bellhopd down | control asks time out; error message says to start bellhopd (mail to agents still spools -- delivered when bellhopd returns) |
| ask timeout | typed `AskTimeout { requestId }`; resumable via `askResult` |
| control `ErrorReply` | typed exception mirroring bellhop error codes |
| CLI emits non-JSON | raw output attached to the error; never silently swallowed |

## 9. Testing

- Reference implementation tests run against a real agentbus store in a
  tempdir (`AGENTBUS_DIR`), with a scripted responder standing in for
  bellhopd (answers control asks; mirrors the cmux-bellhop fake-claude
  approach). Gate: `AGENTBUS_BIN`.
- One end-to-end lane (manual): real bellhopd + cmux, running
  `examples/fix-issue.ts` against a scratch worktree.
- Doc-drift check: `fleet--bellhop.md`'s embedded source equals
  `reference/bellhop.ts`.

## 10. Open questions / verify during implementation

1. `agentbus` CLI stdout shapes: are all verbs stable JSON (envelope
   batches, ask replies, error objects), and does the timeout error carry
   the request_id machine-readably?
2. Flue runtime constraints on spawning child processes from connector
   code under the default virtual sandbox (`just-bash`) -- the connector
   likely requires the Node runtime adapter; confirm and document.
3. Whether `fleet.events()` should tail `agentbus events --follow` as a
   long-lived child or poll `--since <cursor>`; lifecycle of that child
   within a Flue workflow run.
4. Orchestrator id conventions: per-workflow (`flue:issue-1234`) vs
   per-app; collision rules when two workflow runs overlap.

## 11. Future work

- Propose a `fleet` (or `messaging`) connector category to
  `withastro/flue` via discussion, with this repo as the working example.
- Publish the reference implementation as a package once stable.
- Remote story: if bellhop ever grows a remote transport, lift the
  same-machine constraint here.

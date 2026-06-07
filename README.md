# flue-bellhop

A [Flue](https://github.com/withastro/flue) connector for
[cmux-bellhop](https://github.com/reedom/cmux-bellhop): lets headless Flue
workflows command a fleet of named, durable, human-observable Claude Code
agents running in [cmux](https://github.com/manaflow-ai/cmux) panes,
over [agentbus](https://github.com/reedom/agentbus).

Following Flue's connector convention, the product is an instruction
document (`connectors/fleet--bellhop.md`) that an AI coding agent applies
to a Flue app, generating an app-local `connectors/bellhop.ts`. No npm
package, no daemon -- the module wraps the `agentbus` CLI.

```ts
const fleet = await connectBellhop({ id: 'flue:issue-1234' });
await fleet.agent.create({ name: 'orch-a', at: 'repo-a', group: 'issue-1234', cwd: wt });
await fleet.agent.create({ name: 'worker-a1', at: 'repo-a/workers' }); // cwd inherited
const r = await fleet.ask('orch-a', { prompt }, { timeoutMs: 1_800_000 });
```

Same-machine only (cmux + `~/.agentbus`); Node/local Flue runtimes.
Cloudflare Workers and other edge runtimes cannot reach the on-disk store.

Status: reference implementation + instruction doc available.

## Quickstart

Point your coding agent at the instruction document:

```
connectors/fleet--bellhop.md
```

The agent reads the embedded reference source and generates an app-local
`connectors/bellhop.ts` in your Flue app. There is no `flue add` command
for this connector -- the `fleet` category is not yet flue-supported.

## Running the tests locally

agentbus CLI 0.3.0 or later is required. Install with:

```bash
cargo install agentbus-cli@^0.3
```

Then run the tests, pointing at the installed binary:

```bash
AGENTBUS_BIN=$(which agentbus) pnpm test
```

Tests self-skip only when no `agentbus` binary is found on PATH. Set
`AGENTBUS_BIN` to point at a specific binary if it is not on PATH.

Not affiliated with the Astro (Flue), manaflow-ai (cmux), or Anthropic
projects.

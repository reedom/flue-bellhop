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

Status: design phase. See
[docs/superpowers/specs/2026-06-07-flue-bellhop-connector.md](docs/superpowers/specs/2026-06-07-flue-bellhop-connector.md).

Not affiliated with the Astro (Flue), manaflow-ai (cmux), or Anthropic
projects.

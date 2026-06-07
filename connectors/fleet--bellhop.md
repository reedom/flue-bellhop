# Connector: bellhop (fleet)

> **Status: placeholder.** This document is the product of this repo --
> a Flue-convention connector: markdown installation instructions that an
> AI coding agent applies to a Flue app, generating an app-local
> `connectors/bellhop.ts`.
>
> It will be written alongside `reference/bellhop.ts` during
> implementation; CI will fail when the source embedded here drifts from
> the reference. Until then, the design of record is
> [`docs/superpowers/specs/2026-06-07-flue-bellhop-connector.md`](../docs/superpowers/specs/2026-06-07-flue-bellhop-connector.md).

Planned contents (per the spec):

1. Prerequisites: same machine as the fleet; `agentbus` CLI
   (`cargo install agentbus-cli@^0.3`), `bellhopd` running, Node/local
   Flue runtime.
2. Files to create in the Flue app: `connectors/bellhop.ts` (full source,
   embedded here), usage notes for `.flue/workflows/*.ts`.
3. The worked example: one issue, multiple worktrees, orchestrator +
   worker-group placement via `at` paths.
4. Constraints and failure modes (timeouts, `askResult` resume,
   `missing_container`).

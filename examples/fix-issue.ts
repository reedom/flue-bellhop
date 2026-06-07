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

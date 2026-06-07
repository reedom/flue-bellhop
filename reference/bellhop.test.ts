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
    expect(JSON.parse(out)).toMatchObject({ ok: true });
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

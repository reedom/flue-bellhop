import { describe, expect, it } from 'vitest';
import { CliError, connectBellhop, runAgentbus } from './bellhop.js';
import { BIN, onBus, scratchStore } from './testing.js';

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
    const err = await runAgentbus(BIN, dir, ['send', 'nosuch', '--from', 'ext:test'], '{}').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(0 < (err as CliError).exitCode).toBe(true);
    expect(0 < (err as CliError).output.length).toBe(true);
  });
});

describe('runAgentbus spawn failures', () => {
  it('rejects with CliError exitCode -1 when binary does not exist', async () => {
    const err = await runAgentbus('/nonexistent/agentbus', undefined, ['register', 'x']).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(-1);
  });
});

onBus('connectBellhop', () => {
  it('registers a pid-anchored identity and unregisters on close', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({ id: 'flue:test-1', agentbusBin: BIN, agentbusDir: dir });
    const listed = JSON.parse(await runAgentbus(BIN, dir, ['ls']));
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

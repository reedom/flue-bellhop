import { describe, expect, it } from 'vitest';
import { AskTimeout, BellhopError, CliError, connectBellhop, runAgentbus, type Envelope } from './bellhop.js';
import { BIN, createFakeAgentbus, onBus, scratchStore, startResponder } from './testing.js';

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
    // Pre-register the peer so ask does not see unknown_instance before the
    // bash subprocess has a chance to run its own register call.
    await runAgentbus(BIN, dir, ['register', 'peer', '--persistent']);
    const fleet = await connectBellhop({ id: 'flue:dp-2', agentbusBin: BIN, agentbusDir: dir });
    const responder = startResponder(dir, 'peer');
    const reply = await fleet.ask('peer', { q: 'ready?' }, { timeoutMs: 15_000 });
    expect(reply).toEqual({ echo: { q: 'ready?' } });
    await responder;
    await fleet.close();
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

describe('askResult status validation', () => {
  it('throws CliError with "unexpected status" when agentbus emits an unknown status', async () => {
    // The real CLI cannot emit a bogus status; use a fake binary so this test
    // runs even where agentbus is absent and precisely targets the guard.
    const fakeBin = createFakeAgentbus('weird');
    const fleet = await connectBellhop({
      id: 'flue:fake-1',
      agentbusBin: fakeBin,
      // No real store needed; register/unregister return {"ok":true} from the shim.
    });
    const err = await fleet.askResult('msg_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('unexpected status');
    await fleet.close();
  });
});

onBus('control plane', () => {
  it('agent.create carries placement fields', async () => {
    const dir = scratchStore();
    const fleet = await connectBellhop({
      id: 'flue:cp-1',
      agentbusBin: BIN,
      agentbusDir: dir,
      controlTimeoutMs: 15_000,
    });
    // Pre-register the responder so ask does not see unknown_instance before
    // the bash subprocess has a chance to run its own register call.
    await runAgentbus(BIN, dir, ['register', 'bellhop', '--persistent']);
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
    await runAgentbus(BIN, dir, ['register', 'bellhop', '--persistent']);
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
    await runAgentbus(BIN, dir, ['register', 'bellhop', '--persistent']);
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

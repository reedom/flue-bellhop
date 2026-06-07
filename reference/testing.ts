// Shared test helpers for flue-bellhop reference tests.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';

export const BIN = process.env.AGENTBUS_BIN ?? 'agentbus';

export function haveAgentbus(): boolean {
  try {
    execFileSync(BIN, ['--version'], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function scratchStore(): string {
  return mkdtempSync(join(tmpdir(), 'flue-bellhop-'));
}

export const onBus = describe.skipIf(!haveAgentbus());

/**
 * Create a minimal agentbus shim that returns a fixed status string for the
 * ask-result verb, allowing tests to exercise the status-validation guard
 * without a real agentbus binary. Returns the path to the executable script.
 *
 * The shim accepts:
 *   register / unregister  -> {"ok":true}
 *   ask-result <id>        -> {"status":"<bogusStatus>"}
 */
export function createFakeAgentbus(bogusStatus: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agentbus-'));
  const scriptPath = join(dir, 'fake-agentbus.sh');
  const script = [
    '#!/usr/bin/env bash',
    'verb="$1"',
    'case "$verb" in',
    '  register|unregister)',
    '    echo \'{"ok":true}\'',
    '    ;;',
    '  ask-result)',
    `    echo '{"status":"${bogusStatus}"}'`,
    '    ;;',
    '  *)',
    '    echo "unhandled verb: $verb" >&2',
    '    exit 1',
    '    ;;',
    'esac',
  ].join('\n');
  writeFileSync(scriptPath, script, { encoding: 'utf8' });
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Start fake-bellhopd in the background. Resolves when it exits 0 (handled a
 * round), rejects otherwise. Intended to run concurrently with fleet.ask().
 */
export function startResponder(dir: string, id: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['reference/fixtures/fake-bellhopd.sh', id], {
      env: { ...process.env, AGENTBUS_DIR: dir, AGENTBUS_BIN: BIN },
      stdio: 'inherit',
    });
    child.on('exit', (code) =>
      code === 0 ? resolve(0) : reject(new Error(`responder exit ${code}`)),
    );
  });
}

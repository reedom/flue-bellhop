// Shared test helpers for flue-bellhop reference tests.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

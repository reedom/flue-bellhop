// flue-bellhop reference implementation.
// Wraps the `agentbus` CLI (agentbus >= 0.3); never touches the store files
// directly. Same machine as the bellhop fleet; Node runtime only.

import { execFile } from 'node:child_process';

// -- errors -----------------------------------------------------------------

/** The CLI exited non-zero (or emitted non-JSON where JSON was expected). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** bellhopd answered a control ask with an ErrorReply. */
export class BellhopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BellhopError';
  }
}

/** An ask expired; the reply stays retrievable via fleet.askResult(). */
export class AskTimeout extends Error {
  constructor(readonly requestId: string) {
    super(`ask ${requestId} timed out; a late reply is retrievable via askResult`);
    this.name = 'AskTimeout';
  }
}

// -- low-level runner ---------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnCli(
  bin: string,
  agentbusDir: string | undefined,
  args: string[],
  stdin?: string,
): Promise<RunResult> {
  const env = { ...process.env };
  if (agentbusDir !== undefined) {
    env['AGENTBUS_DIR'] = agentbusDir;
  }
  return new Promise((resolve) => {
    const child = execFile(bin, args, { env }, (err, stdout, stderr) => {
      const exitCode =
        err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin?.end(stdin ?? '');
  });
}

/** Run one agentbus verb; returns trimmed stdout or throws CliError. */
export async function runAgentbus(
  bin: string,
  agentbusDir: string | undefined,
  args: string[],
  stdin?: string,
): Promise<string> {
  const { stdout, stderr, exitCode } = await spawnCli(bin, agentbusDir, args, stdin);
  if (exitCode !== 0) {
    throw new CliError(
      `agentbus ${args[0] ?? ''} failed (exit ${exitCode})`,
      `${stdout}\n${stderr}`.trim(),
      exitCode,
    );
  }
  return stdout.trim();
}

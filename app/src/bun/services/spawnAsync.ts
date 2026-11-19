/** The async replacement for execFileSync/spawnSync in the backend: bun's
 *  main thread serves every RPC and every Thread's stream, so a child process
 *  must never be waited on synchronously there (see
 *  internal/PARALLEL-THREADS-PR2-UNBLOCK-BUN.html, 2c). */

export type SpawnResult = {
  /** Exit code; null when the process never exited normally (killed by the
   *  timeout or a signal). */
  code: number | null;
  stdout: string;
  stderr: string;
};

export type SpawnOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Milliseconds before the child is killed. */
  timeout?: number;
};

/** Run a command to completion without blocking the event loop. Never throws
 *  on a non-zero exit — check `code` (or use runChecked). Throws only when the
 *  binary can't be spawned at all (ENOENT). */
export async function run(
  cmd: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeout,
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: proc.signalCode ? null : code, stdout, stderr };
}

/** A command exited non-zero (or was killed). */
export class CommandFailed extends Error {
  constructor(
    readonly cmd: string[],
    readonly result: SpawnResult,
  ) {
    const why = result.code === null ? "was killed" : `exited ${result.code}`;
    const detail = result.stderr.trim().split("\n").slice(-3).join(" ");
    super(`${cmd[0]} ${why}${detail ? `: ${detail}` : ""}`);
  }
  /** Mirrors execFileSync's error shape, which callers used to inspect. */
  get status(): number | null {
    return this.result.code;
  }
}

/** run(), but a non-zero exit throws CommandFailed — the execFileSync
 *  contract, minus the blocking. Resolves to stdout. */
export async function runChecked(
  cmd: string[],
  opts: SpawnOptions = {},
): Promise<string> {
  const result = await run(cmd, opts);
  if (result.code !== 0) throw new CommandFailed(cmd, result);
  return result.stdout;
}

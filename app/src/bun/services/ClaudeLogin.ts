import type { Subprocess } from "bun";
import type { ClaudeAuthStatus } from "../../shared/ipc";

/** Drives the Claude Code CLI's own sign-in from inside the app.
 *
 *  Subscription mode borrows the user's `claude` login; when that OAuth
 *  session dies the CLI answers every prompt with "Failed to authenticate…"
 *  and only `claude auth login` fixes it. That command (2.1.x) prints a
 *  claude.com authorize URL, opens it, and then reads an authorization code
 *  from stdin — the page shows the code after consent (no localhost
 *  callback, so the paste step is unavoidable). This service spawns the
 *  command, hands the URL to the UI, forwards the pasted code, and confirms
 *  the result with `claude auth status --json`. One sign-in at a time. */
export class ClaudeLogin {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private exited: Promise<number> | null = null;
  private stderr = "";
  private url = "";

  private submitted = false;

  constructor(
    private resolveBinary: () => string,
    /** Called when a sign-in finishes (either way) so the app can refresh. */
    private onChanged: (status: ClaudeAuthStatus) => void = () => {},
    /** Called when the CLI finishes WITHOUT a pasted code — the browser tab
     *  it opened completed the login through its local callback (the common
     *  path; the code page is only the fallback). */
    private onFinished: (r: {
      ok: boolean;
      email?: string;
      error?: string;
    }) => void = () => {},
  ) {}

  /** `claude auth status --json`. Never throws — an unreadable status is
   *  reported as { loggedIn: false, error } so callers can show something. */
  async status(): Promise<ClaudeAuthStatus> {
    let bin: string;
    try {
      bin = this.resolveBinary();
    } catch (e) {
      return { loggedIn: false, error: String((e as Error).message ?? e) };
    }
    try {
      const proc = Bun.spawn([bin, "auth", "status", "--json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
      });
      const timer = setTimeout(() => proc.kill(), STATUS_TIMEOUT_MS);
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      clearTimeout(timer);
      return parseAuthStatus(out, err);
    } catch (e) {
      return { loggedIn: false, error: String((e as Error).message ?? e) };
    }
  }

  /** Spawn `claude auth login` and resolve once its sign-in URL is known.
   *  The CLI opens the browser itself; the URL is returned for a manual
   *  fallback. A sign-in already in progress is abandoned first. */
  async start(): Promise<{ ok: boolean; url?: string; error?: string }> {
    this.cancel();
    let bin: string;
    try {
      bin = this.resolveBinary();
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
    const proc = Bun.spawn([bin, "auth", "login"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
    });
    this.proc = proc;
    this.stderr = "";
    this.url = "";
    this.submitted = false;
    void this.drain(proc.stderr, (s) => {
      this.stderr += s;
    });
    this.exited = proc.exited.then(async (code) => {
      const own = this.proc === proc;
      if (own) this.proc = null;
      // Exited without our code: the browser's local callback did the work
      // (or the CLI gave up). Report it so the UI stops waiting for a paste.
      if (own && !this.submitted && this.url) {
        const status = await this.status();
        this.onChanged(status);
        this.onFinished(
          code === 0 && status.loggedIn
            ? { ok: true, email: status.email }
            : {
                ok: false,
                error: `Sign-in failed: ${loginFailureReason(this.stderr) || `the CLI exited with code ${code}`}`,
              },
        );
      }
      return code;
    });
    // Read stdout until the authorize URL shows up (or the process dies).
    const url = await new Promise<string>((resolve) => {
      let buf = "";
      const timer = setTimeout(() => resolve(""), START_TIMEOUT_MS);
      void this.drain(proc.stdout, (s) => {
        buf += s;
        const found = extractLoginUrl(buf);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      }).then(() => {
        clearTimeout(timer);
        resolve(extractLoginUrl(buf) ?? "");
      });
    });
    if (!url) {
      const detail = this.stderr.trim() || "the CLI printed no sign-in link";
      this.cancel();
      return { ok: false, error: `Could not start sign-in: ${detail}` };
    }
    this.url = url;
    return { ok: true, url };
  }

  /** Forward the code the browser showed, wait for the CLI to redeem it,
   *  then confirm via status. */
  async submitCode(
    code: string,
  ): Promise<{ ok: boolean; email?: string; error?: string }> {
    const proc = this.proc;
    const exited = this.exited;
    if (!proc || !exited) {
      return { ok: false, error: "No sign-in in progress — start again." };
    }
    const trimmed = code.trim();
    if (!trimmed) return { ok: false, error: "Paste the code first." };
    this.submitted = true;
    try {
      proc.stdin.write(`${trimmed}\n`);
      await proc.stdin.flush();
      proc.stdin.end();
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
    const timer = setTimeout(() => proc.kill(), SUBMIT_TIMEOUT_MS);
    const exitCode = await exited;
    clearTimeout(timer);
    const status = await this.status();
    this.onChanged(status);
    if (exitCode === 0 && status.loggedIn) {
      return { ok: true, email: status.email };
    }
    const detail =
      loginFailureReason(this.stderr) ||
      (exitCode !== 0
        ? `the CLI exited with code ${exitCode}`
        : "the CLI still reports no login");
    return { ok: false, error: `Sign-in failed: ${detail}` };
  }

  cancel(): void {
    const proc = this.proc;
    this.proc = null;
    this.exited = null;
    this.submitted = true; // a deliberate kill is not a finished sign-in
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
    proc.kill();
  }

  /** The URL of the sign-in in progress ("" when none). */
  get currentUrl(): string {
    return this.proc ? this.url : "";
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    onChunk: (s: string) => void,
  ): Promise<void> {
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream)
        onChunk(dec.decode(chunk, { stream: true }));
    } catch {
      // process died — the exit path reports it
    }
  }
}

const STATUS_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 20_000;
/** The user has this long to sign in and paste the code once submitted —
 *  the CLI redeems it in seconds, so this only guards a hung process. */
const SUBMIT_TIMEOUT_MS = 60_000;

/** Strip terminal escapes (the CLI wraps the URL in an OSC 8 hyperlink and
 *  colours the prompt) and pull the first claude.com sign-in link out.
 *  Exported for tests. */
export function extractLoginUrl(stdout: string): string | null {
  const plain = stripAnsi(stdout);
  const m = plain.match(/https:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

/** Parse `claude auth status --json`. The CLI prints one JSON object;
 *  anything else (missing binary text, a stack trace) reads as signed-out
 *  with the raw text as the reason. Exported for tests. */
export function parseAuthStatus(stdout: string, stderr = ""): ClaudeAuthStatus {
  const plain = stripAnsi(stdout).trim();
  const start = plain.indexOf("{");
  const end = plain.lastIndexOf("}");
  if (start === -1 || end <= start) {
    const reason = (stripAnsi(stderr).trim() || plain).slice(0, 200);
    return { loggedIn: false, error: reason || "no status output" };
  }
  try {
    const j = JSON.parse(plain.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    return {
      loggedIn: j.loggedIn === true,
      ...(typeof j.email === "string" && j.email ? { email: j.email } : {}),
      ...(typeof j.authMethod === "string" ? { method: j.authMethod } : {}),
    };
  } catch (e) {
    return { loggedIn: false, error: String((e as Error).message ?? e) };
  }
}

/** The CLI reports a bad code as "Login failed: …" on stderr. */
export function loginFailureReason(stderr: string): string {
  const plain = stripAnsi(stderr);
  const m = plain.match(/Login failed:?\s*(.+)/i);
  if (m) return m[1].trim();
  return plain.trim().split("\n").filter(Boolean).pop() ?? "";
}

/** OSC (hyperlinks, titles) and CSI (colours, cursor moves) sequences. */
function stripAnsi(s: string): string {
  return Bun.stripANSI(s);
}

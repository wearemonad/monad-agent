import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { api } from "../rpc";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "awaiting-code"; url: string; error?: string }
  | { kind: "verifying" }
  | { kind: "done"; email?: string }
  | { kind: "failed"; error: string };

/** The in-app `claude auth login` flow, shared by the chat (when a run dies
 *  with "Failed to authenticate…") and Settings → Providers. The CLI opens
 *  claude.com in the browser; after consent the page shows a code that the
 *  user pastes here — there is no localhost callback in this flow, so the
 *  paste step is the whole trick. */
export function ClaudeLoginFlow({
  onSignedIn,
  autoStart = false,
  startLabel = "Sign in to Claude",
}: {
  onSignedIn?: (email?: string) => void;
  /** Kick off the browser flow immediately (the chat card asks first). */
  autoStart?: boolean;
  startLabel?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const finished = useStore((s) => s.claudeLoginResult);

  // The common path: the CLI's own browser tab completes the login through
  // a local callback and the CLI exits — no code ever needs pasting. The
  // bun side reports that; stop waiting the moment it does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per login result (seq), not on every phase change.
  useEffect(() => {
    if (!finished) return;
    if (phase.kind !== "awaiting-code" && phase.kind !== "verifying") return;
    if (finished.ok) {
      setPhase({ kind: "done", email: finished.email });
      onSignedIn?.(finished.email);
    } else {
      setPhase({ kind: "failed", error: finished.error ?? "Sign-in failed." });
    }
  }, [finished?.seq]);

  const start = async () => {
    setPhase({ kind: "starting" });
    setCode("");
    const res = await api.claudeLoginStart();
    if (res.ok && res.url) {
      setPhase({ kind: "awaiting-code", url: res.url });
    } else {
      setPhase({
        kind: "failed",
        error: res.error ?? "Could not start sign-in.",
      });
    }
  };

  const submit = async () => {
    if (phase.kind !== "awaiting-code") return;
    const url = phase.url;
    setPhase({ kind: "verifying" });
    const res = await api.claudeLoginSubmitCode(code);
    if (res.ok) {
      setPhase({ kind: "done", email: res.email });
      onSignedIn?.(res.email);
    } else {
      // A bad paste is the common miss — the CLI exited, so a retry means
      // a fresh start; say so instead of leaving a dead input.
      setPhase({
        kind: "failed",
        error: res.error ?? "Sign-in failed.",
      });
      void url;
    }
  };

  const cancel = async () => {
    await api.claudeLoginCancel();
    setPhase({ kind: "idle" });
    setCode("");
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only auto-start.
  useEffect(() => {
    if (autoStart) void start();
  }, []);

  switch (phase.kind) {
    case "idle":
      return (
        <Button size="sm" onClick={() => void start()}>
          <KeyRound size={13} className="mr-1.5" />
          {startLabel}
        </Button>
      );
    case "starting":
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Opening the sign-in page in your browser…
        </p>
      );
    case "awaiting-code":
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Finish signing in in your browser — this card updates by itself once
            the browser says you're set up. Only if the page shows a code
            instead, paste it here.
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              className="flex-1 h-8 text-xs font-mono"
              placeholder="Code (only if the browser shows one)"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim()) void submit();
              }}
            />
            <Button
              size="sm"
              disabled={!code.trim()}
              onClick={() => void submit()}
            >
              Submit
            </Button>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              onClick={() => void api.openUrl(phase.url)}
            >
              <ExternalLink size={12} />
              Open the sign-in page again
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void cancel()}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    case "verifying":
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Checking the code…
        </p>
      );
    case "done":
      return (
        <p className="flex items-center gap-2 text-xs text-success">
          <CheckCircle2 size={13} />
          Signed in{phase.email ? ` as ${phase.email}` : ""}.
        </p>
      );
    case "failed":
      return (
        <div className="space-y-2">
          <p className="text-xs text-destructive wrap-break-word">
            {phase.error}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void start()}>
            Try again
          </Button>
        </div>
      );
  }
}

/** Chat transcript card for a run that died because the Claude CLI login
 *  is gone. Offers the sign-in inline and, once it succeeds, a one-click
 *  resend of the message that failed. */
export function ClaudeLoginCard({
  text,
  retryPrompt,
}: {
  text: string;
  /** The user message whose run failed — offered as "Send again". */
  retryPrompt?: string;
}) {
  const [signedIn, setSignedIn] = useState(false);
  const runState = useStore((s) => s.runState);

  return (
    <Alert variant={signedIn ? "success" : "destructive"}>
      {signedIn ? <CheckCircle2 /> : <TriangleAlert />}
      <AlertTitle>
        {signedIn ? "Signed in to Claude again" : "Claude sign-in expired"}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        {!signedIn && (
          <p className="wrap-break-word">
            {text}
            <br />
            Monad uses your Claude Code login. Sign in again to keep chatting —
            no terminal needed.
          </p>
        )}
        <ClaudeLoginFlow onSignedIn={() => setSignedIn(true)} />
        {signedIn && retryPrompt && (
          <Button
            size="sm"
            variant="secondary"
            disabled={runState === "running"}
            onClick={() => void api.startRun(retryPrompt)}
          >
            Send the last message again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

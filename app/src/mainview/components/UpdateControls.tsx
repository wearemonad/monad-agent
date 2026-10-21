import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useStore } from "../store";
import { api } from "../rpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Updater statuses that are NOT an update in flight — everything else means
 *  work is happening and the button should spin. "check-complete",
 *  "update-available" and "download-complete" are resting states waiting on
 *  the user, not progress: counting them as busy pinned the button to a
 *  disabled "Updating…" forever, with no way to move forward. */
const RESTING_STATUSES = [
  "idle",
  "check-complete",
  "no-update",
  "update-available",
  "download-complete",
  "complete",
  "error",
];

/** T3-style two-phase update controls: Check → Download (spinner + progress %)
 *  → Restart & install (confirmation dialog) → app relaunches.
 *
 *  Ported from T3 Code's desktopUpdate.logic.ts button-action model:
 *  downloaded → "install", available (or a failed download with a known
 *  available version) → "download", otherwise → "check".
 *
 *  Two variants: "full" (settings) shows the manual check button and status
 *  lines; "compact" (sidebar) renders nothing at all until the background
 *  check finds an update, then shows just the action button. */
export function UpdateControls({
  className,
  variant = "full",
}: {
  className?: string;
  variant?: "full" | "compact";
}) {
  const settings = useStore((s) => s.settings);
  const updateStatus = useStore((s) => s.updateStatus);
  const [checking, setChecking] = useState(false);
  // Bridges the gap between clicking Download/Install and the first status
  // push arriving, and papers over the "update-available" re-emit that
  // Electrobun's downloadUpdate() fires mid-download when it re-checks.
  const [downloading, setDownloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Availability survives later statuses (download errors, etc.) so the
  // Download button can come back as a retry — T3's errorContext model.
  const [sawAvailable, setSawAvailable] = useState(false);
  const [result, setResult] = useState<{
    updateAvailable: boolean;
    error: string;
  } | null>(null);

  const status = updateStatus?.status;
  const updateReady = status === "download-complete";
  const installDone = status === "complete";
  const errored = status === "error";

  useEffect(() => {
    if (status === "update-available") setSawAvailable(true);
    if (status === "download-complete" || status === "error")
      setDownloading(false);
    if (status === "error") setInstalling(false);
  }, [status]);

  if (!settings) return null;

  const statusBusy = updateStatus && !RESTING_STATUSES.includes(status!);
  const busy = downloading || installing || !!statusBusy;
  const updateAvailable = result?.updateAvailable || sawAvailable;

  const check = async () => {
    setChecking(true);
    setResult(null);
    const r = await api.updateCheck();
    setResult({ updateAvailable: r.updateAvailable, error: r.error });
    setChecking(false);
  };

  const download = () => {
    setDownloading(true);
    void api.updateDownload();
  };

  const install = () => {
    setConfirmOpen(false);
    setInstalling(true);
    void api.updateInstall();
  };

  const confirmDialog = (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Install update and restart?</AlertDialogTitle>
          <AlertDialogDescription>
            Any running tasks will be interrupted. Make sure you're ready before
            continuing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={install}>
            Restart &amp; install
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const installButton = (
    <Button
      size="sm"
      className="w-full h-7 text-xs"
      onClick={() => setConfirmOpen(true)}
    >
      Restart &amp; install update
    </Button>
  );

  const downloadButton = (
    <Button size="sm" className="w-full h-7 text-xs" onClick={download}>
      {errored ? "Retry download" : "Download update"}
    </Button>
  );

  const progressButton = (
    <Button size="sm" className="w-full h-7 text-xs" disabled>
      <Loader2 size={12} className="animate-spin" />
      {installing
        ? "Installing…"
        : updateStatus?.progress != null
          ? `Downloading… ${Math.round(updateStatus.progress)}%`
          : "Downloading…"}
    </Button>
  );

  if (variant === "compact") {
    // Sidebar: invisible until the background check finds an update — the
    // manual check, version line and status text live in Settings.
    if (settings.channel === "dev" || !settings.updatesConfigured) return null;
    if (installDone || (!updateAvailable && !busy && !updateReady)) return null;
    return (
      <div className={cn("space-y-1.5", className)}>
        {updateReady && !busy
          ? installButton
          : busy
            ? progressButton
            : downloadButton}
        {confirmDialog}
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {settings.channel === "dev" ? (
        <p className="text-[0.625rem] text-muted-foreground">
          Updates disabled in dev builds.
        </p>
      ) : !settings.updatesConfigured ? (
        <p
          className="text-[0.625rem] text-muted-foreground"
          title="This build was published without an update URL, so it can't check for updates. Install the latest release manually once — see docs/releasing.md in the Monad repo"
        >
          Updates not configured (no baseUrl).
        </p>
      ) : (
        <>
          {updateReady && !busy && !installDone ? (
            installButton
          ) : updateAvailable && !busy && !installDone ? (
            downloadButton
          ) : !updateAvailable && !installDone ? (
            <Button
              variant="secondary"
              size="sm"
              className="w-full h-7 text-xs"
              disabled={checking || busy}
              onClick={() => void check()}
            >
              {checking || busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : null}
              {busy
                ? "Updating…"
                : checking
                  ? "Checking…"
                  : "Check for updates"}
            </Button>
          ) : busy ? (
            progressButton
          ) : null}
          {updateStatus && (
            <p
              className="text-[0.625rem] text-muted-foreground truncate"
              title={updateStatus.message}
            >
              {updateStatus.message}
              {updateStatus.progress != null &&
                ` (${Math.round(updateStatus.progress)}%)`}
            </p>
          )}
          {result &&
            !result.updateAvailable &&
            !result.error &&
            !updateStatus && (
              <p className="text-[0.625rem] text-success">Up to date.</p>
            )}
          {result?.error && (
            <p
              className="text-[0.625rem] text-destructive truncate"
              title={result.error}
            >
              {result.error}
            </p>
          )}
          {updateReady && (
            <p className="text-[0.625rem] text-success">
              Update downloaded — restart to install.
            </p>
          )}
          {installDone && (
            <p className="text-[0.625rem] text-success">
              Update installed — restarting…
            </p>
          )}
          {confirmDialog}
        </>
      )}
    </div>
  );
}

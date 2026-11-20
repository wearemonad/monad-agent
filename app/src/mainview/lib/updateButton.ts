/** What the sidebar's round update button shows and does, from the updater's
 *  status plus the little UI state the button keeps itself. Pure, so every
 *  transition is testable without rendering. Modelled on T3 Code's
 *  desktopUpdate.logic.ts: check → download (progress ring) → restart. */

export type UpdateButtonInput = {
  channel: string;
  updatesConfigured: boolean;
  /** Latest push from the bun-side updater, if any. */
  status: { status: string; message: string; progress?: number } | null;
  /** A manual check is in flight. */
  checking: boolean;
  /** Download was clicked and the first progress push hasn't settled it. */
  downloading: boolean;
  /** Install was confirmed; the app is about to relaunch. */
  installing: boolean;
  /** The updater reported an available update at some point this session. */
  sawAvailable: boolean;
  /** Result of the last manual check. */
  checkResult: UpdateCheckResult | null;
};

/** The updateCheck RPC's response. */
export type UpdateCheckResult = {
  updateAvailable: boolean;
  version: string;
  error: string;
};

/** The button's own flags that the updater's status pushes settle. */
export type UpdateFlags = Pick<
  UpdateButtonInput,
  "downloading" | "installing" | "sawAvailable"
>;

/** How one updater status changes the button's flags. Electrobun reports a
 *  restart vetoed by a before-quit handler as "idle", and a download or
 *  re-check that found nothing to do as "no-update" — both must release the
 *  spinner, or the button sits disabled until the app restarts. */
export function applyUpdateStatus(
  flags: UpdateFlags,
  status: string,
): UpdateFlags {
  switch (status) {
    case "update-available":
      return { ...flags, sawAvailable: true };
    case "download-complete":
      return { ...flags, downloading: false };
    case "error":
    case "idle":
      return { ...flags, downloading: false, installing: false };
    case "no-update":
      return { downloading: false, installing: false, sawAvailable: false };
    default:
      return flags;
  }
}

export type UpdateButtonIcon =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded";

export type UpdateButtonState = {
  icon: UpdateButtonIcon;
  action: "check" | "download" | "install" | "none";
  tooltip: string;
  disabled: boolean;
  /** An update is in play: the button gets a filled surface. */
  emphasized: boolean;
  /** Download progress for the ring, 0–100, when known. */
  percent: number | null;
};

/** Updater statuses that are NOT an update in flight; anything else means a
 *  download/apply is running. "check-complete", "update-available" and
 *  "download-complete" wait on the user — counting them as busy once pinned
 *  the old button to a disabled "Updating…" forever. */
export const RESTING_STATUSES = [
  "idle",
  "checking",
  "check-complete",
  "no-update",
  "update-available",
  "download-complete",
  "complete",
  "error",
];

const IDLE: UpdateButtonState = {
  icon: "idle",
  action: "check",
  tooltip: "Check for updates",
  disabled: false,
  emphasized: false,
  percent: null,
};

const CHECKING: UpdateButtonState = {
  ...IDLE,
  icon: "checking",
  action: "none",
  disabled: true,
  tooltip: "Checking for updates…",
};

const unavailable = (tooltip: string): UpdateButtonState => ({
  ...IDLE,
  action: "none",
  tooltip,
  disabled: true,
});

export function resolveUpdateButton(
  input: UpdateButtonInput,
): UpdateButtonState {
  if (input.channel === "dev")
    return unavailable("Updates are off in dev builds");
  if (!input.updatesConfigured)
    return unavailable("This build can't check for updates");

  if (input.checking) return CHECKING;

  const status = input.status?.status;

  // Only while we're installing: Electrobun also replays "complete" after a
  // successful relaunch, which must read as idle.
  if (input.installing)
    return {
      ...IDLE,
      icon: "downloaded",
      action: "none",
      disabled: true,
      emphasized: true,
      tooltip: "Installing update…",
    };

  if (status === "download-complete")
    return {
      ...IDLE,
      icon: "downloaded",
      action: "install",
      emphasized: true,
      tooltip: "Update downloaded. Click to restart and install.",
    };

  const statusBusy = !!status && !RESTING_STATUSES.includes(status);
  if (input.downloading || statusBusy) {
    const percent = statusBusy ? (input.status?.progress ?? null) : null;
    return {
      ...IDLE,
      icon: "downloading",
      action: "none",
      disabled: true,
      emphasized: true,
      percent,
      tooltip:
        percent === null
          ? "Downloading update…"
          : `Downloading update (${Math.floor(percent)}%)`,
    };
  }

  if (status === "error" && input.sawAvailable)
    return {
      ...IDLE,
      icon: "available",
      action: "download",
      emphasized: true,
      // Download or install — the status doesn't say which; re-downloading
      // first is the safe retry for both.
      tooltip: "Update failed. Click to retry.",
    };

  const version = input.checkResult?.updateAvailable
    ? input.checkResult.version
    : "";
  if (input.sawAvailable || input.checkResult?.updateAvailable)
    return {
      ...IDLE,
      icon: "available",
      action: "download",
      emphasized: true,
      tooltip: version
        ? `Update ${version} ready to download`
        : "Update ready to download",
    };

  if (status === "checking") return CHECKING;

  if (input.checkResult?.error)
    return {
      ...IDLE,
      tooltip: `Couldn't check for updates: ${input.checkResult.error}`,
    };
  if (input.checkResult)
    return { ...IDLE, tooltip: "Monad is up to date. Click to check again." };
  return IDLE;
}

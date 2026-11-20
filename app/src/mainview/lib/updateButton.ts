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
  checkResult: {
    updateAvailable: boolean;
    version: string;
    error: string;
  } | null;
};

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
const RESTING_STATUSES = [
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

  if (input.installing || status === "complete")
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
      tooltip: "Download failed. Click to retry.",
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

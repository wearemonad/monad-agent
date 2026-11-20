import { describe, expect, test } from "bun:test";
import { resolveUpdateButton, type UpdateButtonInput } from "./updateButton";

const base: UpdateButtonInput = {
  channel: "stable",
  updatesConfigured: true,
  status: null,
  checking: false,
  downloading: false,
  installing: false,
  sawAvailable: false,
  checkResult: null,
};

describe("resolveUpdateButton", () => {
  test("an idle build offers a manual check", () => {
    expect(resolveUpdateButton(base)).toEqual({
      icon: "idle",
      action: "check",
      tooltip: "Check for updates",
      disabled: false,
      emphasized: false,
      percent: null,
    });
  });

  test("dev builds can't update and say so", () => {
    const s = resolveUpdateButton({ ...base, channel: "dev" });
    expect(s).toMatchObject({ action: "none", disabled: true, icon: "idle" });
    expect(s.tooltip).toBe("Updates are off in dev builds");
  });

  test("a build without an update URL can't update and says so", () => {
    const s = resolveUpdateButton({ ...base, updatesConfigured: false });
    expect(s).toMatchObject({ action: "none", disabled: true });
    expect(s.tooltip).toBe("This build can't check for updates");
  });

  test("a manual check spins and blocks repeat clicks", () => {
    expect(resolveUpdateButton({ ...base, checking: true })).toMatchObject({
      icon: "checking",
      action: "none",
      disabled: true,
      tooltip: "Checking for updates…",
    });
  });

  test("the background check spins the idle button too", () => {
    const s = resolveUpdateButton({
      ...base,
      status: { status: "checking", message: "" },
    });
    expect(s).toMatchObject({ icon: "checking", disabled: true });
  });

  test("a background re-check doesn't hide an update already found", () => {
    const s = resolveUpdateButton({
      ...base,
      sawAvailable: true,
      status: { status: "checking", message: "" },
    });
    expect(s).toMatchObject({ icon: "available", action: "download" });
  });

  test("a check that finds nothing says Monad is up to date", () => {
    const s = resolveUpdateButton({
      ...base,
      checkResult: { updateAvailable: false, version: "0.6.5", error: "" },
    });
    expect(s).toMatchObject({ icon: "idle", action: "check" });
    expect(s.tooltip).toBe("Monad is up to date. Click to check again.");
  });

  test("a failed check shows why and lets you try again", () => {
    const s = resolveUpdateButton({
      ...base,
      checkResult: { updateAvailable: false, version: "", error: "offline" },
    });
    expect(s).toMatchObject({ icon: "idle", action: "check" });
    expect(s.tooltip).toBe("Couldn't check for updates: offline");
  });

  test("a check that finds an update offers the download, naming the version", () => {
    const s = resolveUpdateButton({
      ...base,
      checkResult: { updateAvailable: true, version: "0.7.0", error: "" },
    });
    expect(s).toEqual({
      icon: "available",
      action: "download",
      tooltip: "Update 0.7.0 ready to download",
      disabled: false,
      emphasized: true,
      percent: null,
    });
  });

  test("an update found by the background check offers the download", () => {
    const s = resolveUpdateButton({
      ...base,
      status: { status: "update-available", message: "" },
      sawAvailable: true,
    });
    expect(s).toMatchObject({ icon: "available", action: "download" });
    expect(s.tooltip).toBe("Update ready to download");
  });

  test("a download in progress shows its percentage on the ring", () => {
    const s = resolveUpdateButton({
      ...base,
      sawAvailable: true,
      status: { status: "download-progress", message: "", progress: 42.7 },
    });
    expect(s).toEqual({
      icon: "downloading",
      action: "none",
      tooltip: "Downloading update (42%)",
      disabled: true,
      emphasized: true,
      percent: 42.7,
    });
  });

  test("the updater re-announcing the update mid-download keeps the ring", () => {
    // Electrobun's downloadUpdate() re-checks and re-emits update-available
    // after Download is clicked; the click itself must keep the spinner.
    const s = resolveUpdateButton({
      ...base,
      sawAvailable: true,
      downloading: true,
      status: { status: "update-available", message: "" },
    });
    expect(s).toMatchObject({ icon: "downloading", percent: null });
    expect(s.tooltip).toBe("Downloading update…");
  });

  test("a finished download offers restart & install", () => {
    const s = resolveUpdateButton({
      ...base,
      sawAvailable: true,
      status: { status: "download-complete", message: "" },
    });
    expect(s).toMatchObject({
      icon: "downloaded",
      action: "install",
      disabled: false,
      emphasized: true,
    });
    expect(s.tooltip).toBe("Update downloaded. Click to restart and install.");
  });

  test("a failed download offers a retry", () => {
    const s = resolveUpdateButton({
      ...base,
      sawAvailable: true,
      status: { status: "error", message: "network down" },
    });
    expect(s).toMatchObject({ icon: "available", action: "download" });
    expect(s.tooltip).toBe("Download failed. Click to retry.");
  });

  test("once install is confirmed the button waits for the relaunch", () => {
    for (const status of ["download-complete", "complete"]) {
      const s = resolveUpdateButton({
        ...base,
        sawAvailable: true,
        installing: status === "download-complete",
        status: { status, message: "" },
      });
      expect(s).toMatchObject({
        icon: "downloaded",
        action: "none",
        disabled: true,
        tooltip: "Installing update…",
      });
    }
  });
});

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStore } from "../store";
import { MonadMark } from "./Logo";

/** The About panel behind app menu → About Monad. Replaces the native macOS
 *  panel, which would be nearly empty — Electrobun's generated Info.plist has
 *  no version or copyright keys. Shows what a bug report needs (version,
 *  channel, runtime versions) with a one-click copy. */
export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen);
  const setOpen = useStore((s) => s.setAboutOpen);
  const settings = useStore((s) => s.settings);
  const [copied, setCopied] = useState(false);

  const version = settings?.appVersion ?? "dev";
  const channel = settings?.channel ?? "dev";
  const rows: Array<[string, string]> = [
    ["Version", channel !== "stable" ? `${version} (${channel})` : version],
    ["Electrobun", settings?.electrobunVersion ?? "—"],
    ["Bun", settings?.bunVersion ?? "—"],
    ["OS", settings?.osVersion ?? "—"],
  ];

  const copyInfo = async () => {
    await navigator.clipboard.writeText(
      rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        className="w-75 max-w-[90vw] sm:max-w-75 p-6 flex flex-col items-center gap-1 text-center"
      >
        <MonadMark className="size-14 mb-1" />
        <DialogTitle className="text-base font-semibold">Monad</DialogTitle>
        <p className="text-xs text-muted-foreground mb-3">
          Your company brain, on your Mac.
        </p>
        <div className="w-full text-xs space-y-1 mb-3">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{k}</span>
              <span className="text-foreground truncate">{v}</span>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="xs" onClick={() => void copyInfo()}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy version info"}
        </Button>
        <p className="text-[0.625rem] text-muted-foreground mt-3">
          © {new Date().getFullYear()} We Are Monad
        </p>
      </DialogContent>
    </Dialog>
  );
}

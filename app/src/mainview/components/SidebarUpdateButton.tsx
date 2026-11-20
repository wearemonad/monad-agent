import { useEffect, useState } from "react";
import { Check, Download, RefreshCw, RotateCw } from "lucide-react";
import { useStore } from "../store";
import { api } from "../rpc";
import { cn } from "@/lib/utils";
import {
  type UpdateButtonIcon,
  resolveUpdateButton,
} from "../lib/updateButton";
import { InstallUpdateDialog } from "./UpdateControls";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** The round button at the right of the sidebar footer, after T3 Code's
 *  SidebarUpdatePill: a quiet refresh icon that checks for updates, which
 *  turns into a filled download badge when one is found, a progress ring
 *  while it downloads, and a restart badge once it's ready to install. */
export function SidebarUpdateButton() {
  const settings = useStore((s) => s.settings);
  const updateStatus = useStore((s) => s.updateStatus);
  const [checking, setChecking] = useState(false);
  // Bridges the gap between clicking Download and the first progress push,
  // and covers the update-available re-emit downloadUpdate() fires mid-way.
  const [downloading, setDownloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [sawAvailable, setSawAvailable] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    updateAvailable: boolean;
    version: string;
    error: string;
  } | null>(null);

  const status = updateStatus?.status;
  useEffect(() => {
    if (status === "update-available") setSawAvailable(true);
    if (status === "download-complete" || status === "error")
      setDownloading(false);
    if (status === "error") setInstalling(false);
  }, [status]);

  if (!settings) return null;

  const view = resolveUpdateButton({
    channel: settings.channel,
    updatesConfigured: settings.updatesConfigured,
    status: updateStatus,
    checking,
    downloading,
    installing,
    sawAvailable,
    checkResult,
  });

  const onClick = async () => {
    if (view.disabled) return;
    if (view.action === "check") {
      setChecking(true);
      try {
        const r = await api.updateCheck();
        setCheckResult(r);
        if (r.updateAvailable) setSawAvailable(true);
      } finally {
        setChecking(false);
      }
    } else if (view.action === "download") {
      setDownloading(true);
      void api.updateDownload();
    } else if (view.action === "install") {
      setConfirmOpen(true);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={view.tooltip}
              aria-disabled={view.disabled || undefined}
              onClick={() => void onClick()}
              className={cn(
                "ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
                view.disabled ? "cursor-default" : "cursor-pointer",
                view.emphasized
                  ? "bg-muted text-foreground hover:bg-muted/70 dark:bg-muted/60 dark:hover:bg-muted"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
                view.disabled && !view.emphasized && "opacity-60",
              )}
            />
          }
        >
          <UpdateIcon icon={view.icon} percent={view.percent} />
        </TooltipTrigger>
        <TooltipContent side="top">{view.tooltip}</TooltipContent>
      </Tooltip>
      <InstallUpdateDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          setInstalling(true);
          void api.updateInstall();
        }}
      />
    </>
  );
}

const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function UpdateIcon({
  icon,
  percent,
}: {
  icon: UpdateButtonIcon;
  percent: number | null;
}) {
  if (icon === "available")
    return (
      <span className="relative grid size-4 place-items-center">
        <Download className="size-4" />
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
        />
      </span>
    );

  if (icon === "downloading") {
    const clamped = Math.min(100, Math.max(0, percent ?? 0));
    return (
      <span className="relative grid size-8 place-items-center">
        <svg
          aria-hidden
          viewBox="0 0 32 32"
          className={cn(
            "pointer-events-none absolute inset-0 size-full -rotate-90",
            // Unknown progress: spin a quarter arc instead of a stuck 0%.
            percent === null && "animate-spin motion-reduce:animate-none",
          )}
        >
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.22}
            strokeWidth="1.5"
          />
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={
              RING_CIRCUMFERENCE * (1 - (percent === null ? 25 : clamped) / 100)
            }
            className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
          />
        </svg>
        <Download className="size-4" />
      </span>
    );
  }

  if (icon === "downloaded")
    return (
      <span className="relative grid size-4 place-items-center">
        <RotateCw className="size-4" />
        <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
          <Check className="size-2" strokeWidth={3} />
        </span>
      </span>
    );

  return (
    <RefreshCw
      className={cn(
        "size-4",
        icon === "checking" && "animate-spin motion-reduce:animate-none",
      )}
    />
  );
}

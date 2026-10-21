import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { api } from "../rpc";

/** Full-window drop target. WKWebView doesn't expose dropped-file paths, so we
 *  read the bytes here and stream them to the bun process over RPC. */
export function FileDropOverlay() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void api.ingestFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  if (!dragging) return null;
  return (
    // The backdrop is mostly opaque background, not a brand tint: the old
    // bg-brand/10 let the transcript show through and left the brand-colored
    // copy fighting a brand-tinted surface. Brand now marks only the border
    // and icon; the copy is foreground/muted on a near-solid surface.
    <div className="fixed inset-0 z-40 bg-background/85 border-2 border-dashed border-brand/70 rounded-xl backdrop-blur-md m-2 flex items-center justify-center pointer-events-none animate-in fade-in-0 duration-150">
      <div className="text-center">
        <Inbox size={40} className="mx-auto mb-3 text-brand" />
        <p className="text-lg font-semibold text-foreground">
          Drop files to add them to the brain
        </p>
        <p className="text-sm text-muted-foreground">
          They land in inbox/ and get ingested automatically
        </p>
      </div>
    </div>
  );
}

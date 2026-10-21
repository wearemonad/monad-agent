import { useId } from "react";
import { cn } from "@/lib/utils";

/** The app mark — the same droplet as icon.iconset/, redrawn as inline SVG so
 *  it inherits the sidebar's sizing and stays crisp at any scale. Keep the two
 *  in sync if the mark changes (both derive from the Figma
 *  "Monad Agent — App Icon" frame; see README). */
export function MonadMark({ className }: { className?: string }) {
  // The gradient lives in <defs> and is referenced by url(#id) — a fixed id
  // would collide the moment the mark renders twice on one page.
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="12"
          y1="4"
          x2="12"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F9B24B" />
          <stop offset="0.55" stopColor="#F1735D" />
          <stop offset="1" stopColor="#ED4A6E" />
        </linearGradient>
      </defs>
      <path
        d="M12 4.4C12 4.4 17 11 17 14.6A5 5 0 0 1 7 14.6C7 11 12 4.4 12 4.4Z"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.6" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Mark + wordmark, as shown at the top of the sidebar. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center", className)}>
      <MonadMark className="size-6" />
      <span className="text-[0.8125rem] font-semibold tracking-tight">
        Agent
      </span>
    </span>
  );
}

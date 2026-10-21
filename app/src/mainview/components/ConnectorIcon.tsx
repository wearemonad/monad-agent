import { Folder, Plus } from "lucide-react";

/** Brand icons for the connector catalog tiles, inlined (no icon package
 *  ships these brands; the app makes no external requests).
 *
 *  Color policy follows each brand's own guide: Slack's pinwheel and
 *  PostHog's logomark are officially multi-color; Linear and Stripe are
 *  one-brand-color marks; GitHub, Notion, and Twenty only publish
 *  black/white marks, so `currentColor` IS their official treatment.
 *  PostHog's head + eye use the theme tokens the way their own dark-mode
 *  logo swaps black↔white. */

const DEFAULT_SIZE = 13;

/** Single-path 24×24 marks (paths from simple-icons; Slack's colored icon
 *  below is Slack's own 2019 asset since simple-icons dropped it). */
const MONO_PATHS: Record<string, string> = {
  notion:
    "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  twenty:
    "M20.97 0H3.03A3.03 3.03 0 0 0 0 3.03v17.94A3.03 3.03 0 0 0 3.03 24h17.94A3.03 3.03 0 0 0 24 20.97V3.03A3.03 3.03 0 0 0 20.97 0ZM4.813 8.936a2.376 2.376 0 0 1 2.374-2.375h4.573c.067 0 .129.04.157.103a.172.172 0 0 1-.03.185l-1.002 1.088a.924.924 0 0 1-.678.299H7.2a.713.713 0 0 0-.713.713v1.796a.418.418 0 0 1-.418.419h-.836a.418.418 0 0 1-.419-.419V8.936zm14.224 6.128a2.376 2.376 0 0 1-2.374 2.375h-1.944a2.376 2.376 0 0 1-2.375-2.375v-3.401c0-.231.087-.454.243-.625l1.134-1.23a.172.172 0 0 1 .298.115v5.13c0 .393.32.713.713.713h1.92c.393 0 .713-.32.713-.713V8.949a.713.713 0 0 0-.713-.713h-2.233c-.255 0-.499.108-.674.295l-6.658 7.235h4c.232 0 .419.187.419.418v.837a.418.418 0 0 1-.419.418h-5.39a.886.886 0 0 1-.886-.886v-.443c0-.223.083-.436.234-.6l7.465-8.109a2.603 2.603 0 0 1 1.916-.84h2.235a2.376 2.376 0 0 1 2.375 2.375v6.128z",
};

/** Single-path marks whose brand guide specifies one flat color. */
const TINTED_PATHS: Record<string, { color: string; d: string }> = {
  linear: {
    color: "#5E6AD2",
    d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  },
  stripe: {
    color: "#635BFF",
    d: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
  },
};

/** Slack's official four-color pinwheel (slack.com media kit, 2019 icon). */
function SlackIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 127 127"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <path
        d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
        fill="#E01E5A"
      />
      <path
        d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
        fill="#36C5F0"
      />
      <path
        d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
        fill="#2EB67D"
      />
      <path
        d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
        fill="#ECB22E"
      />
    </svg>
  );
}

/** PostHog's official colored logomark (posthog.com site header). Wider than
 *  tall by design, but drawn letterboxed into the shared square box so every
 *  icon occupies the same footprint and the text column stays aligned. The
 *  head and eye swap with the theme like their own light/dark variants do. */
function PostHogIcon({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 43.88 25.57"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <path
        fill="#F9BD2B"
        d="M0 18.2585L7.31322 25.5619H0V18.2585ZM0 16.4326L9.14153 25.5619H16.4547L0 9.12925V16.4326ZM0 7.3034L18.283 25.5619H25.5963L0 0V7.3034ZM9.14153 7.3034L27.4246 25.5619V18.2585L9.14153 0V7.3034ZM18.283 0V7.3034L27.4246 16.4326V9.12925L18.283 0Z"
      />
      <path
        fill="var(--foreground)"
        d="M43.8793 22.6406C42.0057 22.6406 40.2095 21.8971 38.8858 20.5752L28.7175 10.4205V25.5619H43.8793V22.6406Z"
      />
      <path
        fill="var(--background)"
        d="M33.1055 22.6405C33.9133 22.6405 34.5681 21.9866 34.5681 21.1799C34.5681 20.3732 33.9133 19.7192 33.1055 19.7192C32.2977 19.7192 31.6429 20.3732 31.6429 21.1799C31.6429 21.9866 32.2977 22.6405 33.1055 22.6405Z"
      />
      <path fill="#1D4AFF" d="M0 25.5619H7.31322L0 18.2585V25.5619Z" />
      <path
        fill="#1D4AFF"
        d="M9.14153 9.12925L0 0V7.3034L9.14153 16.4326V9.12925Z"
      />
      <path
        fill="#1D4AFF"
        d="M0 9.12926V16.4327L9.14153 25.5619V18.2585L0 9.12926Z"
      />
      <path
        fill="#F54E00"
        d="M18.283 9.12925L9.14153 0V7.3034L18.283 16.4326V9.12925Z"
      />
      <path
        fill="#F54E00"
        d="M9.14153 25.5619H16.4547L9.14153 18.2585V25.5619Z"
      />
      <path
        fill="#F54E00"
        d="M9.14153 9.12926V16.4327L18.283 25.5619V18.2585L9.14153 9.12926Z"
      />
    </svg>
  );
}

export function ConnectorIcon({
  id,
  size = DEFAULT_SIZE,
  className,
  fallback: Fallback = Plus,
}: {
  /** Catalog entry id, or an installed server's name ("files" = filesystem). */
  id: string;
  size?: number;
  className?: string;
  /** Glyph for unknown ids: Plus in the catalog, Plug on installed cards. */
  fallback?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  // "Local folder" isn't a brand — the generic folder glyph says it better.
  if (id === "filesystem" || id === "files")
    return <Folder size={size} className={className} />;
  if (id === "slack") return <SlackIcon size={size} className={className} />;
  if (id === "posthog" || id === "posthog-eu")
    return <PostHogIcon size={size} className={className} />;
  const tinted = TINTED_PATHS[id];
  const d = tinted?.d ?? MONO_PATHS[id];
  if (!d) return <Fallback size={size} className={className} />;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={tinted?.color ?? "currentColor"}
      aria-hidden="true"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

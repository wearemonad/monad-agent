import type { ComponentProps } from "react";
import type { Components, ExtraProps } from "react-markdown";
import { api } from "../rpc";

/** Shared react-markdown overrides for text the model (or an ingested
 *  document) authored — chat replies, outbox drafts, knowledge docs, markdown
 *  artifacts. Two rules:
 *
 *  - Links never navigate the app webview. https links open in the system
 *    browser via the bun-side openUrl (which re-validates the scheme); every
 *    other scheme is inert.
 *  - Images only render inline (data:/blob:) sources. A remote src would be
 *    fetched automatically before the user reads the message — the classic
 *    zero-click exfiltration beacon for prompt-injected text — so it renders
 *    as its alt text instead. The index.html CSP backstops this override. */

const INLINE_IMG_SRC = /^(data:image\/|blob:)/i;

/** Markdown link that never navigates the webview: https opens in the
 *  browser, anything else is inert. Exported for renderers that override
 *  `a` for some links (wikilinks) and defer to this for the rest. */
export function SafeLink({
  node,
  href,
  children,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  void node;
  return (
    <a
      {...props}
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https:\/\//i.test(href)) void api.openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export const safeMarkdownComponents: Components = {
  a: SafeLink,
  img({ node, src, alt, title }) {
    void node;
    const source = typeof src === "string" ? src : "";
    if (INLINE_IMG_SRC.test(source)) {
      return (
        <img
          src={source}
          alt={alt ?? ""}
          title={title ?? undefined}
          className="max-w-full rounded-md outline outline-black/10 -outline-offset-1 dark:outline-white/10"
        />
      );
    }
    return (
      <span
        className="text-muted-foreground italic"
        title={source ? `Remote image blocked: ${source}` : undefined}
      >
        [image{alt ? `: ${alt}` : ""}]
      </span>
    );
  },
};

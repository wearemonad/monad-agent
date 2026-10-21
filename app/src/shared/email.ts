// Pure helpers for the inline email-draft card (draft_email tool). Shared by
// the bun tool server, stream normalizer, session replay, and tests.

import type { EmailDraftData } from "./ipc";

/** MCP server name — the tool surfaces to the model as mcp__email__draft_email. */
export const EMAIL_SERVER = "email";
export const EMAIL_TOOL_PREFIX = `mcp__${EMAIL_SERVER}__`;
export const DRAFT_EMAIL_TOOL = `${EMAIL_TOOL_PREFIX}draft_email`;

/** Prefix rule that auto-approves the email tools (pure presentation — the
 *  card's buttons are the only path to Gmail, and a human clicks them). */
export const EMAIL_ALLOW_RULE = `${EMAIL_TOOL_PREFIX}*`;

export const MAX_EMAIL_VARIANTS = 4;

/** Header-injection guard. Email headers are single-line: a CR, LF, or NUL in
 *  an address or subject lets attacker-controlled text (a prompt-injected
 *  "to") open a new header line — e.g. a hidden `Bcc:` on a draft the human
 *  then sends. We REJECT rather than strip so a malformed value surfaces as an
 *  error instead of silently sending somewhere unexpected. */
const HEADER_CONTROL_CHARS = /[\r\n\0]/;

/** A single address, roughly RFC 5322: `local@domain` optionally wrapped in a
 *  display name (`Name <a@b>`). Deliberately permissive on the local/display
 *  parts, strict on structure and on the no-control-chars rule. */
const ADDRESS =
  /^\s*(?:[^<>\r\n\0]*<\s*[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\s*>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*$/;

/** Validate a comma-separated recipient list for use in a header. Returns the
 *  trimmed, re-joined list, or throws with a caller-friendly message. Empty
 *  input is allowed only when `optional` (an absent Cc); an empty required
 *  field throws. */
export function sanitizeAddressList(
  value: string,
  field: string,
  optional = false,
): string {
  if (HEADER_CONTROL_CHARS.test(value)) {
    throw new Error(
      `${field} contains an illegal line break or control character.`,
    );
  }
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    if (optional) return "";
    throw new Error(`${field} is required.`);
  }
  for (const p of parts) {
    if (!ADDRESS.test(p))
      throw new Error(`${field} has an invalid address: "${p}".`);
  }
  return parts.join(", ");
}

/** Reject control chars in a header value that isn't an address (e.g. Subject).
 *  Subjects that are non-ASCII get RFC 2047 base64-encoded downstream, but an
 *  all-ASCII subject reaches the header raw — a bare CRLF there injects too. */
export function assertHeaderSafe(value: string, field: string): string {
  if (HEADER_CONTROL_CHARS.test(value)) {
    throw new Error(
      `${field} contains an illegal line break or control character.`,
    );
  }
  return value;
}

/** True when to/cc/subject are all header-safe. Used by the card gate to reject
 *  a poisoned draft before it renders (so the send buttons never carry it). */
function draftHeadersSafe(
  to: string,
  cc: string | undefined,
  subject: string,
): boolean {
  try {
    sanitizeAddressList(to, "To");
    if (cc?.trim()) sanitizeAddressList(cc, "Cc", true);
    assertHeaderSafe(subject, "Subject");
    return true;
  } catch {
    return false;
  }
}

/** Validate/normalize a draft_email tool input into card data, or null when
 *  it isn't usable (renders as a generic tool row instead of a broken card). */
export function parseEmailDraftInput(input: unknown): EmailDraftData | null {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i.to !== "string" || !i.to.trim()) return null;
  if (typeof i.subject !== "string" || !i.subject.trim()) return null;
  // A draft whose headers carry an injected line break never becomes a card —
  // the card's buttons are a path to Gmail, so the guard belongs here too.
  const ccRaw =
    typeof i.cc === "string" && i.cc.trim() ? i.cc.trim() : undefined;
  if (!draftHeadersSafe(i.to.trim(), ccRaw, i.subject.trim())) return null;
  const raw = Array.isArray(i.variants) ? i.variants : [];
  const variants = raw
    .filter(
      (v): v is { label: string; body: string } =>
        !!v &&
        typeof (v as any).label === "string" &&
        typeof (v as any).body === "string" &&
        !!(v as any).body.trim(),
    )
    .slice(0, MAX_EMAIL_VARIANTS)
    .map((v) => ({ label: v.label.trim() || "Draft", body: v.body }));
  if (variants.length === 0) return null;
  return {
    to: i.to.trim(),
    cc: typeof i.cc === "string" && i.cc.trim() ? i.cc.trim() : undefined,
    subject: i.subject.trim(),
    variants,
  };
}

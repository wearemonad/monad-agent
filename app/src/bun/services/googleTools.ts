import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { extractBody, type GoogleDriveService } from "./GoogleDriveService";
import { assertHeaderSafe, sanitizeAddressList } from "../../shared/email";

/** Header lookup over a Gmail payload; "" when the header is absent. */
const headerOf = (
  headers: { name?: string | null; value?: string | null }[] | null | undefined,
  name: string,
) => headers?.find((x) => x.name === name)?.value ?? "";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Google APIs require RFC3339 with a timezone; models often omit it. Normalize
 *  anything Date-parseable (no-timezone strings are read as local time) so the
 *  first call never 400s; reject unparseable input before it reaches the API. */
function rfc3339(input: string | undefined, fallback: () => Date): string {
  if (!input?.trim()) return fallback().toISOString();
  const d = new Date(input.trim());
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Invalid timestamp "${input}" — use ISO 8601, e.g. 2026-07-10T09:00:00Z`,
    );
  }
  return d.toISOString();
}
const err = (e: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: `Error: ${String((e as Error).message ?? e)}`,
    },
  ],
  isError: true,
});

/** RFC 2047 encoded-word: message headers are ASCII-only, so a subject with
 *  non-ASCII characters (em-dashes, accents, …) must be encoded or Gmail reads
 *  the raw UTF-8 bytes as Latin-1 mojibake ("—" → "â€”"). */
export function encodeHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** RFC 822 message for the Gmail drafts API. The body is base64-encoded with
 *  an explicit UTF-8 charset so non-ASCII text survives the round trip. */
export function buildDraftMime(draft: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}): string {
  // Header-injection guard at the one point every draft path funnels through
  // (agent tool + human-clicked card). Throws on a CRLF-poisoned recipient so
  // a hidden Bcc can never reach a stored Gmail draft.
  const to = sanitizeAddressList(draft.to, "To");
  const cc = draft.cc?.trim() ? sanitizeAddressList(draft.cc, "Cc", true) : "";
  assertHeaderSafe(draft.subject, "Subject");
  const body64 = Buffer.from(draft.body, "utf8").toString("base64");
  return [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeaderValue(draft.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body64.match(/.{1,76}/g)?.join("\r\n") ?? "",
  ].join("\r\n");
}

/** Create a Gmail DRAFT (never sends) on the workspace's connected account.
 *  Shared by the agent's gmail_create_draft tool and the inline email card's
 *  human-clicked "Create draft" action. Returns the Gmail draft id. */
export async function createGmailDraft(
  google: GoogleDriveService,
  workspaceId: string,
  draft: { to: string; cc?: string; subject: string; body: string },
): Promise<string> {
  const raw = Buffer.from(buildDraftMime(draft)).toString("base64url");
  const res = await google.call(workspaceId, (signal) =>
    google
      .gmailFor(workspaceId)
      .users.drafts.create(
        { userId: "me", requestBody: { message: { raw } } },
        { signal },
      ),
  );
  const id = res.data.id;
  if (!id) throw new Error("Gmail did not return a draft id.");
  return id;
}

/** In-process MCP server exposing the workspace's connected Google account to the
 *  agent. Scoped per run to one workspace; tokens never leave the bun process.
 *  Gmail is read + draft only — sending is deliberately not implemented. */
export function buildGoogleToolsServer(
  google: GoogleDriveService,
  workspaceId: string,
  selfEmail?: string,
) {
  return createSdkMcpServer({
    name: "google",
    version: "1.0.0",
    instructions:
      "Google account tools for this workspace (Gmail read/draft, Calendar). Email drafts are created in Gmail but NEVER sent by the agent — the human reviews and sends them from the Outbox panel in Monad's sidebar (no need to open Gmail)." +
      (selfEmail
        ? ` The connected account is ${selfEmail}; for briefings or notes to self, draft to that address.`
        : ""),
    tools: [
      tool(
        "gmail_search",
        "Search Gmail messages. Returns id, from, subject, date, snippet for up to 15 matches.",
        {
          query: z
            .string()
            .describe("Gmail search query, e.g. 'from:jane newer_than:7d'"),
        },
        async ({ query }) => {
          try {
            const api = google.gmailFor(workspaceId);
            const list = await google.read(workspaceId, (signal) =>
              api.users.messages.list(
                { userId: "me", q: query, maxResults: 15 },
                { signal },
              ),
            );
            const ids = (list.data.messages ?? [])
              .map((m) => m.id)
              .filter((id): id is string => !!id);
            const rows = await Promise.all(
              ids.map(async (id) => {
                const m = await google.read(workspaceId, (signal) =>
                  api.users.messages.get(
                    {
                      userId: "me",
                      id,
                      format: "metadata",
                      metadataHeaders: ["From", "Subject", "Date"],
                    },
                    { signal },
                  ),
                );
                const h = (name: string) =>
                  headerOf(m.data.payload?.headers, name);
                return `id=${id} | ${h("Date")} | ${h("From")} | ${h("Subject")} | ${m.data.snippet ?? ""}`;
              }),
            );
            return text(rows.join("\n") || "No matches.");
          } catch (e) {
            return err(e);
          }
        },
      ),
      tool(
        "gmail_read",
        "Read one Gmail message body (plain text, truncated) by id from gmail_search.",
        {
          // Gmail ids are URL-safe base64; validating + encoding keeps a
          // model-supplied value from steering the API path (../, ?query…).
          messageId: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/, "not a Gmail message id"),
        },
        async ({ messageId }) => {
          try {
            const m = await google.read(workspaceId, (signal) =>
              google
                .gmailFor(workspaceId)
                .users.messages.get(
                  { userId: "me", id: messageId, format: "full" },
                  { signal },
                ),
            );
            const h = (name: string) => headerOf(m.data.payload?.headers, name);
            const body = extractBody(m.data.payload).slice(0, 6000);
            return text(
              `From: ${h("From")}\nTo: ${h("To")}\nDate: ${h("Date")}\nSubject: ${h("Subject")}\n\n${body}`,
            );
          } catch (e) {
            return err(e);
          }
        },
      ),
      tool(
        "gmail_create_draft",
        "Create a Gmail DRAFT (never sends). Use for follow-ups the human will review and send.",
        {
          to: z.string().describe("Recipient email"),
          subject: z.string(),
          body: z.string().describe("Plain-text body"),
          cc: z.string().optional(),
        },
        async ({ to, subject, body, cc }) => {
          try {
            const id = await createGmailDraft(google, workspaceId, {
              to,
              cc,
              subject,
              body,
            });
            return text(
              `Draft created (id ${id}). It has NOT been sent — the user can review and send it from the Outbox panel in the sidebar (or in Gmail).`,
            );
          } catch (e) {
            return err(e);
          }
        },
      ),
      tool(
        "calendar_list_events",
        "List calendar events between two ISO timestamps (defaults: now → +7 days).",
        {
          timeMin: z.string().optional().describe("ISO 8601, default now"),
          timeMax: z
            .string()
            .optional()
            .describe("ISO 8601, default now + 7 days"),
        },
        async ({ timeMin, timeMax }) => {
          try {
            const min = rfc3339(timeMin, () => new Date());
            const max = rfc3339(
              timeMax,
              () => new Date(Date.now() + 7 * 86400_000),
            );
            const res = await google.read(workspaceId, (signal) =>
              google.calendarApi(workspaceId).events.list(
                {
                  calendarId: "primary",
                  timeMin: min,
                  timeMax: max,
                  singleEvents: true,
                  orderBy: "startTime",
                  maxResults: 25,
                },
                { signal },
              ),
            );
            const rows = (res.data.items ?? []).map(
              (e) =>
                `${e.start?.dateTime ?? e.start?.date} → ${e.end?.dateTime ?? e.end?.date} | ${e.summary ?? "(no title)"}${e.attendees ? ` | ${e.attendees.length} attendees` : ""}`,
            );
            return text(rows.join("\n") || "No events in range.");
          } catch (e) {
            return err(e);
          }
        },
      ),
      tool(
        "calendar_create_event",
        // Kept accurate by AgentService's ALWAYS_PROMPT_TOOLS: this tool can
        // email invitations to arbitrary attendees, so every call needs a
        // human click — always-allow never applies, background runs deny it.
        "Create a calendar event on the primary calendar. Every call requires the user's approval via the permission dialog (never auto-approved; unavailable in scheduled runs). Attendees, if given, will receive an invitation email once the user approves.",
        {
          summary: z.string(),
          startISO: z.string().describe("Start, ISO 8601 with timezone"),
          endISO: z.string().describe("End, ISO 8601 with timezone"),
          description: z.string().optional(),
          attendees: z.array(z.string()).optional().describe("Attendee emails"),
        },
        async ({ summary, startISO, endISO, description, attendees }) => {
          try {
            const res = await google.call(workspaceId, (signal) =>
              google.calendarApi(workspaceId).events.insert(
                {
                  calendarId: "primary",
                  requestBody: {
                    summary,
                    description,
                    start: { dateTime: rfc3339(startISO, () => new Date()) },
                    end: {
                      dateTime: rfc3339(
                        endISO,
                        () => new Date(Date.now() + 3600_000),
                      ),
                    },
                    attendees: attendees?.map((email) => ({ email })),
                  },
                },
                { signal },
              ),
            );
            return text(`Event created: ${res.data.htmlLink ?? res.data.id}`);
          } catch (e) {
            return err(e);
          }
        },
      ),
    ],
  });
}

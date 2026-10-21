import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  EMAIL_SERVER,
  MAX_EMAIL_VARIANTS,
  parseEmailDraftInput,
} from "../../shared/email";

/** In-process MCP server for the inline email-draft card. The tool only
 *  PRESENTS drafts in the chat — it never touches Gmail or the filesystem;
 *  every send/save action is a button a human clicks on the card. */
export function buildEmailToolsServer() {
  return createSdkMcpServer({
    name: EMAIL_SERVER,
    version: "1.0.0",
    instructions:
      "Presents email drafts as an interactive card in the chat (variant tabs, copy, save-to-Gmail-drafts, send — all human-clicked). Use draft_email whenever the user asks you to draft/write an email in an interactive chat. For scheduled/background jobs use gmail_create_draft instead — background runs have no chat to show the card in.",
    tools: [buildDraftEmailTool()],
  });
}

/** Exported separately so tests can drive the handler. */
export function buildDraftEmailTool() {
  return tool(
    "draft_email",
    "Present an email draft to the user as an interactive card with the recipient, subject, and 1-4 body variants. The card lets the user copy a variant, save it as a Gmail draft, or send it — the agent itself never sends. Offer 2-3 variants with short contrasting labels (e.g. 'Brief and clean', 'Warmer, more context') when tone is a judgment call; one variant is fine when it isn't.",
    {
      to: z.string().describe("Recipient email address"),
      cc: z.string().optional().describe("Cc addresses, comma-separated"),
      subject: z.string(),
      variants: z
        .array(
          z.object({
            label: z
              .string()
              .describe("Short tab label, e.g. 'Brief and clean'"),
            body: z.string().describe("Complete plain-text email body"),
          }),
        )
        .min(1)
        .max(MAX_EMAIL_VARIANTS),
    },
    async (input) => {
      if (!parseEmailDraftInput(input)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: draft needs a recipient, a subject, and at least one variant with a non-empty body.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Draft presented in the chat with ${input.variants.length} variant(s). The user can copy it, save it to Gmail drafts, or send it from the card — do NOT repeat the email body in your reply; one short sentence about the draft is enough.`,
          },
        ],
      };
    },
  );
}

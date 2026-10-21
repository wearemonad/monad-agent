import { describe, expect, test } from "bun:test";
import { backgroundToolDecision } from "./AgentService";
import { isIngestSafeTool } from "./ingestPolicy";

const WS = "/Users/alex/brains/main";

// C2 regression: the workspace always-allow list matches tool names only.
// Before the fix it was consulted FIRST, so "Read is always allowed" let a
// prompt-injected background ingest run read any file on the machine — the
// ingest policy's path checks were never reached.
describe("backgroundToolDecision precedence", () => {
  const ingestSafe = (tool: string, input: Record<string, unknown>) =>
    isIngestSafeTool(tool, input, WS);
  const allowAll = () => true;
  const allowNone = () => false;

  test("an always-allow name grant cannot bypass the ingest policy's path scope", () => {
    expect(
      backgroundToolDecision(
        "Read",
        { file_path: "/Users/alex/.ssh/id_rsa" },
        WS,
        allowAll,
        ingestSafe,
      ),
    ).toBe("deny");
    expect(
      backgroundToolDecision(
        "Write",
        { file_path: `${WS}/.mcp.json` },
        WS,
        allowAll,
        ingestSafe,
      ),
    ).toBe("deny");
    expect(
      backgroundToolDecision(
        "Bash",
        { command: 'cat ""/etc/passwd' },
        WS,
        allowAll,
        ingestSafe,
      ),
    ).toBe("deny");
  });

  test("the ingest policy still admits its own tools without any grant", () => {
    expect(
      backgroundToolDecision(
        "Read",
        { file_path: `${WS}/inbox/doc.pdf` },
        WS,
        allowNone,
        ingestSafe,
      ),
    ).toBe("background-safe");
    expect(
      backgroundToolDecision(
        "Write",
        { file_path: `${WS}/knowledge/notes/x.md` },
        WS,
        allowNone,
        ingestSafe,
      ),
    ).toBe("background-safe");
  });

  test("non-governed tools fall back to the always-allow list", () => {
    expect(
      backgroundToolDecision(
        "mcp__monad_artifacts__artifact_create",
        { id: "x" },
        WS,
        allowAll,
        ingestSafe,
      ),
    ).toBe("auto-allowed");
    expect(
      backgroundToolDecision(
        "mcp__twenty__create_note",
        {},
        WS,
        allowNone,
        ingestSafe,
      ),
    ).toBe("deny");
  });

  test("scheduled runs (no ingest policy) get path-scoped always-allow", () => {
    expect(
      backgroundToolDecision(
        "Read",
        { file_path: `${WS}/knowledge/a.md` },
        WS,
        allowAll,
      ),
    ).toBe("auto-allowed");
    expect(
      backgroundToolDecision(
        "Read",
        { file_path: "/Users/alex/.ssh/id_rsa" },
        WS,
        allowAll,
      ),
    ).toBe("deny");
    expect(
      backgroundToolDecision(
        "WebFetch",
        { url: "https://x.test" },
        WS,
        allowNone,
      ),
    ).toBe("deny");
  });

  test("gmail draft stays background-safe regardless of grants", () => {
    expect(
      backgroundToolDecision(
        "mcp__google__gmail_create_draft",
        {},
        WS,
        allowNone,
      ),
    ).toBe("background-safe");
  });

  // integrations#12: calendar events can invite arbitrary external attendees —
  // every call needs a human, so background runs deny even with a grant.
  test("calendar_create_event is denied in background runs regardless of grants", () => {
    expect(
      backgroundToolDecision(
        "mcp__google__calendar_create_event",
        { summary: "x", attendees: ["a@evil.test"] },
        WS,
        allowAll,
      ),
    ).toBe("deny");
    expect(
      backgroundToolDecision(
        "mcp__google__calendar_create_event",
        {},
        WS,
        allowAll,
        ingestSafe,
      ),
    ).toBe("deny");
  });
});

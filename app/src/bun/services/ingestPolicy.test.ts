import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  fileToolPathsInsideWorkspace,
  isIngestSafeTool,
  isScheduledSafeTool,
} from "./ingestPolicy";

const WS = "/Users/alex/brains/main";

describe("file tools", () => {
  test("Read/Write/Edit inside the workspace are safe", () => {
    expect(
      isIngestSafeTool("Read", { file_path: `${WS}/inbox/deck.pdf` }, WS),
    ).toBe(true);
    expect(
      isIngestSafeTool(
        "Write",
        { file_path: `${WS}/knowledge/clients/acme.md` },
        WS,
      ),
    ).toBe(true);
    expect(
      isIngestSafeTool("Edit", { file_path: `${WS}/knowledge/INDEX.md` }, WS),
    ).toBe(true);
  });

  test("relative paths resolve against the workspace", () => {
    expect(isIngestSafeTool("Read", { file_path: "inbox/notes.md" }, WS)).toBe(
      true,
    );
    expect(
      isIngestSafeTool("Write", { file_path: "knowledge/notes/x.md" }, WS),
    ).toBe(true);
  });

  test("paths outside the workspace are rejected", () => {
    expect(isIngestSafeTool("Read", { file_path: "/etc/passwd" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool("Write", { file_path: "/Users/alex/.zshrc" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Read", { file_path: `${WS}/../other/secret.md` }, WS),
    ).toBe(false);
    expect(isIngestSafeTool("Read", { file_path: "../outside.md" }, WS)).toBe(
      false,
    );
  });

  test("a sibling folder sharing the workspace prefix is outside", () => {
    expect(
      isIngestSafeTool("Read", { file_path: `${WS}-backup/x.md` }, WS),
    ).toBe(false);
  });

  test("Glob/Grep without a path default to the cwd and are safe", () => {
    expect(isIngestSafeTool("Glob", { pattern: "inbox/*" }, WS)).toBe(true);
    expect(isIngestSafeTool("Grep", { pattern: "acme" }, WS)).toBe(true);
    expect(isIngestSafeTool("Grep", { pattern: "x", path: "/tmp" }, WS)).toBe(
      false,
    );
  });
});

describe("bash", () => {
  test("the ingest skill's commands pass", () => {
    expect(isIngestSafeTool("Bash", { command: "ls inbox/" }, WS)).toBe(true);
    expect(isIngestSafeTool("Bash", { command: "ls -la inbox/" }, WS)).toBe(
      true,
    );
    expect(
      isIngestSafeTool(
        "Bash",
        {
          command: "mv inbox/deck.pdf knowledge/originals/2026-07-16-deck.pdf",
        },
        WS,
      ),
    ).toBe(true);
    expect(
      isIngestSafeTool(
        "Bash",
        { command: "textutil -convert txt -stdout inbox/brief.docx" },
        WS,
      ),
    ).toBe(true);
    expect(
      isIngestSafeTool(
        "Bash",
        {
          command:
            "mkdir -p knowledge/originals && mv inbox/a.pdf knowledge/originals/a.pdf",
        },
        WS,
      ),
    ).toBe(true);
  });

  test("quoted paths with spaces pass", () => {
    expect(
      isIngestSafeTool(
        "Bash",
        {
          command:
            'mv "inbox/Q3 report.pdf" "knowledge/originals/2026-07-16-Q3 report.pdf"',
        },
        WS,
      ),
    ).toBe(true);
  });

  test("absolute paths are checked against the workspace", () => {
    expect(
      isIngestSafeTool("Bash", { command: `cat ${WS}/inbox/a.md` }, WS),
    ).toBe(true);
    expect(isIngestSafeTool("Bash", { command: "cat /etc/passwd" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool("Bash", { command: "mv inbox/a.pdf /tmp/a.pdf" }, WS),
    ).toBe(false);
  });

  test("non-allowlisted commands are rejected", () => {
    expect(isIngestSafeTool("Bash", { command: "rm inbox/a.pdf" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool("Bash", { command: "curl https://evil.example" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "osascript -e 'beep'" }, WS),
    ).toBe(false);
  });

  test("tilde expansion cannot escape the workspace", () => {
    expect(isIngestSafeTool("Bash", { command: "cat ~/.ssh/id_rsa" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool(
        "Bash",
        { command: "mv inbox/a.pdf ~/Desktop/a.pdf" },
        WS,
      ),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "ls --directory=~/Documents" }, WS),
    ).toBe(false);
  });

  test("absolute paths embedded in --flag=VALUE options are checked", () => {
    expect(
      isIngestSafeTool(
        "Bash",
        { command: "cp --target-directory=/tmp inbox/a.md" },
        WS,
      ),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "wc --files0-from=/etc/passwd" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool(
        "Bash",
        { command: `cp --target-directory=${WS}/knowledge inbox/a.md` },
        WS,
      ),
    ).toBe(true);
    expect(
      isIngestSafeTool(
        "Bash",
        { command: "mv --suffix=.bak inbox/a.md inbox/b.md" },
        WS,
      ),
    ).toBe(true);
  });

  test("relative globs are fine, absolute ones are not", () => {
    expect(isIngestSafeTool("Bash", { command: "cat inbox/*.md" }, WS)).toBe(
      true,
    );
    expect(isIngestSafeTool("Bash", { command: "cat /etc/*" }, WS)).toBe(false);
  });

  test("metacharacters, traversal, and chained commands are rejected", () => {
    expect(
      isIngestSafeTool("Bash", { command: "ls inbox/; rm -rf /" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "cat inbox/a.md | sh" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "cat inbox/$(whoami).md" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "ls ../other-workspace" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: "cat inbox/a.md > /tmp/out" }, WS),
    ).toBe(false);
    expect(isIngestSafeTool("Bash", { command: "ls & rm x" }, WS)).toBe(false);
    expect(isIngestSafeTool("Bash", { command: "" }, WS)).toBe(false);
  });

  test("the shape agents actually write for a .docx passes", () => {
    // Real-world ingest command that used to be denied, after which the agent
    // concluded shell was off and left the file unprocessed.
    expect(
      isIngestSafeTool(
        "Bash",
        {
          command: `cd "${WS}" && ls inbox/ && textutil -convert txt -stdout inbox/Developer_Agreement_v6.docx; echo ---; cat knowledge/INDEX.md; ls knowledge/*/`,
        },
        WS,
      ),
    ).toBe(true);
  });

  test("cd is only allowed into the workspace root", () => {
    expect(isIngestSafeTool("Bash", { command: `cd ${WS}` }, WS)).toBe(true);
    expect(isIngestSafeTool("Bash", { command: "cd inbox && ls" }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Bash", { command: "cd /tmp && ls" }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Bash", { command: "cd" }, WS)).toBe(false);
  });

  test("; sequences validate every segment", () => {
    expect(
      isIngestSafeTool("Bash", { command: "ls inbox; ls knowledge" }, WS),
    ).toBe(true);
    expect(isIngestSafeTool("Bash", { command: "ls; rm inbox/a" }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Bash", { command: "ls;" }, WS)).toBe(false);
    expect(
      isIngestSafeTool("Bash", { command: 'echo "a;cat /etc/passwd"' }, WS),
    ).toBe(false);
  });
});

describe("write allowlist (C1)", () => {
  test("writes are confined to the content subtrees", () => {
    expect(
      isIngestSafeTool("Write", { file_path: "knowledge/clients/acme.md" }, WS),
    ).toBe(true);
    expect(
      isIngestSafeTool("Write", { file_path: "inbox/processing-note.md" }, WS),
    ).toBe(true);
    expect(
      isIngestSafeTool("Write", { file_path: "artifacts/summary.html" }, WS),
    ).toBe(true);
    expect(isIngestSafeTool("Write", { file_path: "notes.md" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool("Write", { file_path: "outbox/draft.md" }, WS),
    ).toBe(false);
    expect(
      isIngestSafeTool("Edit", { file_path: `${WS}/knowledge/INDEX.md` }, WS),
    ).toBe(true);
    expect(
      isIngestSafeTool("Edit", { file_path: `${WS}/settings.json` }, WS),
    ).toBe(false);
  });

  test("executable agent config is never writable — that would be code execution", () => {
    expect(
      isIngestSafeTool("Write", { file_path: `${WS}/.mcp.json` }, WS),
    ).toBe(false);
    expect(isIngestSafeTool("Write", { file_path: ".mcp.json" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool(
        "Edit",
        { file_path: `${WS}/.claude/settings.json` },
        WS,
      ),
    ).toBe(false);
    expect(
      isIngestSafeTool("Write", { file_path: ".claude/skills/x/SKILL.md" }, WS),
    ).toBe(false);
    expect(isIngestSafeTool("Write", { file_path: "CLAUDE.md" }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Edit", { file_path: `${WS}/CLAUDE.md` }, WS)).toBe(
      false,
    );
    // dotfiles hidden inside allowed subtrees are still denied
    expect(
      isIngestSafeTool("Write", { file_path: "knowledge/.evil/hook.sh" }, WS),
    ).toBe(false);
  });

  test("dotfiles are not readable either", () => {
    expect(isIngestSafeTool("Read", { file_path: `${WS}/.mcp.json` }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool(
        "Read",
        { file_path: ".claude/settings.local.json" },
        WS,
      ),
    ).toBe(false);
    expect(
      isIngestSafeTool("Grep", { pattern: "key", path: ".claude" }, WS),
    ).toBe(false);
  });

  test("a write tool without an explicit target is rejected", () => {
    expect(isIngestSafeTool("Write", { content: "x" }, WS)).toBe(false);
    expect(isIngestSafeTool("Edit", {}, WS)).toBe(false);
  });

  test("bash cannot move or copy into the agent config", () => {
    expect(
      isIngestSafeTool(
        "Bash",
        { command: "mv inbox/payload.json .mcp.json" },
        WS,
      ),
    ).toBe(false);
    expect(
      isIngestSafeTool(
        "Bash",
        { command: "cp inbox/hook.sh .claude/settings.json" },
        WS,
      ),
    ).toBe(false);
    expect(isIngestSafeTool("Bash", { command: "mkdir .claude" }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Bash", { command: "cat .mcp.json" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool("Bash", { command: "cp inbox/x.md CLAUDE.md" }, WS),
    ).toBe(false);
  });
});

describe("quote handling (C3)", () => {
  test("a leading empty quote cannot smuggle an absolute path", () => {
    // The C3 exploit: stripQuotes-style handling turned `""/etc/passwd` into
    // a token that dodged the absolute-path check while bash still opened
    // /etc/passwd. Proper tokenization must resolve it to /etc/passwd.
    expect(isIngestSafeTool("Bash", { command: 'cat ""/etc/passwd' }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Bash", { command: "cat ''/etc/passwd" }, WS)).toBe(
      false,
    );
    expect(
      isIngestSafeTool(
        "Bash",
        { command: 'cp ""/Users/alex/.ssh/id_rsa knowledge/' },
        WS,
      ),
    ).toBe(false);
    expect(
      isIngestSafeTool(
        "Bash",
        { command: 'mv ""/Users/alex/taxes.pdf inbox/x' },
        WS,
      ),
    ).toBe(false);
  });

  test("quotes embedded mid-token still resolve to the real path", () => {
    expect(isIngestSafeTool("Bash", { command: 'cat /etc"/passwd"' }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Bash", { command: 'cat "/etc"/passwd' }, WS)).toBe(
      false,
    );
  });

  test("an unterminated quote rejects the whole command", () => {
    expect(isIngestSafeTool("Bash", { command: 'cat "inbox/a.md' }, WS)).toBe(
      false,
    );
  });

  test("flag values naming protected files are rejected", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "monad-ingest-"));
    try {
      fs.writeFileSync(path.join(tmp, ".mcp.json"), "{}");
      expect(
        isIngestSafeTool(
          "Bash",
          { command: "wc --files0-from=.mcp.json" },
          tmp,
        ),
      ).toBe(false);
      expect(
        isIngestSafeTool(
          "Bash",
          { command: "wc --files0-from=.claude/x" },
          tmp,
        ),
      ).toBe(false);
      // non-path flag values still pass (existing legit usage)
      expect(
        isIngestSafeTool(
          "Bash",
          { command: "mv --suffix=.bak inbox/a.md inbox/b.md" },
          tmp,
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("symlink containment", () => {
  test("a symlink inside the workspace cannot resolve outside it", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "monad-symlink-"));
    try {
      const ws = path.join(base, "ws");
      const outside = path.join(base, "outside");
      fs.mkdirSync(path.join(ws, "inbox"), { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "s3cret");
      fs.symlinkSync(outside, path.join(ws, "inbox", "link"));
      expect(
        isIngestSafeTool("Read", { file_path: "inbox/link/secret.txt" }, ws),
      ).toBe(false);
      expect(
        isIngestSafeTool("Bash", { command: "cat inbox/link/secret.txt" }, ws),
      ).toBe(false);
      // a normal file next to it is still fine
      fs.writeFileSync(path.join(ws, "inbox", "ok.md"), "hi");
      expect(isIngestSafeTool("Read", { file_path: "inbox/ok.md" }, ws)).toBe(
        true,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("fileToolPathsInsideWorkspace", () => {
  test("scopes path-carrying tools to the workspace", () => {
    expect(
      fileToolPathsInsideWorkspace(
        "Read",
        { file_path: `${WS}/knowledge/a.md` },
        WS,
      ),
    ).toBe(true);
    expect(
      fileToolPathsInsideWorkspace(
        "Read",
        { file_path: "/Users/alex/.ssh/id_rsa" },
        WS,
      ),
    ).toBe(false);
    expect(
      fileToolPathsInsideWorkspace("Grep", { pattern: "x", path: "/etc" }, WS),
    ).toBe(false);
    expect(
      fileToolPathsInsideWorkspace("Glob", { pattern: "**/*.md" }, WS),
    ).toBe(true);
  });

  test("tools without path inputs pass through", () => {
    expect(fileToolPathsInsideWorkspace("ToolSearch", { query: "x" }, WS)).toBe(
      true,
    );
    expect(
      fileToolPathsInsideWorkspace(
        "mcp__monad_artifacts__artifact_create",
        {},
        WS,
      ),
    ).toBe(true);
  });
});

describe("everything else", () => {
  test("network, agents, and MCP tools are not ingest-safe", () => {
    expect(isIngestSafeTool("WebFetch", { url: "https://x.test" }, WS)).toBe(
      false,
    );
    expect(isIngestSafeTool("Task", { prompt: "do things" }, WS)).toBe(false);
    expect(isIngestSafeTool("mcp__twenty__create_note", {}, WS)).toBe(false);
    expect(
      isIngestSafeTool("NotebookEdit", { notebook_path: `${WS}/x.ipynb` }, WS),
    ).toBe(false);
  });
});

describe("scheduled-run policy", () => {
  test("writes are confined to outbox/ and artifacts/ — never the brain", () => {
    expect(
      isScheduledSafeTool(
        "Write",
        { file_path: "outbox/briefings/2026-08-16-briefing.md" },
        WS,
      ),
    ).toBe(true);
    expect(
      isScheduledSafeTool("Write", { file_path: "artifacts/report.html" }, WS),
    ).toBe(true);
    // Unlike ingest, scheduled runs have no review queue: knowledge/ (and
    // inbox/, which feeds auto-ingest) must stay read-only to them.
    expect(
      isScheduledSafeTool("Write", { file_path: "knowledge/clients/x.md" }, WS),
    ).toBe(false);
    expect(
      isScheduledSafeTool("Edit", { file_path: "inbox/note.md" }, WS),
    ).toBe(false);
    expect(isScheduledSafeTool("Write", { file_path: "outbox.md" }, WS)).toBe(
      false,
    );
  });

  test("reads and safe shell stay workspace-contained like ingest", () => {
    expect(
      isScheduledSafeTool(
        "Read",
        { file_path: `${WS}/knowledge/INDEX.md` },
        WS,
      ),
    ).toBe(true);
    expect(isScheduledSafeTool("Grep", { pattern: "deadline" }, WS)).toBe(true);
    expect(isScheduledSafeTool("Read", { file_path: "/etc/passwd" }, WS)).toBe(
      false,
    );
    expect(
      isScheduledSafeTool("Bash", { command: "ls outbox/briefings" }, WS),
    ).toBe(true);
    expect(
      isScheduledSafeTool("Bash", { command: "curl https://evil.example" }, WS),
    ).toBe(false);
  });

  test("agent config stays protected", () => {
    expect(isScheduledSafeTool("Write", { file_path: ".mcp.json" }, WS)).toBe(
      false,
    );
    expect(
      isScheduledSafeTool("Read", { file_path: `${WS}/CLAUDE.md` }, WS),
    ).toBe(false);
  });
});

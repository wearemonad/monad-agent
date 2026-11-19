import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { monadTag } from "../services/SessionStore";
import { claudeProjectDir } from "../services/sessionFiles";

/** Dev-only Threads for the fake-stream harness (MONAD_FAKE_AGENT=N): real
 *  session files in the workspace's Claude project folder, so the sidebar,
 *  getSessionHistory and the memory index treat them like any other Thread.
 *  Fixed ids make them easy to find again and remove. */

const MAX_FAKE_THREADS = 20;

export const fakeSessionId = (i: number) =>
  `00000000-fa4e-4000-8000-${String(i + 1).padStart(12, "0")}`;

const fakeFile = (cwd: string, i: number) =>
  path.join(claudeProjectDir(cwd), `${fakeSessionId(i)}.jsonl`);

type Line = Record<string, unknown>;

/** Last entry uuid per fake session, so appended turns chain without
 *  re-reading the file. */
const leaves = new Map<string, string>();

/** One user + assistant exchange, chained onto `parent` the way the CLI
 *  chains entries (getSessionMessages walks parentUuid from the last leaf). */
function exchange(
  sessionId: string,
  cwd: string,
  parent: string | null,
  question: string,
  answer: string,
): Line[] {
  const user = randomUUID();
  const assistant = randomUUID();
  const base = { isSidechain: false, cwd, sessionId, version: "2.1.285" };
  const at = new Date().toISOString();
  return [
    {
      parentUuid: parent,
      ...base,
      message: { role: "user", content: question },
      type: "user",
      uuid: user,
      timestamp: at,
      entrypoint: "sdk-ts",
    },
    {
      parentUuid: user,
      ...base,
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
      type: "assistant",
      uuid: assistant,
      timestamp: at,
    },
  ];
}

const QUESTIONS = [
  "Summarise last quarter's numbers for the board.",
  "What changed in the pricing doc this week?",
  "Draft the agenda for Monday's team meeting.",
  "Which customers are up for renewal in January?",
];

function answer(i: number, turn: number): string {
  return [
    `### Thread ${i + 1}, answer ${turn + 1}`,
    "",
    "Revenue grew while support load grew faster. The table has the detail:",
    "",
    "| Metric | Before | After |",
    "| ------ | ------ | ----- |",
    `| Revenue | 1.2M | ${(1.2 + turn / 50).toFixed(2)}M |`,
    "| Tickets | 3 400 | 4 100 |",
    "",
    "```sql",
    "select account, renewal_date from contracts where renewal_date < '2027-02-01';",
    "```",
    "",
    "- Hire before January.",
    "- Move the FAQ into the help centre.",
  ].join("\n");
}

/** Write the fake Threads numbered `indices` into one workspace, with
 *  `messages` pre-existing messages each (half user, half assistant).
 *  Rewritten on every launch, so each run of the harness starts from the
 *  same history. Returns their session ids. */
export function seedFakeThreads(
  cwd: string,
  workspaceId: string,
  indices: number[],
  messages = 40,
): string[] {
  fs.mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const ids: string[] = [];
  for (const i of indices.filter((n) => n < MAX_FAKE_THREADS)) {
    const sessionId = fakeSessionId(i);
    const lines: Line[] = [];
    let parent: string | null = null;
    for (let turn = 0; turn < messages / 2; turn++) {
      const pair = exchange(
        sessionId,
        cwd,
        parent,
        QUESTIONS[turn % QUESTIONS.length],
        answer(i, turn),
      );
      lines.push(...pair);
      parent = pair[1].uuid as string;
    }
    lines.push(
      { type: "ai-title", aiTitle: `[fake] Thread ${i + 1}`, sessionId },
      { type: "tag", tag: monadTag(workspaceId), sessionId },
    );
    if (parent) leaves.set(sessionId, parent);
    fs.writeFileSync(
      fakeFile(cwd, i),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    ids.push(sessionId);
  }
  return ids;
}

/** Grow a fake Thread's file as its stream progresses, so the memory index
 *  sees a changing session the way it does with real parallel runs. */
export function appendFakeTurn(
  cwd: string,
  workspaceId: string,
  sessionId: string,
  text: string,
): void {
  const i = Number(sessionId.slice(-12)) - 1;
  try {
    const pair = exchange(
      sessionId,
      cwd,
      leaves.get(sessionId) ?? null,
      "Keep going.",
      text,
    );
    leaves.set(sessionId, pair[1].uuid as string);
    const lines = [
      ...pair,
      { type: "tag", tag: monadTag(workspaceId), sessionId },
    ];
    fs.appendFileSync(
      fakeFile(cwd, i),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  } catch {
    // best-effort: the harness keeps streaming either way
  }
}

/** Remove every fake Thread from a workspace (harness off, or on quit). */
export function removeFakeThreads(cwd: string): void {
  for (let i = 0; i < MAX_FAKE_THREADS; i++) {
    fs.rmSync(fakeFile(cwd, i), { force: true });
  }
}

export const isFakeSessionId = (id: string) =>
  id.startsWith("00000000-fa4e-4000-8000-");

/** Session ids ordered largest file first: the long, real Threads the
 *  harness opens as "idle" targets. Ids without a file are left out. */
export function largestSessions(
  cwd: string,
  sessionIds: string[],
  limit: number,
): { sessionId: string; bytes: number }[] {
  const dir = claudeProjectDir(cwd);
  const sized: { sessionId: string; bytes: number }[] = [];
  for (const sessionId of sessionIds) {
    try {
      const bytes = fs.statSync(path.join(dir, `${sessionId}.jsonl`)).size;
      sized.push({ sessionId, bytes });
    } catch {
      // not a Claude session file (an OpenAI thread, or gone)
    }
  }
  return sized.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

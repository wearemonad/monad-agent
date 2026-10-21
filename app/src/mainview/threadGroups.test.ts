import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../shared/ipc";
import { groupThreads, sectionExpanded, sectionStatus } from "./threadGroups";

const t = (
  sessionId: string,
  kind?: SessionSummary["kind"],
): SessionSummary => ({
  sessionId,
  title: sessionId,
  ...(kind ? { kind } : {}),
});

describe("groupThreads", () => {
  test("briefings get their own section; other kinds stay in threads", () => {
    const g = groupThreads(
      [
        t("chat"),
        t("b1", "briefing"),
        t("prep", "meeting-prep"),
        t("job", "scheduled"),
      ],
      [],
    );
    expect(g.briefings.map((x) => x.sessionId)).toEqual(["b1"]);
    expect(g.rest.map((x) => x.sessionId)).toEqual(["chat", "prep", "job"]);
    expect(g.pinned).toEqual([]);
  });

  test("a pinned briefing appears under Pinned only", () => {
    const g = groupThreads([t("b1", "briefing"), t("b2", "briefing")], ["b1"]);
    expect(g.pinned.map((x) => x.sessionId)).toEqual(["b1"]);
    expect(g.briefings.map((x) => x.sessionId)).toEqual(["b2"]);
  });

  test("order within each section is preserved (newest first from the store)", () => {
    const g = groupThreads(
      [t("b3", "briefing"), t("c2"), t("b2", "briefing"), t("c1")],
      [],
    );
    expect(g.briefings.map((x) => x.sessionId)).toEqual(["b3", "b2"]);
    expect(g.rest.map((x) => x.sessionId)).toEqual(["c2", "c1"]);
  });
});

describe("sectionStatus", () => {
  test("rolls up unread and working from the section's own threads only", () => {
    const threads = [t("b1", "briefing"), t("b2", "briefing")];
    expect(
      sectionStatus(
        threads,
        ["b2", "deleted-thread", "chat"],
        (id) => id === "b1",
      ),
    ).toEqual({ unread: 1, working: true });
    expect(sectionStatus(threads, ["chat"], () => false)).toEqual({
      unread: 0,
      working: false,
    });
  });
});

describe("sectionExpanded", () => {
  test("persisted collapse is honoured when not searching", () => {
    expect(sectionExpanded("briefings", ["briefings"], false, true)).toBe(
      false,
    );
    expect(sectionExpanded("briefings", ["pinned"], false, true)).toBe(true);
  });

  test("a search with matches opens a collapsed section", () => {
    expect(sectionExpanded("briefings", ["briefings"], true, true)).toBe(true);
    expect(sectionExpanded("briefings", ["briefings"], true, false)).toBe(
      false,
    );
  });
});

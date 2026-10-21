import { describe, expect, test } from "bun:test";
import { skillNameOf } from "./AgentService";

/** A switched-off skill is enforced at the tool boundary, so the name has to be
 *  recovered from whichever parameter the SDK used for it — and only from a
 *  Skill call, never from a tool that happens to carry a "name" input. */
describe("skillNameOf", () => {
  test("reads the skill from any of the parameter spellings", () => {
    expect(skillNameOf("Skill", { skill: "crm-status" })).toBe("crm-status");
    expect(skillNameOf("Skill", { command: "crm-status" })).toBe("crm-status");
    expect(skillNameOf("Skill", { name: "crm-status" })).toBe("crm-status");
  });

  test("plugin-qualified names collapse to the bare skill name", () => {
    expect(skillNameOf("Skill", { skill: "monad:crm-status" })).toBe(
      "crm-status",
    );
    expect(skillNameOf("Skill", { skill: "/crm-status" })).toBe("crm-status");
    expect(skillNameOf("Skill", { skill: "  crm-status  " })).toBe(
      "crm-status",
    );
  });

  test("other tools are never treated as skill calls", () => {
    expect(skillNameOf("Bash", { command: "crm-status" })).toBe("");
    expect(
      skillNameOf("mcp__google__gmail_create_draft", { name: "crm-status" }),
    ).toBe("");
  });

  test("a Skill call with no usable name yields no match (never a blanket deny)", () => {
    expect(skillNameOf("Skill", {})).toBe("");
    expect(skillNameOf("Skill", { skill: "   " })).toBe("");
    expect(skillNameOf("Skill", { skill: 42 })).toBe("");
  });
});

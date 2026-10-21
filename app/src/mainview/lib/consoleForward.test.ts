import { describe, expect, test } from "bun:test";
import { formatLogArg, formatLogArgs } from "./consoleForward";

describe("formatLogArg", () => {
  test("strings pass through, primitives stringify", () => {
    expect(formatLogArg("hi")).toBe("hi");
    expect(formatLogArg(42)).toBe("42");
    expect(formatLogArg(undefined)).toBe("undefined");
    expect(formatLogArg(null)).toBe("null");
  });

  test("objects become JSON, capped in length", () => {
    expect(formatLogArg({ a: 1 })).toBe('{"a":1}');
    const big = formatLogArg({ s: "x".repeat(5_000) });
    expect(big.length).toBeLessThan(2_100);
    expect(big.endsWith("…")).toBe(true);
  });

  test("circular objects fall back instead of throwing", () => {
    const o: any = {};
    o.self = o;
    expect(formatLogArg(o)).toBe("[object Object]");
  });

  test("errors keep their leading stack lines", () => {
    const out = formatLogArg(new Error("boom"));
    expect(out).toContain("boom");
  });

  test("multiple args join like console output", () => {
    expect(formatLogArgs(["state:", { open: true }, 3])).toBe(
      'state: {"open":true} 3',
    );
  });
});

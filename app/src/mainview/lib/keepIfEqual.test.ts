import { describe, expect, test } from "bun:test";
import { keepIfEqual, keepListIfEqual } from "./keepIfEqual";

describe("keepIfEqual", () => {
  test("returns the previous reference when the new value is deep-equal", () => {
    const prev = { a: 1, nested: { b: [1, 2] } };
    expect(keepIfEqual(prev, { a: 1, nested: { b: [1, 2] } })).toBe(prev);
  });

  test("returns the new value when anything differs", () => {
    const prev = { a: 1, nested: { b: [1, 2] } };
    const next = { a: 1, nested: { b: [1, 3] } };
    expect(keepIfEqual(prev, next)).toBe(next);
  });

  test("handles null on either side", () => {
    const next = { a: 1 };
    expect(keepIfEqual(null, next)).toBe(next);
    expect(keepIfEqual(next, null)).toBe(null);
  });
});

describe("keepListIfEqual", () => {
  const key = (r: { id: string }) => r.id;

  test("an unchanged list keeps the previous array", () => {
    const prev = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ];
    const next = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ];
    expect(keepListIfEqual(prev, next, key)).toBe(prev);
  });

  test("one changed row: new array, unchanged rows keep their old objects", () => {
    const prev = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ];
    const next = [
      { id: "a", n: 1 },
      { id: "b", n: 20 },
      { id: "c", n: 3 },
    ];
    const out = keepListIfEqual(prev, next, key);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(prev[2]);
  });

  test("reordered rows keep their objects, in the new order", () => {
    const prev = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ];
    const out = keepListIfEqual(
      prev,
      [
        { id: "b", n: 2 },
        { id: "a", n: 1 },
      ],
      key,
    );
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });
});

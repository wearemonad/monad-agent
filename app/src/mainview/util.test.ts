import { describe, expect, test } from "bun:test";
import { bytesToBase64 } from "./util";

describe("bytesToBase64", () => {
  test("round-trips small input", () => {
    const bytes = new Uint8Array([104, 105]); // "hi"
    expect(bytesToBase64(bytes.buffer)).toBe(btoa("hi"));
  });

  test("encodes a buffer far past the argument-spread limit without throwing", () => {
    // A spread `String.fromCharCode(...bytes)` blows the stack around ~100K
    // args — this is the image-drop bug. 2MB exercises the chunked path.
    const size = 2 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 256;

    let b64 = "";
    expect(() => {
      b64 = bytesToBase64(bytes.buffer);
    }).not.toThrow();

    // decodes back to the exact bytes
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(size);
    expect(decoded[0]).toBe(0);
    expect(decoded[size - 1]).toBe((size - 1) % 256);
  });
});

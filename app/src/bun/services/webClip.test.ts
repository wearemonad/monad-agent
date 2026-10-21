import { describe, expect, test } from "bun:test";
import { extractReadable, fetchWebClip } from "./webClip";

describe("extractReadable", () => {
  test("takes the title and strips markup", () => {
    const { title, text } = extractReadable(
      `<html><head><title>T &amp; Co</title><style>.x{color:red}</style></head>
			<body><p>Alpha beta.</p><script>evil()</script><p>Gamma &lt;3</p></body></html>`,
    );
    expect(title).toBe("T & Co");
    expect(text).toContain("Alpha beta.");
    expect(text).toContain("Gamma <3");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color:red");
  });

  test("prefers <article> content over page chrome when it is substantial", () => {
    const filler = "Real content sentence. ".repeat(40);
    const html = `<html><body><nav>menu one two three</nav><article><p>${filler}</p></article><footer>foot</footer></body></html>`;
    const { text } = extractReadable(html);
    expect(text).toContain("Real content sentence.");
    expect(text).not.toContain("menu one two three");
    expect(text).not.toContain("foot");
  });

  test("drops nav/header/footer even without an article", () => {
    const { text } = extractReadable(
      `<html><body><header>site head</header><p>Body copy.</p><footer>legal</footer></body></html>`,
    );
    expect(text).toContain("Body copy.");
    expect(text).not.toContain("site head");
    expect(text).not.toContain("legal");
  });

  test("decodes numeric and named entities", () => {
    const { text } = extractReadable(
      `<html><body><p>caf&#233; &amp; bar &#x2192; go</p></body></html>`,
    );
    expect(text).toContain("café & bar → go");
  });
});

describe("fetchWebClip", () => {
  test("rejects non-http(s) protocols", async () => {
    await expect(fetchWebClip("ftp://example.com/x")).rejects.toThrow(/http/i);
    await expect(fetchWebClip("file:///etc/passwd")).rejects.toThrow(/http/i);
  });
});

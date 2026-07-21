/**
 * The pure-ECMAScript utf8ToBase64 (engine-portable) must be byte-identical to
 * the Node `Buffer.from(s,"utf-8").toString("base64")` it replaced — otherwise
 * every preseed/bootstrap would change. Fuzz a range of inputs incl. multibyte
 * UTF-8, emoji (surrogate pairs), and realistic recipe-sized JSON.
 */
import { describe, it, expect } from "vitest";
import { utf8ToBase64 } from "../src/base64.js";

const ref = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("utf8ToBase64", () => {
  const cases = [
    "",
    "a",
    "ab",
    "abc",
    "abcd",
    "hello world",
    "café — naïve façade",
    "日本語テキスト",
    "emoji: 😀🔒🚀 surrogate pairs",
    "mixed 1\n2\t3 \"quotes\" 'and' \\backslash/",
    JSON.stringify({ serverDomain: "home.harry.flagship.services", n: 12345, arr: [1, 2, 3], u: "ü" }),
  ];
  for (const c of cases) {
    it(`matches Buffer for ${JSON.stringify(c).slice(0, 40)}`, () => {
      expect(utf8ToBase64(c)).toBe(ref(c));
    });
  }

  it("matches Buffer over a deterministic fuzz of code points", () => {
    let s = "";
    for (let i = 0; i < 2000; i++) s += String.fromCodePoint((i * 131 + 7) % 0x2000 || 1);
    expect(utf8ToBase64(s)).toBe(ref(s));
  });

  it("matches Buffer for full astral-plane code points", () => {
    let s = "";
    for (let cp = 0x1f300; cp < 0x1f320; cp++) s += String.fromCodePoint(cp);
    expect(utf8ToBase64(s)).toBe(ref(s));
  });
});

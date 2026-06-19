import { describe, expect, it } from "vitest";
// The authoritative webapp encoder this module is a strict TS port of.
import { renderQrSvg as renderQrSvgJs } from "../../../apps/web/public/qrEncoder.js";
import { renderQrSvg, encodeQr } from "../src/qrSvg.js";

const SAMPLES = [
  "flagship://access?server=home.alice.flagship.services&svc=notes&ref=alice-notes&page=cb2421036efeb738c6017d8ee92e7b89",
  "https://flagshipserver.com/",
  "a",
  "The quick brown fox jumps over the lazy dog 0123456789",
];

describe("qrSvg — server-side QR port", () => {
  it("is deterministic + emits a valid SVG", () => {
    const a = renderQrSvg(SAMPLES[0]!, { size: 200 });
    const b = renderQrSvg(SAMPLES[0]!, { size: 200 });
    expect(a).toBe(b);
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain('width="200"');
    expect(a).toContain("<rect");
  });

  it("produces a square module matrix of finder-pattern shape", () => {
    const m = encodeQr("hello world", "L");
    expect(m.length).toBeGreaterThanOrEqual(21); // version-1 is 21×21
    expect(m.every((row) => row.length === m.length)).toBe(true);
    // Top-left finder pattern: a 7×7 dark border ring (corners dark).
    expect(m[0]![0]).toBe(1);
    expect(m[0]![6]).toBe(1);
    expect(m[6]![0]).toBe(1);
    expect(m[1]![1]).toBe(0); // inside the ring's white separator
  });

  it("matches the authoritative webapp encoder byte-for-byte", () => {
    for (const s of SAMPLES) {
      expect(renderQrSvg(s, { size: 240, foreground: "#0f172a" })).toBe(
        renderQrSvgJs(s, { size: 240, foreground: "#0f172a" }),
      );
    }
  });
});

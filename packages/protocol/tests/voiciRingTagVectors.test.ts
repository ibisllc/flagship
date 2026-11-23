// Names on a locked phone: the ring tag key and tag, the locked-name key and the attach body's ringTagKey against
// test-vectors/voici/ring-tag.json (tools/voici-ring-tag-vectors.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", "voici", "ring-tag.json"), "utf8"));
const h = (s: string) => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("voici ring-tag vectors", () => {
  it("derives the per-page tag key and a fresh tag per ring", () => {
    expect(H(P.deriveVoiciRingTagKey(h(V.messagesSecret), V.pageId))).toBe(V.tagKey);
    expect(H(P.deriveVoiciRingTagKey(h(V.messagesSecret), V.otherPageId))).toBe(V.otherTagKey);
    for (const t of V.tags) {
      expect(P.voiciRingTag(h(V.tagKey), t.ringId)).toBe(t.tag);
      expect(P.voiciRingTag(h(V.otherTagKey), t.ringId)).toBe(t.otherPageTag);
      expect(t.tag).not.toBe(t.otherPageTag);
    }
    expect(new Set(V.tags.map((t: { tag: string }) => t.tag)).size).toBe(V.tags.length);
    expect(() => P.voiciRingTag(h(V.tagKey), "AB".repeat(16))).toThrow();
    expect(() => P.deriveVoiciRingTagKey(h(V.messagesSecret), "nope")).toThrow();
  });

  it("keys a locked name by a hash of the pseudonym", () => {
    for (const n of V.lockedNames) expect(P.voiciLockedNameKey(n.pseudonymPub)).toBe(n.key);
  });

  it("reads the attach body's optional ringTagKey", () => {
    for (const c of V.bodies) {
      const got = P.parseVoiciRingBackBody(c.input);
      expect(got === null ? null : (got.ringTagKey ?? "none"), c.name).toBe(c.expect);
      if (got) expect(Object.keys(got.envelope)).not.toContain("ringTagKey");
    }
  });

  it("the committed vectors are current", () => {
    execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "..", "tools", "voici-ring-tag-vectors.ts"), "--check"], { stdio: "pipe" });
  }, 60_000);
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { browserGrantDurationChoices, browserGrantWithin, canonicalBrowserGrantAnswer, canonicalBrowserGrantRevoke } from "../public/webapp/lib/browserGrant.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/browser-grant/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("web browser-grant", () => {
  it("matches the shared vector and refuses the malformed answers", async () => {
    for (const a of v.answers) {
      const bytes = await canonicalBrowserGrantAnswer(a.answer);
      expect(new TextDecoder().decode(bytes)).toBe(a.canonical);
      expect(ed25519.verify(hex(a.signatureHex), bytes, hex(v.pubHex))).toBe(true);
    }
    for (const r of v.refused) await expect(canonicalBrowserGrantAnswer(r.answer), r.name).rejects.toThrow();
  });

  it("answers only the same scope or narrower, and offers the asked duration or shorter", () => {
    for (const n of v.narrowing) expect(browserGrantWithin(n.ask, n.answer), n.name).toBe(n.within);
    for (const c of v.choices) expect(browserGrantDurationChoices(c.asked)).toEqual(c.choices);
  });

  it("matches the revoke vector and refuses the malformed revokes", () => {
    const rv = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/browser-grant-revoke/vectors.json"), "utf8"));
    for (const r of rv.revokes) {
      const bytes = canonicalBrowserGrantRevoke(r.revoke);
      expect(new TextDecoder().decode(bytes)).toBe(r.canonical);
      expect(ed25519.verify(hex(r.signatureHex), bytes, hex(rv.pubHex))).toBe(true);
    }
    for (const r of rv.refused) expect(() => canonicalBrowserGrantRevoke(r.revoke), r.name).toThrow();
  });
});

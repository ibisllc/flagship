import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { aiConsentBody, canonicalAiRepairConsent } from "../public/webapp/lib/aiRepairConsent.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/ai-repair-consent/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("web ai-repair-consent", () => {
  it("matches the shared vector: canonical bytes and signatures", () => {
    for (const o of v.orders) {
      const bytes = canonicalAiRepairConsent(o.order);
      expect(new TextDecoder().decode(bytes)).toBe(o.canonical);
      expect(ed25519.verify(hex(o.signatureHex), bytes, hex(v.pubHex))).toBe(true);
    }
  });
  it("refuses the malformed orders", () => {
    for (const r of v.refused) expect(() => canonicalAiRepairConsent(r.order), r.name).toThrow();
  });
  it("builds the consent object the box checks", async () => {
    const o = v.orders[0];
    expect(await aiConsentBody(o.order, () => hex(o.signatureHex))).toEqual({ issuedAt: o.order.issuedAt, provider: o.order.provider, source: o.order.source, highTokens: o.order.highTokens, signature: o.signatureHex });
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";
import { signLlmPromoIssue, verifyLlmPromoIssue, type LlmPromoIssueRequest } from "../src/llmPromo.js";

interface Vectors {
  umkSeedHex: string;
  pub: string;
  cases: Array<LlmPromoIssueRequest & { canonical: string; signature: string }>;
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/llm-promo-issue/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

function requestOf(c: Vectors["cases"][number]): LlmPromoIssueRequest {
  return {
    username: c.username,
    serverFqdn: c.serverFqdn,
    provider: c.provider,
    desiredDailyInputTokenCap: c.desiredDailyInputTokenCap,
    desiredDailyOutputTokenCap: c.desiredDailyOutputTokenCap,
    issuedAt: c.issuedAt,
  };
}

describe("llm-promo-issue vectors (test-vectors/llm-promo-issue/vectors.json)", () => {
  it("the signing key is the IRK derived from the UMK seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });

  it("every case signs to the pinned signature and verifies", () => {
    expect(V.cases.length).toBeGreaterThan(0);
    for (const c of V.cases) {
      const req = requestOf(c);
      const canonical = [
        "flagship/llm-promo-issue/v1",
        req.username,
        req.serverFqdn,
        req.provider,
        req.desiredDailyInputTokenCap,
        req.desiredDailyOutputTokenCap,
        req.issuedAt,
      ].join("|");
      expect(canonical).toBe(c.canonical);
      expect(hex(signLlmPromoIssue(req, irk))).toBe(c.signature);
      expect(verifyLlmPromoIssue(req, fromHex(c.signature), irk.publicKey)).toBe(true);
      expect(verifyLlmPromoIssue({ ...req, issuedAt: req.issuedAt + 1 }, fromHex(c.signature), irk.publicKey)).toBe(false);
    }
  });
});

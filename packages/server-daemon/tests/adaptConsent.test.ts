import { describe, expect, it } from "vitest";
import { ed, signAiRepairConsent } from "@flagship/protocol";
import { AdaptConsentGate, estimateAiTokens, type ConsentInput } from "../src/buildmodes/adaptConsent.js";

const owner = new Uint8Array(32).fill(7);
const BUILD = "0123456789abcdef";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NOW = 1_800_000_000_000;

function gate(over: { provider?: string; source?: "byok" | "promo"; bytes?: number; none?: boolean } = {}) {
  let t = NOW;
  const g = new AdaptConsentGate({
    serverDomain: "home.alice.flagship.services",
    authority: () => ({ username: "alice", ownerIrkPub: ed.getPublicKey(owner) }),
    costOf: () => (over.none ? null : { provider: over.provider ?? "anthropic", source: over.source ?? "byok" }),
    workspaceBytes: () => over.bytes ?? 40_000,
    now: () => t,
  });
  return { g, advance: (ms: number) => void (t += ms) };
}

function consent(g: AdaptConsentGate, over: Partial<{ provider: string; source: "byok" | "promo"; highTokens: number; issuedAt: number; key: Uint8Array }> = {}): ConsentInput {
  const est = g.estimate(BUILD, "adapt")!;
  const c = { serverDomain: "home.alice.flagship.services", buildId: BUILD, operation: "adapt" as const, provider: over.provider ?? est.provider, source: over.source ?? est.source, highTokens: over.highTokens ?? est.highTokens, issuedAt: over.issuedAt ?? NOW };
  const sig = signAiRepairConsent(c, (m) => ed.sign(m, over.key ?? owner));
  return { issuedAt: c.issuedAt, provider: c.provider, source: c.source, highTokens: c.highTokens, signature: hex(sig) };
}

describe("per-operation AI consent", () => {
  it("estimates a range that grows with the project and is capped", () => {
    const small = estimateAiTokens(4_000);
    const big = estimateAiTokens(4_000_000);
    expect(small.highTokens).toBeGreaterThan(small.lowTokens);
    expect(big.lowTokens).toBeGreaterThan(small.lowTokens);
    expect(big.highTokens).toBeLessThanOrEqual(2_000_000);
  });

  it("asks first: no consent is a 428 with the provider, who pays and the range", () => {
    const { g } = gate({ provider: "openai", source: "byok" });
    const v = g.check(BUILD, "adapt", undefined);
    expect(v).toMatchObject({ ok: false, status: 428, reason: "consent-required", estimate: { provider: "openai", source: "byok", unit: "tokens" } });
  });

  it("a build with no credential is left to refuse itself", () => {
    expect(gate({ none: true }).g.check(BUILD, "adapt", undefined)).toEqual({ ok: true });
  });

  it("accepts the owner's signature once, and never twice", () => {
    const { g } = gate();
    const c = consent(g);
    expect(g.check(BUILD, "adapt", c)).toEqual({ ok: true, tokenBudget: c.highTokens });
    expect(g.check(BUILD, "adapt", c)).toMatchObject({ ok: false, status: 403, reason: "that consent was already used" });
  });

  it("refuses a stranger's signature, a stale one, a changed provider or source and a smaller estimate", () => {
    const { g, advance } = gate();
    expect(g.check(BUILD, "adapt", consent(g, { key: new Uint8Array(32).fill(8) }))).toMatchObject({ ok: false, status: 403 });
    expect(g.check(BUILD, "adapt", consent(g, { provider: "someone-else" }))).toMatchObject({ ok: false, reason: "the provider changed since you agreed" });
    expect(g.check(BUILD, "adapt", consent(g, { source: "promo" }))).toMatchObject({ ok: false, reason: "the provider changed since you agreed" });
    expect(g.check(BUILD, "adapt", consent(g, { highTokens: 10 }))).toMatchObject({ ok: false, reason: "the estimate grew since you agreed" });
    const old = consent(g);
    advance(11 * 60_000);
    expect(g.check(BUILD, "adapt", old)).toMatchObject({ ok: false, reason: "that consent is stale" });
  });

  it("a consent for another operation or another build does not carry over", () => {
    const { g } = gate();
    const c = consent(g);
    expect(g.check(BUILD, "repair", c)).toMatchObject({ ok: false, status: 403 });
    expect(g.check("fedcba9876543210", "adapt", c)).toMatchObject({ ok: false, status: 403 });
  });
});

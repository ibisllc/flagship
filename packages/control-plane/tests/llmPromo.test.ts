/**
 * Tests for /api/llm-promo/issue + /api/llm-promo/status.
 */

import { describe, expect, it } from "vitest";
import { ed, signLlmPromoIssue, type Keypair } from "@flagship/protocol";
import {
  InMemoryLlmPromoStorage,
  InMemoryTierStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import { handleLlmPromoIssue, handleLlmPromoStatus } from "../src/llmPromo.js";

function makeIrk(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s;
}
async function seed(usernames: InMemoryUsernameStorage, name: string, irk: Keypair) {
  await usernames.put({ username: name, irkPubHex: bytesToHex(irk.publicKey), claimedAt: Date.now() });
}
const stubMint = async (args: { provider: string; expiresAt: number }) => ({
  key: `fk-${args.provider}-${args.expiresAt}`,
  providerKeyId: `pkid-${args.expiresAt}`,
});

function makeRequest(overrides: Partial<{ provider: "anthropic" | "openai" | "google"; desiredDailyInputTokenCap: number; desiredDailyOutputTokenCap: number; issuedAt: number }> = {}) {
  return {
    username: "alice",
    serverFqdn: "home.alice.flagship.services",
    provider: overrides.provider ?? "anthropic" as const,
    desiredDailyInputTokenCap: overrides.desiredDailyInputTokenCap ?? 1000,
    desiredDailyOutputTokenCap: overrides.desiredDailyOutputTokenCap ?? 500,
    issuedAt: overrides.issuedAt ?? Date.now(),
  };
}

describe("/api/llm-promo/issue", () => {
  it("mints a key for a free-tier user under the daily cap", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const claim = makeRequest();
    const sig = signLlmPromoIssue(claim, irk);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; tier: string; apiKey: string };
    expect(body.ok).toBe(true);
    expect(body.tier).toBe("free");
    expect(body.apiKey).toMatch(/^fk-anthropic-/);
  });

  it("clamps requested per-call cap to the tier max", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const claim = makeRequest({ desiredDailyInputTokenCap: 999_999 });
    const sig = signLlmPromoIssue(claim, irk);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    const body = r.body as { dailyInputTokenCap: number };
    expect(body.dailyInputTokenCap).toBe(1000); // free tier cap
  });

  it("returns 429 once daily cap reached", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const today = Math.floor(Date.now() / 86_400_000);
    // Pre-bump to 50 (free-tier daily cap).
    for (let i = 0; i < 50; i++) {
      await llmPromo.bumpDaily("alice", today, 0, 0);
    }
    const claim = makeRequest();
    const sig = signLlmPromoIssue(claim, irk);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(429);
    const body = r.body as { error: string; retryAt: number };
    expect(body.error).toContain("daily promo cap");
    expect(body.retryAt).toBeGreaterThan(Date.now());
  });

  it("returns 429 when lifetime cap reached (free-tier 200)", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    for (let i = 0; i < 200; i++) {
      await llmPromo.bumpLifetime("alice", 0, 0, Date.now());
    }
    const claim = makeRequest();
    const sig = signLlmPromoIssue(claim, irk);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(429);
    const body = r.body as { error: string };
    expect(body.error).toContain("lifetime");
  });

  it("hobby tier sees a higher daily cap", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    await tiers.put({ username: "alice", tier: "hobby", updatedAt: Date.now() });
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const today = Math.floor(Date.now() / 86_400_000);
    for (let i = 0; i < 50; i++) {
      await llmPromo.bumpDaily("alice", today, 0, 0);
    }
    const claim = makeRequest();
    const sig = signLlmPromoIssue(claim, irk);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200); // hobby allows 100/day
  });

  it("rejects unknown username", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const irk = makeIrk();
    const claim = { ...makeRequest(), username: "ghost" };
    const sig = signLlmPromoIssue(claim, irk);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(404);
  });

  it("rejects wrong signature", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const real = makeIrk(); const evil = makeIrk();
    await seed(usernames, "alice", real);
    const claim = makeRequest();
    const sig = signLlmPromoIssue(claim, evil);
    const r = await handleLlmPromoIssue(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
  });
});

describe("/api/llm-promo/status", () => {
  it("returns the per-tier caps + current usage", async () => {
    const usernames = new InMemoryUsernameStorage();
    const llmPromo = new InMemoryLlmPromoStorage();
    const tiers = new InMemoryTierStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const today = Math.floor(Date.now() / 86_400_000);
    await llmPromo.bumpDaily("alice", today, 100, 50);
    const r = await handleLlmPromoStatus(
      { llmPromo, tiers, usernames, mintProviderKey: stubMint },
      "alice",
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      tier: string;
      daily: { used: number; cap: number };
      lifetime: { used: number; cap: number };
    };
    expect(body.tier).toBe("free");
    expect(body.daily.used).toBe(1);
    expect(body.daily.cap).toBe(50);
    expect(body.lifetime.cap).toBe(200);
  });
});

import { describe, expect, it } from "vitest";
import { ed, signLlmPromoIssue, type Keypair, type LlmPromoIssueRequest } from "@flagship/protocol";
import { InMemoryLlmPromoStorage, InMemoryUsernameStorage } from "@flagship/storage";
import {
  FREE_AI_TOKENS_DEFAULT,
  FREE_AI_TOKEN_TTL_MS,
  FREE_AI_USED_UP_MESSAGE,
  handleFreeAiAllowance,
  handleFreeAiStatus,
  handleFreeAiToken,
  parseFreeAiAllowance,
  promoStorageLedger,
  type FreeAiDeps,
} from "../src/freeAiCredits.js";
import { handleLlmPromoUsage } from "../src/llmPromo.js";
import { mintScopedInferenceToken, verifyScopedInferenceToken } from "../src/inferenceToken.js";

const NOW = 1_800_000_000_000;
const SECRET = "inference-secret";
const ENDPOINT = { baseUrl: "https://inference.example.test", model: "flagship-free" };

function keypair(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function setup(over: Partial<FreeAiDeps> = {}) {
  const usernames = new InMemoryUsernameStorage();
  const promo = new InMemoryLlmPromoStorage();
  const irk = keypair();
  const aid = keypair();
  await usernames.put({
    username: "alice",
    irkPubHex: hex(irk.publicKey),
    aidPubHex: hex(aid.publicKey),
    claimedAt: NOW,
  });
  const deps: FreeAiDeps = {
    usernames,
    ledger: promoStorageLedger(promo),
    endpoint: ENDPOINT,
    tokenSecret: SECRET,
    now: () => NOW,
    newKeyId: () => "fa-test",
    ...over,
  };
  return { deps, promo, irk, aid };
}

function signed(key: Keypair, over: Partial<LlmPromoIssueRequest> = {}) {
  const request: LlmPromoIssueRequest = {
    username: "alice",
    serverFqdn: "home.alice.flagship.services",
    provider: "flagship",
    desiredDailyInputTokenCap: 0,
    desiredDailyOutputTokenCap: 0,
    issuedAt: NOW,
    ...over,
  };
  return { request, signature: hex(signLlmPromoIssue(request, key)) };
}

describe("free AI token", () => {
  it("mints a promo credential for the blessed endpoint and records nothing", async () => {
    const { deps, promo, irk } = await setup();
    const r = await handleFreeAiToken(deps, signed(irk));
    expect(r.status).toBe(200);
    const body = r.body as {
      credential: { provider: string; apiKey: string; baseUrl: string; source: string; relay: boolean };
      model: string;
      expiresAt: number;
      credits: { usedTokens: number; allowanceTokens: number; remainingTokens: number };
    };
    expect(body.credential).toMatchObject({ provider: "flagship", baseUrl: ENDPOINT.baseUrl, source: "promo", relay: true });
    expect(body.model).toBe("flagship-free");
    expect(body.expiresAt).toBe(NOW + FREE_AI_TOKEN_TTL_MS);
    expect(body.credits).toEqual({ usedTokens: 0, allowanceTokens: FREE_AI_TOKENS_DEFAULT, remainingTokens: FREE_AI_TOKENS_DEFAULT });
    const v = await verifyScopedInferenceToken(body.credential.apiKey, SECRET, NOW + 1000);
    expect(v.ok && v.claims.username).toBe("alice");
    expect(v.ok && v.claims.serverFqdn).toBeUndefined();
    expect(await promo.getLifetime("alice")).toBeUndefined();
  });

  it("accepts a request signed with the account AID", async () => {
    const { deps, aid } = await setup();
    expect((await handleFreeAiToken(deps, signed(aid))).status).toBe(200);
  });

  it("refuses a foreign signature, a stale request and a non-flagship provider", async () => {
    const { deps, irk } = await setup();
    expect((await handleFreeAiToken(deps, signed(keypair()))).status).toBe(403);
    expect((await handleFreeAiToken(deps, signed(irk, { issuedAt: NOW - 10 * 60_000 }))).status).toBe(403);
    const anthropic = signed(irk, { provider: "anthropic" });
    expect((await handleFreeAiToken(deps, anthropic)).status).toBe(400);
    expect((await handleFreeAiToken(deps, signed(irk, { username: "bob" }))).status).toBe(404);
  });

  it("says the credits are used up once metered usage reaches the allowance", async () => {
    const { deps, promo, irk } = await setup({ allowanceTokens: 1000 });
    await promo.recordMeteredUsage("alice", 1, 700, 300, NOW);
    const r = await handleFreeAiToken(deps, signed(irk));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      error: FREE_AI_USED_UP_MESSAGE,
      code: "free-ai-used-up",
      credits: { usedTokens: 1000, allowanceTokens: 1000, remainingTokens: 0 },
    });
  });

  it("is unavailable without an endpoint, a secret, or with a zero allowance", async () => {
    for (const over of [{ endpoint: null }, { tokenSecret: undefined }, { allowanceTokens: 0 }]) {
      const { deps, irk } = await setup(over);
      const r = await handleFreeAiToken(deps, signed(irk));
      expect(r.status).toBe(503);
      expect((r.body as { code: string }).code).toBe("free-ai-unavailable");
    }
  });
});

describe("free AI status", () => {
  it("reports used and remaining tokens from metered usage", async () => {
    const { deps, promo, irk } = await setup({ allowanceTokens: 10_000 });
    await promo.recordMeteredUsage("alice", 1, 1500, 500, NOW);
    const r = await handleFreeAiStatus(deps, signed(irk, { serverFqdn: "" }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      available: true,
      credits: { usedTokens: 2000, allowanceTokens: 10_000, remainingTokens: 8000 },
    });
  });

  it("still answers, as unavailable, when free AI isn't configured", async () => {
    const { deps, irk } = await setup({ endpoint: null });
    const r = await handleFreeAiStatus(deps, signed(irk, { serverFqdn: "" }));
    expect((r.body as { available: boolean }).available).toBe(false);
  });

  it("needs the account's signature", async () => {
    const { deps } = await setup();
    expect((await handleFreeAiStatus(deps, signed(keypair(), { serverFqdn: "" }))).status).toBe(403);
  });
});

describe("free AI allowance (shim check)", () => {
  it("tracks usage reported through the existing usage webhook", async () => {
    const { deps, promo, irk } = await setup({ allowanceTokens: 5000 });
    const minted = await handleFreeAiToken(deps, signed(irk));
    const token = (minted.body as { credential: { apiKey: string } }).credential.apiKey;
    const before = await handleFreeAiAllowance(deps, { token });
    expect(before.body).toEqual({ ok: true, remainingTokens: 5000, allowanceTokens: 5000 });
    await handleLlmPromoUsage(
      {
        llmPromo: promo,
        now: () => NOW,
        verifyToken: async (t) => {
          const v = await verifyScopedInferenceToken(t, SECRET, NOW);
          return v.ok ? { ok: true, username: v.claims.username } : { ok: false };
        },
      },
      { token, inputTokens: 4000, outputTokens: 1500 },
    );
    const after = await handleFreeAiAllowance(deps, { token });
    expect((after.body as { remainingTokens: number }).remainingTokens).toBe(0);
  });

  it("refuses a token minted with another secret, or an expired one", async () => {
    const { deps } = await setup();
    const forged = await mintScopedInferenceToken(
      { username: "alice", keyId: "x", iat: NOW, exp: NOW + 1000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      "other",
    );
    expect((await handleFreeAiAllowance(deps, { token: forged })).status).toBe(403);
    const expired = await mintScopedInferenceToken(
      { username: "alice", keyId: "x", iat: NOW - 2000, exp: NOW - 1000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      SECRET,
    );
    expect((await handleFreeAiAllowance(deps, { token: expired })).status).toBe(403);
    expect((await handleFreeAiAllowance(deps, {})).status).toBe(400);
  });
});

describe("parseFreeAiAllowance", () => {
  it("defaults, accepts whole numbers and 0, and ignores junk", () => {
    expect(parseFreeAiAllowance(undefined)).toBe(FREE_AI_TOKENS_DEFAULT);
    expect(parseFreeAiAllowance("")).toBe(FREE_AI_TOKENS_DEFAULT);
    expect(parseFreeAiAllowance("250000")).toBe(250_000);
    expect(parseFreeAiAllowance("0")).toBe(0);
    expect(parseFreeAiAllowance("-5")).toBe(FREE_AI_TOKENS_DEFAULT);
    expect(parseFreeAiAllowance("lots")).toBe(FREE_AI_TOKENS_DEFAULT);
  });
});

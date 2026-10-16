import { describe, expect, it } from "vitest";
import { ed, signLlmPromoIssue, type Keypair, type LlmPromoIssueRequest } from "@flagship/protocol";
import {
  InMemoryDaemonStatusStorage,
  InMemoryMeterStorage,
  InMemoryServerStorage,
  InMemoryTierStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  FREE_AI_DEFAULTS,
  FREE_AI_MESSAGES,
  FREE_AI_TOKEN_TTL_MS,
  SERVER_SEEN_WINDOW_MS,
  TOKENS_PER_CREDIT,
  creditsOf,
  freeAiConfigFromEnv,
  handleFreeAiAllowance,
  handleFreeAiStatus,
  handleFreeAiToken,
  recordFreeAiUsage,
  weightedTokens,
  type FreeAiConfig,
  type FreeAiDeps,
} from "../src/freeAiCredits.js";
import { mintScopedInferenceToken, verifyScopedInferenceToken } from "../src/inferenceToken.js";
import { meterPeriodKey } from "../src/meter.js";

const NOW = Date.UTC(2026, 9, 14, 12); // Wednesday 2026-10-14
const SECRET = "inference-secret";
const ENDPOINT = { baseUrl: "https://inference.example.test", model: "flagship-free" };
const BOX = "home.alice.flagship.services";
const SMALL: FreeAiConfig = { ...FREE_AI_DEFAULTS, weeklyTokens: 1000, starterTokens: 3000, dailyCapTokens: 100_000 };

function keypair(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function setup(over: Partial<FreeAiDeps> = {}, opts: { seenAt?: number | null; revoked?: boolean } = {}) {
  const usernames = new InMemoryUsernameStorage();
  const servers = new InMemoryServerStorage();
  const daemonStatus = new InMemoryDaemonStatusStorage();
  const meter = new InMemoryMeterStorage();
  const irk = keypair();
  const aid = keypair();
  await usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), aidPubHex: hex(aid.publicKey), claimedAt: NOW });
  await servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: "00", registeredAt: NOW - 86_400_000 });
  if (opts.revoked) await servers.revoke(BOX, "test", NOW);
  const seenAt = opts.seenAt === undefined ? NOW - 5 * 60_000 : opts.seenAt;
  if (seenAt !== null) {
    await daemonStatus.put({
      serverDomain: BOX,
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      servicesServedJson: "[]",
      lastReported: seenAt,
    });
  }
  let now = NOW;
  const deps: FreeAiDeps = {
    usernames,
    servers,
    daemonStatus,
    meter,
    tiers: new InMemoryTierStorage(),
    endpoint: ENDPOINT,
    tokenSecret: SECRET,
    config: SMALL,
    now: () => now,
    newKeyId: () => "fa-test",
    ...over,
  };
  return { deps, meter, irk, aid, setNow: (t: number) => (now = t) };
}

function signed(key: Keypair, over: Partial<LlmPromoIssueRequest> = {}, at = NOW) {
  const request: LlmPromoIssueRequest = {
    username: "alice",
    serverFqdn: BOX,
    provider: "flagship",
    desiredDailyInputTokenCap: 0,
    desiredDailyOutputTokenCap: 0,
    issuedAt: at,
    ...over,
  };
  return { request, signature: hex(signLlmPromoIssue(request, key)) };
}

describe("config", () => {
  it("defaults: 2M starter, 500k a week, 50M a day for everyone, output weighs 4, no end date", () => {
    expect(freeAiConfigFromEnv({})).toEqual({
      starterTokens: 2_000_000,
      weeklyTokens: 500_000,
      dailyCapTokens: 50_000_000,
      inputWeight: 1,
      outputWeight: 4,
      endsAt: null,
    });
  });

  it("reads every number and the end date, and ignores junk", () => {
    const c = freeAiConfigFromEnv({
      AI_PROMO_STARTER_TOKENS: "100",
      AI_PROMO_WEEKLY_TOKENS: "50",
      AI_PROMO_DAILY_CAP_TOKENS: "nope",
      AI_PROMO_INPUT_WEIGHT: "0.5",
      AI_PROMO_OUTPUT_WEIGHT: "-1",
      AI_PROMO_ENDS_AT: "2027-01-31T00:00:00Z",
    });
    expect(c).toEqual({
      starterTokens: 100,
      weeklyTokens: 50,
      dailyCapTokens: 50_000_000,
      inputWeight: 0.5,
      outputWeight: 4,
      endsAt: Date.UTC(2027, 0, 31),
    });
    expect(freeAiConfigFromEnv({ AI_PROMO_ENDS_AT: "1800000000000" }).endsAt).toBe(1_800_000_000_000);
    expect(freeAiConfigFromEnv({ AI_PROMO_ENDS_AT: "someday" }).endsAt).toBeNull();
  });

  it("weighs output tokens more than input", () => {
    expect(weightedTokens(FREE_AI_DEFAULTS, 1000, 100)).toBe(1400);
    expect(weightedTokens({ ...FREE_AI_DEFAULTS, inputWeight: 0.5 }, 3, 0)).toBe(2);
  });
});

describe("free AI token", () => {
  it("mints a promo credential for an account with a running server, recording nothing", async () => {
    const { deps, meter, irk } = await setup();
    const r = await handleFreeAiToken(deps, signed(irk));
    expect(r.status).toBe(200);
    const body = r.body as {
      credential: { provider: string; apiKey: string; baseUrl: string; source: string; relay: boolean };
      model: string;
      expiresAt: number;
      credits: { week: { remaining: number }; starter: { remaining: number }; remainingTokens: number };
    };
    expect(body.credential).toMatchObject({ provider: "flagship", baseUrl: ENDPOINT.baseUrl, source: "promo", relay: true });
    expect(body.model).toBe("flagship-free");
    expect(body.expiresAt).toBe(NOW + FREE_AI_TOKEN_TTL_MS);
    expect(body.credits.week.remaining).toBe(1000);
    expect(body.credits.starter.remaining).toBe(3000);
    expect(body.credits.remainingTokens).toBe(4000);
    const v = await verifyScopedInferenceToken(body.credential.apiKey, SECRET, NOW + 1000);
    expect(v.ok && v.claims.username).toBe("alice");
    expect(await meter.get("alice", "ai-promo-week", meterPeriodKey("week", NOW))).toBeUndefined();
  });

  it("accepts the account AID and refuses a foreign key, a stale request and another provider", async () => {
    const { deps, aid, irk } = await setup();
    expect((await handleFreeAiToken(deps, signed(aid))).status).toBe(200);
    expect((await handleFreeAiToken(deps, signed(keypair()))).status).toBe(403);
    expect((await handleFreeAiToken(deps, signed(irk, {}, NOW - 10 * 60_000))).status).toBe(403);
    expect((await handleFreeAiToken(deps, signed(irk, { provider: "anthropic" }))).status).toBe(400);
    expect((await handleFreeAiToken(deps, signed(irk, { username: "bob" }))).status).toBe(404);
  });

  it("gives nothing to an account without a running registered server", async () => {
    for (const opts of [{ seenAt: null }, { seenAt: NOW - SERVER_SEEN_WINDOW_MS - 1 }, { revoked: true }]) {
      const { deps, irk } = await setup({}, opts);
      const r = await handleFreeAiToken(deps, signed(irk));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: FREE_AI_MESSAGES.noServer, code: "free-ai-no-server" });
    }
  });

  it("stops once this week's top-up and the starter reserve are both spent", async () => {
    const { deps, irk } = await setup();
    await recordFreeAiUsage(deps, "alice", 4000, 0);
    const r = await handleFreeAiToken(deps, signed(irk));
    expect(r.status).toBe(429);
    expect((r.body as { code: string }).code).toBe("free-ai-used-up");
    expect((r.body as { error: string }).error).toBe(FREE_AI_MESSAGES.usedUp);
  });

  it("pauses for everyone once today's all-accounts cap is used, until the next UTC day", async () => {
    const { deps, irk, setNow } = await setup({ config: { ...SMALL, dailyCapTokens: 500 } });
    await recordFreeAiUsage(deps, "someone-else", 500, 0);
    const r = await handleFreeAiToken(deps, signed(irk));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: FREE_AI_MESSAGES.busyToday, code: "free-ai-busy-today" });
    const tomorrow = Date.UTC(2026, 9, 15, 0, 1);
    setNow(tomorrow);
    expect((await handleFreeAiToken(deps, signed(irk, {}, tomorrow))).status).toBe(200);
  });

  it("ends on the end date, and passes minted before it stop there", async () => {
    const endsAt = NOW + 60_000;
    const { deps, irk, setNow } = await setup({ config: { ...SMALL, endsAt } });
    const before = await handleFreeAiToken(deps, signed(irk));
    expect((before.body as { expiresAt: number }).expiresAt).toBe(endsAt);
    setNow(endsAt);
    const after = await handleFreeAiToken(deps, signed(irk, {}, endsAt));
    expect(after.status).toBe(410);
    expect(after.body).toEqual({ error: FREE_AI_MESSAGES.ended, code: "free-ai-ended" });
  });

  it("is unavailable without an endpoint or a secret", async () => {
    for (const over of [{ endpoint: null }, { tokenSecret: undefined }]) {
      const { deps, irk } = await setup(over);
      const r = await handleFreeAiToken(deps, signed(irk));
      expect(r.status).toBe(503);
      expect((r.body as { code: string }).code).toBe("free-ai-unavailable");
    }
  });
});

describe("spending: the week first, then the starter reserve", () => {
  it("takes from this week's top-up, then the reserve, and the week tops up on Monday without carrying over", async () => {
    const { deps, irk, setNow } = await setup();
    // 200 in + 100 out = 600 weighted: all from the week.
    let c = await recordFreeAiUsage(deps, "alice", 200, 100);
    expect(c.week).toMatchObject({ used: 600, remaining: 400, resetsAt: Date.UTC(2026, 9, 19) });
    expect(c.starter.remaining).toBe(3000);
    // 1000 more: 400 from the week, 600 from the reserve.
    c = await recordFreeAiUsage(deps, "alice", 1000, 0);
    expect(c.week.remaining).toBe(0);
    expect(c.starter).toMatchObject({ used: 600, remaining: 2400 });
    expect(c.remainingTokens).toBe(2400);

    // Next week: a fresh 1000, the reserve as it was.
    const monday = Date.UTC(2026, 9, 19, 9);
    setNow(monday);
    await deps.daemonStatus.put({
      serverDomain: BOX,
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      servicesServedJson: "[]",
      lastReported: monday - 60_000,
    });
    const status = await handleFreeAiStatus(deps, signed(irk, { serverFqdn: "" }, monday));
    expect(status.body).toMatchObject({
      available: true,
      reason: null,
      credits: { week: { used: 0, remaining: 1000 }, starter: { remaining: 2400 }, remainingTokens: 3400 },
    });
  });

  it("records raw input and output separately", async () => {
    const { deps, meter } = await setup();
    await recordFreeAiUsage(deps, "Alice", 120, 30);
    const month = meterPeriodKey("month", NOW);
    expect((await meter.get("alice", "ai-promo-input", month))?.amount).toBe(120);
    expect((await meter.get("alice", "ai-promo-output", month))?.amount).toBe(30);
    expect((await meter.get("*", "ai-promo-global", meterPeriodKey("day", NOW)))?.amount).toBe(240);
  });
});

describe("free AI status", () => {
  it("reports both allowances and why free AI can't be used right now", async () => {
    const { deps, irk } = await setup({}, { seenAt: null });
    const r = await handleFreeAiStatus(deps, signed(irk, { serverFqdn: "" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      available: true,
      ended: false,
      reason: "no-server",
      message: FREE_AI_MESSAGES.noServer,
      credits: { week: { allowance: 1000 }, starter: { allowance: 3000 } },
    });
  });

  it("says the promotion has ended (the apps hide it) and when it isn't configured", async () => {
    const ended = await setup({ config: { ...SMALL, endsAt: NOW - 1 } });
    expect((await handleFreeAiStatus(ended.deps, signed(ended.irk, { serverFqdn: "" }))).body).toMatchObject({
      available: false,
      ended: true,
      reason: null,
    });
    const off = await setup({ endpoint: null });
    expect((await handleFreeAiStatus(off.deps, signed(off.irk, { serverFqdn: "" }))).body).toMatchObject({
      available: false,
      ended: false,
    });
  });

  it("needs the account's signature", async () => {
    const { deps } = await setup();
    expect((await handleFreeAiStatus(deps, signed(keypair(), { serverFqdn: "" }))).status).toBe(403);
  });

  it("adds credits (1 credit = 1,000 weighted tokens) and keeps the token fields", async () => {
    const { deps, irk } = await setup({ config: { ...FREE_AI_DEFAULTS } });
    await recordFreeAiUsage(deps, "alice", 100_000, 40_000); // 260,000 weighted, all from this week
    const r = await handleFreeAiStatus(deps, signed(irk, { serverFqdn: "" }));
    expect(r.body).toMatchObject({
      credits: {
        remainingTokens: 2_240_000,
        allowanceTokens: 2_500_000,
        remainingCredits: 2_240,
        weeklyCredits: 500,
        tokensPerCredit: 1000,
      },
    });
  });
});

describe("credits", () => {
  it("rounds down to whole credits and never goes negative", () => {
    expect(TOKENS_PER_CREDIT).toBe(1000);
    expect(creditsOf(0)).toBe(0);
    expect(creditsOf(999)).toBe(0);
    expect(creditsOf(1_000)).toBe(1);
    expect(creditsOf(1_840_999)).toBe(1_840);
    expect(creditsOf(-5)).toBe(0);
  });
});

describe("free AI allowance (the shim's check)", () => {
  async function pass(deps: FreeAiDeps, irk: Keypair) {
    const minted = await handleFreeAiToken(deps, signed(irk));
    return (minted.body as { credential: { apiKey: string } }).credential.apiKey;
  }

  it("answers what's left, and stops when it's spent", async () => {
    const { deps, irk } = await setup();
    const token = await pass(deps, irk);
    expect((await handleFreeAiAllowance(deps, { token })).body).toMatchObject({
      ok: true,
      remainingTokens: 4000,
      allowanceTokens: 4000,
      model: { id: "medium-vision", multiplier: 2 },
    });
    await recordFreeAiUsage(deps, "alice", 4000, 0);
    expect((await handleFreeAiAllowance(deps, { token })).body).toMatchObject({
      remainingTokens: 0,
      code: "free-ai-used-up",
      message: FREE_AI_MESSAGES.usedUp,
    });
  });

  it("stops at the end date and once today's all-accounts cap is used", async () => {
    const t = await mintScopedInferenceToken(
      { username: "alice", keyId: "x", iat: NOW - 1, exp: NOW + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      SECRET,
    );
    const ended = await setup({ config: { ...SMALL, endsAt: NOW } });
    expect((await handleFreeAiAllowance(ended.deps, { token: t })).body).toMatchObject({ code: "free-ai-ended" });
    const busy = await setup({ config: { ...SMALL, dailyCapTokens: 100 } });
    await recordFreeAiUsage(busy.deps, "bob", 100, 0);
    expect((await handleFreeAiAllowance(busy.deps, { token: t })).body).toMatchObject({
      remainingTokens: 0,
      code: "free-ai-busy-today",
    });
  });

  it("refuses a forged token and a malformed body", async () => {
    const { deps } = await setup();
    const forged = await mintScopedInferenceToken(
      { username: "alice", keyId: "x", iat: NOW, exp: NOW + 1000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      "other",
    );
    expect((await handleFreeAiAllowance(deps, { token: forged })).status).toBe(403);
    expect((await handleFreeAiAllowance(deps, {})).status).toBe(400);
  });
});

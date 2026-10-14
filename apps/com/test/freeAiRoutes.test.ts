/**
 * Route wiring for free AI credits over a real D1-over-sqlite binding:
 * mint → the shim's allowance check → the shim's usage report → status,
 * until the allowance runs out. Handler detail lives in
 * packages/control-plane/tests/freeAiCredits.test.ts.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { deriveIRK, signLlmPromoIssue, type LlmPromoIssueRequest } from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const BOX = "home.alice.flagship.services";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function setup(vars: Partial<ControlPlaneEnv> = {}) {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: "00", registeredAt: 1 });
  await storage.daemonStatus.put({
    serverDomain: BOX,
    certSha256: null,
    certValidUntil: null,
    certIssuer: null,
    servicesServedJson: "[]",
    lastReported: Date.now(),
  });
  const env: ControlPlaneEnv = {
    DB: sqlite as unknown as D1Database,
    FLAGSHIP_INFERENCE_ENDPOINT: JSON.stringify({ baseUrl: "https://inference.example.test", model: "flagship-free" }),
    FLAGSHIP_INFERENCE_TOKEN_SECRET: "route-secret",
    AI_PROMO_WEEKLY_TOKENS: "400",
    AI_PROMO_STARTER_TOKENS: "600",
    ...vars,
  };
  return { env, close: () => sqlite.close() };
}

function signedBody(provider: LlmPromoIssueRequest["provider"] = "flagship") {
  const request: LlmPromoIssueRequest = {
    username: "alice",
    serverFqdn: "home.alice.flagship.services",
    provider,
    desiredDailyInputTokenCap: 0,
    desiredDailyOutputTokenCap: 0,
    issuedAt: Date.now(),
  };
  return { request, signature: hex(signLlmPromoIssue(request, irk)) };
}

async function post(env: ControlPlaneEnv, path: string, body: unknown) {
  const res = await tryControlPlane(
    new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }),
    env,
  );
  return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
}

describe("free AI routes", () => {
  it("mints, meters through the shim's endpoints (week first, output weighted), and stops at the allowance", async () => {
    const { env, close } = await setup();
    try {
      const minted = await post(env, "/api/free-ai/token", signedBody());
      expect(minted.status).toBe(200);
      const token = (minted.body.credential as { apiKey: string }).apiKey;

      const allowance = await post(env, "/api/free-ai/allowance", { token });
      expect(allowance.body).toMatchObject({ ok: true, remainingTokens: 1000 });

      // 100 in + 50 out × 4 = 300 weighted, all from this week's 400.
      expect((await post(env, "/api/llm-promo/usage", { token, inputTokens: 100, outputTokens: 50 })).status).toBe(200);
      const status = await post(env, "/api/free-ai/status", signedBody());
      expect(status.body).toMatchObject({
        available: true,
        reason: null,
        credits: { week: { used: 300, remaining: 100 }, starter: { used: 0, remaining: 600 }, remainingTokens: 700 },
      });

      await post(env, "/api/llm-promo/usage", { token, inputTokens: 700, outputTokens: 0 });
      const spent = await post(env, "/api/free-ai/token", signedBody());
      expect(spent.status).toBe(429);
      expect(spent.body.code).toBe("free-ai-used-up");
      expect((await post(env, "/api/free-ai/allowance", { token })).body).toMatchObject({
        remainingTokens: 0,
        code: "free-ai-used-up",
      });
    } finally {
      close();
    }
  });

  it("charges a report at the catalog model's multiplier", async () => {
    const { env, close } = await setup({ AI_PROMO_WEEKLY_TOKENS: "100000" });
    try {
      const minted = await post(env, "/api/free-ai/token", signedBody());
      const token = (minted.body.credential as { apiKey: string }).apiKey;
      const allowance = await post(env, "/api/free-ai/allowance", { token, model: "high" });
      expect(allowance.body).toMatchObject({ model: { id: "high", multiplier: 3.5 }, creditTokens: 1000 });
      // (100 + 50 × 4) × 3.5 = 1,050 weighted.
      await post(env, "/api/llm-promo/usage", { token, inputTokens: 100, outputTokens: 50, model: "high" });
      const status = await post(env, "/api/free-ai/status", signedBody());
      expect(status.body).toMatchObject({ credits: { week: { used: 1050 } } });
    } finally {
      close();
    }
  });

  it("stops after the end date and tells the apps it has ended", async () => {
    const { env, close } = await setup({ AI_PROMO_ENDS_AT: "2020-01-01T00:00:00Z" });
    try {
      const r = await post(env, "/api/free-ai/token", signedBody());
      expect(r.status).toBe(410);
      expect(r.body.code).toBe("free-ai-ended");
      expect((await post(env, "/api/free-ai/status", signedBody())).body).toMatchObject({ available: false, ended: true });
    } finally {
      close();
    }
  });

  it("answers 503 for a mint while the endpoint isn't configured", async () => {
    const { env, close } = await setup({ FLAGSHIP_INFERENCE_ENDPOINT: undefined });
    try {
      const r = await post(env, "/api/free-ai/token", signedBody());
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("free-ai-unavailable");
      expect((await post(env, "/api/free-ai/status", signedBody())).body.available).toBe(false);
    } finally {
      close();
    }
  });

  it("no longer hands out placeholder keys for other providers", async () => {
    const { env, close } = await setup();
    try {
      const r = await post(env, "/api/llm-promo/issue", signedBody("anthropic"));
      expect(r.status).toBe(410);
    } finally {
      close();
    }
  });
});

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
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function setup(vars: Partial<ControlPlaneEnv> = {}) {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  const env: ControlPlaneEnv = {
    DB: sqlite as unknown as D1Database,
    FLAGSHIP_INFERENCE_ENDPOINT: JSON.stringify({ baseUrl: "https://inference.example.test", model: "flagship-free" }),
    FLAGSHIP_INFERENCE_TOKEN_SECRET: "route-secret",
    FLAGSHIP_FREE_AI_TOKENS: "1000",
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
  it("mints, meters through the shim's endpoints, and stops at the allowance", async () => {
    const { env, close } = await setup();
    try {
      const minted = await post(env, "/api/free-ai/token", signedBody());
      expect(minted.status).toBe(200);
      const token = (minted.body.credential as { apiKey: string }).apiKey;

      const allowance = await post(env, "/api/free-ai/allowance", { token });
      expect(allowance.body).toMatchObject({ ok: true, remainingTokens: 1000 });

      const usage = await post(env, "/api/llm-promo/usage", { token, inputTokens: 600, outputTokens: 150 });
      expect(usage.status).toBe(200);

      const status = await post(env, "/api/free-ai/status", signedBody());
      expect(status.body).toEqual({
        available: true,
        credits: { usedTokens: 750, allowanceTokens: 1000, remainingTokens: 250 },
      });

      await post(env, "/api/llm-promo/usage", { token, inputTokens: 250, outputTokens: 0 });
      const spent = await post(env, "/api/free-ai/token", signedBody());
      expect(spent.status).toBe(429);
      expect(spent.body.code).toBe("free-ai-used-up");
      expect((await post(env, "/api/free-ai/allowance", { token })).body).toMatchObject({ remainingTokens: 0 });
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

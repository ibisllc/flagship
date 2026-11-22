import { describe, expect, it } from "vitest";
import { InMemoryLlmPromoStorage, InMemoryMeterStorage, InMemoryTierStorage } from "@flagship/storage";
import { FREE_AI_DEFAULTS, handleFreeAiAllowance } from "../src/freeAiCredits.js";
import {
  SERVICE_DAILY_TOKENS,
  mintServiceInferenceToken,
  recordServiceUsage,
  resolveServiceModel,
  serviceAccountId,
} from "../src/inferenceService.js";
import { inferenceLineup } from "../src/inferenceSettings.js";
import { mintScopedInferenceToken, verifyScopedInferenceToken } from "../src/inferenceToken.js";
import { handleLlmPromoUsage } from "../src/llmPromo.js";
import { meterCheck } from "../src/meter.js";

const SECRET = "inference-secret";
const NOW = Date.UTC(2026, 10, 21, 12);

function deps() {
  return { meter: new InMemoryMeterStorage(), tiers: new InMemoryTierStorage(), tokenSecret: SECRET, now: () => NOW };
}

describe("service passes (.com's own Flagship Inference calls)", () => {
  it("names a service account no username can be, and expires quickly", async () => {
    const token = await mintServiceInferenceToken("adapter-review", SECRET, NOW);
    const v = await verifyScopedInferenceToken(token, SECRET, NOW);
    expect(v.ok && v.claims).toMatchObject({ service: "adapter-review", username: "service:adapter-review" });
    expect(v.ok && v.claims.exp - NOW).toBeLessThanOrEqual(10 * 60_000);
    expect(serviceAccountId("adapter-review")).not.toMatch(/^[a-z0-9-]+$/);
    expect((await verifyScopedInferenceToken(token, SECRET, NOW + 11 * 60_000)).ok).toBe(false);
  });

  it("the allowance runs on the service's own budget and model, even when the promo has ended", async () => {
    const d = deps();
    const token = await mintServiceInferenceToken("adapter-review", SECRET, NOW);
    const ended = { ...FREE_AI_DEFAULTS, endsAt: NOW - 1 };
    const r = await handleFreeAiAllowance({ ...d, config: ended }, { token, model: "high" });
    expect(r.status).toBe(200);
    const body = r.body as { remainingTokens: number; code?: string; model: { id: string } };
    expect(body.remainingTokens).toBe(SERVICE_DAILY_TOKENS);
    expect(body.code).toBeUndefined();
    expect(body.model.id).toBe("medium");
  });

  it("uses its model even when the owner turned it off in the menus", () => {
    const lineup = inferenceLineup({ models: { medium: { enabled: false } } });
    expect(resolveServiceModel("adapter-review", lineup).id).toBe("medium");
  });

  it("a service pass with an unknown service is refused", async () => {
    const token = await mintScopedInferenceToken(
      { username: "service:x", service: "x" as never, keyId: "k", iat: NOW, exp: NOW + 60_000, dailyInputTokenCap: 0, dailyOutputTokenCap: 0 },
      SECRET,
    );
    expect((await handleFreeAiAllowance(deps(), { token })).status).toBe(403);
  });

  it("usage goes on the service's counters only, never an account's ledger or ai-tokens", async () => {
    const d = deps();
    const llmPromo = new InMemoryLlmPromoStorage();
    const token = await mintServiceInferenceToken("adapter-review", SECRET, NOW);
    const recorded: unknown[] = [];
    const r = await handleLlmPromoUsage(
      {
        llmPromo,
        meter: d.meter,
        tiers: d.tiers,
        now: d.now,
        verifyToken: async (t) => {
          const v = await verifyScopedInferenceToken(t, SECRET, NOW);
          return v.ok ? { ok: true, username: v.claims.username, ...(v.claims.service ? { service: v.claims.service } : {}) } : { ok: false };
        },
        recordServiceUsage: async (service, input, output) => {
          recorded.push([service, input, output]);
          await recordServiceUsage(d, service, input, output);
        },
      },
      { token, inputTokens: 1000, outputTokens: 100 },
    );
    expect(r.status).toBe(200);
    expect(recorded).toEqual([["adapter-review", 1000, 100]]);
    expect(await llmPromo.getDaily("service:adapter-review", Math.floor(NOW / 86_400_000))).toBeFalsy();
    const md = { meter: d.meter, tiers: d.tiers, now: d.now };
    expect((await meterCheck(md, "service:adapter-review", "ai-tokens")).used).toBe(0);
    // 1000 × 1 + 100 × 4 weighted, at medium's multiplier of 1.
    expect((await meterCheck(md, "service:adapter-review", "ai-service-day")).used).toBe(1400);
    expect((await meterCheck(md, "*", "ai-promo-global")).used).toBe(0);
    const after = await handleFreeAiAllowance(d, { token });
    expect((after.body as { remainingTokens: number }).remainingTokens).toBe(SERVICE_DAILY_TOKENS - 1400);
  });

  it("stops at the daily budget", async () => {
    const d = deps();
    await recordServiceUsage({ ...d, dailyTokens: 1000 }, "adapter-review", 2000, 0);
    const token = await mintServiceInferenceToken("adapter-review", SECRET, NOW);
    const r = await handleFreeAiAllowance(d, { token });
    expect((r.body as { remainingTokens: number }).remainingTokens).toBe(SERVICE_DAILY_TOKENS - 2000);
    const { serviceAllowance } = await import("../src/inferenceService.js");
    const capped = await serviceAllowance({ ...d, dailyTokens: 1000 }, { ...(await verifyClaims(token)), service: "adapter-review" });
    expect(capped.body).toMatchObject({ remainingTokens: 0, code: "free-ai-busy-today" });
  });
});

async function verifyClaims(token: string) {
  const v = await verifyScopedInferenceToken(token, SECRET, NOW);
  if (!v.ok) throw new Error("bad token");
  return v.claims;
}

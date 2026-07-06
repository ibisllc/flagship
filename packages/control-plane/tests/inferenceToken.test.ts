import { describe, expect, it } from "vitest";
import {
  mintScopedInferenceToken,
  verifyScopedInferenceToken,
  type InferenceTokenClaims,
} from "../src/inferenceToken.js";

const SECRET = "shared-inference-secret";
const NOW = 1_700_000_000_000;

function claims(over: Partial<InferenceTokenClaims> = {}): InferenceTokenClaims {
  return {
    username: "alice",
    keyId: "fp-1",
    iat: NOW,
    exp: NOW + 3_600_000,
    dailyInputTokenCap: 1000,
    dailyOutputTokenCap: 500,
    serverFqdn: "home.alice.flagship.services",
    ...over,
  };
}

describe("scoped inference token", () => {
  it("round-trips claims under the shared secret", async () => {
    const tok = await mintScopedInferenceToken(claims(), SECRET);
    expect(tok.startsWith("v1.")).toBe(true);
    const v = await verifyScopedInferenceToken(tok, SECRET, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.username).toBe("alice");
      expect(v.claims.keyId).toBe("fp-1");
      expect(v.claims.dailyOutputTokenCap).toBe(500);
    }
  });

  it("rejects a wrong secret (bad-signature)", async () => {
    const tok = await mintScopedInferenceToken(claims(), SECRET);
    const v = await verifyScopedInferenceToken(tok, "attacker-secret", NOW);
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload", async () => {
    const tok = await mintScopedInferenceToken(claims(), SECRET);
    const [, , mac] = tok.split(".");
    const forged = { ...claims(), dailyInputTokenCap: 999_999 };
    const forgedPayload = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const v = await verifyScopedInferenceToken(`v1.${forgedPayload}.${mac}`, SECRET, NOW);
    expect(v.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const tok = await mintScopedInferenceToken(claims({ exp: NOW - 1 }), SECRET);
    const v = await verifyScopedInferenceToken(tok, SECRET, NOW);
    expect(v).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a malformed token", async () => {
    expect((await verifyScopedInferenceToken("garbage", SECRET, NOW)).ok).toBe(false);
    expect((await verifyScopedInferenceToken("v2.a.b", SECRET, NOW)).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { verifyScopedInferenceToken } from "@flagship/control-plane";
import {
  FlagshipInferenceIssuer,
  buildFlagshipInferenceIssuer,
} from "../src/routes/llmPromo.js";

const endpoint = { baseUrl: "https://coder.runpod.example.com", model: "flagship-coder-v1" };
const SECRET = "prod-inference-secret";

describe("FlagshipInferenceIssuer", () => {
  it("mints a scoped token + returns the blessed endpoint + caps", async () => {
    const now = 1_700_000_000_000;
    const issuer = new FlagshipInferenceIssuer({ endpoint, tokenSecret: SECRET, now: () => now });
    const minted = await issuer.mintKey({ irkPub: new Uint8Array(32), userId: "harry" });
    expect(minted.baseUrl).toBe(endpoint.baseUrl);
    expect(minted.model).toBe(endpoint.model);
    expect(minted.keyId).toMatch(/^fp-/);
    expect(minted.lifetimeTokens).toBe(500_000);
    expect(minted.dailyTokens).toBe(100_000);

    const v = await verifyScopedInferenceToken(minted.apiKey, SECRET, now + 1000);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.username).toBe("harry");
      expect(v.claims.keyId).toBe(minted.keyId);
      expect(v.claims.exp).toBe(now + 60 * 60_000);
    }
  });

  it("mints a fresh keyId each call", async () => {
    const issuer = new FlagshipInferenceIssuer({ endpoint, tokenSecret: SECRET });
    const a = await issuer.mintKey({ irkPub: new Uint8Array(32), userId: "harry" });
    const b = await issuer.mintKey({ irkPub: new Uint8Array(32), userId: "harry" });
    expect(a.keyId).not.toBe(b.keyId);
  });

  it("buildFlagshipInferenceIssuer returns null unless BOTH endpoint + secret are set", () => {
    expect(buildFlagshipInferenceIssuer({})).toBeNull();
    expect(buildFlagshipInferenceIssuer({ FLAGSHIP_INFERENCE_ENDPOINT: JSON.stringify(endpoint) })).toBeNull();
    expect(buildFlagshipInferenceIssuer({ FLAGSHIP_INFERENCE_TOKEN_SECRET: SECRET })).toBeNull();
    expect(
      buildFlagshipInferenceIssuer({
        FLAGSHIP_INFERENCE_ENDPOINT: JSON.stringify(endpoint),
        FLAGSHIP_INFERENCE_TOKEN_SECRET: SECRET,
      }),
    ).toBeInstanceOf(FlagshipInferenceIssuer);
  });
});

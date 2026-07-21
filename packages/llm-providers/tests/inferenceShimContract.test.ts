/**
 * Contract test between the flagship provider (box side) and the inference
 * meter shim (infra/inference/shim). Pins two things:
 *
 *   1. Token no-drift: a scoped token minted by `.com`
 *      (`@flagship/control-plane`) MUST verify under the shim's vendored
 *      `verifyScopedInferenceToken` (they share the `v1.<payload>.<mac>`
 *      HMAC-SHA256 format).
 *   2. Wire shape: the request the `flagship` adapter sends to
 *      `<baseUrl>/v1/chat/completions` (Bearer token + OpenAI body incl.
 *      tools) is exactly what the shim proxies, and the shim's
 *      `extractUsage` reads back the same `usage.{prompt,completion}_tokens`
 *      the adapter surfaces as input/output tokens.
 */
import { describe, expect, it } from "vitest";
import { mintScopedInferenceToken } from "@flagship/control-plane";
import { flagship, type ChatRequest, type FetchLike } from "../src/index.js";
import {
  verifyScopedInferenceToken as shimVerify,
  extractUsage,
  buildUsageReport,
} from "../../../infra/inference/shim/src/meter.js";

const SECRET = "shared-inference-secret";

describe("inference shim ↔ flagship provider contract", () => {
  it("a .com-minted scoped token verifies under the shim's vendored verify (no drift)", async () => {
    const now = 1_700_000_000_000;
    const token = await mintScopedInferenceToken(
      { username: "alice", keyId: "fp-1", iat: now, exp: now + 3_600_000, dailyInputTokenCap: 1000, dailyOutputTokenCap: 500 },
      SECRET,
    );
    const v = await shimVerify(token, SECRET, now + 1000);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.username).toBe("alice");
      expect(v.claims.keyId).toBe("fp-1");
    }
    // Wrong secret is rejected (the shim gates on .com's secret).
    expect((await shimVerify(token, "other", now)).ok).toBe(false);
  });

  it("the flagship request shape is exactly what the shim proxies, and usage round-trips", async () => {
    const token = await mintScopedInferenceToken(
      { username: "alice", keyId: "fp-1", iat: 0, exp: Date.now() + 3_600_000, dailyInputTokenCap: 1000, dailyOutputTokenCap: 500 },
      SECRET,
    );
    // vLLM/OpenAI response the shim would receive + meter.
    const vllmResponse = {
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      model: "flagship-coder-v1",
      usage: { prompt_tokens: 42, completion_tokens: 17 },
    };
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const shimFetch: FetchLike = async (url, init) => {
      // This is what the shim receives from the box.
      captured = { url, headers: init?.headers ?? {}, body: JSON.parse(init!.body as string) };
      return { ok: true, status: 200, async text() { return ""; }, async json() { return vllmResponse; } };
    };
    const req: ChatRequest = {
      model: "flagship-coder-v1",
      messages: [{ role: "user", content: "build it" }],
      tools: [{ name: "write_file", description: "write", inputSchema: { type: "object" } }],
    };
    const resp = await flagship.chat(req, { apiKey: token, baseUrl: "https://inference.flagshipserver.com" }, shimFetch);

    // Shim-visible request contract.
    expect(captured!.url).toBe("https://inference.flagshipserver.com/v1/chat/completions");
    expect(captured!.headers.authorization).toBe(`Bearer ${token}`);
    expect((captured!.body as { model: string }).model).toBe("flagship-coder-v1");
    expect((captured!.body as { tools: unknown[] }).tools).toHaveLength(1);

    // The shim's extractUsage reads the SAME fields the adapter surfaces.
    const usg = extractUsage(vllmResponse);
    expect(usg).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(resp.inputTokens).toBe(42);
    expect(resp.outputTokens).toBe(17);

    // The usage report the shim POSTs to .com carries the presented token.
    expect(buildUsageReport(token, usg)).toEqual({ token, inputTokens: 42, outputTokens: 17 });
  });
});

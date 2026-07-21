/**
 * Pure auth/meter core for the Flagship inference shim.
 *
 * Standalone (no @flagship deps) so it bundles cleanly into a Cloudflare
 * Worker. The token verify below MUST stay wire-compatible with
 * `packages/control-plane/src/inferenceToken.ts` (the minter) — the
 * `v1.<base64url(payload)>.<base64url(hmac)>` format + HMAC-SHA256 over
 * `v1.<payload>`. `packages/llm-providers/tests/inferenceShimContract.test.ts`
 * pins that agreement (a .com-minted token must verify here).
 */

export interface InferenceTokenClaims {
  username: string;
  keyId: string;
  exp: number;
  iat: number;
  dailyInputTokenCap: number;
  dailyOutputTokenCap: number;
  serverFqdn?: string;
}

const PREFIX = "v1";

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export type VerifyResult =
  | { ok: true; claims: InferenceTokenClaims }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/** Verify a scoped inference token's MAC + expiry (mirror of the minter). */
export async function verifyScopedInferenceToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const [, payloadB64, macB64] = parts;
  let expected: Uint8Array;
  let given: Uint8Array;
  try {
    expected = await hmac(secret, `${PREFIX}.${payloadB64}`);
    given = b64urlDecode(macB64!);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!timingSafeEqual(expected, given)) return { ok: false, reason: "bad-signature" };
  let claims: InferenceTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64!))) as InferenceTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || now >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/**
 * Extract the true token usage from a vLLM/OpenAI chat-completions
 * response body (non-streaming). vLLM reports `usage.prompt_tokens` +
 * `usage.completion_tokens` — the same field names the flagship/openai
 * adapter reads back. Absent ⇒ zeros (we never over-report).
 */
export function extractUsage(responseJson: unknown): { inputTokens: number; outputTokens: number } {
  const u = (responseJson as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
  return {
    inputTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0,
    outputTokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : 0,
  };
}

/** The body the shim POSTs to `.com` /api/llm-promo/usage. */
export interface UsageReport {
  token: string;
  inputTokens: number;
  outputTokens: number;
}

export function buildUsageReport(token: string, usage: { inputTokens: number; outputTokens: number }): UsageReport {
  return { token, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

/**
 * Sum the token deltas the shim has metered for a token id in the current
 * window. A trivial in-memory counter suffices per Worker isolate; the
 * authoritative cap check is against `.com` status, but this fast local
 * gate refuses a request whose token has already spent its per-token
 * daily cap on THIS isolate (defense against a hot loop).
 */
export class TokenMeter {
  private spent = new Map<string, number>();
  add(keyId: string, tokens: number): number {
    const next = (this.spent.get(keyId) ?? 0) + tokens;
    this.spent.set(keyId, next);
    return next;
  }
  spentFor(keyId: string): number {
    return this.spent.get(keyId) ?? 0;
  }
}

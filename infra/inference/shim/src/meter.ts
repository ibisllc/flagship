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

// ──────────────────────────────────────────────────────────────────────
// Request hygiene: what reaches the upstream model API
// ──────────────────────────────────────────────────────────────────────

/** Top-level chat-completions fields passed upstream; everything else is dropped. */
const REQUEST_FIELDS = new Set([
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "response_format",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "stream",
]);

/** Per-message fields passed upstream (`name` and any extras are dropped). */
const MESSAGE_FIELDS = new Set(["role", "content", "tool_calls", "tool_call_id"]);

export interface SanitizeOptions {
  /** The upstream's model id; replaces whatever the box asked for. */
  model?: string;
  /** Ceiling on `max_tokens` for one call. */
  maxOutputTokens: number;
}

export type SanitizeResult =
  | { ok: true; body: Record<string, unknown>; stream: boolean }
  | { ok: false; error: string };

/**
 * Rebuild a chat-completions request from an allowlist, so nothing that
 * could identify the box or its owner (`user`, `metadata`, a message
 * `name`, unknown extras) reaches the upstream provider. The model is
 * pinned to the upstream's id, the output length is capped, and a
 * streaming request asks for the final usage chunk the meter reads.
 */
export function sanitizeChatRequest(raw: unknown, opts: SanitizeOptions): SanitizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
  const src = raw as Record<string, unknown>;
  if (!Array.isArray(src.messages) || src.messages.length === 0) return { ok: false, error: "messages required" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (REQUEST_FIELDS.has(k)) out[k] = v;
  out.messages = src.messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) if (MESSAGE_FIELDS.has(k)) kept[k] = v;
    return kept;
  });
  out.model = opts.model ?? (typeof src.model === "string" ? src.model : undefined);
  const asked = [src.max_tokens, src.max_completion_tokens].find((n) => typeof n === "number" && n > 0) as
    | number
    | undefined;
  out.max_tokens = Math.min(asked ?? opts.maxOutputTokens, opts.maxOutputTokens);
  const stream = src.stream === true;
  if (stream) out.stream_options = { include_usage: true };
  else delete out.stream;
  return { ok: true, body: out, stream };
}

/** Rough token count for text when the upstream reports no usage. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Reads an OpenAI-style SSE stream as it passes through: keeps the last
 * `usage` object it sees (the `include_usage` chunk) and counts generated
 * characters so a stream without usage can still be charged.
 */
export class SseUsageScanner {
  private buffer = "";
  private usage: { inputTokens: number; outputTokens: number } | null = null;
  private generatedChars = 0;

  feed(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
  }

  /** Usage for the whole stream; `requestChars` sizes the prompt if none was reported. */
  finish(requestChars: number): { inputTokens: number; outputTokens: number } {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    if (this.usage && (this.usage.inputTokens > 0 || this.usage.outputTokens > 0)) return this.usage;
    return { inputTokens: estimateTokens(requestChars), outputTokens: estimateTokens(this.generatedChars) };
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk: {
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ function?: { arguments?: unknown } }> } }>;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.usage) {
      const u = extractUsage(chunk);
      if (u.inputTokens > 0 || u.outputTokens > 0) this.usage = u;
    }
    for (const c of chunk.choices ?? []) {
      if (typeof c.delta?.content === "string") this.generatedChars += c.delta.content.length;
      for (const t of c.delta?.tool_calls ?? []) {
        if (typeof t.function?.arguments === "string") this.generatedChars += t.function.arguments.length;
      }
    }
  }
}

const CONTEXT_TOO_LONG =
  /context[_ -]?(length|window)|maximum context|max(imum)?_?tokens? .*exceed|too many (input )?tokens|(prompt|input|request) is too long|reduce the length|exceeds? the (model'?s? )?(max|maximum|context)/i;

/**
 * Whether an upstream refusal means the request didn't fit the model's
 * context window. Providers word it differently (OpenAI-style
 * `context_length_exceeded`, vLLM's "maximum context length is …", others'
 * "prompt is too long"), so a 413 or a 400 whose body says so counts.
 */
export function isContextTooLong(status: number, body: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  return CONTEXT_TOO_LONG.test(body.slice(0, 4096));
}

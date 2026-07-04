/**
 * The blessed in-house inference endpoint — the OpenAI-compatible coding
 * model Flagship hosts (vLLM on RunPod) that backs the free-credits
 * ("flagship") provider posture.
 *
 * Server-side config ONLY. The RunPod URL is rotatable and never appears
 * in a recipe or a client build: the promo minter reads it here, mints a
 * scoped `.com` token, and hands the client `{ apiKey, baseUrl, model }`
 * so the box talks to the endpoint directly. Rotating the endpoint is a
 * `wrangler secret put FLAGSHIP_INFERENCE_ENDPOINT` away — no client
 * redeploy.
 *
 * Parsed exactly like `FLAGSHIP_ISO_MANIFEST` (see `isoManifest.ts`):
 * a JSON string, validated, NEVER throwing — a bad/absent config simply
 * degrades to `null` ("inference unconfigured") and the minter refuses a
 * `flagship` issue rather than handing out a broken key.
 */

/** The blessed endpoint the box should call for the `flagship` provider. */
export interface InferenceEndpoint {
  /**
   * The OpenAI-compatible base URL (the adapter appends
   * `/v1/chat/completions`). MUST be public https — the box applies the
   * SSRF baseUrl guard and (for promo credentials) pins to this host.
   */
  baseUrl: string;
  /** The served model id (e.g. a Qwen2.5-Coder-Instruct deployment). */
  model: string;
}

/**
 * Parse the `FLAGSHIP_INFERENCE_ENDPOINT` env var (a JSON string of the
 * `InferenceEndpoint` shape) into an endpoint, or null when unset /
 * unparseable / shape-invalid. NEVER throws.
 *
 * Validation mirrors `parseBlessedIsoManifest`: both fields must be
 * non-empty strings, and `baseUrl` must parse as an `https:` URL (the
 * box would reject a non-https baseUrl anyway under the strict guard, so
 * reject it here too rather than mint a dead key).
 */
export function parseBlessedInferenceEndpoint(
  raw: string | undefined,
): InferenceEndpoint | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.baseUrl !== "string" ||
    m.baseUrl.length === 0 ||
    typeof m.model !== "string" ||
    m.model.length === 0
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(m.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return { baseUrl: m.baseUrl, model: m.model };
}

/** The RunPod host a promo credential is pinned to (SSRF allowlist). */
export function inferenceEndpointHost(ep: InferenceEndpoint): string {
  return new URL(ep.baseUrl).hostname.toLowerCase();
}

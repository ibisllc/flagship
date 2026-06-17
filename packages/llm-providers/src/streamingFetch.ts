/**
 * Production fetch implementations built on Node's global fetch, hardened
 * against SSRF onto the box's loopback data plane (Postgres/Redis/MinIO/
 * Forgejo + the daemon's own API) and the cloud metadata endpoint.
 *
 * Two shapes are exported because the provider abstraction has two:
 *   - `defaultFetch`          → `FetchLike`          (non-streaming `chat`)
 *   - `defaultStreamingFetch` → `StreamingFetchLike` (streaming `chatStream`,
 *                               body split into UTF-8 SSE lines)
 *
 * Both go through ONE `guardedRequest` core so the SSRF defense is uniform
 * (no per-adapter drift):
 *   1. Resolve + classify the target host before connect — a hostname that
 *      resolves to an internal address (localtest.me → 127.0.0.1, *.nip.io)
 *      is rejected even though its spelling is public.
 *   2. Issue the request with `redirect: "manual"`; on a 3xx with a
 *      `Location`, re-run the full resolving guard against the redirect
 *      target before following it (capped hops) — so a public URL can't
 *      `302 → http://169.254.169.254/` or `→ http://127.0.0.1:5432/`.
 *
 * The harness wires `defaultFetch` as its non-streaming `fetchImpl` and
 * `defaultStreamingFetch` as its streaming impl so EVERY provider call
 * (anthropic/openai/google/ollama/openrouter, streaming or not) is guarded
 * at the fetch layer regardless of what each adapter does internally.
 */

import {
  assertSafeResolvedUrl,
  type BaseUrlGuardOptions,
  type HostResolver,
} from "./baseUrlGuard.js";
import type { FetchLike, StreamingFetchLike } from "./types.js";

/** Max 3xx hops we'll follow before giving up. */
const MAX_REDIRECTS = 5;

/**
 * Posture for the production fetchers' SSRF guard. The daemon constructs
 * these from the same `baseUrlGuard` options it hands the harness so a
 * self-hoster's `allowPrivate` / `hostAllowlist` / `allowHttp` LAN override
 * applies to the actual connect + every redirect hop, not just the up-front
 * baseUrl string check. A test-only `resolve` injects a stub resolver.
 */
export interface GuardedFetchOptions {
  guard?: BaseUrlGuardOptions;
  resolve?: HostResolver;
}

/**
 * Resolve+classify the URL, then fetch with `redirect:"manual"`, following
 * 3xx Location headers only after re-validating each through the guard.
 * Returns the final non-redirect Response (or throws `UnsafeBaseUrlError`
 * if the target — or any redirect target — is internal).
 */
async function guardedRequest(
  input: string,
  init:
    | { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | ArrayBuffer }
    | undefined,
  opts: GuardedFetchOptions,
): Promise<Response> {
  const f = globalThis.fetch as typeof globalThis.fetch;
  let current = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Throws UnsafeBaseUrlError if `current` is internal or resolves internal.
    await assertSafeResolvedUrl(current, opts.guard ?? {}, opts.resolve);
    const res = await f(current, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      redirect: "manual",
    });
    // `redirect:"manual"` surfaces a 3xx as an opaque-redirect (status 0) or
    // as the real 3xx with a Location header, depending on the runtime. Treat
    // any 3xx-with-Location as a redirect we must re-validate before following.
    const location = res.headers.get("location");
    const isRedirect = (res.status >= 300 && res.status < 400) || res.type === "opaqueredirect";
    if (isRedirect && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

/** Build a non-streaming `FetchLike` bound to an SSRF posture. */
export function guardedFetch(opts: GuardedFetchOptions = {}): FetchLike {
  return async (input, init) => {
    const r = await guardedRequest(input, init, opts);
    return {
      ok: r.ok,
      status: r.status,
      text: () => r.text(),
      json: () => r.json(),
    };
  };
}

/** Build a streaming `StreamingFetchLike` bound to an SSRF posture. */
export function guardedStreamingFetch(opts: GuardedFetchOptions = {}): StreamingFetchLike {
  return async (input, init) => {
    const r = await guardedRequest(input, init, opts);
    return {
      ok: r.ok,
      status: r.status,
      text: () => r.text(),
      lines: () => readLines(r.body),
    };
  };
}

/**
 * The default non-streaming fetch — strict public-build SSRF posture. The
 * harness can build a posture-specific one with `guardedFetch({ guard })`
 * for a self-hoster's LAN override.
 */
export const defaultFetch: FetchLike = guardedFetch();

/**
 * The default streaming fetch — strict public-build SSRF posture. Splits
 * the response body into UTF-8 lines (SSE-friendly).
 */
export const defaultStreamingFetch: StreamingFetchLike = guardedStreamingFetch();

async function* readLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buf.length > 0) yield buf;
      return;
    }
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
}

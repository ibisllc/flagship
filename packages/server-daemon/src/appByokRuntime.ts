/**
 * Runtime LLM-call seam for an installed BYOK app.
 *
 * This is the piece that closes the pillar-4 gap: when a deployed,
 * vibe-coded app makes an LLM call, the daemon loads *that app's own*
 * stored `{providerId, apiKey, baseUrl?}` (see `appByokStore.ts`),
 * resolves the matching `@flagship/llm-providers` adapter, and calls
 * it with the user's key. The key is held only for the duration of the
 * single call and never returned to the caller.
 *
 * Security contract (mirrors `LlmHarness`):
 *   - the apiKey is NEVER logged, NEVER put in an error message/stack,
 *     and NEVER returned to the app.
 *   - provider errors are surfaced WITHOUT the key (the providers raise
 *     `ProviderError` whose message is the upstream body, not creds —
 *     but we still slice + never echo the request config).
 *   - resolution is strictly scoped to the requesting `appId`.
 */

import {
  ProviderError,
  defaultRegistry,
  type ChatRequest,
  type ChatResponse,
  type FetchLike,
  type ProviderRegistry,
} from "@flagship/llm-providers";
import type { AppByokStore } from "./appByokStore.js";

export interface AppByokRuntimeDeps {
  store: AppByokStore;
  /** Provider registry; defaults to the built-in adapter set. */
  registry?: ProviderRegistry;
  /** Inject for tests; production lets the provider use Node's fetch. */
  fetchImpl?: FetchLike;
}

export type AppByokCallResult =
  | { ok: true; response: ChatResponse }
  | { ok: false; code: "no-config" | "unknown-provider" | "provider-error"; message: string };

/**
 * Run one chat request on behalf of `appId` using the app's own stored
 * BYOK provider config. Returns a discriminated result — never throws
 * the key, never logs.
 */
export class AppByokRuntime {
  private readonly registry: ProviderRegistry;
  private readonly fetchImpl?: FetchLike;

  constructor(private readonly deps: AppByokRuntimeDeps) {
    this.registry = deps.registry ?? defaultRegistry;
    this.fetchImpl = deps.fetchImpl;
  }

  async chat(appId: string, request: ChatRequest): Promise<AppByokCallResult> {
    const cfg = await this.deps.store.get(appId);
    if (!cfg || cfg.apiKey.length === 0) {
      return {
        ok: false,
        code: "no-config",
        message: "no BYOK provider configured for this app",
      };
    }
    if (!this.registry.has(cfg.providerId)) {
      // Echo only the provider id (non-secret), never the key.
      return {
        ok: false,
        code: "unknown-provider",
        message: `unknown provider: ${cfg.providerId}`,
      };
    }
    try {
      const response = await this.registry.get(cfg.providerId).chat(
        request,
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl },
        this.fetchImpl,
      );
      return { ok: true, response };
    } catch (e) {
      if (e instanceof ProviderError) {
        return {
          ok: false,
          code: "provider-error",
          message: `${e.provider} request failed (${e.status})`,
        };
      }
      // Never interpolate the caught error — a misbehaving provider
      // adapter must not be able to smuggle the key into our message.
      return {
        ok: false,
        code: "provider-error",
        message: "provider call failed",
      };
    }
  }
}

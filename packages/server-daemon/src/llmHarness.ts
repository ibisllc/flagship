import {
  openLlmPayload,
  sealLlmPayload,
  type Bytes,
  type SealedBlob,
} from "@flagship/protocol";
import {
  assertSafeProviderBaseUrl,
  defaultRegistry,
  defaultStreamingFetch,
  defaultStreamingRegistry,
  ProviderError,
  ProviderRegistry,
  StreamingProviderRegistry,
  UnsafeBaseUrlError,
  type BaseUrlGuardOptions,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamEvent,
  type FetchLike,
  type ProviderConfig,
  type StreamingFetchLike,
} from "@flagship/llm-providers";

export interface LlmHarnessOptions {
  swk: Bytes;
  registry?: ProviderRegistry;
  /**
   * Streaming-provider registry for `chatStream`. Defaults to the
   * built-in streaming providers (anthropic / openai / google).
   */
  streamingRegistry?: StreamingProviderRegistry;
  fetchImpl?: FetchLike;
  /**
   * Streaming-fetch implementation for `chatStream`. Production omits
   * this and the harness uses Node's global fetch (`defaultStreamingFetch`);
   * tests inject a fake that yields pre-baked SSE lines.
   */
  streamingFetchImpl?: StreamingFetchLike;
  /**
   * SSRF posture for a sealed-request `baseUrl`. Defaults to the strict
   * public-build posture (https-only, internal ranges blocked). A
   * self-hoster running a LAN model server flips `allowPrivate`/`allowHttp`
   * or supplies a `hostAllowlist`.
   */
  baseUrlGuard?: BaseUrlGuardOptions;
}

/**
 * A BYOK credential the box holds (transiently, sealed at rest) for a
 * session/build. The harness opens it in memory ONLY for the duration
 * of one provider call. flagshipserver.com NEVER sees this — it arrives
 * at the box over the paired-session-gated pinned pipe and never leaves.
 */
export interface LlmCredential {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}

/** Outcome of a `chatStream` call (no model text — that flows via onEvent). */
export type ChatStreamOutcome =
  | { ok: true }
  | { ok: false; reason: "unknown-provider" | "unsafe-base-url" | "no-streaming" | "provider-error"; message: string };

interface SealedRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  request: ChatRequest;
}

interface SealedResponse {
  ok: true;
  response: ChatResponse;
}

interface SealedError {
  ok: false;
  provider?: string;
  status?: number;
  message: string;
}

/**
 * Decrypts an SWK-sealed LLM payload, calls the chosen provider with the
 * user-supplied key (held only in memory for this call), and seals the
 * response back. flagshipserver.com is never in the credential path —
 * the daemon runs on the user's own Flagship server, behind the tunnel.
 */
export class LlmHarness {
  private readonly registry: ProviderRegistry;
  private readonly streamingRegistry: StreamingProviderRegistry;
  private readonly fetchImpl?: FetchLike;
  private readonly streamingFetchImpl: StreamingFetchLike;
  private readonly swk: Bytes;
  private readonly baseUrlGuard?: BaseUrlGuardOptions;

  constructor(opts: LlmHarnessOptions) {
    this.swk = opts.swk;
    this.registry = opts.registry ?? defaultRegistry;
    this.streamingRegistry = opts.streamingRegistry ?? defaultStreamingRegistry;
    this.fetchImpl = opts.fetchImpl;
    this.streamingFetchImpl = opts.streamingFetchImpl ?? defaultStreamingFetch;
    this.baseUrlGuard = opts.baseUrlGuard;
  }

  listProviders(): string[] {
    return this.registry.list();
  }

  listStreamingProviders(): string[] {
    return this.streamingRegistry.list();
  }

  /** Whether `chatStream` can run for a given provider name. */
  canStream(provider: string): boolean {
    return this.streamingRegistry.has(provider);
  }

  /**
   * Run a streaming chat with a credential held only for this call. The
   * credential arrives in plaintext (the caller unseals it from the
   * transient credential store just-in-time) — it is NEVER logged and
   * NEVER part of an event. flagshipserver.com is not in this path: the
   * box terminates TLS and calls the provider directly with the owner's
   * BYOK key.
   *
   * Mirrors `chat()`'s validation: resolve the provider, apply the
   * baseUrl SSRF guard, then stream `ChatStreamEvent`s to `onEvent`.
   * Returns a structured outcome (no model text — that flows via events).
   */
  async chatStream(
    credential: LlmCredential,
    request: ChatRequest,
    onEvent: (e: ChatStreamEvent) => void,
  ): Promise<ChatStreamOutcome> {
    if (!this.streamingRegistry.has(credential.provider)) {
      const message = "no streaming adapter for provider";
      onEvent({ kind: "error", message });
      return { ok: false, reason: "no-streaming", message };
    }
    const cfg: ProviderConfig = { apiKey: credential.apiKey };
    if (typeof credential.baseUrl === "string" && credential.baseUrl.length > 0) {
      try {
        assertSafeProviderBaseUrl(credential.baseUrl, this.baseUrlGuard);
      } catch (e) {
        const message =
          e instanceof UnsafeBaseUrlError ? e.message : "invalid baseUrl";
        onEvent({ kind: "error", message });
        return { ok: false, reason: "unsafe-base-url", message };
      }
      cfg.baseUrl = credential.baseUrl;
    }
    let sawError: { message: string } | null = null;
    const provider = this.streamingRegistry.get(credential.provider);
    await provider.chatStream(
      request,
      cfg,
      (e: ChatStreamEvent) => {
        if (e.kind === "error" && !sawError) sawError = { message: e.message };
        onEvent(e);
      },
      this.streamingFetchImpl,
    );
    if (sawError) {
      return { ok: false, reason: "provider-error", message: (sawError as { message: string }).message };
    }
    return { ok: true };
  }

  /**
   * Non-streaming chat with a plaintext credential (the build-mode
   * `adaptRunner` path). Same provider dispatch + baseUrl guard as
   * `chat()`, but takes the credential directly instead of a sealed
   * blob, and returns the model's text. Throws on provider / guard
   * failure so the orchestrator can journal a value-free reason.
   */
  async chatWithCredential(
    credential: LlmCredential,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    if (!this.registry.has(credential.provider)) {
      throw new Error("unknown provider");
    }
    if (typeof credential.baseUrl === "string" && credential.baseUrl.length > 0) {
      assertSafeProviderBaseUrl(credential.baseUrl, this.baseUrlGuard);
    }
    const cfg: ProviderConfig = { apiKey: credential.apiKey };
    if (typeof credential.baseUrl === "string" && credential.baseUrl.length > 0) {
      cfg.baseUrl = credential.baseUrl;
    }
    return this.registry.get(credential.provider).chat(request, cfg, this.fetchImpl);
  }

  /**
   * Open a sealed request, call the provider, seal the result. If the
   * provider call fails, the error is sealed too (so error messages don't
   * leak to anyone observing the wire).
   */
  async chat(sealed: SealedBlob): Promise<SealedBlob> {
    let opened: Uint8Array;
    try {
      opened = openLlmPayload(sealed, this.swk);
    } catch {
      return this.sealError({ ok: false, message: "decrypt failed" });
    }

    let req: SealedRequest;
    try {
      const txt = new TextDecoder().decode(opened);
      req = JSON.parse(txt) as SealedRequest;
    } catch {
      return this.sealError({ ok: false, message: "malformed payload" });
    }

    if (
      typeof req.provider !== "string" ||
      typeof req.apiKey !== "string" ||
      !req.request ||
      typeof req.request.model !== "string" ||
      !Array.isArray(req.request.messages)
    ) {
      return this.sealError({ ok: false, message: "missing required fields" });
    }

    if (!this.registry.has(req.provider)) {
      return this.sealError({ ok: false, provider: req.provider, message: "unknown provider" });
    }

    // Defense-in-depth: a sealed-request baseUrl must not point at an
    // internal service before it ever reaches a provider fetch.
    if (typeof req.baseUrl === "string" && req.baseUrl.length > 0) {
      try {
        assertSafeProviderBaseUrl(req.baseUrl, this.baseUrlGuard);
      } catch (e) {
        if (e instanceof UnsafeBaseUrlError) {
          return this.sealError({ ok: false, provider: req.provider, message: e.message });
        }
        return this.sealError({ ok: false, provider: req.provider, message: "invalid baseUrl" });
      }
    }

    try {
      const response = await this.registry.get(req.provider).chat(
        req.request,
        { apiKey: req.apiKey, baseUrl: req.baseUrl },
        this.fetchImpl,
      );
      const sealedResp: SealedResponse = { ok: true, response };
      return sealLlmPayload(new TextEncoder().encode(JSON.stringify(sealedResp)), this.swk);
    } catch (e) {
      if (e instanceof ProviderError) {
        return this.sealError({
          ok: false,
          provider: e.provider,
          status: e.status,
          message: e.bodyText.slice(0, 256),
        });
      }
      return this.sealError({
        ok: false,
        provider: req.provider,
        message: e instanceof Error ? e.message : "provider call failed",
      });
    }
  }

  private sealError(err: SealedError): SealedBlob {
    return sealLlmPayload(new TextEncoder().encode(JSON.stringify(err)), this.swk);
  }
}

export type { SealedRequest, SealedResponse, SealedError };

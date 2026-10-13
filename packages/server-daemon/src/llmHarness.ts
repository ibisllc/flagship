import { type SealedBlob } from "@flagship/protocol";
import type { SwkOps } from "./keyCustodian.js";
import {
  assertSafeProviderBaseUrl,
  isInternalIpLiteral,
  defaultRegistry,
  defaultStreamingRegistry,
  guardedFetch,
  guardedStreamingFetch,
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
import { RelayError, relayUnavailable } from "./tunnel/outboundStream.js";
import type { ProviderRelay } from "./tunnel/relayFetch.js";

export interface LlmHarnessOptions {
  swk: SwkOps;
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
  /**
   * The Flagship relay (AI calls leave through the hub over the tunnel,
   * docs/ai-privacy-and-staging.md §4). A credential with relay on (the
   * default) uses it for every non-local endpoint; if it's absent or
   * unavailable the call fails rather than going direct.
   */
  relay?: ProviderRelay;
  /** Test seam: name → addresses, for the "is this baseUrl on the LAN" check. */
  resolveHost?: (host: string) => Promise<string[]>;
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
  /**
   * Provenance. `"promo"` marks a Flagship-minted free-credits token
   * (scoped `.com` token → our blessed inference endpoint). The harness
   * pins a promo credential's SSRF guard to its OWN baseUrl host, so even
   * if something downstream tried to redirect the call, the scoped token
   * can only ever be presented to the blessed RunPod host — never an
   * attacker proxy or an internal service. Absent / `"byok"` ⇒ the
   * owner's key keeps the strict default guard (no host allowlist).
   */
  source?: "byok" | "promo";
  /**
   * Send this key's calls through the Flagship relay so the provider sees
   * Flagship's address, not the box's. Absent ⇒ ON. A local endpoint (a LAN
   * Ollama) is always direct.
   */
  relay?: boolean;
}

/**
 * Read the optional `relay` flag off a wire credential. `undefined` when
 * absent (relay on), the boolean when well-formed, `"invalid"` otherwise.
 */
export function parseRelayFlag(raw: unknown): boolean | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === "boolean" ? raw : "invalid";
}

/**
 * The free-AI shim answers a refusal (credits used up, pass expired, busy)
 * as `{"error":{"message","code":"free-ai-…"}}` worded for the owner. Return
 * that message when `text` is one, so the owner reads it instead of a raw
 * provider error.
 */
export function freeAiMessage(text: string): string | null {
  try {
    const b = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    const code = b?.error?.code;
    const message = b?.error?.message;
    if (typeof code === "string" && code.startsWith("free-ai") && typeof message === "string") return message;
  } catch {
    // not the shim's JSON
  }
  return null;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home.arpa", ".internal", ".localdomain"];

/**
 * Is `rawUrl` a local endpoint (on the box or the LAN) that must be called
 * directly? Judged by spelling: an internal IP literal, `localhost`, a
 * single-label name, or a LAN suffix. When `resolve` is given (only for the
 * owner's own baseUrl host, never a provider's default host, so the box
 * doesn't look up provider names locally), a name whose records include an
 * internal address counts as local too.
 */
export async function isLocalEndpoint(
  rawUrl: string,
  resolve?: (host: string) => Promise<string[]>,
): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (isInternalIpLiteral(host)) return true;
  if (host === "localhost" || (!host.includes(".") && !host.includes(":"))) return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (!resolve) return false;
  try {
    return (await resolve(host)).some((a) => isInternalIpLiteral(a));
  } catch {
    return false;
  }
}

const defaultResolveHost = async (host: string): Promise<string[]> => {
  const dns = await import("node:dns");
  return (await dns.promises.lookup(host, { all: true })).map((r) => r.address);
};

/**
 * Wrap a direct fetch so a relay-on credential goes through the relay for
 * every non-local URL, and fails closed when the relay can't carry it.
 * Exported for tests; the harness builds one per call.
 */
export function routeProviderFetch<F extends FetchLike | StreamingFetchLike>(args: {
  direct: F;
  relayed: F | undefined;
  relayAvailable: () => boolean;
  wantsRelay: boolean;
  baseUrl?: string;
  guard?: BaseUrlGuardOptions;
  resolveHost?: (host: string) => Promise<string[]>;
  onRelayError?: (e: RelayError) => void;
}): F {
  const baseHost = (() => {
    try {
      return args.baseUrl ? new URL(args.baseUrl).hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  })();
  const routed = async (input: string, init?: Parameters<F>[1]) => {
    if (!args.wantsRelay) return (args.direct as FetchLike)(input, init as Parameters<FetchLike>[1]);
    let sameHost = false;
    try {
      sameHost = baseHost !== null && new URL(input).hostname.toLowerCase() === baseHost;
    } catch {
      /* the guard below rejects it */
    }
    if (await isLocalEndpoint(input, sameHost ? args.resolveHost : undefined)) {
      return (args.direct as FetchLike)(input, init as Parameters<FetchLike>[1]);
    }
    // Same scheme / host-pin / literal-IP rules as the direct path; the hub
    // enforces the resolved-address rules on its side.
    assertSafeProviderBaseUrl(input, args.guard);
    try {
      if (!args.relayed || !args.relayAvailable()) throw relayUnavailable();
      return await (args.relayed as FetchLike)(input, init as Parameters<FetchLike>[1]);
    } catch (e) {
      if (e instanceof RelayError) args.onRelayError?.(e);
      throw e;
    }
  };
  return routed as unknown as F;
}

/** Outcome of a `chatStream` call (no model text — that flows via onEvent). */
export type ChatStreamOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "unknown-provider" | "unsafe-base-url" | "no-streaming" | "provider-error" | "relay-unavailable";
      message: string;
    };

interface SealedRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  /** Absent ⇒ relay on, as for every credential. */
  relay?: boolean;
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
  private readonly injectedFetch?: FetchLike;
  private readonly injectedStreamingFetch?: StreamingFetchLike;
  private readonly defaultFetch: FetchLike;
  private readonly defaultStreamingFetch: StreamingFetchLike;
  private readonly swk: SwkOps;
  private readonly baseUrlGuard?: BaseUrlGuardOptions;
  private readonly relay?: ProviderRelay;
  private readonly resolveHost: (host: string) => Promise<string[]>;

  constructor(opts: LlmHarnessOptions) {
    this.swk = opts.swk;
    this.relay = opts.relay;
    this.resolveHost = opts.resolveHost ?? defaultResolveHost;
    this.registry = opts.registry ?? defaultRegistry;
    this.streamingRegistry = opts.streamingRegistry ?? defaultStreamingRegistry;
    this.baseUrlGuard = opts.baseUrlGuard;
    // Tests inject their own fetchers; we honor them verbatim so a test
    // controls the wire. Production leaves them unset and each call builds
    // an SSRF-guarded fetch bound to the effective per-credential posture
    // (`guardFor`), so the actual connect + every redirect hop re-resolves
    // + re-classifies the host under the RIGHT guard — closing the
    // redirect / DNS-record bypass AND enforcing the promo host-pin.
    this.injectedFetch = opts.fetchImpl;
    this.injectedStreamingFetch = opts.streamingFetchImpl;
    this.defaultFetch = guardedFetch({ guard: this.baseUrlGuard });
    this.defaultStreamingFetch = guardedStreamingFetch({ guard: this.baseUrlGuard });
  }

  /** The blocking fetch for a credential — injected impl, else a guarded
   *  fetch bound to this credential's effective guard (promo host-pin). */
  private fetchForCredential(
    credential: Pick<LlmCredential, "source" | "baseUrl" | "relay">,
    onRelayError?: (e: RelayError) => void,
  ): FetchLike {
    if (this.injectedFetch) return this.injectedFetch;
    const direct =
      credential.source === "promo" ? guardedFetch({ guard: this.guardFor(credential) }) : this.defaultFetch;
    return routeProviderFetch<FetchLike>({
      direct,
      relayed: this.relay?.fetch,
      relayAvailable: () => this.relay?.available() ?? false,
      wantsRelay: credential.relay !== false,
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
      guard: this.guardFor(credential),
      resolveHost: this.resolveHost,
      ...(onRelayError ? { onRelayError } : {}),
    });
  }

  private streamingFetchForCredential(
    credential: LlmCredential,
    onRelayError?: (e: RelayError) => void,
  ): StreamingFetchLike {
    if (this.injectedStreamingFetch) return this.injectedStreamingFetch;
    const direct =
      credential.source === "promo"
        ? guardedStreamingFetch({ guard: this.guardFor(credential) })
        : this.defaultStreamingFetch;
    return routeProviderFetch<StreamingFetchLike>({
      direct,
      relayed: this.relay?.streamingFetch,
      relayAvailable: () => this.relay?.available() ?? false,
      wantsRelay: credential.relay !== false,
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
      guard: this.guardFor(credential),
      resolveHost: this.resolveHost,
      ...(onRelayError ? { onRelayError } : {}),
    });
  }

  /**
   * The effective SSRF posture for one credential. A promo credential is
   * PINNED to its own baseUrl host (the blessed inference endpoint) via
   * `exclusiveHost`: the scoped token can ONLY ever be sent there — every
   * other host, and any redirect to one, is rejected.
   *
   * We deliberately use `exclusiveHost` and NOT `hostAllowlist`: the
   * allowlist is a permit-list that BYPASSES the private/loopback block
   * for the listed host (it returns before IP classification), which
   * would let a misconfigured promo baseUrl reach an internal address.
   * `exclusiveHost` restricts without bypassing, so the strict public-
   * only classification (incl. the unconditional metadata block + the
   * https-only scheme rule, since allowPrivate/allowHttp stay off) still
   * runs. A BYOK credential keeps the harness default (no pin).
   */
  private guardFor(credential: Pick<LlmCredential, "source" | "baseUrl">): BaseUrlGuardOptions | undefined {
    if (credential.source !== "promo") return this.baseUrlGuard;
    if (typeof credential.baseUrl !== "string" || credential.baseUrl.length === 0) {
      return this.baseUrlGuard;
    }
    let host: string;
    try {
      host = new URL(credential.baseUrl).hostname;
    } catch {
      return this.baseUrlGuard;
    }
    return { ...this.baseUrlGuard, exclusiveHost: host };
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
        assertSafeProviderBaseUrl(credential.baseUrl, this.guardFor(credential));
      } catch (e) {
        const message =
          e instanceof UnsafeBaseUrlError ? e.message : "invalid baseUrl";
        onEvent({ kind: "error", message });
        return { ok: false, reason: "unsafe-base-url", message };
      }
      cfg.baseUrl = credential.baseUrl;
    }
    let sawError: { message: string } | null = null;
    let relayFailed: RelayError | null = null;
    const provider = this.streamingRegistry.get(credential.provider);
    await provider.chatStream(
      request,
      cfg,
      (ev: ChatStreamEvent) => {
        let e = ev;
        if (e.kind === "error" && credential.source === "promo") {
          const friendly = freeAiMessage(e.message);
          if (friendly) e = { ...e, message: friendly };
        }
        if (e.kind === "error" && !sawError) sawError = { message: e.message };
        onEvent(e);
      },
      this.streamingFetchForCredential(credential, (e) => {
        relayFailed ??= e;
      }),
    );
    if (relayFailed) {
      return { ok: false, reason: "relay-unavailable", message: (relayFailed as RelayError).message };
    }
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
      assertSafeProviderBaseUrl(credential.baseUrl, this.guardFor(credential));
    }
    const cfg: ProviderConfig = { apiKey: credential.apiKey };
    if (typeof credential.baseUrl === "string" && credential.baseUrl.length > 0) {
      cfg.baseUrl = credential.baseUrl;
    }
    try {
      return await this.registry
        .get(credential.provider)
        .chat(request, cfg, this.fetchForCredential(credential));
    } catch (e) {
      const friendly =
        credential.source === "promo" && e instanceof ProviderError ? freeAiMessage(e.bodyText) : null;
      if (!friendly || !(e instanceof ProviderError)) throw e;
      const out = new ProviderError(e.provider, e.status, friendly);
      out.message = friendly;
      throw out;
    }
  }

  /**
   * Open a sealed request, call the provider, seal the result. If the
   * provider call fails, the error is sealed too (so error messages don't
   * leak to anyone observing the wire).
   */
  async chat(sealed: SealedBlob): Promise<SealedBlob> {
    let opened: Uint8Array;
    try {
      opened = this.swk.openWithSwk(sealed);
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
        this.fetchForCredential({
          ...(typeof req.baseUrl === "string" && req.baseUrl.length > 0 ? { baseUrl: req.baseUrl } : {}),
          ...(typeof req.relay === "boolean" ? { relay: req.relay } : {}),
        }),
      );
      const sealedResp: SealedResponse = { ok: true, response };
      return this.swk.sealWithSwk(new TextEncoder().encode(JSON.stringify(sealedResp)));
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
    return this.swk.sealWithSwk(new TextEncoder().encode(JSON.stringify(err)));
  }
}

export type { SealedRequest, SealedResponse, SealedError };

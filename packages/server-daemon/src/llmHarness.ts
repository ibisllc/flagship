import {
  openLlmPayload,
  sealLlmPayload,
  type Bytes,
  type SealedBlob,
} from "@flagship/protocol";
import {
  assertSafeProviderBaseUrl,
  defaultRegistry,
  ProviderError,
  ProviderRegistry,
  UnsafeBaseUrlError,
  type BaseUrlGuardOptions,
  type ChatRequest,
  type ChatResponse,
  type FetchLike,
} from "@flagship/llm-providers";

export interface LlmHarnessOptions {
  swk: Bytes;
  registry?: ProviderRegistry;
  fetchImpl?: FetchLike;
  /**
   * SSRF posture for a sealed-request `baseUrl`. Defaults to the strict
   * public-build posture (https-only, internal ranges blocked). A
   * self-hoster running a LAN model server flips `allowPrivate`/`allowHttp`
   * or supplies a `hostAllowlist`.
   */
  baseUrlGuard?: BaseUrlGuardOptions;
}

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
  private readonly fetchImpl?: FetchLike;
  private readonly swk: Bytes;
  private readonly baseUrlGuard?: BaseUrlGuardOptions;

  constructor(opts: LlmHarnessOptions) {
    this.swk = opts.swk;
    this.registry = opts.registry ?? defaultRegistry;
    this.fetchImpl = opts.fetchImpl;
    this.baseUrlGuard = opts.baseUrlGuard;
  }

  listProviders(): string[] {
    return this.registry.list();
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

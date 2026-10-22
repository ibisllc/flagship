// Sending one request through the private relay (OHTTP), with the owner's
// fallback rule: if the relay can't carry it, send the same request directly
// and say so, so a lapsed relay plan costs privacy, never availability
// (docs/outbound-proxy.md §OHTTP). Used by the box's setup scripts and by
// `.com`'s daily relay probe.

import {
  decapsulateOhttpResponse,
  decodeBhttpResponse,
  encapsulateOhttpRequest,
  encodeBhttpRequest,
  OHTTP_REQUEST_MEDIA_TYPE,
  OHTTP_RESPONSE_MEDIA_TYPE,
  parseOhttpKeyConfig,
  type OhttpKeyConfig,
} from "./ohttp.js";

/** Header a direct fallback carries, so `.com` can count relay failures (no box identity). */
export const RELAY_FALLBACK_HEADER = "x-flagship-relay-fallback";

/**
 * Flagship's relay, once the owner has one: the relay URL (the provider maps
 * it to `.com`'s gateway) and the gateway's public key configuration (hex).
 * Null until provisioned; boxes then send directly, marked "unconfigured".
 * The env `FLAGSHIP_OHTTP_RELAY_URL` + `FLAGSHIP_OHTTP_KEY_CONFIG` override it.
 */
export const DEFAULT_OHTTP_RELAY: { relayUrl: string; keyConfigHex: string } | null = null;

export interface OhttpRelay {
  relayUrl: string;
  keyConfig: OhttpKeyConfig;
}

export function ohttpRelayFrom(relayUrl: string | undefined | null, keyConfigHex: string | undefined | null): OhttpRelay | null {
  if (!relayUrl || !keyConfigHex || !/^https:\/\//.test(relayUrl) || !/^([0-9a-f]{2})+$/i.test(keyConfigHex)) return null;
  const bytes = new Uint8Array(keyConfigHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(keyConfigHex.slice(i * 2, i * 2 + 2), 16);
  const keyConfig = parseOhttpKeyConfig(bytes);
  return keyConfig ? { relayUrl, keyConfig } : null;
}

export interface PrivateRequest {
  url: string;
  method?: string;
  headers?: Array<[string, string]>;
  body?: Uint8Array | string;
}

export interface PrivateResponse {
  status: number;
  headers: Array<[string, string]>;
  body: Uint8Array;
  /** How it travelled. */
  path: "ohttp" | "direct";
  /** Why it went direct, when it did. */
  fallbackReason?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null; forEach?(cb: (v: string, k: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface SendPrivatelyOptions {
  relay: OhttpRelay | null;
  /** Default true. False is the later "strict" mode: a relay failure is an error. */
  fallbackDirect?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const te = new TextEncoder();

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

export async function sendPrivately(req: PrivateRequest, opts: SendPrivatelyOptions): Promise<PrivateResponse> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const method = (req.method ?? "POST").toUpperCase();
  const body = typeof req.body === "string" ? te.encode(req.body) : req.body ?? new Uint8Array(0);
  const headers = req.headers ?? [];

  const direct = async (reason: string): Promise<PrivateResponse> => {
    if (opts.fallbackDirect === false) throw new Error(`private relay unavailable (${reason})`);
    const h: Record<string, string> = Object.fromEntries(headers);
    h[RELAY_FALLBACK_HEADER] = reason;
    const res = await withTimeout(timeoutMs, (signal) =>
      f(req.url, { method, headers: h, ...(method === "GET" || method === "HEAD" ? {} : { body }), signal }),
    );
    const out: Array<[string, string]> = [];
    res.headers.forEach?.((v, k) => out.push([k, v]));
    return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()), path: "direct", fallbackReason: reason };
  };

  if (!opts.relay) return direct("unconfigured");
  const u = new URL(req.url);
  const { encapsulated, context } = encapsulateOhttpRequest(
    opts.relay.keyConfig,
    encodeBhttpRequest({ method, scheme: "https", authority: u.host, path: `${u.pathname}${u.search}`, headers, body }),
  );
  let relayRes: Awaited<ReturnType<FetchLike>>;
  try {
    relayRes = await withTimeout(timeoutMs, (signal) =>
      f(opts.relay!.relayUrl, {
        method: "POST",
        headers: { "content-type": OHTTP_REQUEST_MEDIA_TYPE },
        body: encapsulated,
        signal,
      }),
    );
  } catch (e) {
    return direct((e as Error).name === "AbortError" ? "relay-timeout" : "relay-unreachable");
  }
  if (!relayRes.ok) return direct(`relay-${relayRes.status}`);
  if ((relayRes.headers.get("content-type") ?? "").split(";")[0]!.trim() !== OHTTP_RESPONSE_MEDIA_TYPE) {
    return direct("relay-bad-response");
  }
  try {
    const inner = decodeBhttpResponse(decapsulateOhttpResponse(context, new Uint8Array(await relayRes.arrayBuffer())));
    return { status: inner.status, headers: inner.headers, body: inner.body, path: "ohttp" };
  } catch {
    return direct("relay-bad-response");
  }
}

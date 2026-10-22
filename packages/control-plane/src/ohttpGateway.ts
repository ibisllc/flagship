// `.com`'s Oblivious HTTP gateway (RFC 9458; docs/outbound-proxy.md §OHTTP).
//
// A box with an outbound proxy sends its setup POSTs and boot-unlock
// requests through a third-party relay. The relay forwards the Encapsulated
// Request here; we decrypt it, run it against our own handlers (never an
// outbound fetch: this is not an open proxy), and encrypt the answer. The
// relay never sees content; we never see the box's address. Only the few
// paths a box needs before its daemon runs are accepted.

import {
  decapsulateOhttpRequest,
  decodeBhttpRequest,
  encapsulateOhttpResponse,
  encodeBhttpResponse,
  encodeOhttpKeys,
  ohttpGatewayKey,
  OHTTP_KEYS_MEDIA_TYPE,
  OHTTP_RESPONSE_MEDIA_TYPE,
  OhttpError,
  type OhttpGatewayKey,
} from "@flagship/protocol";

export const OHTTP_GATEWAY_PATH = "/api/ohttp/gateway";
export const OHTTP_KEYS_PATH = "/.well-known/ohttp-keys";
export const OHTTP_PROBE_PATH = "/api/ohttp/probe";
const MAX_ENCAPSULATED = 64 * 1024;

/** Parse `OHTTP_GATEWAY_KEYS`: `<keyId>:<64 hex X25519 private key>[,…]`, current key first. */
export function ohttpGatewayKeysFromEnv(raw: string | undefined | null): OhttpGatewayKey[] {
  if (!raw) return [];
  const out: OhttpGatewayKey[] = [];
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,3}):([0-9a-fA-F]{64})\s*$/.exec(part);
    if (!m) continue;
    const id = Number(m[1]);
    if (id > 255 || out.some((k) => k.keyId === id)) continue;
    const priv = new Uint8Array(32);
    for (let i = 0; i < 32; i++) priv[i] = parseInt(m[2]!.slice(i * 2, i * 2 + 2), 16);
    out.push(ohttpGatewayKey(id, priv));
  }
  return out;
}

/**
 * The inner requests a box may make through the relay: the setup POSTs and
 * the boot-unlock calls, plus the relay probe. Anything else is refused.
 */
export function isOhttpTargetAllowed(method: string, authority: string, path: string, apex: string, bootHost: string): boolean {
  const p = path.split("?")[0]!;
  const host = authority.toLowerCase();
  if (host === apex) {
    if (method === "POST" && p === "/api/server/register") return true;
    if (method === "POST" && /^\/api\/server\/[a-z0-9.-]{1,253}\/sealed-luks-key$/.test(p)) return true;
    if (method === "POST" && /^\/api\/order\/[A-Za-z0-9]{1,64}\/status$/.test(p)) return true;
    if (method === "GET" && p === OHTTP_PROBE_PATH) return true;
    return false;
  }
  if (host === bootHost) {
    if (method === "GET" && /^\/api\/boot\/lease\/[a-z0-9.-]{1,253}$/.test(p)) return true;
    if (method === "POST" && p === "/api/boot/request") return true;
    if (method === "GET" && /^\/api\/boot\/response\/[a-z0-9.-]{1,253}\/[A-Za-z0-9_-]{1,128}$/.test(p)) return true;
    return false;
  }
  return false;
}

/** Headers a client may not set on the inner request (hop-by-hop, ours, Cloudflare's). */
function innerHeaderAllowed(name: string): boolean {
  const n = name.toLowerCase();
  if (["host", "connection", "content-length", "transfer-encoding", "upgrade", "x-flagship-relay-fallback", "x-flagship-effective-host"].includes(n)) return false;
  if (n.startsWith("cf-") || n.startsWith("x-forwarded") || n === "forwarded" || n === "x-real-ip" || n === "true-client-ip") return false;
  return true;
}

export interface OhttpGatewayDeps {
  keys: readonly OhttpGatewayKey[];
  apexHost: string;
  bootHost: string;
  /** Run the decrypted request against `.com`'s own routing. */
  dispatch: (req: Request) => Promise<Response>;
  /** Count one arrival through the relay (no identity). */
  recordArrival?: () => Promise<void>;
}

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The published key configurations (`application/ohttp-keys`). */
export function ohttpKeysResponse(keys: readonly OhttpGatewayKey[]): Response {
  if (keys.length === 0) return plain(404, "no gateway keys configured");
  return new Response(encodeOhttpKeys(keys), {
    status: 200,
    headers: { "content-type": OHTTP_KEYS_MEDIA_TYPE, "cache-control": "public, max-age=86400" },
  });
}

export async function handleOhttpGateway(request: Request, deps: OhttpGatewayDeps): Promise<Response> {
  if (request.method !== "POST") return plain(405, "POST an Encapsulated Request");
  if ((request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== "message/ohttp-req") {
    return plain(415, "expected message/ohttp-req");
  }
  if (deps.keys.length === 0) return plain(503, "gateway not configured");
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_ENCAPSULATED) return plain(413, "request too large");

  let decrypted: ReturnType<typeof decapsulateOhttpRequest>;
  try {
    decrypted = decapsulateOhttpRequest(deps.keys, body);
  } catch (e) {
    // RFC 9458 §5.2: a key the client should refetch, else a plain 400.
    return e instanceof OhttpError && e.code === "key" ? plain(422, "unknown key") : plain(400, "could not decrypt");
  }

  const seal = (status: number, headers: Array<[string, string]>, content: Uint8Array) =>
    new Response(encapsulateOhttpResponse(decrypted.context, encodeBhttpResponse({ status, headers, body: content })), {
      status: 200,
      headers: { "content-type": OHTTP_RESPONSE_MEDIA_TYPE, "cache-control": "no-store" },
    });
  const te = new TextEncoder();
  const sealError = (status: number, error: string) =>
    seal(status, [["content-type", "application/json"]], te.encode(JSON.stringify({ error })));

  let inner: ReturnType<typeof decodeBhttpRequest>;
  try {
    inner = decodeBhttpRequest(decrypted.request);
  } catch {
    return sealError(400, "malformed request");
  }
  const method = inner.method.toUpperCase();
  if (inner.scheme !== "https" || !isOhttpTargetAllowed(method, inner.authority, inner.path, deps.apexHost, deps.bootHost)) {
    return sealError(403, "not available through the relay");
  }

  const headers = new Headers();
  for (const [n, v] of inner.headers) if (innerHeaderAllowed(n)) headers.append(n, v);
  const req = new Request(`https://${inner.authority.toLowerCase()}${inner.path}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: inner.body }),
  });
  await deps.recordArrival?.().catch(() => {});
  let res: Response;
  try {
    res = await deps.dispatch(req);
  } catch {
    return sealError(502, "the request failed");
  }
  const out: Array<[string, string]> = [];
  const ct = res.headers.get("content-type");
  if (ct) out.push(["content-type", ct]);
  return seal(res.status, out, new Uint8Array(await res.arrayBuffer()));
}

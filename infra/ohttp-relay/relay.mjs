// Flagship's INTERIM Oblivious HTTP relay (RFC 9458 §4.2; docs/outbound-proxy.md
// "Interim relay"). It forwards an Encapsulated Request to `.com`'s gateway and
// the Encapsulated Response back, and nothing else: it can't read either (only
// the gateway holds the key), it never forwards the client's address or
// headers, and it logs no addresses.
//
// Interim, operated by Flagship: it hides your address from `.com`'s logs only
// because it runs on a different host and provider (not Cloudflare). It is not
// a non-collusion guarantee, since one operator runs both halves. A third-party
// relay replaces it once the owner signs a contract; the apps and boxes learn
// the relay from `.com` (`GET /api/ohttp/config`), so no release is needed.
//
// Env: PORT (8080), GATEWAY_URL (https://flagshipserver.com/api/ohttp/gateway),
// ALLOWED_ORIGINS (comma list for browser CORS), PER_IP_PER_MINUTE (60).
import { createServer } from "node:http";

export const MAX_BODY = 64 * 1024;
const REQ_TYPE = "message/ohttp-req";
const RES_TYPE = "message/ohttp-res";

export function relayConfigFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? 8080),
    gatewayUrl: env.GATEWAY_URL ?? "https://flagshipserver.com/api/ohttp/gateway",
    allowedOrigins: new Set(
      (env.ALLOWED_ORIGINS ?? "https://webapp.flagshipserver.com,https://remote.flagshipserver.com")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    perIpPerMinute: Number(env.PER_IP_PER_MINUTE ?? 60),
    timeoutMs: Number(env.TIMEOUT_MS ?? 20_000),
  };
}

/**
 * The per-address limit keeps the relay from being a free amplifier. Addresses live only in this map, in
 * memory, for at most a minute, and are never written anywhere.
 */
function limiter(perMinute, now = Date.now) {
  const buckets = new Map();
  let sweptAt = now();
  return (key) => {
    const t = now();
    if (t - sweptAt > 60_000) {
      buckets.clear();
      sweptAt = t;
    }
    const n = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, n);
    return n <= perMinute;
  };
}

export function createRelay(cfg = relayConfigFromEnv(), deps = {}) {
  const f = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const allow = limiter(cfg.perIpPerMinute, deps.now);
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-max-age", "600");
    }
  };
  const plain = (res, status, text) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  return createServer(async (req, res) => {
    res.setHeader("referrer-policy", "no-referrer");
    if (req.method === "GET" && req.url === "/healthz") return plain(res, 200, "ok");
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(req.headers.origin && cfg.allowedOrigins.has(req.headers.origin) ? 204 : 403);
      return res.end();
    }
    if (req.method !== "POST") return plain(res, 405, "method not allowed");
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== REQ_TYPE) return plain(res, 415, "expected message/ohttp-req");
    // The socket's address, never a header a client could set.
    if (!allow(req.socket.remoteAddress ?? "")) return plain(res, 429, "slow down");
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return plain(res, 413, "too large");
      chunks.push(c);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      // Only the content type travels: no address, no cookies, no client headers.
      const up = await f(cfg.gatewayUrl, {
        method: "POST",
        headers: { "content-type": REQ_TYPE },
        body: Buffer.concat(chunks),
        signal: ctrl.signal,
        redirect: "error",
      });
      const body = Buffer.from(await up.arrayBuffer());
      const ct = (up.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!up.ok || ct !== RES_TYPE) return plain(res, 502, "gateway error");
      res.writeHead(200, { "content-type": RES_TYPE, "cache-control": "no-store" });
      res.end(body);
    } catch {
      plain(res, 504, "gateway unreachable");
    } finally {
      clearTimeout(t);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = relayConfigFromEnv();
  createRelay(cfg).listen(cfg.port, () => console.log(`ohttp relay (interim) on :${cfg.port} → ${cfg.gatewayUrl}`));
}

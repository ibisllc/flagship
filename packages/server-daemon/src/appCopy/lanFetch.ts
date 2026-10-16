/**
 * Fetch from the copy's source over the local network (docs/lan-direct.md §
 * Box to box). Only the address changes: the request still goes to
 * `https://<source>`, so SNI, the Host header and the certificate check
 * (WebPKI, against the source's own name) are exactly the relay's, and the
 * source's LAN listener pipes it into the same TLS server the tunnel feeds.
 * Something else holding that address can't answer as the source.
 */
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { LanEndpoint } from "@flagship/protocol";

export type LanFetch = (
  endpoint: LanEndpoint,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

/** `ca` replaces the system roots (tests). A connection gets
 *  `connectTimeoutMs` to finish its handshake, then may go quiet for at most
 *  `idleTimeoutMs` (a Wi-Fi drop leaves no reset, only silence); either way the
 *  request fails and the caller goes back to the relay. */
export function makeLanFetch(o: { connectTimeoutMs?: number; idleTimeoutMs?: number; ca?: string } = {}): LanFetch {
  const connectTimeoutMs = o.connectTimeoutMs ?? 3_000;
  const idleTimeoutMs = o.idleTimeoutMs ?? 15_000;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8, ...(o.ca ? { ca: o.ca } : {}) });
  return (endpoint, url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const family = endpoint.address.includes(":") ? 6 : 4;
      const lookup = ((_host: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (o?.all) cb(null, [{ address: endpoint.address, family }]);
        else cb(null, endpoint.address, family);
      }) as unknown as LookupFunction;
      const req = https.request(
        {
          hostname: u.hostname,
          port: endpoint.port,
          path: u.pathname + u.search,
          method: init.method,
          headers: { ...init.headers, host: u.host, "content-length": String(Buffer.byteLength(init.body)) },
          lookup,
          agent,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          // The connection closed before the whole answer arrived.
          res.on("close", () => {
            if (!res.complete) reject(new Error("the local connection dropped mid-answer"));
          });
          res.on("end", () => {
            const status = res.statusCode ?? 502;
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
            resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      const t = setTimeout(() => req.destroy(new Error("no answer on the local network")), connectTimeoutMs);
      const connected = (): void => {
        clearTimeout(t);
        req.setTimeout(idleTimeoutMs, () => req.destroy(new Error("the local network went quiet")));
      };
      req.on("socket", (s) => {
        // A kept-alive socket is already connected and past its handshake.
        if (!s.connecting && !s.pending) connected();
        else s.once("secureConnect", connected);
      });
      req.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      req.end(init.body);
    });
}

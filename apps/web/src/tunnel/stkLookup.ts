/**
 * The STK `.com` registered for a server (`GET /api/server/by-domain/<serverId>`), cached so reconnect storms don't
 * reach `.com`. A cached key decides only a HELLO that presents it: one that presents another key (the name was
 * registered again with a new key) is answered from a fresh read, which then replaces the cached key. A HELLO that
 * matches a stale cached key still meets `.com`'s live serving record in the serving gate on every HELLO.
 */
import type { TunnelAuthLookup } from "./tunnelHub.js";

export interface StkLookupOptions {
  comBaseUrl: string;
  /** In-process registrations, asked first (dev and tests). */
  local?: (serverId: string) => Uint8Array | null;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function comStkLookup(opts: StkLookupOptions): TunnelAuthLookup {
  const base = opts.comBaseUrl.replace(/\/+$/, "");
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { pub: Uint8Array; expiresAt: number }>();
  return async (serverId, presented) => {
    const local = opts.local?.(serverId);
    if (local) return local;
    const cached = cache.get(serverId);
    if (cached && cached.expiresAt > now() && (!presented || sameBytes(cached.pub, presented))) return cached.pub;
    try {
      const resp = await (opts.fetchImpl ?? fetch)(`${base}/api/server/by-domain/${encodeURIComponent(serverId)}`);
      if (!resp.ok) {
        cache.delete(serverId);
        return null;
      }
      const body = (await resp.json()) as { identityPubKey?: unknown; revoked?: unknown };
      if (typeof body.identityPubKey !== "string" || !HEX64.test(body.identityPubKey) || body.revoked) {
        cache.delete(serverId);
        return null;
      }
      const pub = new Uint8Array(Buffer.from(body.identityPubKey, "hex"));
      cache.set(serverId, { pub, expiresAt: now() + ttlMs });
      return pub;
    } catch {
      return null;
    }
  };
}

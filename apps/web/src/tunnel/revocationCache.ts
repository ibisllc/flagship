/**
 * Per-user entitlement revocation cache for the .services tunnel hub.
 *
 * On every HELLO, the hub asks: "is this cert id revoked for this
 * user?" Calling .com on every HELLO would be expensive; we cache
 * responses with a short TTL (default 5 min). Stale entries refresh
 * lazily on the next access.
 *
 * Returning null on fetch failure means "couldn't get an answer" —
 * the hub treats that as fail-open (don't reject on transient .com
 * outages). Returning an empty Set means "definitely empty list."
 */

import {
  verifyEntitlementRevocationList,
  type Bytes,
  type EntitlementRevocationList,
} from "@flagship/protocol";

export interface RevocationCacheOptions {
  controlPlaneBaseUrl: string;
  /** Look up the user's IRK pubkey to verify the signed list. */
  irkLookup: (username: string) => Promise<Bytes | null>;
  /** Cache TTL in ms. Default 5 min. */
  ttlMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Entry {
  certIds: Set<string>;
  fetchedAt: number;
  issuedAt: number;
}

export class RevocationCache {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly opts: Required<Omit<RevocationCacheOptions, "fetchImpl">> & {
    fetchImpl: typeof fetch;
  };

  constructor(opts: RevocationCacheOptions) {
    this.opts = {
      controlPlaneBaseUrl: opts.controlPlaneBaseUrl.replace(/\/+$/, ""),
      irkLookup: opts.irkLookup,
      ttlMs: opts.ttlMs ?? 5 * 60_000,
      fetchImpl: opts.fetchImpl ?? (globalThis.fetch as typeof fetch),
      now: opts.now ?? (() => Date.now()),
    };
  }

  /**
   * Lookup callback shape that plugs into TunnelHubOptions.revocationLookup.
   * Returns the user's current revoked-cert-id set, or null on fetch
   * failure (caller's fail-open policy).
   */
  async lookup(username: string): Promise<Set<string> | null> {
    const cur = this.cache.get(username);
    if (cur && this.opts.now() - cur.fetchedAt < this.opts.ttlMs) {
      return cur.certIds;
    }
    await this.refresh(username);
    return this.cache.get(username)?.certIds ?? null;
  }

  async refresh(username: string): Promise<void> {
    const inflight = this.inflight.get(username);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const r = await this.opts.fetchImpl(
          `${this.opts.controlPlaneBaseUrl}/api/cert-revocations/${encodeURIComponent(username)}`,
        );
        if (!r.ok) return;
        const body = (await r.json()) as {
          username?: string;
          certIds?: string[];
          issuedAt?: number;
          signature?: string | null;
        };
        if (!body || typeof body.username !== "string") return;
        const certIds = body.certIds ?? [];
        // Empty + signature=null is the legitimate "no list ever posted" case.
        // Skip signature verification — there's nothing to verify.
        if (certIds.length === 0 && !body.signature) {
          this.cache.set(username, {
            certIds: new Set(),
            fetchedAt: this.opts.now(),
            issuedAt: 0,
          });
          return;
        }
        if (typeof body.signature !== "string" || typeof body.issuedAt !== "number") {
          return;
        }
        const irkPub = await this.opts.irkLookup(username);
        if (!irkPub) return;
        const list: EntitlementRevocationList = {
          username,
          certIds,
          issuedAt: body.issuedAt,
        };
        const sig = hexToBytes(body.signature);
        if (!verifyEntitlementRevocationList(list, sig, irkPub)) return;
        // Replay defense: don't accept an OLDER list than what we have.
        const cur = this.cache.get(username);
        if (cur && body.issuedAt < cur.issuedAt) return;
        this.cache.set(username, {
          certIds: new Set(certIds),
          fetchedAt: this.opts.now(),
          issuedAt: body.issuedAt,
        });
      } finally {
        this.inflight.delete(username);
      }
    })();
    this.inflight.set(username, p);
    await p;
  }
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

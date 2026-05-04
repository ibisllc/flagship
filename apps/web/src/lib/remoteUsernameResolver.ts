import type { FetchLike } from "@flagship/llm-providers";
import { hexToBytes } from "./hex.js";

/**
 * The .com ↔ .services bridge: a `(username) => Promise<Uint8Array | null>`
 * that the .services side uses to verify any IRK signature it sees. Each
 * unique username is fetched once from `.com /api/username/:username` and
 * cached for `cacheTtlMs` (default 5 minutes). Negative results (404) are
 * cached briefly too so a flood of unknown-user requests doesn't hammer .com.
 *
 * The cache is intentionally small — usernames are scarce per request, and
 * we'd rather take a fresh read than serve a stale revocation.
 */
export interface RemoteUsernameResolverOptions {
  /** Base URL of flagshipserver.com. */
  comBaseUrl: string;
  fetchImpl?: FetchLike;
  /** Positive-result TTL. Default 5 minutes. */
  cacheTtlMs?: number;
  /** Negative-result TTL. Default 30 seconds. */
  negativeCacheTtlMs?: number;
  /** Override now() for tests. */
  now?: () => number;
}

interface CacheEntry {
  value: Uint8Array | null;
  expiresAt: number;
}

export class RemoteUsernameResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: RemoteUsernameResolverOptions) {}

  /** Drop the cache (use after explicit revocations). */
  invalidate(username?: string): void {
    if (username) this.cache.delete(username.toLowerCase());
    else this.cache.clear();
  }

  /**
   * The lookup contract that matches every consumer's `resolveUserIrk` shape.
   * Bind it: `resolveUserIrk: resolver.lookup.bind(resolver)`.
   */
  async lookup(username: string): Promise<Uint8Array | null> {
    const key = username.toLowerCase();
    const now = (this.opts.now ?? (() => Date.now()))();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value ? hit.value.slice() : null;

    const f = this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const url = `${this.opts.comBaseUrl}/api/username/${encodeURIComponent(username)}`;
    let resp;
    try {
      resp = await f(url, { method: "GET" });
    } catch {
      return null;
    }
    if (!resp.ok) {
      const ttl = this.opts.negativeCacheTtlMs ?? 30_000;
      this.cache.set(key, { value: null, expiresAt: now + ttl });
      return null;
    }
    const body = (await resp.json()) as { irkPub?: string };
    if (typeof body.irkPub !== "string" || !/^[0-9a-f]{64}$/.test(body.irkPub)) {
      return null;
    }
    let irkPub: Uint8Array;
    try {
      irkPub = hexToBytes(body.irkPub);
    } catch {
      return null;
    }
    const ttl = this.opts.cacheTtlMs ?? 5 * 60_000;
    this.cache.set(key, { value: irkPub.slice(), expiresAt: now + ttl });
    return irkPub;
  }
}

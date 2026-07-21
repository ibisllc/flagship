import type { FetchLike } from "@flagship/llm-providers";
import { hexToBytes } from "./hex.js";

/**
 * The .com ↔ .services authority bridge. It caches the username's IRK plus
 * optional admin root from `.com /api/username/:username`; `lookup()` keeps the
 * established IRK-only consumer contract, while `lookupAuthority()` supplies
 * the sensitive RootEntitlement gate. Each unique username is fetched once per
 * `cacheTtlMs` (default 5 minutes). Negative results (404) are cached briefly
 * too so a flood of unknown-user requests doesn't hammer .com.
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

export interface RemoteUsernameAuthority {
  irkPub: Uint8Array;
  adminRootPub: Uint8Array | null;
}

interface CacheEntry {
  value: RemoteUsernameAuthority | null;
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
    const authority = await this.lookupAuthority(username);
    return authority?.irkPub.slice() ?? null;
  }

  /**
   * Resolve both account authorities from the same cached `.com` directory
   * read. RootEntitlements use the admin root when present; ordinary
   * membership operations continue to use the IRK returned by `lookup()`.
   */
  async lookupAuthority(username: string): Promise<RemoteUsernameAuthority | null> {
    const key = username.toLowerCase();
    const now = (this.opts.now ?? (() => Date.now()))();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return cloneAuthority(hit.value);

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
    const body = (await resp.json()) as { irkPub?: string; adminRootPub?: unknown };
    if (typeof body.irkPub !== "string" || !/^[0-9a-f]{64}$/.test(body.irkPub)) {
      return null;
    }
    let irkPub: Uint8Array;
    let adminRootPub: Uint8Array | null = null;
    try {
      irkPub = hexToBytes(body.irkPub);
      if (body.adminRootPub !== undefined && body.adminRootPub !== null) {
        if (typeof body.adminRootPub !== "string" || !/^[0-9a-f]{64}$/.test(body.adminRootPub)) {
          return null;
        }
        adminRootPub = hexToBytes(body.adminRootPub);
      }
    } catch {
      return null;
    }
    const value = { irkPub, adminRootPub };
    const ttl = this.opts.cacheTtlMs ?? 5 * 60_000;
    this.cache.set(key, { value: cloneAuthority(value), expiresAt: now + ttl });
    return cloneAuthority(value);
  }
}

function cloneAuthority(value: RemoteUsernameAuthority | null): RemoteUsernameAuthority | null {
  return value
    ? {
        irkPub: value.irkPub.slice(),
        adminRootPub: value.adminRootPub?.slice() ?? null,
      }
    : null;
}

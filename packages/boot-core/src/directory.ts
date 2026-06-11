/**
 * The CANONICAL id-cert reads (cloneable).
 *
 * The boot worker holds NO identity directory of its own. It resolves
 * the box STK and the account IRK for a serverDomain from the identity
 * plane, over HTTP, using endpoints that already exist on the identity
 * plane (flagshipserver.com / apps/com):
 *
 *   - box STK   ← GET {IDENTITY_PLANE_URL}/api/users/:u/pods
 *                 (the `pods[].identityPubKey` for the matching
 *                  `serverDomain` — the directory-bound STK).
 *   - account IRK ← GET {IDENTITY_PLANE_URL}/api/users/:u/pubkey-cert
 *                 (the CA-signed `binding.pubKey` — the canonical
 *                  account IRK). This is the same artifact every other
 *                  client already trusts as the account's identity cert.
 *
 * `IDENTITY_PLANE_URL` is config, so an enterprise clone repoints the
 * directory at its own identity plane without touching code.
 *
 * The username is derived from the serverDomain — the box FQDN is
 * `<server>.<user>.<apex>`; the user label is the one immediately before
 * the configurable apex.
 */

export interface DirectoryClient {
  /**
   * Returns the directory-bound box STK pubkey (hex) for `serverDomain`,
   * or null if no such server is registered. Used for box-STK authz
   * binding.
   */
  boxStkForDomain(serverDomain: string): Promise<string | null>;
  /**
   * Returns the account IRK pubkey (hex) that OWNS `serverDomain`, or
   * null if the server / account is unknown. Used for owner-IRK authz
   * binding.
   */
  ownerIrkForDomain(serverDomain: string): Promise<string | null>;
  /**
   * Returns the active watch-delegate pubkeys (hex) scoped to "boot-approval"
   * for the account that owns `serverDomain`, each with its expiry, or null
   * if the server / account is unknown. Used for the delegate-role authz
   * binding on the boot-approval route (the gate filters expiry).
   *
   * The identity plane's `/watch-delegates` list is the authority: it returns
   * only delegates that are un-revoked AND still verify under the account's
   * CURRENT IRK, so an IRK rotation drops orphaned delegates here without the
   * boot worker holding any directory state of its own.
   */
  activeBootDelegatesForDomain(
    serverDomain: string,
  ): Promise<Array<{ pubKeyHex: string; expiresAt: number }> | null>;
  /**
   * The account username that owns `serverDomain`, used to scope the parked
   * mailbox row so the phone's per-account `/api/secret-requests` listing
   * surfaces it. Null when the domain doesn't resolve to a known account.
   *
   * Why this matters for the CONSOLIDATED (apps/com) deployment: there is
   * now ONE mailbox. The boot router's parked row IS the row the phone
   * reads, so it must carry the real username — not the serverDomain
   * placeholder the standalone worker used (its phone-readable row was a
   * SEPARATE one created by the identity plane's notify-owner handler).
   * The standalone `HttpDirectoryClient` derives it from the FQDN; the
   * in-process client resolves it from storage.
   */
  usernameForDomain(serverDomain: string): Promise<string | null>;
}

export interface HttpDirectoryClientOpts {
  identityPlaneUrl: string;
  /** Apex the boot worker serves under, e.g. "flagship.services". Used
   *  only to derive the user label from the box FQDN. */
  apex: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Derive the account username from a box FQDN of the form
 * `<server>.<user>.<apex>`. Returns null when the domain doesn't sit
 * under the configured apex or lacks the `<server>.<user>` prefix.
 */
export function usernameFromServerDomain(serverDomain: string, apex: string): string | null {
  const d = serverDomain.toLowerCase().replace(/\.$/, "");
  const a = apex.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  const suffix = `.${a}`;
  if (!d.endsWith(suffix)) return null;
  const head = d.slice(0, d.length - suffix.length); // "<server>.<user>"
  const labels = head.split(".");
  if (labels.length < 2) return null;
  const user = labels[labels.length - 1];
  if (!user) return null;
  return user;
}

/**
 * Directory reads must never be served from a cached response — a stale
 * STK/IRK binding would mis-authorize. `cache` is a Cloudflare/browser
 * fetch directive that isn't in the base `RequestInit` type (no DOM lib),
 * so it's attached via a cast; on the clone runtime (Cloudflare Workers /
 * a real browser fetch) it takes effect, and on a fetch that ignores it
 * the `accept` header is harmless.
 */
const NO_STORE_INIT = {
  headers: { accept: "application/json" },
  cache: "no-store",
} as RequestInit;

export class HttpDirectoryClient implements DirectoryClient {
  private readonly base: string;
  private readonly apex: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpDirectoryClientOpts) {
    this.base = opts.identityPlaneUrl.replace(/\/$/, "");
    this.apex = opts.apex;
    // MUST bind the global fetch: calling it as `this.fetchImpl(...)` sets
    // `this` to the client instance, which Cloudflare rejects with
    // "Illegal invocation" (it requires `this === globalThis`). Confirmed
    // on metal as the #27 boot-unlock 1101. Injected test mocks pass through.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  async boxStkForDomain(serverDomain: string): Promise<string | null> {
    const user = usernameFromServerDomain(serverDomain, this.apex);
    if (!user) return null;
    const res = await this.fetchImpl(
      `${this.base}/api/users/${encodeURIComponent(user)}/pods`,
      NO_STORE_INIT,
    );
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const pods = (body as { pods?: unknown }).pods;
    if (!Array.isArray(pods)) return null;
    const want = serverDomain.toLowerCase();
    for (const p of pods) {
      if (
        p &&
        typeof p === "object" &&
        typeof (p as { serverDomain?: unknown }).serverDomain === "string" &&
        (p as { serverDomain: string }).serverDomain.toLowerCase() === want &&
        typeof (p as { identityPubKey?: unknown }).identityPubKey === "string"
      ) {
        // A revoked pod is no longer a valid box for boot operations.
        const revokedAt = (p as { revokedAt?: unknown }).revokedAt;
        if (typeof revokedAt === "number") return null;
        return (p as { identityPubKey: string }).identityPubKey.toLowerCase();
      }
    }
    return null;
  }

  async ownerIrkForDomain(serverDomain: string): Promise<string | null> {
    const user = usernameFromServerDomain(serverDomain, this.apex);
    if (!user) return null;
    // First confirm the server actually exists + belongs to this account
    // (so an owner can't write to a serverDomain that maps to their
    // username but was never registered).
    const stk = await this.boxStkForDomain(serverDomain);
    if (stk === null) return null;
    const res = await this.fetchImpl(
      `${this.base}/api/users/${encodeURIComponent(user)}/pubkey-cert`,
      NO_STORE_INIT,
    );
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const binding = (body as { binding?: unknown }).binding;
    if (
      binding &&
      typeof binding === "object" &&
      typeof (binding as { pubKey?: unknown }).pubKey === "string"
    ) {
      return (binding as { pubKey: string }).pubKey.toLowerCase();
    }
    return null;
  }

  async activeBootDelegatesForDomain(
    serverDomain: string,
  ): Promise<Array<{ pubKeyHex: string; expiresAt: number }> | null> {
    const user = usernameFromServerDomain(serverDomain, this.apex);
    if (!user) return null;
    // The server must exist + belong to this account, same precondition as
    // the owner-IRK read — a delegate can't approve boots for a serverDomain
    // that maps to the username but was never registered.
    const stk = await this.boxStkForDomain(serverDomain);
    if (stk === null) return null;
    const res = await this.fetchImpl(
      `${this.base}/api/users/${encodeURIComponent(user)}/watch-delegates`,
      NO_STORE_INIT,
    );
    if (!res.ok) return [];
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return [];
    }
    const delegates = (body as { delegates?: unknown }).delegates;
    if (!Array.isArray(delegates)) return [];
    const out: Array<{ pubKeyHex: string; expiresAt: number }> = [];
    for (const d of delegates) {
      if (!d || typeof d !== "object") continue;
      const pub = (d as { delegatePubKey?: unknown }).delegatePubKey;
      const scopes = (d as { scopes?: unknown }).scopes;
      const expiresAt = (d as { expiresAt?: unknown }).expiresAt;
      if (
        typeof pub === "string" &&
        Array.isArray(scopes) &&
        scopes.includes("boot-approval") &&
        typeof expiresAt === "number"
      ) {
        out.push({ pubKeyHex: pub.toLowerCase(), expiresAt });
      }
    }
    return out;
  }

  async usernameForDomain(serverDomain: string): Promise<string | null> {
    return usernameFromServerDomain(serverDomain, this.apex);
  }
}

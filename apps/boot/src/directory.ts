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

export class HttpDirectoryClient implements DirectoryClient {
  private readonly base: string;
  private readonly apex: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpDirectoryClientOpts) {
    this.base = opts.identityPlaneUrl.replace(/\/$/, "");
    this.apex = opts.apex;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async boxStkForDomain(serverDomain: string): Promise<string | null> {
    const user = usernameFromServerDomain(serverDomain, this.apex);
    if (!user) return null;
    const res = await this.fetchImpl(
      `${this.base}/api/users/${encodeURIComponent(user)}/pods`,
      { headers: { accept: "application/json" } },
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
      { headers: { accept: "application/json" } },
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
}

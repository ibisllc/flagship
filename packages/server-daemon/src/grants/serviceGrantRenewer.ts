/**
 * #91 — Phone-side ServiceGrant background renewer.
 *
 * AppGrants ship with a 7-day TTL by convention. Without auto-renewal,
 * every user-installed app would silently lose authority after a week
 * — a footgun. The renewer:
 *
 *   1. Lists the user's currently-active AppGrants (from the encrypted
 *      user-mandate store on .com via #71, or from a local cache).
 *   2. For each grant within RENEW_WINDOW_MS of expiry, re-signs with
 *      a fresh issuedAt + expiresAt and the same content (serverIdentities,
 *      routes, serviceCanonical).
 *   3. Distributes the new grant to all listed serverIdentities via
 *      the existing sibling-WS transport from #86. Each pod stores
 *      the fresh grant; the legacy one expires naturally.
 *
 * Auto-renew default: ON for user-installed apps. Apps that opt into
 * "explicit renewal" (a flag in the grant) require a phone tap each
 * cycle — used for high-sensitivity surfaces like marketplace publish
 * or LLM-promo bootstrap.
 *
 * The renewer is a PURE function over (existing grants, current time,
 * signing key, distributor). I/O happens in the distributor + the
 * grant-store accessor injected by the caller. This makes it directly
 * unit-testable without spinning up sibling-WS.
 */

import {
  serviceGrantActiveAt,
  signServiceGrant,
  verifyServiceGrant,
  type ServiceGrant,
  type Bytes,
  type Keypair,
} from "@flagship/protocol";

/** Default: renew when the grant has 1 day or less remaining. */
export const DEFAULT_RENEW_WINDOW_MS = 24 * 60 * 60_000;
/** Default new-grant duration: 7 days from now. */
export const DEFAULT_GRANT_TTL_MS = 7 * 24 * 60 * 60_000;

export interface GrantWithMeta {
  grant: ServiceGrant;
  signature: Bytes;
  /** When true, renewal requires explicit phone tap rather than auto. */
  requiresExplicitRenewal: boolean;
}

export interface RenewerDeps {
  /** Lists the user's currently-known grants. */
  listGrants: () => Promise<GrantWithMeta[]>;
  /** Persists a refreshed grant + signature alongside the existing
   *  legacy one. The legacy one expires naturally. */
  saveGrant: (next: GrantWithMeta) => Promise<void>;
  /** Distributes the fresh grant to all listed serverIdentities via
   *  the sibling-WS cert-sync transport (#86). Failure is non-fatal
   *  per-pod — the renewer logs and continues. */
  distribute: (next: GrantWithMeta) => Promise<void>;
  /** Whether a grant was revoked (consults the local revocation
   *  cache from #88). Revoked grants are NOT renewed even if they're
   *  within the window. */
  isRevoked: (grantIdHex: string) => Promise<boolean>;
  /** The user's IRK. The renewer signs every renewal with this. */
  irk: Keypair;
  now?: () => number;
  newGrantId?: () => string;
  renewWindowMs?: number;
  grantTtlMs?: number;
}

export interface RenewalRun {
  considered: number;
  renewed: number;
  skippedExplicit: number;
  skippedRevoked: number;
  skippedFarFromExpiry: number;
  failed: { grantId: string; reason: string }[];
}

/**
 * Walk every known grant; renew those eligible. Returns a per-run
 * summary the operator (or the daemon's log) can read.
 */
export async function runRenewal(deps: RenewerDeps): Promise<RenewalRun> {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.renewWindowMs ?? DEFAULT_RENEW_WINDOW_MS;
  const ttlMs = deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  const result: RenewalRun = {
    considered: 0,
    renewed: 0,
    skippedExplicit: 0,
    skippedRevoked: 0,
    skippedFarFromExpiry: 0,
    failed: [],
  };

  const all = await deps.listGrants();
  for (const cur of all) {
    result.considered++;
    const t = now();
    if (cur.grant.expiresAt - t > windowMs) {
      result.skippedFarFromExpiry++;
      continue;
    }
    if (cur.requiresExplicitRenewal) {
      result.skippedExplicit++;
      continue;
    }
    if (await deps.isRevoked(cur.grant.grantId)) {
      result.skippedRevoked++;
      continue;
    }
    try {
      const next = renewOne(cur, deps.irk, t, ttlMs, deps.newGrantId);
      await deps.saveGrant(next);
      // Distribute is best-effort; we count "renewed" once saved.
      try {
        await deps.distribute(next);
      } catch (e) {
        // Distribution failure isn't a renewal failure — the new
        // grant is saved locally and will be picked up by the next
        // sibling-WS cert-sync exchange.
        result.failed.push({
          grantId: cur.grant.grantId,
          reason: `distribute failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      result.renewed++;
    } catch (e) {
      result.failed.push({
        grantId: cur.grant.grantId,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

/**
 * Produce a fresh GrantWithMeta from an existing one. Content
 * (serviceCanonical, serverIdentities, routes, etc.) is copied verbatim;
 * only grantId + issuedAt + expiresAt change. Caller passes the IRK
 * keypair; we sign with it before returning.
 */
export function renewOne(
  cur: GrantWithMeta,
  irk: Keypair,
  now: number,
  ttlMs: number,
  newId?: () => string,
): GrantWithMeta {
  const next: ServiceGrant = {
    ...cur.grant,
    grantId: (newId ?? defaultUuid)(),
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const signature = signServiceGrant(next, irk);
  // Sanity: verify what we just produced (defends against silent
  // canonicalization bugs).
  if (!verifyServiceGrant(next, signature, irk.publicKey)) {
    throw new Error("renewer: self-verify failed on freshly signed grant");
  }
  return {
    grant: next,
    signature,
    requiresExplicitRenewal: cur.requiresExplicitRenewal,
  };
}

/** Lightweight UUID-v4 generator without pulling in a dep. */
function defaultUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (rare in Node 20+).
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * Returns true if `grant` is within the renewal window — useful for
 * UIs that want to surface "next renewal in N hours" without running
 * the full renewer.
 */
export function isInRenewalWindow(
  grant: ServiceGrant,
  now: number,
  windowMs = DEFAULT_RENEW_WINDOW_MS,
): boolean {
  return grant.expiresAt - now <= windowMs && serviceGrantActiveAt(grant, now);
}

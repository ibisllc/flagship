/**
 * ClaimUrlCapability storage + enforcement.
 *
 * Capabilities are phone-issued, IRK-signed authorizations that a
 * specific app instance (appId) on a specific pod (siblingId) may claim
 * a specific FQDN. They are deposited via PhoneOrder and consumed when
 * an app calls the daemon's `/api/url/claim` endpoint.
 *
 * Three checks every claim must pass — slow down on this code, it is
 * security-load-bearing:
 *
 *   1. The capability's `appId` must equal the appId resolved from the
 *      caller's `Authorization: Bearer <FLAGSHIP_APP_TOKEN>`.
 *   2. The capability's `siblingId` must equal THIS pod's serverId.
 *   3. The capability's `fqdn` must equal the fqdn the call is asking
 *      to claim.
 *
 * If ANY component does not match, the capability is unrelated to this
 * call — refuse. Refusal must NOT expose which component failed (avoid
 * letting a hostile app probe for what other instances exist).
 *
 * Revocation is layered on top: a phone-signed revocation list is
 * fetched from the user's home (.com) on demand, cached for ≤60s. A
 * capability whose canonical-bytes id appears in the cached list is
 * refused regardless of expiry.
 */

import {
  claimUrlCapabilityId,
  verifyClaimUrlCapability,
  verifyClaimUrlCapabilityRevocationList,
  type ClaimUrlCapability,
  type ClaimUrlCapabilityRevocationList,
} from "@flagship/protocol";

export interface StoredCapability {
  capability: ClaimUrlCapability;
  /** Hex-encoded ed25519 signature over the canonical bytes. */
  signatureHex: string;
  /** Stable id — sha256 hex of canonical bytes. */
  id: string;
}

export interface CapabilityStore {
  /** Persist a capability whose signature has already been verified. */
  put(stored: StoredCapability): Promise<void>;
  /** Look up by capability id. */
  byId(id: string): Promise<StoredCapability | null>;
  /** Look up by tuple — the path the claim endpoint takes. */
  byTuple(args: {
    appId: string;
    siblingId: string;
    fqdn: string;
  }): Promise<StoredCapability | null>;
  /** Drop a capability (e.g. because the app was uninstalled). */
  forget(id: string): Promise<void>;
  /** Forget every capability bound to `appId`. Idempotent. */
  forgetByApp(appId: string): Promise<void>;
  /** Snapshot of all stored capabilities — for surfacing to operator UIs. */
  list(): Promise<StoredCapability[]>;
}

export class InMemoryCapabilityStore implements CapabilityStore {
  private byIdMap = new Map<string, StoredCapability>();

  async put(stored: StoredCapability): Promise<void> {
    this.byIdMap.set(stored.id, stored);
  }

  async byId(id: string): Promise<StoredCapability | null> {
    return this.byIdMap.get(id) ?? null;
  }

  async byTuple(args: {
    appId: string;
    siblingId: string;
    fqdn: string;
  }): Promise<StoredCapability | null> {
    const fqdn = args.fqdn.toLowerCase();
    for (const s of this.byIdMap.values()) {
      const c = s.capability;
      if (c.appId === args.appId && c.siblingId === args.siblingId && c.fqdn === fqdn) {
        return s;
      }
    }
    return null;
  }

  async forget(id: string): Promise<void> {
    this.byIdMap.delete(id);
  }

  async forgetByApp(appId: string): Promise<void> {
    for (const [id, s] of this.byIdMap) {
      if (s.capability.appId === appId) this.byIdMap.delete(id);
    }
  }

  async list(): Promise<StoredCapability[]> {
    return [...this.byIdMap.values()];
  }
}

/**
 * Verify + admit a freshly-arrived capability into the store.
 *
 * Caller responsibilities:
 *   - `irkPubLookup` returns the registered IRK pubkey for a username.
 *   - The store owns persistence (this function just orchestrates).
 *
 * Returns the StoredCapability that was admitted, or throws on rejection.
 * The error message is intentionally specific for operator logs but
 * MUST NOT be returned to a remote caller verbatim — leak only "rejected".
 */
export async function admitCapability(args: {
  capability: ClaimUrlCapability;
  signatureHex: string;
  irkPubLookup: (username: string) => Promise<Uint8Array | null>;
  store: CapabilityStore;
  now: () => number;
}): Promise<StoredCapability> {
  const { capability, signatureHex, irkPubLookup, store, now } = args;
  const fqdn = capability.fqdn.toLowerCase();
  if (fqdn !== capability.fqdn) {
    throw new Error("capability fqdn must be lower-cased");
  }
  if (capability.expiresAt <= capability.issuedAt) {
    throw new Error("capability expiresAt must be after issuedAt");
  }
  if (capability.expiresAt <= now()) {
    throw new Error("capability already expired");
  }
  const irkPub = await irkPubLookup(capability.username);
  if (!irkPub) throw new Error("unknown username");
  const sig = hexToBytes(signatureHex);
  if (!verifyClaimUrlCapability(capability, sig, irkPub)) {
    throw new Error("invalid capability signature");
  }
  const id = await claimUrlCapabilityId(capability);
  const stored: StoredCapability = { capability, signatureHex, id };
  await store.put(stored);
  return stored;
}

export interface RevocationCache {
  /** True iff the capability id is in the most-recently-fetched list. */
  has(args: { username: string; capabilityId: string }): Promise<boolean>;
  /** Force a refresh from origin; for tests. */
  refresh(username: string): Promise<void>;
}

export interface RevocationFetcher {
  /** Fetch (and verify) the latest revocation list for `username`. */
  fetch(username: string): Promise<{
    list: ClaimUrlCapabilityRevocationList;
    signatureHex: string;
  } | null>;
}

/**
 * In-memory revocation cache with per-username TTL. Default TTL is 60s
 * (per the security spec). Refresh is best-effort: if the origin fails
 * we serve the previous snapshot rather than failing-open.
 *
 * Lists are accepted only if monotonically newer than the cached one —
 * an attacker who replays an older "empty" list cannot un-revoke caps.
 */
export class TtlRevocationCache implements RevocationCache {
  private cache = new Map<string, { ids: Set<string>; issuedAt: number; fetchedAt: number }>();
  private inflight = new Map<string, Promise<void>>();
  constructor(
    private readonly fetcher: RevocationFetcher,
    private readonly irkPubLookup: (username: string) => Promise<Uint8Array | null>,
    private readonly now: () => number,
    private readonly ttlMs: number = 60_000,
  ) {}

  async has(args: { username: string; capabilityId: string }): Promise<boolean> {
    const cur = this.cache.get(args.username);
    if (!cur || this.now() - cur.fetchedAt > this.ttlMs) {
      await this.refreshOnce(args.username);
    }
    const after = this.cache.get(args.username);
    return !!after && after.ids.has(args.capabilityId);
  }

  async refresh(username: string): Promise<void> {
    await this.refreshOnce(username);
  }

  private async refreshOnce(username: string): Promise<void> {
    const existing = this.inflight.get(username);
    if (existing) return existing;
    const p = (async () => {
      try {
        const fetched = await this.fetcher.fetch(username);
        if (!fetched) {
          // Origin returned nothing — keep prior snapshot if any; on
          // first-ever-no-data, install an empty (non-revoking) one so
          // we don't refresh on every check.
          if (!this.cache.has(username)) {
            this.cache.set(username, { ids: new Set(), issuedAt: 0, fetchedAt: this.now() });
          } else {
            this.cache.get(username)!.fetchedAt = this.now();
          }
          return;
        }
        const irkPub = await this.irkPubLookup(username);
        if (!irkPub) return;
        const sig = hexToBytes(fetched.signatureHex);
        if (!verifyClaimUrlCapabilityRevocationList(fetched.list, sig, irkPub)) {
          return;
        }
        const cur = this.cache.get(username);
        if (cur && fetched.list.issuedAt < cur.issuedAt) {
          // Replayed older list — refuse the regression.
          cur.fetchedAt = this.now();
          return;
        }
        this.cache.set(username, {
          ids: new Set(fetched.list.capabilityIds),
          issuedAt: fetched.list.issuedAt,
          fetchedAt: this.now(),
        });
      } finally {
        this.inflight.delete(username);
      }
    })();
    this.inflight.set(username, p);
    await p;
  }
}

export interface CapabilityCheckRequest {
  /** The appId resolved from the caller's FLAGSHIP_APP_TOKEN bearer. */
  callerAppId: string;
  /** This pod's serverId (passed in once at construction in normal use). */
  thisSiblingId: string;
  /** The fqdn the caller is asking to claim or release. */
  requestedFqdn: string;
}

export type CapabilityCheckResult =
  | { ok: true; stored: StoredCapability }
  | { ok: false };

/**
 * The single allow/deny decision for /api/url/claim and /api/url/release.
 *
 * Adversarial cases this MUST reject (covered by the test suite):
 *   - App A presents a request whose token is bound to app A but the
 *     stored capability is bound to app B → no tuple match → reject.
 *   - Pod X looks up a cap that names sibling Y → no tuple match → reject.
 *   - The cap names fqdn F1 but the request is for F2 → reject.
 *   - The cap is expired → reject (without leaking that one existed).
 *   - The cap id is in the revocation cache → reject.
 *
 * We do NOT differentiate the rejection reasons in the return value.
 * Callers should respond with a uniform 403 to deny probing.
 */
export async function checkCapability(
  req: CapabilityCheckRequest,
  store: CapabilityStore,
  revocations: RevocationCache,
  now: () => number,
): Promise<CapabilityCheckResult> {
  const fqdn = req.requestedFqdn.toLowerCase();
  const stored = await store.byTuple({
    appId: req.callerAppId,
    siblingId: req.thisSiblingId,
    fqdn,
  });
  if (!stored) return { ok: false };
  // Defense-in-depth: re-check tuple match here even though byTuple
  // already filtered. A future store impl that accidentally widens its
  // match wouldn't bypass this.
  if (stored.capability.appId !== req.callerAppId) return { ok: false };
  if (stored.capability.siblingId !== req.thisSiblingId) return { ok: false };
  if (stored.capability.fqdn !== fqdn) return { ok: false };
  if (stored.capability.expiresAt <= now()) return { ok: false };
  const revoked = await revocations.has({
    username: stored.capability.username,
    capabilityId: stored.id,
  });
  if (revoked) return { ok: false };
  return { ok: true, stored };
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(s.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

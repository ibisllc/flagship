/**
 * Slice D — Phase 1 enforcement: the `.com`-side SENSITIVE-op authority gate.
 *
 * ONE shared helper every re-pointed sensitive handler (docs/device-admin-tier-
 * spec.md §2 table, "Com" rows) routes its order-signature check through. It
 * folds together (a) the CLEAN-SLATE TRANSITION GATE and (b) the master-admin
 * predicate (`requireMasterAdmin`, `@flagship/protocol`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The clean-slate transition gate (docs/device-admin-tier-spec.md §7)
 * ─────────────────────────────────────────────────────────────────────────
 *   GATE CLOSED — `userRec.adminRootPubHex` is ABSENT (every PRE-WIPE account,
 *     and any account that hasn't recreated with an admin root yet): fall back
 *     to the EXISTING owner-IRK authorization UNCHANGED. This is a strict no-op
 *     for existing accounts — the same membership-IRK verify that ran before D.
 *     (serviceInvites also dual-accepts the account AID, mirroring its legacy
 *     `verifyAccountSigned`; pass `alsoAcceptAid`.)
 *
 *   GATE OPEN — `userRec.adminRootPubHex` is PRESENT (a fresh clean-slate burn
 *     pinned an admin master root): the sensitive order MUST be signed by the
 *     admin master root, OR by a device holding a valid, non-revoked,
 *     non-expired, ADMIN-ROOT-signed `admin` DeviceCapabilityGrant. The
 *     membership IRK — even though it is the account's registered key — can NO
 *     LONGER authorize a sensitive op (that is the whole authority split).
 *
 * Because the gate keys entirely off the presence of the pinned admin root, D's
 * enforcement is inert until accounts are recreated with one (the wipe +
 * reburn), so landing it breaks no existing account.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * How a handler adopts it (docs/device-admin-tier-spec.md §3.1)
 * ─────────────────────────────────────────────────────────────────────────
 * A handler that did
 *     if (!verifyFooOrder(order, sig, hexToBytes(userRec.irkPubHex))) …deny
 * becomes
 *     const authz = await authorizeSensitiveComOp(deps, {
 *       username, userRec,
 *       verifyWith: (pub) => verifyFooOrder(order, sig, hexToBytes(pub)),
 *     });
 *     if (!authz.ok) …deny
 * The `verifyWith` closure is called with a CANDIDATE authority pubkey (hex) and
 * returns whether the order signature verifies under it — so the order is always
 * verified against the SAME key the gate authorized (never a third key). No
 * sensitive handler passes a raw owner-IRK token to a `verify*` call anymore —
 * that invariant is what `scripts/admin-authority-guard.sh` enforces in CI.
 */
import { requireMasterAdmin, type AdminGrantView, type DeviceScope } from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  DeviceCapabilityGrantRecord,
  UsernameRecord,
} from "@flagship/storage";
import { hexToBytes, bytesToHex } from "./hex.js";

export interface AdminAuthorityGateDeps {
  /**
   * OPTIONAL account device-grant store. When present, a delegated device
   * holding an ADMIN-ROOT-signed `admin` DeviceCapabilityGrant can satisfy the
   * open gate (least-privilege promotion, §4.2). When absent, only the BARE
   * admin master root satisfies the open gate — enough for the first-device-is-
   * admin common case and for tests. Wire `storage.deviceCapabilityGrants` in
   * production.
   */
  grants?: DeviceCapabilityGrantStorage;
  now?: () => number;
}

export type SensitiveAuthorization =
  | { ok: true; gated: boolean; signerPubHex: string }
  | { ok: false; reason: string };

/** Same known-DeviceScope narrowing the grant handlers use. */
function parseScopes(raw: unknown): DeviceScope[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DeviceScope[] = [];
  for (const s of raw) {
    if (typeof s !== "string") return null;
    out.push(s as DeviceScope);
  }
  return out;
}

/** Adapt one stored grant row into the runtime-agnostic {@link AdminGrantView}. */
function rowToView(rec: DeviceCapabilityGrantRecord): AdminGrantView | null {
  let scopes: DeviceScope[] | null;
  let devicePub: Uint8Array;
  try {
    scopes = parseScopes(JSON.parse(rec.scopesJson));
    devicePub = hexToBytes(rec.devicePubHex);
  } catch {
    return null;
  }
  if (!scopes) return null;
  return {
    grant: {
      grantId: rec.grantId,
      username: rec.username,
      deviceLabel: rec.deviceLabel,
      devicePubKey: devicePub,
      scopes,
      issuedAt: rec.issuedAt,
      expiresAt: rec.expiresAt,
    },
    signatureHex: rec.signatureHex,
    signerRoot: rec.signerRoot ?? "membership",
    revokedAt: rec.revokedAt,
  };
}

async function activeAdminGrantViews(
  grants: DeviceCapabilityGrantStorage | undefined,
  username: string,
): Promise<AdminGrantView[]> {
  if (!grants) return [];
  const rows = await grants.listForUser(username);
  const out: AdminGrantView[] = [];
  for (const r of rows) {
    if (r.revokedAt != null) continue;
    const v = rowToView(r);
    if (v) out.push(v);
  }
  return out;
}

function safeVerify(verifyWith: (pub: string) => boolean, candidatePubHex: string): boolean {
  try {
    return verifyWith(candidatePubHex.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Authorize a `.com` SENSITIVE op under the clean-slate transition gate.
 *
 * @param verifyWith  returns true iff the order signature verifies under the
 *                    given candidate authority pubkey (hex). Called with the
 *                    admin root / a granted device pub (gate open) or the
 *                    account IRK/AID (gate closed).
 * @param alsoAcceptAid  gate-CLOSED only — additionally accept the account's
 *                    stable AID (serviceInvites dual-accept). Ignored gate-open.
 *
 * Returns `{ ok, gated }` — `gated:true` means the OPEN admin-root path
 * authorized (an admin device signed); `gated:false` means the legacy owner-IRK
 * path did. Callers that don't care can just check `ok`.
 */
export async function authorizeSensitiveComOp(
  deps: AdminAuthorityGateDeps,
  args: {
    username: string;
    userRec: UsernameRecord;
    verifyWith: (candidatePubHex: string) => boolean;
    alsoAcceptAid?: boolean;
    now?: number;
  },
): Promise<SensitiveAuthorization> {
  const { username, userRec, verifyWith } = args;
  const now = args.now ?? (deps.now ?? (() => Date.now()))();

  // ── GATE CLOSED — no admin master root pinned ⇒ legacy owner-IRK auth. This
  //    is byte-for-byte the pre-D behavior for every existing account.
  if (!userRec.adminRootPubHex) {
    if (args.alsoAcceptAid && userRec.aidPubHex && safeVerify(verifyWith, userRec.aidPubHex)) {
      return { ok: true, gated: false, signerPubHex: userRec.aidPubHex.toLowerCase() };
    }
    if (safeVerify(verifyWith, userRec.irkPubHex)) {
      return { ok: true, gated: false, signerPubHex: userRec.irkPubHex.toLowerCase() };
    }
    return { ok: false, reason: "invalid signature" };
  }

  // ── GATE OPEN — an admin master root is pinned. Only the admin root (or an
  //    admin-root-signed `admin` grant) may authorize; the membership IRK cannot.
  const adminRoot = userRec.adminRootPubHex.toLowerCase();

  // 1. The bare admin master root signs directly.
  if (safeVerify(verifyWith, adminRoot)) {
    return { ok: true, gated: true, signerPubHex: adminRoot };
  }

  // 2. A device holding a valid admin-root-signed `admin` grant. We find the
  //    grant whose device pubkey the order signature verifies under, then let
  //    `requireMasterAdmin` re-check the grant (admin-root-signed, non-expired,
  //    non-revoked, verifies under the admin root, carries the `admin` scope).
  const views = await activeAdminGrantViews(deps.grants, username);
  for (const v of views) {
    const devHex = bytesToHex(v.grant.devicePubKey).toLowerCase();
    if (!safeVerify(verifyWith, devHex)) continue;
    const decision = requireMasterAdmin(devHex, username, adminRoot, views, now);
    if (decision.ok) return { ok: true, gated: true, signerPubHex: devHex };
  }

  return { ok: false, reason: "sensitive op requires master-admin authority" };
}

// Account-deletion ceremony — the no-recovery, last-device account-DEATH path.
//
// Removing the last device of an account that has NO cloud recovery is not a
// routine Tier-2/3 action: the wrapped UMK is the only copy of the identity,
// so wiping it ENDS the account. The native apps turn that into a deliberate,
// twice-confirmed deletion (docs/account-deletion-and-name-reclaim.md §2); this
// is the webapp mirror.
//
// The escalation is decided by {@link accountDeletePolicy}: with cloud recovery
// or another active device the key survives elsewhere, so it stays a normal
// Tier-2/3 removal. Only the no-recovery + last-device case runs the ceremony.
// `.com` independently re-enforces last-device (zero active device grants), so
// the client gate is UX — the server is the authority.
//
// The ceremony signs an owner-IRK `account-self-delete` order, optionally
// bundled with an opt-in `servers-self-delete` order ("ask all my servers to
// delete their content", default OFF). The two are submitted as ONE atomic
// bundle to POST <controlApex>/api/account/self-delete; `.com` rejects the
// whole bundle unless the account-self-delete is present + valid + last-device
// (the §5 invariant). On a 200 the caller wipes local key material and drops to
// Welcome — never before.
//
// Canonical bytes are byte-identical to @flagship/protocol's
// signAccountSelfDelete / signServersSelfDelete (pinned by
// packages/protocol/tests/accountDeletionVectors.test.ts) and the Swift/Kotlin
// AccountDeletionOrders mirrors:
//
//   flagship/account-self-delete/v1|<username-lowercased>|<issuedAt>
//   flagship/servers-self-delete/v1|<username-lowercased>|<issuedAt>

import { controlApex } from "./apex.js";

/** Canonical-bytes tags — MUST match @flagship/protocol
 *  TAG_ACCOUNT_SELF_DELETE / TAG_SERVERS_SELF_DELETE. */
export const TAG_ACCOUNT_SELF_DELETE = "flagship/account-self-delete/v1";
export const TAG_SERVERS_SELF_DELETE = "flagship/servers-self-delete/v1";

const APEX = controlApex();

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Compose the account-self-delete canonical bytes. The username is lowercased
 *  to match the TS `.toLowerCase()` in canonicalAccountSelfDelete. */
export function canonicalAccountSelfDeleteBytes(username, issuedAt) {
  return new TextEncoder().encode(
    [TAG_ACCOUNT_SELF_DELETE, String(username).toLowerCase(), issuedAt].join("|"),
  );
}

/** Compose the servers-self-delete canonical bytes. */
export function canonicalServersSelfDeleteBytes(username, issuedAt) {
  return new TextEncoder().encode(
    [TAG_SERVERS_SELF_DELETE, String(username).toLowerCase(), issuedAt].join("|"),
  );
}

/**
 * Decide which removal path the last-device gate must run. Mirrors the iOS/
 * Android trigger (docs §2): account DEATH only when there's NO cloud recovery
 * AND this is the last device; otherwise the key survives elsewhere → a normal
 * Tier-2/3 removal. Demo sandboxes have no real key to lose → exempt.
 *
 * @param {object} args
 * @param {boolean} args.hasCloudRecovery
 * @param {boolean} [args.isDemoAccount]
 * @returns {"ceremony" | "normal" | "exempt"}
 */
export function accountDeletePolicy({
  hasCloudRecovery,
  isDemoAccount = false,
}) {
  if (isDemoAccount) return "exempt";
  if (hasCloudRecovery) return "normal";
  return "ceremony";
}

function makeError(message, status) {
  const e = new Error(message);
  if (status != null) e.status = status;
  return e;
}

/**
 * Sign the deletion bundle with the owner IRK and POST it to
 * /api/account/self-delete. The account-self-delete order is ALWAYS sent; the
 * servers-self-delete order is included ONLY when `includeServers` is true (the
 * opt-in content-wipe). Both orders carry the SAME username + issuedAt so the
 * server can enforce the atomic-bundle invariant.
 *
 * Resolves `{ ok: true, body }` on a 200. Throws an Error with `.status` on any
 * non-2xx (so the caller can route it through the humanized-error path — e.g.
 * 403 "not the last device").
 *
 * @param {object} args
 * @param {string} args.username
 * @param {boolean} [args.includeServers]   include the servers-self-delete order
 * @param {Uint8Array} args.umk             session UMK (for IRK signing)
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {(b: Uint8Array) => string} [deps.bytesToHex]
 * @param {string} [deps.origin]
 * @param {() => number} [deps.now]
 * @returns {Promise<{ ok: true, body: any }>}
 */
export async function submitAccountSelfDelete(args, deps = {}) {
  const { username, includeServers = false, umk, signWithIrk } = args;
  if (!username) throw makeError("username required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw makeError("unlock the webapp first", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || APEX;
  const issuedAt = (deps.now || Date.now)();
  const lowered = String(username).toLowerCase();

  const acctSig = await signWithIrk(
    umk,
    canonicalAccountSelfDeleteBytes(lowered, issuedAt),
  );
  const body = {
    accountSelfDelete: {
      request: { username: lowered, issuedAt },
      signature: toHex(acctSig),
    },
  };
  if (includeServers) {
    const serversSig = await signWithIrk(
      umk,
      canonicalServersSelfDeleteBytes(lowered, issuedAt),
    );
    body.serversSelfDelete = {
      request: { username: lowered, issuedAt },
      signature: toHex(serversSig),
    };
  }

  let resp;
  try {
    resp = await f(`${origin}/api/account/self-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  if (resp.status === 200) {
    return { ok: true, body: await resp.json().catch(() => ({})) };
  }
  const text = await resp.text().catch(() => "");
  throw makeError(text || `account self-delete failed (${resp.status})`, resp.status);
}

/**
 * Run the full ceremony AFTER the user has cleared the typed-username + confirm
 * gate: submit the bundle, and ONLY on a 200 wipe local key material + drop to
 * Welcome. A failure (e.g. 403 "not the last device") leaves the device intact
 * so the error can be surfaced and the user isn't stranded.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {boolean} [args.includeServers]
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {() => Promise<void>} args.resetDevice   keystore.resetDevice — wipe local key
 * @param {() => void} args.lockSession
 * @param {(viewId: string) => void} args.show
 * @param {(slot: string) => void} [args.profileRemove]
 * @param {() => void} [args.stopRenewals]
 * @param {(text: string) => void} [args.setSubtitle]
 * @param {string} [args.welcomeViewId]   landing view after deletion (default "view-bootstrap")
 * @param {object} [deps]                  forwarded to {@link submitAccountSelfDelete}
 * @returns {Promise<{ ok: true, body: any }>}
 */
export async function runDeletionCeremony(args, deps = {}) {
  const {
    username,
    includeServers = false,
    umk,
    signWithIrk,
    resetDevice,
    lockSession,
    show,
    profileRemove,
    stopRenewals,
    setSubtitle,
    welcomeViewId = "view-bootstrap",
  } = args;

  // 1 — the irreversible network step. Throws on any non-200; nothing local
  //     is touched before this succeeds.
  const result = await submitAccountSelfDelete(
    { username, includeServers, umk, signWithIrk },
    deps,
  );

  // 2 — only NOW wipe local key material + drop to Welcome.
  stopRenewals?.();
  await resetDevice();
  if (profileRemove) {
    for (const slot of ["sessionId", "sessionToken", "podBaseUrl", "username"]) {
      profileRemove(slot);
    }
  }
  lockSession();
  setSubtitle?.("account deleted");
  show(welcomeViewId);
  return result;
}

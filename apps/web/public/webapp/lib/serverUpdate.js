// "Update this server" — webapp client of the phone-ordered, dual-signed
// in-place server update (docs/server-update-mechanism.md).
//
// This is the AUTHORIZATION half of the 2-of-2 gate: an admin device signs a
// `flagship/server-update/v1` UpdateOrder naming THIS box + the target commit,
// and deposits it on `.com`'s update lane. The AUTHENTICITY half (the target
// commit is maintainer-ENDORSED) is enforced box-side by the daemon's
// ReleaseGate — there is no maintainer envelope here, and neither half alone
// can push code.
//
// TWO KEYS in the deposit body (mirrors set-leader, NOT the sealed lanes):
//   - the ORDER signature routes through the tag-gated sensitive signer
//     (`flagship/server-update/v1` ∈ SENSITIVE_TAGS) — the admin master root
//     when the account has one, legacy owner IRK otherwise;
//   - the co-signed mailbox AUTH (`device-endpoint-claim`) stays the
//     membership IRK the deposit lane requires (the same gated signer
//     tag-routes it to the legacy key).
//
// Canonical bytes are built byte-identical to @flagship/protocol's
// `canonicalUpdateOrder`:
//   flagship/server-update/v1|serverDomain|targetCommit|fromCommit|nonce|issuedAt

import { controlApex } from "./apex.js";

// ---- Canonical-bytes tag — MUST match @flagship/protocol ----
export const TAG_SERVER_UPDATE = "flagship/server-update/v1";

/** A full lowercase git commit SHA — the only targetCommit form this phase
 *  accepts from the UI (the maintainer-endorsement check is box-side). */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function err(message, status) {
  const e = new Error(message);
  if (status != null) e.status = status;
  return e;
}

function randHex(n, getRandom) {
  const b = new Uint8Array(n);
  (getRandom || ((x) => crypto.getRandomValues(x)))(b);
  return defaultBytesToHex(b);
}

/** Mirror of @flagship/protocol legacyFieldGuard — reject '|' + control chars
 *  in every string field so the canonical bytes can never be ambiguous. */
function fieldGuard(name, value) {
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) {
      throw err(`field "${name}" contains a reserved canonical-bytes char`, 400);
    }
  }
  return s;
}

/**
 * UpdateOrder canonical bytes, byte-identical to @flagship/protocol
 * `canonicalUpdateOrder`. All fields verbatim (no case-folding — commits are
 * matched exactly by the box); issuedAt stringified by join.
 *
 * @param {{ serverDomain: string, targetCommit: string, fromCommit: string,
 *           nonce: string, issuedAt: number }} order
 */
export function canonicalUpdateOrderBytes(order) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_UPDATE,
      fieldGuard("serverDomain", order.serverDomain),
      fieldGuard("targetCommit", order.targetCommit),
      fieldGuard("fromCommit", order.fromCommit),
      fieldGuard("nonce", order.nonce),
      String(order.issuedAt),
    ].join("|"),
  );
}

/** DeviceEndpointClaim mailbox-auth canonical bytes (username verbatim —
 *  matches @flagship/protocol canonicalDeviceEndpointClaim). */
function canonicalMailboxAuthBytes({ username, endpointLabel, phoneIrkPubHex, issuedAt, expiresAt, nonceHex }) {
  return new TextEncoder().encode(
    [
      "flagship/device-endpoint-claim/v1",
      username,
      endpointLabel,
      String(phoneIrkPubHex).toLowerCase(),
      issuedAt,
      expiresAt,
      String(nonceHex).toLowerCase(),
    ].join("|"),
  );
}

/**
 * Build, sign and deposit the admin-authorized UpdateOrder on `.com`'s update
 * lane (POST /api/server/:domain/update). The box claims it on its heartbeat,
 * re-verifies it under the pinned admin authority AND separately confirms the
 * target commit is maintainer-endorsed before applying — a deposit alone never
 * updates anything.
 *
 * issuedAt is minted HERE at send time — `.com` enforces freshness on both the
 * auth wrapper and the order.
 *
 * @param {object} args
 * @param {string} args.serverDomain   the box FQDN this order names
 * @param {string} args.targetCommit   the blessed commit to move to (40-hex)
 * @param {string} args.fromCommit     the box-reported CURRENT commit (40-hex)
 * @param {string} args.username       the owner account name
 * @param {Uint8Array} args.umk        session UMK (for signing)
 * @param {string} args.irkPubHex      the owner's membership IRK pubkey, hex
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 *   the tag-gated sensitive signer (sensitiveSigner()) — routes the order to
 *   the admin root when present, keeps the mailbox auth on the IRK
 * @param {{ fetch?: typeof fetch, comBase?: string, now?: () => number,
 *           getRandomValues?: Function, bytesToHex?: Function }} [deps]
 * @returns {Promise<{ ok: true, order: object, expiresAt?: number }>}
 */
export async function depositUpdateOrder(args, deps = {}) {
  const { serverDomain, targetCommit, fromCommit, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!username) throw err("username required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!irkPubHex) throw err("irkPubHex required", 400);
  if (!COMMIT_SHA_RE.test(String(targetCommit))) {
    throw err("targetCommit must be a full lowercase 40-hex commit", 400);
  }
  if (!COMMIT_SHA_RE.test(String(fromCommit))) {
    throw err("this server hasn't reported its current version yet", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const comBase = deps.comBase || controlApex();
  const now = (deps.now || Date.now)();

  const order = {
    serverDomain: String(serverDomain),
    targetCommit: String(targetCommit),
    fromCommit: String(fromCommit),
    nonce: randHex(32, deps.getRandomValues),
    issuedAt: now,
  };
  const orderSig = await signWithIrk(umk, canonicalUpdateOrderBytes(order));

  // IRK mailbox-auth — same shape as the set-leader / transfer deposits. The
  // gated signer tag-routes device-endpoint-claim to the membership IRK.
  const authNonceHex = randHex(32, deps.getRandomValues);
  const auth = {
    username,
    endpointLabel: "webapp",
    phoneIrkPub: String(irkPubHex).toLowerCase(),
    issuedAt: now,
    expiresAt: now + 120_000,
    nonce: authNonceHex,
  };
  const authSig = await signWithIrk(
    umk,
    canonicalMailboxAuthBytes({
      username,
      endpointLabel: auth.endpointLabel,
      phoneIrkPubHex: auth.phoneIrkPub,
      issuedAt: now,
      expiresAt: auth.expiresAt,
      nonceHex: authNonceHex,
    }),
  );

  const body = {
    auth,
    authSignature: toHex(authSig),
    deposit: {
      serverDomain: order.serverDomain,
      requestNonceHex: randHex(32, deps.getRandomValues),
    },
    order,
    signature: toHex(orderSig),
  };
  let resp;
  try {
    resp = await f(`${comBase}/api/server/${encodeURIComponent(order.serverDomain)}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((out && out.error) || `HTTP ${resp.status}`, resp.status);
  return { ok: true, order, expiresAt: out.expiresAt };
}

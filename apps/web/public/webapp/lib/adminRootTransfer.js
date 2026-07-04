// Slice D §9.8 — transfer-a-box ADMIN AUTHORITY hand-off (giver side).
//
// A transferred box is re-homed to the ACQUIRER's account, so its pinned
// admin-authority anchor must move too — otherwise the box keeps trusting the
// GIVER's admin root over hardware the giver no longer owns. Mirroring the §5
// rotation proof (`.com` is never the trust anchor), the giver's admin master
// root signs an AdminRootTransfer{ old→new } the box verifies against its
// PINNED old root before re-pinning:
//
//   old = the giver's admin root pub (must equal the box's pinned anchor)
//   new = the acquirer's admin root pub from the v2 claim, or "" when the
//         acquirer account has none — "" means UNPIN (legacy anchorless
//         behaviour), never "keep the giver's key".
//
// Runs at claim-received on the giver device (the same point as the disk-key
// re-seal): ownership has ALREADY moved by then, so a failed deposit is a
// retryable warning, never a transfer failure — a box with a pinned admin key
// waits for this hand-off before re-homing.
//
// Canonical bytes mirror the TS spine byte-for-byte
// (packages/protocol adminRootTransfer):
//   flagship/admin-root-transfer/v1 | serverDomain lc | giverUsername lc |
//   acquirerUsername lc | hex(old) lc | hex(new) lc or "" | transferNonce lc |
//   issuedAt
// `|`-separated UTF-8, string fields guarded exactly like
// canonicalBase.legacyFieldGuard (reject '|' + control chars).

import {
  loadAdminRootSeed as ksLoadAdminRootSeed,
  adminRootPubHex as ksAdminRootPubHex,
  signWithAdminRoot as ksSignWithAdminRoot,
  bytesToHex as ksBytesToHex,
} from "../keystore.js";
import { controlApex } from "./apex.js";

/** Canonical-bytes tag — MUST match the TS spine. */
export const TAG_ADMIN_ROOT_TRANSFER = "flagship/admin-root-transfer/v1";

/** Replicates packages/protocol/src/canonicalBase.ts `legacyFieldGuard`. */
function guardField(name, value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) {
      throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    }
    if (c <= 0x1f || c === 0x7f) {
      throw new Error(`canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`);
    }
  }
}

function pubHex64(name, hex) {
  const v = String(hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) {
    throw new Error(`admin-root transfer: ${name} must be 32-byte hex`);
  }
  return v;
}

function loweredField(name, value) {
  const v = String(value ?? "").toLowerCase();
  if (!v) throw new Error(`admin-root transfer: ${name} required`);
  guardField(name, v);
  return v;
}

/**
 * The hand-off canonical bytes, byte-identical to the TS spine.
 *
 * @param {{ serverDomain: string, giverUsername: string, acquirerUsername: string,
 *           oldAdminRootPub: string, newAdminRootPub: string, transferNonce: string,
 *           issuedAt: number }} t
 *   `serverDomain` is the box's OLD canonical (the transferred server's current
 *   domain); `newAdminRootPub` may be "" (unpin).
 * @returns {Uint8Array}
 */
export function adminRootTransferCanonicalBytes(t) {
  const newPub = String(t.newAdminRootPub ?? "");
  return new TextEncoder().encode(
    [
      TAG_ADMIN_ROOT_TRANSFER,
      loweredField("serverDomain", t.serverDomain),
      loweredField("giverUsername", t.giverUsername),
      loweredField("acquirerUsername", t.acquirerUsername),
      pubHex64("oldAdminRootPub", t.oldAdminRootPub),
      newPub === "" ? "" : pubHex64("newAdminRootPub", newPub),
      loweredField("transferNonce", t.transferNonce),
      t.issuedAt,
    ].join("|"),
  );
}

/**
 * GIVER at claim-received: build + sign the AdminRootTransfer with this
 * device's admin master root and deposit it to the broker. All side-effecting
 * collaborators are injectable (the runRotateAdminRoot pattern).
 *
 * Outcomes (never throws past argument validation):
 *   - `{ status: "skipped" }`    — the session holds no admin root: nothing to
 *     hand off, the box has no giver-pinned anchor to move. Silent.
 *   - `{ status: "deposited", handoff, signatureHex }` — proof accepted.
 *   - `{ status: "failed", error }` — the deposit didn't land. Ownership has
 *     already moved, so the caller surfaces a retryable warning (a box with a
 *     pinned admin key will wait for this hand-off before re-homing) WITHOUT
 *     failing the transfer — same semantics as a failed disk-key re-seal.
 *
 * @param {{
 *   serverDomain: string,            // the box's OLD canonical domain
 *   giverUsername: string,
 *   acquirerUsername: string,
 *   acquirerAdminRootPub?: string|null,  // from the claim; ""/null → unpin
 *   transferNonce: string,
 *   umkSeed?: Uint8Array,            // to load the stored admin root seed
 *   adminRootSeed?: Uint8Array|null, // session-held seed (skips the load)
 * }} args
 * @param {{
 *   loadAdminRootSeed?, adminRootPubHex?, signWithAdminRoot?, bytesToHex?,
 *   fetch?, origin?, now?
 * }} [deps]
 */
export async function runGiverAdminHandoff(args, deps = {}) {
  const { serverDomain, giverUsername, acquirerUsername, transferNonce } = args;
  if (!serverDomain || !giverUsername || !acquirerUsername || !transferNonce) {
    throw new Error("admin-root transfer: serverDomain, usernames + transferNonce required");
  }
  const loadSeed = deps.loadAdminRootSeed || ksLoadAdminRootSeed;
  const pubHex = deps.adminRootPubHex || ksAdminRootPubHex;
  const signAdmin = deps.signWithAdminRoot || ksSignWithAdminRoot;
  const toHex = deps.bytesToHex || ksBytesToHex;
  const now = deps.now ?? (() => Date.now());
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();

  const seed = args.adminRootSeed instanceof Uint8Array
    ? args.adminRootSeed
    : args.umkSeed instanceof Uint8Array
      ? await loadSeed(args.umkSeed)
      : null;
  if (!(seed instanceof Uint8Array) || seed.length !== 32) return { status: "skipped" };

  const handoff = {
    serverDomain,
    giverUsername,
    acquirerUsername,
    oldAdminRootPub: pubHex64("oldAdminRootPub", await pubHex(seed)),
    newAdminRootPub: args.acquirerAdminRootPub
      ? pubHex64("newAdminRootPub", args.acquirerAdminRootPub)
      : "",
    transferNonce,
    issuedAt: now(),
  };
  const sig = await signAdmin(seed, adminRootTransferCanonicalBytes(handoff));
  const signatureHex = toHex(sig);

  try {
    const resp = await f(
      `${origin}/api/server/${encodeURIComponent(serverDomain)}/transfer/admin-handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoff, signatureHex }),
      },
    );
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return { status: "failed", error: (body && body.error) || `HTTP ${resp.status}` };
    }
  } catch (e) {
    return { status: "failed", error: (e && e.message) || String(e) };
  }
  return { status: "deposited", handoff, signatureHex };
}

/**
 * GIVER claim-watch: poll until the acquirer claims, then run the admin-root
 * hand-off, retrying a failed deposit on the poll cadence while `isActive()`
 * (e.g. the transfer dialog stays open). DOM-free; the view supplies bound
 * `poll`/`handoff` closures + an `onStatus` renderer.
 *
 * @param {{
 *   poll: () => Promise<{ claimed: boolean, acquirerUsername?: string, acquirerAdminRootPub?: string|null }>,
 *   handoff: (claim: object) => Promise<{ status: string }>,
 *   onStatus?: (result: object, claim: object) => void,
 *   isActive?: () => boolean,
 *   intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {Promise<{ status: "deposited"|"skipped"|"failed"|"inactive" }>}
 */
export async function watchClaimThenHandoff(deps) {
  const { poll, handoff, onStatus = () => {}, isActive = () => true } = deps;
  const intervalMs = deps.intervalMs ?? 5000;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let claim = null;
  while (!claim) {
    if (!isActive()) return { status: "inactive" };
    try {
      const res = await poll();
      if (res && res.claimed) claim = res;
    } catch {
      // transient poll error — keep polling
    }
    if (!claim) await sleep(intervalMs);
  }

  for (;;) {
    const out = await handoff(claim);
    onStatus(out, claim);
    if (out.status !== "failed") return out;
    if (!isActive()) return out;
    await sleep(intervalMs);
  }
}

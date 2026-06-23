// "Replace this server" — webapp client for the graceful-decommission flow
// (docs/server-replacement-graceful-decommission.md §11.4 / §12 clients).
//
// Replacing a server first RETIRES the box that currently holds the FQDN: the
// owner mints + IRK-signs a `ServerDecommission` order for THAT box's STK,
// deposits it on `.com` (the box picks it up on its outbound heartbeat poll and
// flushes a final backup → releases routing → applies the disk disposition), and
// then locally retires the instance (L3) so the phone never again surfaces or
// approves that box's unlock. The replacement is a NEW box (a fresh STK), minted
// through the normal create-server flow; it fetches its eviction chain from `.com`
// on boot and claims the route once the incumbent has released it.
//
// Three hard rules drive the UX:
//   - PRE-FLIGHT GATE (§11.4): a box with NO backup enrolled MUST be hard-blocked
//     before a wipe disposition — replacing it loses its data. Not a toast.
//   - DISPOSITION (§6a): keep · wipe-after-handoff (recommended) · wipe-now (the
//     irreversible one). Maps to the order's `diskDisposition`.
//   - INSTANCE-BOUND (I2): the order names the retiring box's CURRENT STK pubkey,
//     so a replayed order is inert on the replacement (a different STK).
//
// Canonical bytes are built byte-identical to @flagship/protocol's
// `signServerDecommission` (pinned by
// packages/protocol/tests/serverDecommissionVectors.test.ts):
//
//   flagship/server-decommission/v1|<pod lc>|<retiredStk lc>|<finalBackup "1"/"0">
//     |<disposition>|<backupEpoch>|<nonce lc>|<issuedAt>
//
// and the deposit rides the SAME owner IRK mailbox-auth envelope the self-delete /
// pairing / transfer deposits use (a signed DeviceEndpointClaim).

import { controlApex } from "./apex.js";
import {
  get as profileGet,
  set as profileSet,
} from "./profilesStore.js";

// ---- Canonical-bytes tags — MUST match @flagship/protocol ----
export const TAG_SERVER_DECOMMISSION = "flagship/server-decommission/v1";
export const TAG_DEVICE_ENDPOINT_CLAIM = "flagship/device-endpoint-claim/v1";

/** Disk dispositions, in the order the picker offers them. The middle one is the
 *  recommended default (final-flush, keep the disk as a fallback until the
 *  replacement is proven, then wipe). MUST match @flagship/protocol DiskDisposition. */
export const DISK_DISPOSITIONS = ["keep", "wipe-after-handoff", "wipe-now"];
export const DEFAULT_DISPOSITION = "wipe-after-handoff";

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

/**
 * ServerDecommission canonical bytes (owner IRK). podCanonical, retiredStkPubHex
 * and nonce are lowercased; finalBackup encodes as "1"/"0" — byte-identical to
 * @flagship/protocol's `canonicalServerDecommission`.
 *
 * @param {object} o
 * @param {string} o.podCanonical
 * @param {string} o.retiredStkPubHex
 * @param {boolean} o.finalBackup
 * @param {"keep"|"wipe-after-handoff"|"wipe-now"} o.diskDisposition
 * @param {number} o.backupEpoch
 * @param {string} o.nonce
 * @param {number} o.issuedAt
 */
export function canonicalDecommissionBytes(o) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_DECOMMISSION,
      String(o.podCanonical).toLowerCase(),
      String(o.retiredStkPubHex).toLowerCase(),
      o.finalBackup ? "1" : "0",
      o.diskDisposition,
      o.backupEpoch,
      String(o.nonce).toLowerCase(),
      o.issuedAt,
    ].join("|"),
  );
}

/** DeviceEndpointClaim mailbox-auth canonical bytes (username verbatim — matches
 *  @flagship/protocol's canonicalDeviceEndpointClaim). */
function canonicalMailboxAuthBytes({
  username,
  endpointLabel,
  phoneIrkPubHex,
  issuedAt,
  expiresAt,
  nonceHex,
}) {
  return new TextEncoder().encode(
    [
      TAG_DEVICE_ENDPOINT_CLAIM,
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
 * Build the owner IRK mailbox-auth credential (signed DeviceEndpointClaim) the
 * deposit lanes expect. Returns the wire object `{ auth, authSignature }`.
 */
async function buildMailboxAuth(args, deps) {
  const { username, umk, signWithIrk, irkPubHex } = args;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const now = (deps.now || Date.now)();
  const nonceHex = randHex(32, deps.getRandomValues);
  const auth = {
    username,
    endpointLabel: deps.endpointLabel || "webapp",
    phoneIrkPub: irkPubHex,
    issuedAt: now,
    expiresAt: now + 120_000,
    nonce: nonceHex,
  };
  const sig = await signWithIrk(
    umk,
    canonicalMailboxAuthBytes({
      username,
      endpointLabel: auth.endpointLabel,
      phoneIrkPubHex: irkPubHex,
      issuedAt: now,
      expiresAt: auth.expiresAt,
      nonceHex,
    }),
  );
  return { auth, authSignature: toHex(sig) };
}

/**
 * Resolve whether peer-backup is enrolled for this box, plus the box's current
 * STK pubkey hex (the `retiredStkPubHex` the order binds to) — both read off the
 * unauthenticated `/api/users/:u/pods` directory (the pod row carries
 * `identityPubKey` = the box's registered STK).
 *
 * BACKUP-ENROLLMENT SIGNAL — KNOWN GAP. `/pods` does not yet expose a
 * peer-backup-enrolled flag (the box's enrollment state lives behind the
 * peer-backup matchmaker, not the directory). The closest device-local signal is
 * the per-profile `peerBackupChoice` slot the create-server flow records. We read
 * it conservatively: enrolled ONLY if the recorded choice is an explicit "enabled"
 * value; ANY other value (incl. unknown / unreadable) is treated as NOT enrolled,
 * so the pre-flight gate fails CLOSED — it would rather block a wipe than risk
 * silent data loss. TODO: surface a real per-pod `backupEnrolled` on `/pods` (or a
 * box-side signal) and key the gate off that instead of the create-time choice.
 *
 * @returns {Promise<{ retiredStkPubHex: string|null, backupEnrolled: boolean }>}
 */
export async function resolveReplacementContext(args, deps = {}) {
  const { serverDomain, username } = args;
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();

  let retiredStkPubHex = null;
  try {
    const r = await f(`${origin}/api/users/${encodeURIComponent(username)}/pods`);
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      const pod = (body.pods ?? []).find(
        (p) =>
          String(p.serverDomain ?? "").toLowerCase() ===
          String(serverDomain).toLowerCase(),
      );
      const stk = pod?.identityPubKey;
      if (typeof stk === "string" && /^[0-9a-f]{64}$/i.test(stk)) {
        retiredStkPubHex = stk.toLowerCase();
      }
    }
  } catch {
    /* offline / cors — leave STK null; the caller blocks without it */
  }

  const backupEnrolled = isBackupEnrolled(
    deps.peerBackupChoice ?? readPeerBackupChoice(deps),
  );

  return { retiredStkPubHex, backupEnrolled };
}

/** The per-profile create-time peer-backup choice, if recorded. */
function readPeerBackupChoice(deps) {
  const getter = deps.profileGet || profileGet;
  try {
    return getter("peerBackupChoice");
  } catch {
    return null;
  }
}

/** Fail-closed: enrolled ONLY for an explicit enabled value. */
export function isBackupEnrolled(choice) {
  if (choice === true) return true;
  const s = String(choice ?? "").toLowerCase();
  return s === "enabled" || s === "on" || s === "peer" || s === "true";
}

/**
 * The pre-flight gate (§11.4 / pitfall 4). A wipe disposition on a box with NO
 * backup enrolled is a HARD block — replacing it loses the data. `keep` never
 * loses data (the disk survives), so it is always allowed.
 *
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function preflightGate({ disposition, backupEnrolled }) {
  const wipes = disposition === "wipe-after-handoff" || disposition === "wipe-now";
  if (wipes && !backupEnrolled) {
    return {
      blocked: true,
      reason:
        "This server has no backup — replacing it will lose its data. Set up backup first, or choose 'wipe-now' only if you accept data loss.",
    };
  }
  return { blocked: false };
}

/**
 * Build the ServerDecommission order from the chosen disposition. `finalBackup` is
 * true whenever the disposition isn't `keep` OR a backup is enrolled (so an
 * enrolled box always gets a final flush). `backupEpoch` is a fresh monotonic
 * epoch (Date.now) when we're flushing, else 0.
 */
export function buildDecommissionOrder({
  serverDomain,
  retiredStkPubHex,
  disposition,
  backupEnrolled,
  now,
  getRandomValues,
}) {
  const issuedAt = (now || Date.now)();
  const finalBackup = disposition !== "keep" || !!backupEnrolled;
  return {
    podCanonical: serverDomain,
    retiredStkPubHex,
    finalBackup,
    diskDisposition: disposition,
    backupEpoch: finalBackup ? issuedAt : 0,
    nonce: randHex(32, getRandomValues),
    issuedAt,
  };
}

/**
 * Mint + IRK-sign the ServerDecommission order and deposit it on `.com`. Resolves
 * `{ ok: true, order, body }` on a 200; throws with `.status` on a non-2xx.
 *
 * @param {object} args
 * @param {string} args.serverDomain     the FQDN being replaced (== podCanonical)
 * @param {string} args.username         the owner's account name
 * @param {string} args.retiredStkPubHex the incumbent box's CURRENT STK pubkey hex
 * @param {"keep"|"wipe-after-handoff"|"wipe-now"} args.disposition
 * @param {boolean} args.backupEnrolled
 * @param {Uint8Array} args.umk          session UMK (for IRK signing)
 * @param {string} args.irkPubHex        the owner's IRK pubkey, hex
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 */
export async function depositDecommission(args, deps = {}) {
  const {
    serverDomain,
    username,
    retiredStkPubHex,
    disposition,
    backupEnrolled,
    umk,
    irkPubHex,
    signWithIrk,
  } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!irkPubHex) throw err("irkPubHex required", 400);
  if (!retiredStkPubHex || !/^[0-9a-f]{64}$/i.test(retiredStkPubHex)) {
    throw err("couldn't read the box's current key — is it online?", 400);
  }
  if (!DISK_DISPOSITIONS.includes(disposition)) {
    throw err("invalid disposition", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || controlApex();

  const order = buildDecommissionOrder({
    serverDomain,
    retiredStkPubHex: String(retiredStkPubHex).toLowerCase(),
    disposition,
    backupEnrolled,
    now: deps.now,
    getRandomValues: deps.getRandomValues,
  });
  const sig = await signWithIrk(umk, canonicalDecommissionBytes(order));
  const signatureHex = toHex(sig);

  const mailboxAuth = await buildMailboxAuth(
    { username, umk, signWithIrk, irkPubHex },
    deps,
  );
  const reqBody = { ...mailboxAuth, order, signature: signatureHex };

  let resp;
  try {
    resp = await f(
      `${origin}/api/server/${encodeURIComponent(serverDomain)}/decommission`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      },
    );
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return { ok: true, order, body };
}

// ── L3 — locally retire the instance ───────────────────────────────────────
//
// docs §8b L3: the replacement flow removes the retiring box from the phone's
// box list / marks it decommissioned, so a rebooting encrypted zombie's
// disk-unlock request is never surfaced/approved — it can't boot to re-enter the
// fight. The webapp's server list is server-authoritative (it renders from
// /api/me/servers + /pods, with no local pod store), so "retire locally" is a
// per-profile SUPPRESSION SET keyed by lowercased FQDN. Home filters these out,
// and the boot-approval surfaces decline an unlock for a suppressed box.

const DECOMMISSIONED_SLOT = "decommissionedServers";

// profilesStore stringifies values, so the FQDN set is persisted as a JSON
// string and parsed back here.
function readSet(deps = {}) {
  const getter = deps.profileGet || profileGet;
  let raw = null;
  try {
    raw = getter(DECOMMISSIONED_SLOT);
  } catch {
    raw = null;
  }
  if (Array.isArray(raw)) return raw.map((x) => String(x).toLowerCase());
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).toLowerCase());
    } catch {
      /* corrupt slot — treat as empty */
    }
  }
  return [];
}

/** Mark a server instance decommissioned in the phone's local box list (L3).
 *  Idempotent. */
export function markServerDecommissioned(serverDomain, deps = {}) {
  const setter = deps.profileSet || profileSet;
  const key = String(serverDomain).toLowerCase();
  const cur = readSet(deps);
  if (!cur.includes(key)) cur.push(key);
  setter(DECOMMISSIONED_SLOT, JSON.stringify(cur));
  return cur;
}

/** Is this server instance locally retired? */
export function isServerDecommissioned(serverDomain, deps = {}) {
  return readSet(deps).includes(String(serverDomain).toLowerCase());
}

/** The full set of locally-retired FQDNs (lowercased). */
export function decommissionedServers(deps = {}) {
  return readSet(deps);
}

/**
 * The whole flow after the user has cleared the disposition picker + (for a wipe)
 * the pre-flight gate: deposit the signed order, and ONLY on a 200 retire the
 * instance locally (L3). A deposit failure leaves the box in the list so the
 * error can be surfaced and the user isn't stranded.
 *
 * @returns {Promise<{ ok: true, order: object, body: any }>}
 */
export async function runReplacement(args, deps = {}) {
  const result = await depositDecommission(args, deps);
  markServerDecommissioned(args.serverDomain, deps);
  return result;
}

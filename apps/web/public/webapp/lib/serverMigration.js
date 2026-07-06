// "Migrate to new hardware" — webapp client for the server-migration
// orchestration (docs/server-migration.md). Same owner, same
// `<server>.<user>` name, NEW box: the phone initiates an admin-signed
// migration session on `.com`, the owner provisions a provisional second pod
// (a NORMAL add-server recipe — nothing migration-specific in it), the new
// box attaches + pre-seeds from peer-backup, and the phone drives
// confirm-ready → freeze (the graceful-decommission deposit, reused verbatim)
// → the new box takes over the name.
//
// Canonical bytes here are built byte-identical to @flagship/protocol's
// serverMigration.ts (pinned by packages/protocol/tests/
// serverMigrationVectors.test.ts):
//
//   flagship/server-migration/v1|<serverDomain lc>|<oldStk lc>|<disposition>
//     |<nonce lc>|<issuedAt>
//   flagship/server-migration-control/v1|<serverDomain lc>|<action>
//     |<nonce lc>|<issuedAt>
//
// Both tags are SENSITIVE (Slice D): the caller passes a `sensitiveSigner()`
// so the order/control route to the admin master root while the co-signed
// mailbox auth stays the membership IRK (tag-routed — see lib/adminRoot.js).
//
// SWK CONTRACT (invariant 4 — the restore hinges on this): the provisional
// pod must be provisioned with the SWK of the MIGRATING serverDomain
// (deriveSwkFromSeed(umk, <migrating domain>) — the DOTS "flagship.swk.v1"
// protocol derivation), NOT its own provisional name, or the old box's
// peer-backup shards will never decrypt. `migrationSwkServerId` below is the
// seam lib/swkDeposit.js consults before every deposit.
//
// CUTOVER NOTE (client-side step 7): `.com`'s take-over handler rebinds the
// directory identity server-side; the hub's eviction + HELLO claim move the
// live route. There is NO client RCK re-point here: no surface persists the
// RCK private key (it is minted at create, registered, and discarded on every
// platform), so a SetRoutingTarget cannot be signed — the routing-record
// `currentTarget` staleness after migration matches what replace-server
// already leaves behind. The webapp also holds no per-box cert-fingerprint
// pin store (browser TLS validates the box's Let's Encrypt cert), so cert
// re-pin is a mobile-only concern (CertPinRegistry re-verifies via the
// SWK-derived status STK, which the migrated box re-derives identically).

import { controlApex } from "./apex.js";
import {
  buildMailboxAuth,
  buildDecommissionOrder,
  canonicalDecommissionBytes,
} from "./serverReplacement.js";

// ---- Canonical-bytes tags — MUST match @flagship/protocol ----
export const TAG_SERVER_MIGRATION = "flagship/server-migration/v1";
export const TAG_SERVER_MIGRATION_CONTROL = "flagship/server-migration-control/v1";

/** Migration dispositions — deliberately EXCLUDES `wipe-now` (invariant 1:
 *  the old box is wiped only after the successor confirms take-over). MUST
 *  match @flagship/protocol MigrationDisposition. */
export const MIGRATION_DISPOSITIONS = ["keep", "wipe-after-handoff"];
export const DEFAULT_MIGRATION_DISPOSITION = "wipe-after-handoff";

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

// ---------------------------------------------------------------------------
// Canonical bytes (pure — mirror @flagship/protocol exactly)
// ---------------------------------------------------------------------------

/** flagship/server-migration/v1|<serverDomain lc>|<oldStk lc>|<disposition>|<nonce lc>|<issuedAt> */
export function canonicalMigrationOrderBytes(o) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_MIGRATION,
      String(o.serverDomain).toLowerCase(),
      String(o.oldStkPubHex).toLowerCase(),
      o.diskDisposition,
      String(o.nonce).toLowerCase(),
      o.issuedAt,
    ].join("|"),
  );
}

/** flagship/server-migration-control/v1|<serverDomain lc>|<action>|<nonce lc>|<issuedAt> */
export function canonicalMigrationControlBytes(c) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_MIGRATION_CONTROL,
      String(c.serverDomain).toLowerCase(),
      c.action,
      String(c.nonce).toLowerCase(),
      c.issuedAt,
    ].join("|"),
  );
}

/** Build the ServerMigrationOrder wire object (fresh 32-byte nonce). */
export function buildMigrationOrder({
  serverDomain,
  oldStkPubHex,
  disposition,
  now,
  getRandomValues,
}) {
  return {
    serverDomain,
    oldStkPubHex: String(oldStkPubHex).toLowerCase(),
    diskDisposition: disposition,
    nonce: randHex(32, getRandomValues),
    issuedAt: (now || Date.now)(),
  };
}

// ---------------------------------------------------------------------------
// Deposits (admin-signed order/control + owner-IRK mailbox auth)
// ---------------------------------------------------------------------------

async function postDeposit(url, reqBody, f) {
  let resp;
  try {
    resp = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return body;
}

/**
 * Phase 1 — initiate: mint + admin-sign the ServerMigrationOrder and deposit
 * it. `signWithIrk` is the TAG-ROUTED sensitive signer (lib/adminRoot.js): the
 * order signs under the admin root, the mailbox auth under the IRK.
 */
export async function startMigration(args, deps = {}) {
  const {
    serverDomain,
    username,
    oldStkPubHex,
    disposition,
    umk,
    irkPubHex,
    signWithIrk,
  } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!irkPubHex) throw err("irkPubHex required", 400);
  if (!oldStkPubHex || !/^[0-9a-f]{64}$/i.test(oldStkPubHex)) {
    throw err("couldn't read the box's current key — is it online?", 400);
  }
  if (!MIGRATION_DISPOSITIONS.includes(disposition)) {
    throw err("invalid disposition", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || controlApex();

  const order = buildMigrationOrder({
    serverDomain,
    oldStkPubHex,
    disposition,
    now: deps.now,
    getRandomValues: deps.getRandomValues,
  });
  const sig = await signWithIrk(umk, canonicalMigrationOrderBytes(order));
  const mailboxAuth = await buildMailboxAuth({ username, umk, signWithIrk, irkPubHex }, deps);
  const body = await postDeposit(
    `${origin}/api/server/${encodeURIComponent(serverDomain)}/migration`,
    { ...mailboxAuth, order, signature: toHex(sig) },
    f,
  );
  return { ok: true, order, body };
}

/** The public progress timeline — `null` when no session exists (404). */
export async function fetchMigration(serverDomain, deps = {}) {
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();
  let resp;
  try {
    resp = await f(`${origin}/api/server/${encodeURIComponent(serverDomain)}/migration`);
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  if (resp.status === 404) return null;
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return body;
}

async function depositControl(action, args, deps) {
  const { serverDomain, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || controlApex();

  const control = {
    serverDomain,
    action,
    nonce: randHex(32, deps.getRandomValues),
    issuedAt: (deps.now || Date.now)(),
  };
  const sig = await signWithIrk(umk, canonicalMigrationControlBytes(control));
  const mailboxAuth = await buildMailboxAuth({ username, umk, signWithIrk, irkPubHex }, deps);
  const body = await postDeposit(
    `${origin}/api/server/${encodeURIComponent(serverDomain)}/migration/${action === "abort" ? "abort" : "confirm-ready"}`,
    { ...mailboxAuth, control, signature: toHex(sig) },
    f,
  );
  return { ok: true, control, body };
}

/** Phase 4 — admin-signed confirm-ready (409 unless the session is pre-seeded). */
export function confirmMigrationReady(args, deps = {}) {
  return depositControl("confirm-ready", args, deps);
}

/**
 * Abort — admin-signed, honest semantics: everything before take-over aborts
 * cleanly (the old box stays authoritative with all its data); `.com` rejects
 * it with a 409 once taken-over (the point of no return).
 */
export function abortMigration(args, deps = {}) {
  return depositControl("abort", args, deps);
}

/**
 * Phase 5 — freeze: EXACTLY the graceful-decommission deposit (the eviction
 * lane is reused verbatim), posted to the session-validated /migration/freeze
 * route. The order targets the session's OLD instance, always carries a final
 * backup (the final delta the new box restores before take-over), and must
 * match the migration order's disposition.
 */
export async function freezeMigration(args, deps = {}) {
  const { serverDomain, username, session, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!session || !session.oldStkPubHex) throw err("no migration session", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || controlApex();

  // backupEnrolled:true forces finalBackup=true — the freeze handler rejects
  // a no-final-backup order (the final delta IS the point of the freeze).
  const order = buildDecommissionOrder({
    serverDomain,
    retiredStkPubHex: String(session.oldStkPubHex).toLowerCase(),
    disposition: session.disposition,
    backupEnrolled: true,
    now: deps.now,
    getRandomValues: deps.getRandomValues,
  });
  const sig = await signWithIrk(umk, canonicalDecommissionBytes(order));
  const mailboxAuth = await buildMailboxAuth({ username, umk, signWithIrk, irkPubHex }, deps);
  const body = await postDeposit(
    `${origin}/api/server/${encodeURIComponent(serverDomain)}/migration/freeze`,
    { ...mailboxAuth, order, signature: toHex(sig) },
    f,
  );
  return { ok: true, order, body };
}

// ---------------------------------------------------------------------------
// SWK hold — the migration-aware seam lib/swkDeposit.js consults
// ---------------------------------------------------------------------------
//
// When a migration is initiated on this device we record a HOLD for the
// migrating domain. While a hold is live, the SWK deposit for any OTHER pod
// of this account first resolves the migration session:
//   - the session's attached new box IS that pod  → deposit the MIGRATING
//     domain's SWK (the whole point);
//   - the session is still awaiting its new box   → DEFER the deposit (we
//     cannot yet tell whether this fresh pod is the migration's provisional
//     box; depositing its own-name SWK now would poison the restore);
//   - the session is gone/terminal                → clear the hold, deposit
//     normally.

const HOLD_PREFIX = "flagship.migrationHold.";

export function setMigrationHold(migratingDomain) {
  try {
    localStorage.setItem(HOLD_PREFIX + String(migratingDomain).toLowerCase(), "1");
  } catch {
    /* private mode — the deposit falls back to normal derivation */
  }
}

export function clearMigrationHold(migratingDomain) {
  try {
    localStorage.removeItem(HOLD_PREFIX + String(migratingDomain).toLowerCase());
  } catch {
    /* ignore */
  }
}

export function activeMigrationHolds() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(HOLD_PREFIX)) out.push(k.slice(HOLD_PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Session phases in which the migration is live (mirror of the `.com` set). */
const ACTIVE_PHASES = new Set(["initiated", "provisioned", "pre-seeded", "ready", "freezing"]);

/**
 * Which serverId should the SWK for `podDomain` derive from?
 *   - `{ serverId: <migrating domain> }` — this pod is the attached new box;
 *   - `{ defer: true }` — a live migration hasn't attached its new box yet,
 *     hold the deposit off until it does;
 *   - `null` — no migration involvement, derive from the pod's own name.
 *
 * @param {{ podDomain: string, holds?: string[] }} args
 * @param {{ fetchSession?: (domain: string) => Promise<object|null> }} [deps]
 */
export async function migrationSwkServerId(args, deps = {}) {
  const pod = String(args.podDomain).toLowerCase();
  const holds = args.holds ?? activeMigrationHolds();
  const fetchSession = deps.fetchSession || ((d) => fetchMigration(d, deps));
  for (const migrating of holds) {
    if (migrating === pod) continue; // the migrating box itself derives normally
    let session = null;
    try {
      session = await fetchSession(migrating);
    } catch {
      // Unreachable `.com` — be conservative: defer rather than risk a
      // wrong-name SWK poisoning the restore.
      return { defer: true };
    }
    if (!session || !ACTIVE_PHASES.has(session.phase)) {
      if (session?.phase === "taken-over" || session?.phase === "aborted" || !session) {
        clearMigrationHold(migrating);
      }
      continue;
    }
    const attached = session.newServerDomain ? String(session.newServerDomain).toLowerCase() : null;
    if (attached === pod) return { serverId: migrating };
    if (!attached) return { defer: true };
    // A different pod is the migration's new box — this one is unrelated.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline mapping — the spec's 8 steps from the GET body
// ---------------------------------------------------------------------------

/** How long an attached-but-not-pre-seeded session waits before we surface
 *  the "is backup enabled?" hint (the GET carries no manifest signal). */
export const PRESEED_STUCK_MS = 10 * 60_000;

/**
 * Map the GET body onto the spec's 8-phase timeline. Returns
 * `[{ key, label, at, state }]` with state ∈ done | active | pending
 * (aborted sessions mark every un-stamped step pending).
 */
export function migrationSteps(s, nowMs) {
  const aborted = s.abortedAt != null;
  const rows = [
    ["initiate", "Migration authorized", s.initiatedAt],
    ["provision", "New box online + attached", s.attachedAt],
    ["pre-seed", "Data restored to the new box", s.preSeededAt],
    ["ready", "Confirmed ready to take over", s.readyAt],
    ["freeze", "Old server frozen — final backup", s.freezeAt],
    ["final-delta", "Final backup flushed", s.finalDeltaAt],
    ["take-over", "New box took over the name", s.takenOverAt],
    ["close-out", "Old box closed out", s.oldClosedOutAt],
  ];
  let activeSeen = false;
  return rows.map(([key, label, at]) => {
    let state;
    if (at != null) {
      state = "done";
    } else if (aborted || activeSeen) {
      state = "pending";
    } else {
      state = "active";
      activeSeen = true;
    }
    return { key, label, at: at ?? null, state };
  });
}

/** Honest waiting copy for the CURRENT wait, plus the stuck-pre-seed hint. */
export function migrationWaitCopy(s, nowMs) {
  const now = nowMs ?? Date.now();
  if (s.abortedAt != null) {
    return "Migration aborted — your old server stays active with all its data.";
  }
  if (s.done) return "Migration complete — the server now runs on the new box.";
  switch (s.phase) {
    case "initiated":
      return "Waiting for the new box to come online. Apply the recipe on the new hardware; it will attach itself here.";
    case "provisioned":
      if (s.attachedAt != null && now - s.attachedAt > PRESEED_STUCK_MS) {
        return "The new box attached but hasn't restored any data yet. If this server has no backup enabled, enable backup first — the migration restores from it.";
      }
      return "New box attached — restoring this server's data from backup. The old server keeps serving meanwhile.";
    case "pre-seeded":
      return "Data restored. Confirm the hand-off when you're ready — the old server will briefly freeze writes while the name moves.";
    case "ready":
      return "Ready — freeze the old server to flush the final backup and hand the name over.";
    case "freezing":
      return s.finalDeltaAt == null
        ? "Old server is frozen and flushing its final backup…"
        : "Final backup flushed — the new box is applying it and claiming the name…";
    case "taken-over":
      return "The new box is serving the name. Waiting for the old box to close out.";
    default:
      return "";
  }
}

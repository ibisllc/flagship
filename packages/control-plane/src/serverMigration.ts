/**
 * Server-migration orchestration (docs/server-migration.md) — the `.com` lane
 * of the 8-phase state machine that moves a server to new hardware with the
 * SAME owner + SAME `<server>.<user>` name.
 *
 *   POST /api/server/:domain/migration                admin-signed initiate (owner mailbox-auth)
 *   GET  /api/server/:domain/migration                phase state (PUBLIC — both boxes + the phone poll it)
 *   GET  /api/server/:newBox/migration-assignment     the NEW box discovers its assignment (PUBLIC)
 *   POST /api/server/:domain/migration/attach         new box attaches itself (STK-signed)
 *   POST /api/server/:domain/migration/pre-seeded     new box reports restore complete (STK-signed)
 *   POST /api/server/:domain/migration/confirm-ready  admin-signed phase-4 confirm (owner mailbox-auth)
 *   POST /api/server/:domain/migration/freeze         admin decommission deposit, session-validated (reuses the eviction lane)
 *   POST /api/server/:domain/migration/take-over      new box acks take-over (STK-signed) — the POINT OF NO RETURN
 *   POST /api/server/:domain/migration/abort          admin-signed abort (owner mailbox-auth); rejected after take-over
 *
 * Invariants enforced HERE (server-side, not just client ordering):
 *   - wipe-only-after-takeover: the eviction's successor-confirm
 *     (`markNewAcked` — what the old box's wipe gate keys off) is set ONLY by
 *     the take-over handler, which itself requires the final-delta barrier
 *     (the eviction row's epochCompleteAt) to have been reported.
 *   - release-before-claim: freeze (which makes the old box release routing)
 *     must precede take-over (which rebinds the directory identity); a
 *     take-over ack in any earlier phase is rejected.
 *   - abort keeps the old box authoritative: abort deletes the un-honored
 *     eviction row (the old box never consumes a retracted order) and is
 *     REJECTED once take-over is recorded (the enforceable point of no
 *     return — after `markNewAcked` fires, `.com` cannot retract the old
 *     box's wipe confirm without racing its poll).
 *
 * Auth model: initiate / confirm-ready / abort are SENSITIVE (they retire,
 * wipe, and re-home a box) — owner mailbox-auth for the deposit + the Slice-D
 * master-admin gate (`authorizeSensitiveComOp`) for the order signature.
 * Attach / pre-seeded / take-over are box phase-acks, verified against the
 * new box's DIRECTORY-BOUND STK (registration is the authenticator; the box
 * itself never holds owner authority). The GETs are public: everything served
 * is admin-signed or non-secret phase state, and both boxes re-verify the
 * order under their config-pinned authority before acting.
 */

import {
  isMigrationDisposition,
  verifyServerMigrationAck,
  verifyServerMigrationAttach,
  verifyServerMigrationControl,
  verifyServerMigrationOrder,
  type MigrationControlAction,
  type ServerMigrationAck,
  type ServerMigrationAttach,
  type ServerMigrationControl,
  type ServerMigrationOrder,
} from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  ServerEvictionStorage,
  ServerMigrationRecord,
  ServerMigrationStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, hexToBytes } from "./hex.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { authPhoneMailbox, type SecretMailboxDeps } from "./secretMailbox.js";
import { handlePostDecommission, type ServerDecommissionDeps } from "./serverDecommission.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";

export interface ServerMigrationDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  serverMigrations: ServerMigrationStorage;
  serverEvictions: ServerEvictionStorage;
  /** Slice D — device-grant store for the master-admin gate. Optional: absent
   *  ⇒ only the bare admin root satisfies the open gate. */
  grants?: DeviceCapabilityGrantStorage;
  /** Mailbox-auth deps (authenticates the phone depositor as the owner). */
  mailbox: SecretMailboxDeps;
  now?: () => number;
}

const HEX_NONCE = /^[0-9a-f]{64}$/; // 32 bytes hex
const HEX_SIG = /^[0-9a-f]{128}$/; // 64 bytes hex
/** Box phase-acks must be fresh — same window as the peer-backup lane. */
const ACK_FRESHNESS_MS = 10 * 60_000;

/** Non-terminal phases — a new initiate is refused while one is live. */
const ACTIVE_PHASES: ReadonlySet<string> = new Set([
  "initiated",
  "provisioned",
  "pre-seeded",
  "ready",
  "freezing",
]);

// ──────────────────────────────────────────────────────────────────────
// 1. POST /api/server/:domain/migration  (admin-signed initiate)
// ──────────────────────────────────────────────────────────────────────

export async function handlePostMigrationStart(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();

  const auth = await authPhoneMailbox(deps.mailbox, body);
  if (!auth.ok) return auth.response;

  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.username.toLowerCase() !== auth.username) {
    return forbidden("server belongs to a different account");
  }

  const b = body as { order?: Record<string, unknown>; signature?: unknown };
  const o = b?.order ?? {};
  if (
    typeof o.serverDomain !== "string" ||
    typeof o.oldStkPubHex !== "string" ||
    !isMigrationDisposition(o.diskDisposition) ||
    typeof o.nonce !== "string" ||
    typeof o.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed order");
  }
  if (!HEX64.test(o.oldStkPubHex.toLowerCase())) {
    return malformed("oldStkPubHex must be 32 bytes hex");
  }
  if (!HEX_NONCE.test(o.nonce.toLowerCase())) {
    return malformed("nonce must be 32 bytes hex");
  }
  if (!HEX_SIG.test(b.signature.toLowerCase())) {
    return malformed("signature must be 64 bytes hex");
  }
  if (o.serverDomain.toLowerCase() !== host.toLowerCase()) {
    return forbidden("order serverDomain does not match the domain");
  }
  // The order binds to the CURRENT live instance: a stale order minted against
  // a previous tenant of this name (pre-replacement / pre-migration) is dead on
  // arrival, and the freeze-phase decommission can only ever target the box
  // this admin actually looked at.
  if (o.oldStkPubHex.toLowerCase() !== reg.identityPubKeyHex.toLowerCase()) {
    return conflict("order oldStkPubHex is not the server's current identity");
  }

  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return notFound("unknown user");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }

  const order: ServerMigrationOrder = {
    serverDomain: o.serverDomain,
    oldStkPubHex: o.oldStkPubHex,
    diskDisposition: o.diskDisposition,
    nonce: o.nonce,
    issuedAt: o.issuedAt,
  };
  // SENSITIVE — master-admin authority (legacy owner-IRK when no admin root is pinned).
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: reg.username.toLowerCase(),
      userRec,
      verifyWith: (pub) => verifyServerMigrationOrder(order, sig, hexToBytes(pub)),
    },
  );
  if (!authz.ok) {
    return forbidden("invalid signature");
  }

  const existing = await deps.serverMigrations.getSession(host.toLowerCase());
  if (existing && ACTIVE_PHASES.has(existing.phase)) {
    // Idempotent re-deposit of the SAME order is fine; a different one must
    // abort the live session first.
    const sameOrder = safeOrderNonce(existing.orderJson) === order.nonce.toLowerCase();
    if (!sameOrder) return conflict("a migration is already in progress for this server");
    return ok({ ok: true, phase: existing.phase });
  }

  await deps.serverMigrations.putSession({
    serverDomain: host.toLowerCase(),
    username: reg.username.toLowerCase(),
    oldStkPubHex: order.oldStkPubHex.toLowerCase(),
    orderJson: JSON.stringify(order),
    orderSignatureHex: b.signature.toLowerCase(),
    disposition: order.diskDisposition,
    phase: "initiated",
    initiatedAt: now,
    newServerDomain: null,
    newStkPubHex: null,
    attachedAt: null,
    preSeededAt: null,
    readyAt: null,
    freezeAt: null,
    takenOverAt: null,
    abortedAt: null,
  });
  return ok({ ok: true, phase: "initiated" });
}

function safeOrderNonce(orderJson: string): string | null {
  try {
    const n = (JSON.parse(orderJson) as { nonce?: unknown }).nonce;
    return typeof n === "string" ? n.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 2. GET phase state (both boxes + the phone) + the new box's assignment
// ──────────────────────────────────────────────────────────────────────

async function sessionStatusBody(
  deps: ServerMigrationDeps,
  s: ServerMigrationRecord,
): Promise<Record<string, unknown>> {
  // The final-delta barrier lives on the EVICTION row (the freeze phase reuses
  // the decommission lane); join it live rather than duplicating state.
  const ev = await deps.serverEvictions.getEviction(s.serverDomain, s.oldStkPubHex);
  const finalDeltaAt = ev?.epochCompleteAt ?? null;
  const oldClosedOutAt = ev?.oldAckedAt ?? null;
  return {
    serverDomain: s.serverDomain,
    phase: s.phase,
    orderJson: s.orderJson,
    orderSignatureHex: s.orderSignatureHex,
    disposition: s.disposition,
    oldStkPubHex: s.oldStkPubHex,
    newServerDomain: s.newServerDomain,
    newStkPubHex: s.newStkPubHex,
    initiatedAt: s.initiatedAt,
    attachedAt: s.attachedAt,
    preSeededAt: s.preSeededAt,
    readyAt: s.readyAt,
    freezeAt: s.freezeAt,
    finalDeltaAt,
    takenOverAt: s.takenOverAt,
    abortedAt: s.abortedAt,
    oldClosedOutAt,
    // "done" is derived: the new box took over AND the old box closed out.
    done: s.phase === "taken-over" && oldClosedOutAt != null,
  };
}

export async function handleGetMigration(
  deps: ServerMigrationDeps,
  host: string,
): Promise<HandlerResponse> {
  const s = await deps.serverMigrations.getSession(host.toLowerCase());
  if (!s) return notFound("no migration session");
  return ok(await sessionStatusBody(deps, s));
}

/**
 * The NEW box's discovery read: keyed by ITS OWN registered pod FQDN, returns
 * the account's migration session it should serve — either one already
 * attached to it, or an unattached `initiated` session awaiting a new box.
 */
export async function handleGetMigrationAssignment(
  deps: ServerMigrationDeps,
  newBoxDomain: string,
): Promise<HandlerResponse> {
  const me = newBoxDomain.toLowerCase();
  const reg = await deps.servers.get(me);
  if (!reg) return notFound("unknown server");
  const sessions = await deps.serverMigrations.listForUser(reg.username);
  const mine = sessions.find(
    (s) =>
      s.serverDomain !== me &&
      s.phase !== "aborted" &&
      (s.newServerDomain === me ||
        (s.newServerDomain === null && s.phase === "initiated")),
  );
  if (!mine) return notFound("no migration assignment");
  return ok(await sessionStatusBody(deps, mine));
}

// ──────────────────────────────────────────────────────────────────────
// 3. POST .../migration/attach  (new box, STK-signed)
// ──────────────────────────────────────────────────────────────────────

export async function handlePostMigrationAttach(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const b = body as { attach?: Record<string, unknown>; signatureHex?: unknown };
  const a = b?.attach ?? {};
  if (
    typeof a.serverDomain !== "string" ||
    typeof a.newServerDomain !== "string" ||
    typeof a.newStkPubHex !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof b?.signatureHex !== "string" ||
    !HEX_SIG.test(b.signatureHex.toLowerCase())
  ) {
    return malformed("malformed attach");
  }
  if (!HEX64.test(a.newStkPubHex.toLowerCase())) {
    return malformed("newStkPubHex must be 32 bytes hex");
  }
  if (a.serverDomain.toLowerCase() !== host.toLowerCase()) {
    return forbidden("attach serverDomain does not match the domain");
  }
  if (Math.abs(now - a.issuedAt) > ACK_FRESHNESS_MS) {
    return forbidden("stale attach");
  }

  const session = await deps.serverMigrations.getSession(host.toLowerCase());
  if (!session) return notFound("no migration session");
  if (session.phase === "aborted") return conflict("migration aborted");

  const newDomain = a.newServerDomain.toLowerCase();
  if (newDomain === host.toLowerCase()) {
    return forbidden("the new box cannot be the migrating server itself");
  }
  const newReg = await deps.servers.get(newDomain);
  if (!newReg) return notFound("new box is not a registered server");
  if (newReg.revokedAt) return forbidden("new box registration is revoked");
  if (newReg.username.toLowerCase() !== session.username) {
    return forbidden("new box belongs to a different account");
  }
  // The claimed STK must BE the new pod's directory-bound identity — the
  // registration is the authenticator, never the body's own word.
  if (newReg.identityPubKeyHex.toLowerCase() !== a.newStkPubHex.toLowerCase()) {
    return forbidden("newStkPubHex is not the registered identity of newServerDomain");
  }

  const attach: ServerMigrationAttach = {
    serverDomain: a.serverDomain,
    newServerDomain: a.newServerDomain,
    newStkPubHex: a.newStkPubHex,
    issuedAt: a.issuedAt,
  };
  let sigOk = false;
  try {
    sigOk = verifyServerMigrationAttach(
      attach,
      hexToBytes(b.signatureHex),
      hexToBytes(newReg.identityPubKeyHex),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return forbidden("invalid attach signature");

  if (session.phase !== "initiated") {
    // Idempotent re-attach by the SAME box is fine; a second box is not.
    if (session.newStkPubHex === a.newStkPubHex.toLowerCase()) {
      return ok({ ok: true, phase: session.phase });
    }
    return conflict("a different box is already attached");
  }
  await deps.serverMigrations.attachNewBox(
    host.toLowerCase(),
    newDomain,
    a.newStkPubHex.toLowerCase(),
    now,
  );
  return ok({ ok: true, phase: "provisioned" });
}

// ──────────────────────────────────────────────────────────────────────
// 4. POST .../migration/pre-seeded + .../migration/take-over  (new box acks)
// ──────────────────────────────────────────────────────────────────────

async function verifyNewBoxAck(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
  expectedPhase: "pre-seeded" | "take-over",
): Promise<
  | { ok: true; session: ServerMigrationRecord }
  | { ok: false; response: HandlerResponse }
> {
  const now = (deps.now ?? (() => Date.now()))();
  const b = body as { ack?: Record<string, unknown>; signatureHex?: unknown };
  const a = b?.ack ?? {};
  if (
    typeof a.serverDomain !== "string" ||
    typeof a.stkPubHex !== "string" ||
    a.phase !== expectedPhase ||
    typeof a.issuedAt !== "number" ||
    typeof b?.signatureHex !== "string" ||
    !HEX_SIG.test(b.signatureHex.toLowerCase())
  ) {
    return { ok: false, response: malformed("malformed ack") };
  }
  if (a.serverDomain.toLowerCase() !== host.toLowerCase()) {
    return { ok: false, response: forbidden("ack serverDomain does not match the domain") };
  }
  if (Math.abs(now - a.issuedAt) > ACK_FRESHNESS_MS) {
    return { ok: false, response: forbidden("stale ack") };
  }
  const session = await deps.serverMigrations.getSession(host.toLowerCase());
  if (!session) return { ok: false, response: notFound("no migration session") };
  if (session.phase === "aborted") return { ok: false, response: conflict("migration aborted") };
  if (!session.newStkPubHex) {
    return { ok: false, response: conflict("no box attached to this migration") };
  }
  if (a.stkPubHex.toLowerCase() !== session.newStkPubHex) {
    return { ok: false, response: forbidden("ack is not from the attached box") };
  }
  const ack: ServerMigrationAck = {
    serverDomain: a.serverDomain,
    stkPubHex: a.stkPubHex,
    phase: expectedPhase,
    issuedAt: a.issuedAt,
  };
  let sigOk = false;
  try {
    sigOk = verifyServerMigrationAck(
      ack,
      hexToBytes(b.signatureHex),
      hexToBytes(session.newStkPubHex),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, response: forbidden("invalid ack signature") };
  return { ok: true, session };
}

export async function handlePostMigrationPreSeeded(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const v = await verifyNewBoxAck(deps, host, body, "pre-seeded");
  if (!v.ok) return v.response;
  const { session } = v;
  if (session.phase === "provisioned") {
    await deps.serverMigrations.markPreSeeded(host.toLowerCase(), now);
    return ok({ ok: true, phase: "pre-seeded" });
  }
  // Already recorded (or the phone has advanced the machine further) — never
  // downgrade the phase on a re-poll.
  return ok({ ok: true, phase: session.phase, alreadyRecorded: true });
}

export async function handlePostMigrationTakeOver(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const v = await verifyNewBoxAck(deps, host, body, "take-over");
  if (!v.ok) return v.response;
  const { session } = v;

  if (session.phase === "taken-over") {
    return ok({ ok: true, phase: "taken-over", alreadyRecorded: true });
  }
  // release-before-claim: take-over is legal ONLY out of the freeze phase (the
  // old box has been ordered to flush + release routing).
  if (session.phase !== "freezing") {
    return conflict("take-over requires the freeze phase");
  }
  // no-data-loss: the final delta MUST have been flushed (the old box's §9
  // epoch-complete report on the eviction row) before the name moves.
  const ev = await deps.serverEvictions.getEviction(host.toLowerCase(), session.oldStkPubHex);
  if (!ev || ev.epochCompleteAt == null) {
    return conflict("final delta not flushed yet");
  }

  // Effect order matters:
  //  1. rebind the directory identity (the new box IS <server>.<user> now —
  //     heartbeats / DNS-01 / mailbox / hub HELLO authenticate as it);
  //  2. record the phase;
  //  3. LAST, set the eviction successor-confirm — the old box's wipe gate
  //     only opens once the rebind is durable (a crash in between retries
  //     idempotently and never leaves the wipe authorized without a rebind).
  await deps.servers.put({
    serverDomain: host.toLowerCase(),
    username: session.username,
    identityPubKeyHex: session.newStkPubHex!,
    registeredAt: now,
  });
  await deps.serverMigrations.markTakenOver(host.toLowerCase(), now);
  await deps.serverEvictions.markNewAcked(host.toLowerCase(), now);
  return ok({ ok: true, phase: "taken-over" });
}

// ──────────────────────────────────────────────────────────────────────
// 5. POST .../migration/confirm-ready + .../migration/abort  (admin-signed)
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse + structurally validate an admin control deposit and mailbox-auth the
 * depositor as the domain's owner. Does NOT authorize the signature — each
 * sensitive handler routes that through `authorizeSensitiveComOp` ITSELF (the
 * admin-authority guard asserts the gate inside every sensitive handler body).
 */
async function parseAdminControl(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
  action: MigrationControlAction,
): Promise<
  | {
      ok: true;
      username: string;
      userRec: NonNullable<Awaited<ReturnType<UsernameStorage["get"]>>>;
      control: ServerMigrationControl;
      sig: Uint8Array;
    }
  | { ok: false; response: HandlerResponse }
> {
  const auth = await authPhoneMailbox(deps.mailbox, body);
  if (!auth.ok) return { ok: false, response: auth.response };

  const reg = await deps.servers.get(host);
  if (!reg) return { ok: false, response: notFound("unknown server") };
  if (reg.username.toLowerCase() !== auth.username) {
    return { ok: false, response: forbidden("server belongs to a different account") };
  }

  const b = body as { control?: Record<string, unknown>; signature?: unknown };
  const c = b?.control ?? {};
  if (
    typeof c.serverDomain !== "string" ||
    c.action !== action ||
    typeof c.nonce !== "string" ||
    typeof c.issuedAt !== "number" ||
    typeof b?.signature !== "string" ||
    !HEX_SIG.test(b.signature.toLowerCase())
  ) {
    return { ok: false, response: malformed("malformed control") };
  }
  if (!HEX_NONCE.test(c.nonce.toLowerCase())) {
    return { ok: false, response: malformed("nonce must be 32 bytes hex") };
  }
  if (c.serverDomain.toLowerCase() !== host.toLowerCase()) {
    return { ok: false, response: forbidden("control serverDomain does not match the domain") };
  }

  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return { ok: false, response: notFound("unknown user") };

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { ok: false, response: malformed("invalid hex") };
  }
  return {
    ok: true,
    username: reg.username.toLowerCase(),
    userRec,
    control: { serverDomain: c.serverDomain, action, nonce: c.nonce, issuedAt: c.issuedAt },
    sig,
  };
}

export async function handlePostMigrationConfirmReady(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const v = await parseAdminControl(deps, host, body, "confirm-ready");
  if (!v.ok) return v.response;
  // SENSITIVE — master-admin authority (legacy owner-IRK when no admin root is pinned).
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: v.username,
      userRec: v.userRec,
      verifyWith: (pub) => verifyServerMigrationControl(v.control, v.sig, hexToBytes(pub)),
    },
  );
  if (!authz.ok) return forbidden("invalid signature");

  const session = await deps.serverMigrations.getSession(host.toLowerCase());
  if (!session) return notFound("no migration session");
  if (session.phase === "ready") return ok({ ok: true, phase: "ready", alreadyRecorded: true });
  if (session.phase !== "pre-seeded") {
    return conflict("confirm-ready requires a pre-seeded migration");
  }
  await deps.serverMigrations.markReady(host.toLowerCase(), now);
  return ok({ ok: true, phase: "ready" });
}

export async function handlePostMigrationAbort(
  deps: ServerMigrationDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const v = await parseAdminControl(deps, host, body, "abort");
  if (!v.ok) return v.response;
  // SENSITIVE — master-admin authority (legacy owner-IRK when no admin root is pinned).
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: v.username,
      userRec: v.userRec,
      verifyWith: (pub) => verifyServerMigrationControl(v.control, v.sig, hexToBytes(pub)),
    },
  );
  if (!authz.ok) return forbidden("invalid signature");

  const session = await deps.serverMigrations.getSession(host.toLowerCase());
  if (!session) return notFound("no migration session");
  if (session.phase === "aborted") return ok({ ok: true, phase: "aborted", alreadyRecorded: true });
  // The POINT OF NO RETURN: once take-over is recorded the directory is
  // rebound and the old box's wipe confirm is already visible — `.com` can no
  // longer retract it without racing the old box's poll. Everything earlier
  // (including freezing) aborts cleanly: the old box stays/returns
  // authoritative and its data is intact (wipe requires the successor confirm
  // that only take-over sets).
  if (session.phase === "taken-over") {
    return conflict("migration already took over — past the point of no return");
  }
  await deps.serverMigrations.markAborted(host.toLowerCase(), now);
  // Neutralize a deposited-but-unconsumed decommission order so the old box
  // never learns of a retracted eviction (and a mid-wait old box's migration
  // confirm poll sees `aborted` and powers off KEEPING its data).
  try {
    await deps.serverEvictions.deleteEviction(host.toLowerCase(), session.oldStkPubHex);
  } catch {
    // best-effort — the wipe gate still can't open (no successor confirm).
  }
  return ok({ ok: true, phase: "aborted" });
}

// ──────────────────────────────────────────────────────────────────────
// 6. POST .../migration/freeze — admin decommission deposit, session-validated
// ──────────────────────────────────────────────────────────────────────

/**
 * Phase 5. The body IS a decommission deposit (`{auth…, order, signature}` —
 * the owner-IRK/admin-signed ServerDecommission); this handler validates it
 * against the migration session, then DELEGATES to the eviction lane
 * (`handlePostDecommission` — the admin gate lives there) and stamps the
 * freeze phase on success. Reuse, not duplication: phases 5/7 are the
 * graceful-decommission machinery verbatim.
 */
export async function handlePostMigrationFreeze(
  deps: ServerMigrationDeps & { decommission: ServerDecommissionDeps },
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const session = await deps.serverMigrations.getSession(host.toLowerCase());
  if (!session) return notFound("no migration session");
  if (session.phase === "aborted") return conflict("migration aborted");
  if (session.phase !== "ready" && session.phase !== "freezing") {
    return conflict("freeze requires a ready migration");
  }

  // Pre-validate the embedded decommission order against the session BEFORE
  // the eviction lane records anything.
  const b = body as { order?: Record<string, unknown> };
  const o = b?.order ?? {};
  if (typeof o.retiredStkPubHex !== "string" || o.retiredStkPubHex.toLowerCase() !== session.oldStkPubHex) {
    return conflict("decommission order does not target the migrating instance");
  }
  if (o.finalBackup !== true) {
    return conflict("migration freeze requires finalBackup (the final delta)");
  }
  if (o.diskDisposition !== session.disposition) {
    return conflict("decommission disposition does not match the migration order");
  }

  const res = await handlePostDecommission(deps.decommission, host, body);
  if (res.status !== 200) return res;

  if (session.phase !== "freezing") {
    await deps.serverMigrations.markFreeze(host.toLowerCase(), now);
  }
  return ok({ ok: true, phase: "freezing" });
}

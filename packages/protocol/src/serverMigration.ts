/**
 * Server migration — move a server to new hardware, SAME owner + SAME
 * `<server>.<user>` name/identity (docs/server-migration.md).
 *
 * Four small envelopes drive the 8-phase state machine:
 *
 * - {@link ServerMigrationOrder} — the ADMIN-SIGNED "migrate this server"
 *   authorization (phase 1). Sensitive: it ultimately retires + wipes a box and
 *   re-homes routing, so it rides the Slice-D master-admin gate on `.com`
 *   (`authorizeSensitiveComOp`) AND box-side (`authorizeSensitiveOrder`).
 *   `oldStkPubHex` binds the order to the CURRENT live instance, so a replayed
 *   order can never re-migrate a later tenant of the same name. The disk
 *   disposition is restricted to `keep` / `wipe-after-handoff` — a migration
 *   never authorizes `wipe-now` (invariant 1: the old box is wiped ONLY after
 *   the new box confirms take-over).
 *
 * - {@link ServerMigrationControl} — the admin-signed phase-4/abort control
 *   (`confirm-ready` | `abort`). Same authority as the order; its own nonce so
 *   each control action is a distinct signature.
 *
 * - {@link ServerMigrationAttach} — the NEW box announces itself (phase 2).
 *   STK-signed by the new box's registered identity key; `.com` additionally
 *   checks the claimed key IS the directory-bound identity of
 *   `newServerDomain` and that the pod belongs to the same account.
 *
 * - {@link ServerMigrationAck} — the new box's STK-signed phase reports
 *   (`pre-seeded` after the restore completes; `take-over` after the final
 *   delta is applied). The take-over ack is the fail-safe key-off signal: it
 *   is what lets `.com` mark the eviction successor-confirmed (the old box's
 *   wipe gate) and rebind the directory identity.
 *
 * Canonical bytes are `|`-joined, field-guarded, `flagship/<purpose>/v1`
 * tagged (canonicalBase.ts conventions); hostnames/hex are lowercased into
 * the bytes so casing never changes a signature.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_MIGRATION_ORDER = "flagship/server-migration/v1";
const TAG_MIGRATION_CONTROL = "flagship/server-migration-control/v1";
const TAG_MIGRATION_ATTACH = "flagship/server-migration-attach/v1";
const TAG_MIGRATION_ACK = "flagship/server-migration-ack/v1";

/** What happens to the old box's disk after a CONFIRMED take-over (§ phase 7).
 *  Deliberately excludes `wipe-now`: a migration must never destroy the only
 *  copy before the successor confirms (invariant 1). */
export type MigrationDisposition = "keep" | "wipe-after-handoff";

export function isMigrationDisposition(v: unknown): v is MigrationDisposition {
  return v === "keep" || v === "wipe-after-handoff";
}

export interface ServerMigrationOrder {
  /** The migrating pod FQDN (`<server>.<user>.flagship.services`) — the name that carries over. */
  serverDomain: string;
  /** The CURRENT (old) instance's STK pubkey, hex — binds the order to one live box. */
  oldStkPubHex: string;
  /** Disk disposition applied to the old box after confirmed take-over. */
  diskDisposition: MigrationDisposition;
  /** 32-byte random nonce, hex (replay distinctness). */
  nonce: string;
  issuedAt: number;
}

export type MigrationControlAction = "confirm-ready" | "abort";

export interface ServerMigrationControl {
  serverDomain: string;
  action: MigrationControlAction;
  /** 32-byte random nonce, hex. */
  nonce: string;
  issuedAt: number;
}

export interface ServerMigrationAttach {
  /** The migrating (old) pod FQDN this attach targets. */
  serverDomain: string;
  /** The new box's OWN registered pod FQDN (the provisional second-pod name). */
  newServerDomain: string;
  /** The new box's registered identity (STK) pubkey, hex — the signer. */
  newStkPubHex: string;
  issuedAt: number;
}

export type MigrationAckPhase = "pre-seeded" | "take-over";

export interface ServerMigrationAck {
  /** The migrating (old) pod FQDN. */
  serverDomain: string;
  /** The acking box's STK pubkey, hex — must equal the session's attached new STK. */
  stkPubHex: string;
  phase: MigrationAckPhase;
  issuedAt: number;
}

function canonicalServerMigrationOrder(o: ServerMigrationOrder): Bytes {
  legacyFieldGuard("serverDomain", o.serverDomain);
  legacyFieldGuard("oldStkPubHex", o.oldStkPubHex);
  legacyFieldGuard("diskDisposition", o.diskDisposition);
  legacyFieldGuard("nonce", o.nonce);
  return new TextEncoder().encode(
    [
      TAG_MIGRATION_ORDER,
      o.serverDomain.toLowerCase(),
      o.oldStkPubHex.toLowerCase(),
      o.diskDisposition,
      o.nonce.toLowerCase(),
      o.issuedAt,
    ].join("|"),
  );
}

function canonicalServerMigrationControl(c: ServerMigrationControl): Bytes {
  legacyFieldGuard("serverDomain", c.serverDomain);
  legacyFieldGuard("action", c.action);
  legacyFieldGuard("nonce", c.nonce);
  return new TextEncoder().encode(
    [
      TAG_MIGRATION_CONTROL,
      c.serverDomain.toLowerCase(),
      c.action,
      c.nonce.toLowerCase(),
      c.issuedAt,
    ].join("|"),
  );
}

function canonicalServerMigrationAttach(a: ServerMigrationAttach): Bytes {
  legacyFieldGuard("serverDomain", a.serverDomain);
  legacyFieldGuard("newServerDomain", a.newServerDomain);
  legacyFieldGuard("newStkPubHex", a.newStkPubHex);
  return new TextEncoder().encode(
    [
      TAG_MIGRATION_ATTACH,
      a.serverDomain.toLowerCase(),
      a.newServerDomain.toLowerCase(),
      a.newStkPubHex.toLowerCase(),
      a.issuedAt,
    ].join("|"),
  );
}

function canonicalServerMigrationAck(a: ServerMigrationAck): Bytes {
  legacyFieldGuard("serverDomain", a.serverDomain);
  legacyFieldGuard("stkPubHex", a.stkPubHex);
  legacyFieldGuard("phase", a.phase);
  return new TextEncoder().encode(
    [
      TAG_MIGRATION_ACK,
      a.serverDomain.toLowerCase(),
      a.stkPubHex.toLowerCase(),
      a.phase,
      a.issuedAt,
    ].join("|"),
  );
}

/** Sign with the admin master root (legacy accounts: the owner IRK — the
 *  clean-slate transition gate picks the anchor, not this function). */
export function signServerMigrationOrder(o: ServerMigrationOrder, authority: Keypair): Bytes {
  return ed.sign(canonicalServerMigrationOrder(o), authority.privateKey);
}

export function verifyServerMigrationOrder(
  o: ServerMigrationOrder,
  sig: Bytes,
  authorityPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServerMigrationOrder(o), authorityPub);
  } catch {
    return false;
  }
}

export function signServerMigrationControl(c: ServerMigrationControl, authority: Keypair): Bytes {
  return ed.sign(canonicalServerMigrationControl(c), authority.privateKey);
}

export function verifyServerMigrationControl(
  c: ServerMigrationControl,
  sig: Bytes,
  authorityPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServerMigrationControl(c), authorityPub);
  } catch {
    return false;
  }
}

/** Signed by the NEW box's registered identity (STK) key. */
export function signServerMigrationAttach(a: ServerMigrationAttach, stk: Keypair): Bytes {
  return ed.sign(canonicalServerMigrationAttach(a), stk.privateKey);
}

export function verifyServerMigrationAttach(
  a: ServerMigrationAttach,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServerMigrationAttach(a), stkPub);
  } catch {
    return false;
  }
}

/** Signed by the attached new box's STK key. */
export function signServerMigrationAck(a: ServerMigrationAck, stk: Keypair): Bytes {
  return ed.sign(canonicalServerMigrationAck(a), stk.privateKey);
}

export function verifyServerMigrationAck(
  a: ServerMigrationAck,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServerMigrationAck(a), stkPub);
  } catch {
    return false;
  }
}

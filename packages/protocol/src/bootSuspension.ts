/**
 * Durable boot suspension (SEC-LOCK-001, SEC-DEADMAN-001; plan §5.5, §17.4).
 *
 * A lock or a dead-man lapse must outlive possession of the box. The boot
 * worker keeps one record per server and refuses to release any auto-unlock
 * lease while it says "suspended". Who may change it:
 *
 *   owner (account IRK, or admin root on a pinned account)
 *       may suspend or resume, always by starting a NEW epoch: epoch = current + 1.
 *   box (the registered STK)
 *       may only suspend, inside the CURRENT epoch, as seq = current + 1.
 *       It can never resume, never lower anything, and never advance the epoch,
 *       so a thief holding the box and its key cannot clear a lock or use up
 *       the owner's next epoch number.
 *
 * Reading a missing or unreadable record means suspended, never unlocked.
 *
 * Canonical bytes: `|`-separated, tag first, like every other signed message.
 */

import { ed } from "./edSync.js";
import { assertCanonicalField, hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_BOOT_SUSPENSION = "flagship/boot-suspension/v1";

export type BootSuspensionAction = "suspend" | "resume";
export type BootSuspensionSigner = "owner" | "box";
export type BootSuspensionReason =
  | "manual-lock"
  | "dead-man"
  | "box-fail-closed"
  | "owner-suspend"
  | "owner-resume";

/** Reasons a box may give. A box can never claim an owner reason. */
export const BOX_SUSPENSION_REASONS: readonly BootSuspensionReason[] = ["manual-lock", "dead-man", "box-fail-closed"];
export const OWNER_SUSPENSION_REASONS: readonly BootSuspensionReason[] = ["manual-lock", "dead-man", "owner-suspend", "owner-resume"];

/** Largest counter we accept, so a counter can never be pushed to overflow. */
export const MAX_SUSPENSION_COUNTER = 2 ** 31 - 1;

export interface BootSuspensionOrder {
  serverDomain: string;
  /** Owner-controlled epoch. */
  epoch: number;
  /** Box-controlled counter inside an epoch; always 0 for an owner order. */
  seq: number;
  action: BootSuspensionAction;
  reason: BootSuspensionReason;
  signer: BootSuspensionSigner;
  issuedAt: number;
}

export function canonicalBootSuspension(o: BootSuspensionOrder): Bytes {
  assertCanonicalField(o.serverDomain, "boot-suspension", "serverDomain");
  for (const [n, v] of [["epoch", o.epoch], ["seq", o.seq], ["issuedAt", o.issuedAt]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`boot-suspension: bad ${n}`);
  }
  if (o.action !== "suspend" && o.action !== "resume") throw new Error("boot-suspension: bad action");
  if (o.signer !== "owner" && o.signer !== "box") throw new Error("boot-suspension: bad signer");
  assertCanonicalField(o.reason, "boot-suspension", "reason");
  return new TextEncoder().encode(
    [TAG_BOOT_SUSPENSION, o.serverDomain, o.epoch, o.seq, o.action, o.reason, o.signer, o.issuedAt].join("|"),
  );
}

export function signBootSuspension(o: BootSuspensionOrder, privateKey: Bytes): Bytes {
  return ed.sign(canonicalBootSuspension(o), privateKey);
}

export function verifyBootSuspension(o: BootSuspensionOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBootSuspension(o), pub);
  } catch {
    return false;
  }
}

/** What the boot worker stores and returns. */
export interface BootSuspensionState {
  serverDomain: string;
  epoch: number;
  seq: number;
  suspended: boolean;
  reason: BootSuspensionReason | null;
  /** Who set the current value. */
  signer: BootSuspensionSigner | null;
  /** issuedAt of the order that set it. */
  orderIssuedAt: number;
  /** Server time of the last change. */
  updatedAt: number;
  /** Signature of the order that set the current value, hex (verifiable by the box and phones). */
  signatureHex: string;
}

export type SuspensionRefusal =
  | "stale-epoch"
  | "future-epoch"
  | "stale-seq"
  | "seq-jump"
  | "box-cannot-resume"
  | "box-reason"
  | "owner-reason"
  | "owner-seq"
  | "counter-overflow"
  | "too-soon"
  | "stale-order";

export type SuspensionOutcome =
  | { ok: true; changed: boolean; state: BootSuspensionState }
  | { ok: false; code: SuspensionRefusal; current: BootSuspensionState };

/** The state of a server nobody has ever suspended. */
export function initialSuspension(serverDomain: string): BootSuspensionState {
  return {
    serverDomain,
    epoch: 0,
    seq: 0,
    suspended: false,
    reason: null,
    signer: null,
    orderIssuedAt: 0,
    updatedAt: 0,
    signatureHex: "",
  };
}

/** Minimum gap between two box-signed changes (a stolen key cannot hammer the record). */
export const BOX_SUSPENSION_MIN_GAP_MS = 10_000;
/** How old an order may be when it arrives. */
export const SUSPENSION_MAX_AGE_MS = 5 * 60_000;

/**
 * Apply an ALREADY-VERIFIED order (signature checked by the caller against the
 * right key for `order.signer`). Pure: both storage backends and the tests use it.
 */
export function applyBootSuspension(
  current: BootSuspensionState | null,
  order: BootSuspensionOrder,
  signatureHex: string,
  now: number,
): SuspensionOutcome {
  const cur = current ?? initialSuspension(order.serverDomain);
  const refuse = (code: SuspensionRefusal): SuspensionOutcome => ({ ok: false, code, current: cur });

  if (order.epoch > MAX_SUSPENSION_COUNTER || order.seq > MAX_SUSPENSION_COUNTER) return refuse("counter-overflow");
  if (Math.abs(now - order.issuedAt) > SUSPENSION_MAX_AGE_MS) return refuse("stale-order");

  if (order.signer === "owner") {
    if (!OWNER_SUSPENSION_REASONS.includes(order.reason)) return refuse("owner-reason");
    if (order.seq !== 0) return refuse("owner-seq");
    if (order.epoch <= cur.epoch) return refuse("stale-epoch");
    if (order.epoch !== cur.epoch + 1) return refuse("future-epoch");
    return {
      ok: true,
      changed: true,
      state: {
        serverDomain: order.serverDomain,
        epoch: order.epoch,
        seq: 0,
        suspended: order.action === "suspend",
        reason: order.reason,
        signer: "owner",
        orderIssuedAt: order.issuedAt,
        updatedAt: now,
        signatureHex,
      },
    };
  }

  // Box (STK): set-only, inside the current epoch.
  if (order.action !== "suspend") return refuse("box-cannot-resume");
  if (!BOX_SUSPENSION_REASONS.includes(order.reason)) return refuse("box-reason");
  if (order.epoch < cur.epoch) return refuse("stale-epoch");
  if (order.epoch > cur.epoch) return refuse("future-epoch");
  if (order.seq <= cur.seq) {
    // A retry of something already applied: still suspended, nothing to do.
    return cur.suspended ? { ok: true, changed: false, state: cur } : refuse("stale-seq");
  }
  if (order.seq !== cur.seq + 1) return refuse("seq-jump");
  if (cur.signer === "box" && cur.updatedAt > 0 && now - cur.updatedAt < BOX_SUSPENSION_MIN_GAP_MS) {
    return refuse("too-soon");
  }
  if (cur.suspended) {
    // Already suspended: record the box's later assertion without changing who or why.
    return { ok: true, changed: false, state: cur };
  }
  return {
    ok: true,
    changed: true,
    state: {
      serverDomain: order.serverDomain,
      epoch: cur.epoch,
      seq: order.seq,
      suspended: true,
      reason: order.reason,
      signer: "box",
      orderIssuedAt: order.issuedAt,
      updatedAt: now,
      signatureHex,
    },
  };
}

/** The one question every release path asks. Unknown or unreadable ⇒ suspended. */
export function mayReleaseLease(state: BootSuspensionState | null | undefined): boolean {
  return state !== undefined && state !== null && !state.suspended;
}

/** A never-suspended server has no row; that is not "unknown". Only a read FAILURE is. */
export function suspensionHex(o: BootSuspensionOrder): string {
  return hex(canonicalBootSuspension(o));
}

/**
 * The longest an auto-unlock lease may live on a server with the dead-man
 * switch on: it may not outlast the affirmation that keeps the switch alive.
 * `affirmationDeadline` is the signed lease-expiry the box holds (now + window).
 */
export function maxLeaseExpiryForDeadMan(affirmationDeadline: number, requestedExpiry: number): number {
  return Math.min(requestedExpiry, affirmationDeadline);
}

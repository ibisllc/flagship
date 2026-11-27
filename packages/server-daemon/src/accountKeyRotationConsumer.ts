/**
 * Box-side account master-key rotation (docs/account-key-rotation.md).
 *
 * `.com` serves the account's lane: admin-root rotations and account-key hops, in the order they were
 * made. A hop moves the account from key epoch N to N+1 and is authorised by the admin root pinned at
 * that point, never by an account key (whoever held the old account key holds the old IRK too). The box
 * replays the lane itself from its own pin (verifyAccountKeyRotationChain), and only on a verified hop
 * adopts the new IRK and AID, without a re-pair: membership is re-anchored, the owner key file on /boot
 * and the rotated-key record are rewritten, every owner and companion session ends (their parent is the
 * account, not a device, so a removed device's sessions cannot be told apart), unused pre-deposited
 * backup keys are discarded, and the per-server re-keys are flagged as due.
 *
 * Pin: `<dataDir>/account-key-pin.json` (durable write, 0600): the epoch, IRK, AID and admin root the
 * box trusts and how much of the lane it consumed. A pin that is lost (unreadable) is set aside and
 * replaced by a `lost` marker: until the lane is replayed again from the box's own seed (the IRK its
 * config holds, the recipe's admin root) the epoch is unknown and the box refuses requests signed with
 * the account key. `.com`'s word about the epoch (the doorbell's `keyEpoch`) is only a hint in the
 * safe direction: above the trusted epoch, the same refusal holds until the hop is verified here.
 */
import {
  AccountKeyRotationError,
  verifyAccountKeyRotationChain,
  verifyAdminRootRotation,
  accountKeyRotationDigestHex,
  type AccountKeyChainEvent,
  type AccountKeyRotation,
  type AccountKeyState,
  type PolicyState,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** What this box advertises so clients offer the rotation only on servers that can follow it. */
export const ACCOUNT_KEY_ROTATION_CAPABILITY = "account-key-rotation/v1";

/** The per-server follow-ups a hop leaves to an admin device (and the box's own LUKS step). */
export const REKEY_AFTER_ROTATION = ["cgk", "archive-keys", "bak", "pod-binding", "rck", "luks", "swk"] as const;

function bytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface AccountKeyPin {
  epoch: number;
  irkPubHex: string;
  aidPubHex: string | null;
  /** The admin root after the last lane event consumed. */
  adminRootPubHex: string;
  /** Lane events consumed (admin-root rotations included). */
  laneConsumed: number;
  /** The digest of the last hop applied, checked against the lane on every replay. */
  lastDigestHex: string | null;
  updatedAt: number;
  /** Re-keys an admin device still has to send after a hop. */
  rekeyDue?: string[];
  /** Set while a verified hop's local steps run; a restart runs them again. */
  pendingApply?: AccountKeyHop | null;
}

export interface AccountKeyHop {
  fromEpoch: number;
  toEpoch: number;
  oldIrkPubHex: string;
  newIrkPubHex: string;
  oldAidPubHex: string | null;
  newAidPubHex: string;
  removedDeviceIds: string[];
}

export class AccountKeyPinLostError extends Error {
  constructor(readonly since: number) {
    super("the account-key pin was lost; replay the lane from the box's own seed first");
  }
}

export interface AccountKeyPinStore {
  read(): Promise<AccountKeyPin | null>;
  write(pin: AccountKeyPin): Promise<void>;
}

export function defaultAccountKeyPinPath(dataDir: string): string {
  return `${dataDir}/account-key-pin.json`;
}

export function fileAccountKeyPinStore(path: string, now: () => number = Date.now): AccountKeyPinStore {
  return {
    async read() {
      const r = await readStateFile(path);
      if (r.kind === "missing") return null;
      let p: Partial<AccountKeyPin> & { lost?: unknown; since?: unknown };
      try {
        if (r.kind === "unreadable") throw r.error;
        p = JSON.parse(r.text) as typeof p;
        if (!p || typeof p !== "object") throw new Error("not an account-key pin");
        if (p.lost === true) throw new AccountKeyPinLostError(typeof p.since === "number" ? p.since : 0);
        if (
          typeof p.epoch !== "number" || !Number.isSafeInteger(p.epoch) || p.epoch < 0 ||
          typeof p.irkPubHex !== "string" || !HEX64.test(p.irkPubHex) ||
          typeof p.adminRootPubHex !== "string" || !HEX64.test(p.adminRootPubHex) ||
          typeof p.laneConsumed !== "number"
        ) throw new Error("the pin is incomplete");
      } catch (e) {
        if (e instanceof AccountKeyPinLostError) throw e;
        const since = now();
        await keepCorruptAside(path, e, "This server refuses requests signed with your account key until it has re-checked your account's key changes with Flagship.");
        await writeFileDurable(path, JSON.stringify({ lost: true, since }, null, 2));
        throw new AccountKeyPinLostError(since);
      }
      return {
        epoch: p.epoch,
        irkPubHex: p.irkPubHex,
        aidPubHex: typeof p.aidPubHex === "string" && HEX64.test(p.aidPubHex) ? p.aidPubHex : null,
        adminRootPubHex: p.adminRootPubHex,
        laneConsumed: p.laneConsumed,
        lastDigestHex: typeof p.lastDigestHex === "string" ? p.lastDigestHex : null,
        updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
        ...(Array.isArray(p.rekeyDue) ? { rekeyDue: p.rekeyDue.filter((x): x is string => typeof x === "string") } : {}),
        ...(p.pendingApply ? { pendingApply: p.pendingApply } : {}),
      };
    },
    async write(pin) {
      await writeFileDurable(path, JSON.stringify(pin, null, 2));
    },
  };
}

// ── The lane ─────────────────────────────────────────────────────────────

/** Parses `.com`'s lane strictly into chain events; null when any entry is malformed. */
export function parseLane(raw: unknown): AccountKeyChainEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AccountKeyChainEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") return null;
    const o = e as Record<string, unknown>;
    if (o.kind === "admin-root-rotation") {
      const r = o.rotation as Record<string, unknown> | undefined;
      if (!r || typeof r.username !== "string" || typeof r.oldAdminRootPubHex !== "string" || typeof r.newAdminRootPubHex !== "string" ||
        typeof r.issuedAt !== "number" || typeof o.signatureHex !== "string") return null;
      out.push({
        kind: "admin-root-rotation",
        rotation: { username: r.username, oldAdminRootPubHex: r.oldAdminRootPubHex.toLowerCase(), newAdminRootPubHex: r.newAdminRootPubHex.toLowerCase(), issuedAt: r.issuedAt },
        signatureHex: o.signatureHex.toLowerCase(),
        ...(o.pq !== undefined && o.pq !== null ? { pq: o.pq } : {}),
      });
    } else if (o.kind === "account-key-rotation") {
      if (!o.rotation || typeof o.rotation !== "object" || !o.signatures || typeof o.signatures !== "object") return null;
      out.push({
        kind: "account-key-rotation",
        rotation: o.rotation as AccountKeyRotation,
        signatures: o.signatures as AccountKeyChainEvent extends { signatures: infer S } ? S : never,
        ...(o.pq !== undefined && o.pq !== null ? { pq: o.pq } : {}),
      } as AccountKeyChainEvent);
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Where a box with no pin stands on the lane: just after the last hop whose new IRK is the key it trusts
 * (or at the hop whose old IRK it is). The admin root at that point is replayed from the box's own seed:
 * admin-root rotations that depart from the root held move it (each verified), others are history from
 * before the box. Null when the box's key appears nowhere although the lane has hops.
 */
export function placeOnLane(args: {
  username: string;
  lane: readonly AccountKeyChainEvent[];
  trustedIrkPubHex: string;
  trustedAidPubHex: string | null;
  adminRootSeedHex: string;
}): { start: AccountKeyState; index: number } | null {
  const irk = args.trustedIrkPubHex.toLowerCase();
  let root = args.adminRootSeedHex.toLowerCase();
  const roots: string[] = [];
  let place: { index: number; epoch: number; aid: string | null } | null = null;
  let sawHop = false;
  for (let i = 0; i < args.lane.length; i++) {
    roots.push(root);
    const ev = args.lane[i]!;
    if (ev.kind === "admin-root-rotation") {
      const r = ev.rotation;
      if (r.oldAdminRootPubHex === root && HEX64.test(r.newAdminRootPubHex) && HEX128.test(ev.signatureHex) &&
        verifyAdminRootRotation({ username: args.username, oldAdminRootPub: bytes(root), newAdminRootPub: bytes(r.newAdminRootPubHex), issuedAt: r.issuedAt }, bytes(ev.signatureHex), bytes(root))) {
        root = r.newAdminRootPubHex;
      }
      continue;
    }
    sawHop = true;
    const h = ev.rotation;
    if (h.oldIrkPubHex === irk) place = { index: i, epoch: h.fromEpoch, aid: args.trustedAidPubHex };
    if (h.newIrkPubHex === irk) place = { index: i + 1, epoch: h.toEpoch, aid: h.newAidPubHex };
  }
  roots.push(root);
  if (!place) {
    if (sawHop) return null;
    place = { index: 0, epoch: 0, aid: args.trustedAidPubHex };
  }
  return {
    start: { username: args.username, epoch: place.epoch, irkPubHex: irk, aidPubHex: place.aid ?? args.trustedAidPubHex, adminRootPubHex: roots[place.index]! },
    index: place.index,
  };
}

export interface AccountKeyPq {
  policy: PolicyState;
  bindingFor: (pubHex: string) => VerifiedPqKeyBinding | null;
  now: number;
}

export type ReplayOutcome =
  | { kind: "unchanged"; pin: AccountKeyPin }
  | { kind: "advanced"; pin: AccountKeyPin; hops: AccountKeyHop[] }
  | { kind: "refused"; reason: string };

/**
 * PURE (but for verification): replay the lane from the pin. All or nothing: a bad event anywhere after
 * the pin refuses the whole replay and nothing moves.
 */
export function replayLane(args: {
  username: string;
  pin: AccountKeyPin;
  lane: readonly AccountKeyChainEvent[];
  pq?: AccountKeyPq;
  now: number;
}): ReplayOutcome {
  const { pin, lane } = args;
  if (pin.laneConsumed > lane.length) return { kind: "refused", reason: "lane-shorter-than-pin" };
  if (pin.lastDigestHex) {
    const last = lane.slice(0, pin.laneConsumed).reverse().find((e) => e.kind === "account-key-rotation");
    let digest: string | null = null;
    try {
      digest = last && last.kind === "account-key-rotation" ? accountKeyRotationDigestHex(last.rotation) : null;
    } catch {
      digest = null;
    }
    if (digest !== pin.lastDigestHex) return { kind: "refused", reason: "lane-changed" };
  }
  const events = lane.slice(pin.laneConsumed);
  if (events.length === 0) return { kind: "unchanged", pin };
  const start: AccountKeyState = { username: args.username, epoch: pin.epoch, irkPubHex: pin.irkPubHex, aidPubHex: pin.aidPubHex, adminRootPubHex: pin.adminRootPubHex };
  let result;
  try {
    result = verifyAccountKeyRotationChain({
      start,
      events,
      ...(args.pq ? { pq: { policy: args.pq.policy, adminRootBinding: args.pq.bindingFor(pin.adminRootPubHex), now: args.pq.now } } : {}),
    });
  } catch (e) {
    return { kind: "refused", reason: e instanceof AccountKeyRotationError ? String(e.code) : (e as Error).message };
  }
  const hops: AccountKeyHop[] = [];
  let aid = pin.aidPubHex;
  let lastDigest = pin.lastDigestHex;
  for (const ev of events) {
    if (ev.kind !== "account-key-rotation") continue;
    const r = ev.rotation;
    hops.push({
      fromEpoch: r.fromEpoch, toEpoch: r.toEpoch, oldIrkPubHex: r.oldIrkPubHex, newIrkPubHex: r.newIrkPubHex,
      oldAidPubHex: aid, newAidPubHex: r.newAidPubHex, removedDeviceIds: [...r.removedDeviceIds],
    });
    aid = r.newAidPubHex;
    lastDigest = accountKeyRotationDigestHex(r);
  }
  const next: AccountKeyPin = {
    ...pin,
    epoch: result.state.epoch,
    irkPubHex: result.state.irkPubHex,
    aidPubHex: result.state.aidPubHex ?? aid,
    adminRootPubHex: result.state.adminRootPubHex,
    laneConsumed: lane.length,
    lastDigestHex: lastDigest,
    updatedAt: args.now,
  };
  return hops.length ? { kind: "advanced", pin: next, hops } : { kind: "unchanged", pin: next };
}

// ── The epoch gate ───────────────────────────────────────────────────────

export interface AccountKeyEpochStatus {
  /** The epoch this box verified itself, or null while its pin is lost. */
  trustedEpoch: number | null;
  /** The highest epoch `.com` reported (a hint). */
  hintedEpoch: number | null;
  /** True while requests signed with the account key are refused here. */
  holdingOwnerKey: boolean;
  rekeyDue: string[];
  lastError: string | null;
  capability: string;
}

/**
 * One gate the daemon's account-key checks ask: while the box's epoch is unknown (pin lost) or `.com`
 * reports a higher one than the box verified, the IRK the box holds may be the one an admin just
 * replaced, so nothing signed with it is accepted until the replay catches up.
 */
export class AccountKeyEpochGate {
  private armed = false;
  private trusted: number | null = null;
  private hinted: number | null = null;
  private lastError: string | null = null;
  private due: string[] = [];

  /** Only a box that follows the lane (it pins an admin root) ever holds the account key back. */
  arm(): void {
    this.armed = true;
  }

  setTrusted(epoch: number | null, rekeyDue: readonly string[] = this.due): void {
    this.trusted = epoch;
    this.due = [...rekeyDue];
  }

  /** The doorbell's `keyEpoch`. Only ever raises the hint. */
  hint(epoch: unknown): void {
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return;
    if (this.hinted === null || epoch > this.hinted) this.hinted = epoch;
  }

  setError(e: string | null): void {
    this.lastError = e;
  }

  ownerKeyHeld(): boolean {
    if (!this.armed) return false;
    if (this.trusted === null) return true;
    return this.hinted !== null && this.hinted > this.trusted;
  }

  /** A deposit consumer's `guard`: refuses to claim while the owner key is held. */
  readonly guard = async <T>(claim: () => Promise<T>): Promise<T> => {
    if (this.ownerKeyHeld()) throw new Error("the account key is changing; this server waits until it has verified the change");
    return claim();
  };

  status(): AccountKeyEpochStatus {
    return {
      trustedEpoch: this.trusted,
      hintedEpoch: this.hinted,
      holdingOwnerKey: this.ownerKeyHeld(),
      rekeyDue: [...this.due],
      lastError: this.lastError,
      capability: ACCOUNT_KEY_ROTATION_CAPABILITY,
    };
  }
}

// ── The consumer ─────────────────────────────────────────────────────────

export interface AccountKeyRotationHooks {
  /** Re-anchor every installed app's membership from the old IRK to the new one; the rows rewritten. */
  reissueStableIds(oldIrkPubHex: string, newIrkPubHex: string): Promise<number>;
  /** The rotated-key record beside the config and the owner key file on /boot. */
  persistIrk(newIrkPubHex: string): Promise<void>;
  /** End every owner and companion session (their parent is the account, not a device). */
  clearOwnerSessions(): Promise<number>;
  /** Drop the unused pre-deposited backup keys (made under the old account key). */
  discardArchiveKeys(): Promise<number>;
  /** Activity (`account.key.rotated`). */
  note(kind: string, detail: string, ok: boolean): void;
  restart(reason: string): void;
}

export interface AccountKeyRotationConsumerOptions {
  username: string;
  /** The IRK and AID the box's config holds (its seed when no pin exists). */
  configIrkPubHex: string;
  configAidPubHex: string | null;
  /** The recipe's admin root (the admin-root seed), and the root the box pins now. */
  adminRootSeedHex: string;
  controlPlaneBaseUrl: string;
  /** The box's read-token fetch (doorbell-wrapped): the lane is an account read. */
  fetchImpl: typeof fetch;
  pinStore: AccountKeyPinStore;
  gate: AccountKeyEpochGate;
  hooks: AccountKeyRotationHooks;
  pq?: () => AccountKeyPq | null;
  now?: () => number;
  log?: (m: string) => void;
}

export type AccountKeyPollOutcome =
  | { kind: "no-change"; epoch: number }
  | { kind: "rotated"; fromEpoch: number; toEpoch: number }
  | { kind: "error"; reason: string };

async function fetchLane(o: AccountKeyRotationConsumerOptions): Promise<{ keyEpoch: number; lane: AccountKeyChainEvent[] } | string> {
  const url = `${o.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/users/${encodeURIComponent(o.username)}/account-key-rotations`;
  try {
    const res = await o.fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { keyEpoch: 0, lane: [] };
    if (!res.ok) return `lane GET ${res.status}`;
    const body = (await res.json()) as { keyEpoch?: unknown; lane?: unknown };
    const lane = parseLane(body.lane);
    if (!lane) return "malformed lane";
    return { keyEpoch: typeof body.keyEpoch === "number" ? body.keyEpoch : 0, lane };
  } catch (e) {
    return `lane GET failed: ${(e as Error).message}`;
  }
}

/** The box's local steps for verified hops. Safe to run again after a crash (the pin keeps them pending). */
async function applyHops(o: AccountKeyRotationConsumerOptions, hops: AccountKeyHop[]): Promise<{ rewritten: number; sessions: number; keys: number }> {
  const first = hops[0]!;
  const last = hops[hops.length - 1]!;
  let rewritten = 0;
  for (const h of hops) rewritten += await o.hooks.reissueStableIds(h.oldIrkPubHex, h.newIrkPubHex);
  await o.hooks.persistIrk(last.newIrkPubHex);
  const sessions = await o.hooks.clearOwnerSessions();
  const keys = await o.hooks.discardArchiveKeys();
  const removed = new Set(hops.flatMap((h) => h.removedDeviceIds)).size;
  o.hooks.note(
    "account.key.rotated",
    `Your account key changed (epoch ${first.fromEpoch} to ${last.toEpoch}). ${removed} device${removed === 1 ? "" : "s"} removed; ` +
      `${sessions} browser session${sessions === 1 ? "" : "s"} ended; ${rewritten} membership row${rewritten === 1 ? "" : "s"} re-anchored; ` +
      `${keys} unused backup key${keys === 1 ? "" : "s"} discarded. Re-keys due: ${REKEY_AFTER_ROTATION.join(", ")}.`,
    true,
  );
  return { rewritten, sessions, keys };
}

export async function pollAccountKeyRotations(o: AccountKeyRotationConsumerOptions): Promise<AccountKeyPollOutcome> {
  const now = (o.now ?? Date.now)();
  const log = o.log ?? (() => {});
  let pin: AccountKeyPin | null;
  let lost = false;
  try {
    pin = await o.pinStore.read();
  } catch (e) {
    if (!(e instanceof AccountKeyPinLostError)) {
      o.gate.setTrusted(null);
      o.gate.setError((e as Error).message);
      return { kind: "error", reason: (e as Error).message };
    }
    pin = null;
    lost = true;
    o.gate.setTrusted(null);
  }
  if (pin?.pendingApply) {
    // A verified hop whose local steps a restart interrupted: run them again, then clear the mark.
    await applyHops(o, [pin.pendingApply]);
    pin = { ...pin, pendingApply: null };
    await o.pinStore.write(pin);
  }
  if (pin) o.gate.setTrusted(pin.epoch, pin.rekeyDue ?? []);
  const onDisk = pin !== null;

  const fetched = await fetchLane(o);
  if (typeof fetched === "string") {
    o.gate.setError(fetched);
    return { kind: "error", reason: fetched };
  }
  o.gate.hint(fetched.keyEpoch);

  if (!pin) {
    const placed = placeOnLane({
      username: o.username.toLowerCase(),
      lane: fetched.lane,
      trustedIrkPubHex: o.configIrkPubHex,
      trustedAidPubHex: o.configAidPubHex,
      adminRootSeedHex: o.adminRootSeedHex,
    });
    if (!placed) {
      const reason = "this server's account key is not on the account's lane: it waits for an admin device";
      o.gate.setError(reason);
      log(`[account-key] ${reason}`);
      return { kind: "error", reason };
    }
    let lastDigestHex: string | null = null;
    const before = fetched.lane.slice(0, placed.index).reverse().find((e) => e.kind === "account-key-rotation");
    if (before && before.kind === "account-key-rotation") lastDigestHex = accountKeyRotationDigestHex(before.rotation);
    pin = {
      epoch: placed.start.epoch, irkPubHex: placed.start.irkPubHex, aidPubHex: placed.start.aidPubHex ?? null,
      adminRootPubHex: placed.start.adminRootPubHex, laneConsumed: placed.index, lastDigestHex, updatedAt: now,
    };
    if (lost) log(`[account-key] lost pin: placed this server at epoch ${pin.epoch} from its own key`);
  }

  const out = replayLane({ username: o.username.toLowerCase(), pin, lane: fetched.lane, ...(o.pq?.() ? { pq: o.pq()! } : {}), now });
  if (out.kind === "refused") {
    o.gate.setTrusted(lost ? null : pin.epoch, pin.rekeyDue ?? []);
    o.gate.setError(`refused the account's key lane: ${out.reason}`);
    log(`[account-key] refused the lane (${out.reason}); nothing changed`);
    return { kind: "error", reason: out.reason };
  }
  o.gate.setError(null);
  if (out.kind === "unchanged") {
    const changed = out.pin.laneConsumed !== pin.laneConsumed || out.pin.adminRootPubHex !== pin.adminRootPubHex;
    if (changed || !onDisk) await o.pinStore.write(out.pin);
    o.gate.setTrusted(out.pin.epoch, out.pin.rekeyDue ?? []);
    return { kind: "no-change", epoch: out.pin.epoch };
  }
  // A verified advance: one combined hop for the local steps, written as pending before any of them.
  const first = out.hops[0]!;
  const last = out.hops[out.hops.length - 1]!;
  const combined: AccountKeyHop = {
    fromEpoch: first.fromEpoch, toEpoch: last.toEpoch, oldIrkPubHex: first.oldIrkPubHex, newIrkPubHex: last.newIrkPubHex,
    oldAidPubHex: first.oldAidPubHex, newAidPubHex: last.newAidPubHex, removedDeviceIds: [...new Set(out.hops.flatMap((h) => h.removedDeviceIds))],
  };
  const rekeyDue = [...new Set([...(pin.rekeyDue ?? []), ...REKEY_AFTER_ROTATION])];
  await o.pinStore.write({ ...out.pin, rekeyDue, pendingApply: combined });
  await applyHops(o, out.hops);
  await o.pinStore.write({ ...out.pin, rekeyDue, pendingApply: null });
  o.gate.setTrusted(out.pin.epoch, rekeyDue);
  log(`[account-key] verified epoch ${combined.fromEpoch} -> ${combined.toEpoch}; restarting under the new account key`);
  o.hooks.restart("account key rotated; restarting under the new account key");
  return { kind: "rotated", fromEpoch: combined.fromEpoch, toEpoch: combined.toEpoch };
}

/**
 * What the daemon reads at boot, before wiring anything that checks the account key: the pin's IRK and AID
 * override the config's (null when there is no pin; `lost` when it is unreadable, so the gate holds).
 */
export async function resolvePinnedAccountKeys(store: AccountKeyPinStore): Promise<{ irkPubHex: string; aidPubHex: string | null; epoch: number; rekeyDue: string[] } | null | "lost"> {
  try {
    const p = await store.read();
    return p ? { irkPubHex: p.irkPubHex, aidPubHex: p.aidPubHex, epoch: p.epoch, rekeyDue: p.rekeyDue ?? [] } : null;
  } catch {
    return "lost";
  }
}

export interface AccountKeyRotationPoller {
  pollOnce(): Promise<AccountKeyPollOutcome>;
  start(): void;
  stop(): void;
}

export function buildAccountKeyRotationPoller(o: AccountKeyRotationConsumerOptions & { intervalMs?: number }): AccountKeyRotationPoller {
  const intervalMs = o.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<AccountKeyPollOutcome> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const pollOnce = (): Promise<AccountKeyPollOutcome> => {
    if (running) return running;
    running = pollAccountKeyRotations(o)
      .catch((e: Error): AccountKeyPollOutcome => ({ kind: "error", reason: e.message }))
      .then((r) => {
        if (r.kind === "rotated") stop();
        return r;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  return {
    pollOnce,
    start() {
      if (timer) return;
      void pollOnce();
      timer = setInterval(() => void pollOnce(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}

/**
 * Enterprise orgs on the box (docs/enterprise-accounts.md §6, §8; phase E3): pin the org authority
 * record's genesis, replay its chain from `.com` itself, keep the seat book, decide org orders, and
 * hand seat offboarding to the hooks that rotate what a departed seat could have held.
 *
 * Like the admin-root pin, `.com` is never trusted: the box verifies the whole chain from the
 * genesis hash in its config, refuses a served chain that does not extend the one it pinned (a
 * fork or a rollback), and keeps the verified objects on disk so a restart works offline. Freezes,
 * overturns, vetoes, grants and revokes are re-verified on every load.
 */
import {
  authorizeOrgOrder,
  buildOrgSeatBook,
  orgAuthorityHash,
  orgSeatForKey,
  orgSeatRank,
  verifyOrgAuthorityChain,
  type OrgAction,
  type OrgApproval,
  type OrgAuthorityEntry,
  type OrgAuthorityState,
  type OrgOverturn,
  type OrgSeatBook,
  type OrgSeatFreeze,
  type OrgSeatGrantBundle,
  type OrgSeatRevokeBundle,
  type OrgSigned,
  type OrgVeto,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";

export interface OrgPinFile {
  v: 1;
  orgId: string;
  genesisHash: string;
  entries: OrgAuthorityEntry[];
  freezes: OrgSigned<OrgSeatFreeze>[];
  overturns: OrgSigned<OrgOverturn>[];
  vetoes: OrgSigned<OrgVeto>[];
  grants: OrgSeatGrantBundle[];
  revokes: OrgSeatRevokeBundle[];
  /** When `.com` observed each delayed-change notice open, by its sha256 (the first time this box saw wins). */
  noticeOpenedAt?: Record<string, number>;
  /** Seats whose departure still needs a rotation, and what is left to rotate. */
  rotationsPending: OrgRotationPending[];
  syncedAt: number;
}

/** What a departed seat could have held (§5.4, §8); disk keys only where it had unlock at boot. */
export type OrgRotationKind = "cgk" | "directory-key" | "archive-keys" | "disk-key";

export interface OrgRotationPending {
  seatId: string;
  left: number;
  remaining: OrgRotationKind[];
}

export interface OrgPinned {
  file: OrgPinFile;
  state: OrgAuthorityState;
  book: OrgSeatBook;
}

export class OrgPinError extends Error {
  constructor(
    readonly code: "fork" | "rollback" | "wrong-org" | "corrupt",
    message: string,
  ) {
    super(message);
  }
}

/** Verifies a pin file's objects from the genesis the box was installed with. */
export function verifyOrgPin(file: OrgPinFile, expected: { orgId: string; genesisHash: string }, now: number): OrgPinned {
  if (file.orgId !== expected.orgId || file.genesisHash !== expected.genesisHash) throw new OrgPinError("wrong-org", "the pin names another org");
  const state = verifyOrgAuthorityChain(file.entries, {
    genesisHash: expected.genesisHash,
    now,
    freezes: file.freezes,
    overturns: file.overturns,
    vetoes: file.vetoes,
    noticeOpenedAt: file.noticeOpenedAt ?? {},
  });
  if (state.orgId !== expected.orgId) throw new OrgPinError("wrong-org", "the chain names another org");
  const book = buildOrgSeatBook(state, { grants: file.grants, revokes: file.revokes, freezes: file.freezes, overturns: file.overturns, now });
  return { file, state, book };
}

export interface OrgPinStore {
  read(): Promise<OrgPinFile | null>;
  write(file: OrgPinFile): Promise<void>;
}

export function fileOrgPinStore(path: string): OrgPinStore {
  return {
    async read() {
      const r = await readStateFile(path);
      if (r.kind === "missing") return null;
      if (r.kind === "unreadable") throw new OrgPinError("corrupt", String(r.error));
      try {
        const f = JSON.parse(r.text) as OrgPinFile;
        if (f?.v !== 1 || !Array.isArray(f.entries)) throw new Error("shape");
        return f;
      } catch (e) {
        await keepCorruptAside(path, e, "the org's authority is replayed from its genesis at the next sync; until then org orders are refused");
        throw new OrgPinError("corrupt", "org pin unreadable");
      }
    },
    async write(file) {
      await writeFileDurable(path, JSON.stringify(file));
    },
  };
}

/** What `.com` serves: `GET /api/orgs/<id>/authority` and `GET /api/orgs/<id>/seats`. */
export interface OrgServed {
  entries: OrgAuthorityEntry[];
  freezes: OrgSigned<OrgSeatFreeze>[];
  overturns: OrgSigned<OrgOverturn>[];
  vetoes: OrgSigned<OrgVeto>[];
  grants: OrgSeatGrantBundle[];
  revokes: OrgSeatRevokeBundle[];
  noticeOpenedAt?: Record<string, number>;
}

export interface OrgSyncResult {
  pinned: OrgPinned;
  changed: boolean;
  /** Seats that were live before this sync and are not now (revoked, left, lapsed). */
  departed: string[];
}

const keyOf = (o: unknown) => JSON.stringify(o);

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  const seen = new Set(a.map(keyOf));
  return [...a, ...b.filter((x) => !seen.has(keyOf(x)))];
}

function observedTimes(m: unknown): Record<string, number> {
  if (!m || typeof m !== "object") return {};
  return Object.fromEntries(
    Object.entries(m as Record<string, unknown>).filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && typeof v === "number" && Number.isSafeInteger(v) && v >= 0),
  ) as Record<string, number>;
}

/**
 * Adopts what `.com` served when it extends the pinned chain. Freezes, overturns, vetoes and
 * revokes are merged (a `.com` that drops one cannot undo it on this box); grants are replaced by
 * the served set plus what the box held, and the seat book decides which win. The chain itself
 * must keep every pinned version byte for byte.
 */
export function mergeOrgServed(
  prev: OrgPinned | null,
  served: OrgServed,
  expected: { orgId: string; genesisHash: string },
  now: number,
  admitNewSeat?: (grantIssuedAt: number, liveSeats: number) => boolean,
): OrgSyncResult {
  const old = prev?.file;
  if (admitNewSeat && prev) {
    // The Business plan's backstop (orgPlanCheck.ts): a seat new to this box waits while the org's plan can't take it;
    // `.com` serves its grant again on the next sync, so it joins once the plan allows.
    let live = liveSeats(prev.book, now).size;
    const known = new Set(prev.book.seats.keys());
    const grants: OrgSeatGrantBundle[] = [];
    for (const g of served.grants) {
      const seat = g.grant.seatId;
      if (known.has(seat) || prev.book.revoked.has(seat)) grants.push(g);
      else if (admitNewSeat(g.grant.issuedAt, live)) {
        grants.push(g);
        known.add(seat);
        live++;
      }
    }
    served = { ...served, grants };
  }
  if (old) {
    if (served.entries.length < old.entries.length) throw new OrgPinError("rollback", "the served chain is shorter than the pinned one");
    for (let i = 0; i < old.entries.length; i++) {
      if (orgAuthorityHash(old.entries[i]!.record) !== orgAuthorityHash(served.entries[i]!.record)) throw new OrgPinError("fork", `the served chain differs at version ${i}`);
    }
  }
  const file: OrgPinFile = {
    v: 1,
    orgId: expected.orgId,
    genesisHash: expected.genesisHash,
    entries: old ? [...old.entries, ...served.entries.slice(old.entries.length)] : served.entries,
    freezes: union(old?.freezes ?? [], served.freezes),
    overturns: union(old?.overturns ?? [], served.overturns),
    vetoes: union(old?.vetoes ?? [], served.vetoes),
    grants: union(old?.grants ?? [], served.grants),
    revokes: union(old?.revokes ?? [], served.revokes),
    // An observed open time this box already holds stays: a `.com` that later serves another cannot move a window.
    noticeOpenedAt: { ...observedTimes(served.noticeOpenedAt), ...(old?.noticeOpenedAt ?? {}) },
    rotationsPending: old?.rotationsPending ?? [],
    syncedAt: now,
  };
  let pinned: OrgPinned;
  try {
    pinned = verifyOrgPin(file, expected, now);
  } catch (e) {
    if (!prev) throw e;
    const kept = { ...file, entries: old!.entries };
    pinned = verifyOrgPin(kept, expected, now);
  }
  const before = prev ? liveSeats(prev.book, now) : new Set<string>();
  const after = liveSeats(pinned.book, now);
  const departed = [...before].filter((s) => !after.has(s));
  const changed = !old || keyOf(old.entries) !== keyOf(pinned.file.entries) || departed.length > 0 || keyOf(old.grants) !== keyOf(pinned.file.grants);
  return { pinned, changed, departed };
}

function liveSeats(book: OrgSeatBook, now: number): Set<string> {
  return new Set([...book.seats.values()].filter((s) => !book.revoked.has(s.seatId) && s.grant.expiresAt > now).map((s) => s.seatId));
}

/** The box-local effects of a seat leaving, run in order; each throws to stay pending. */
export interface OrgOffboardingHooks {
  /** Close the seat's paired sessions and app sessions on this box. */
  closeSessions(seatId: string): Promise<void>;
  /** Drop per-app ids the seat enrolled as itself from every app's list (§10). */
  dropEnrolledAppIds(seatId: string): Promise<void>;
  /** Stop invites the seat created from admitting new people. */
  freezeInvitesBy(seatId: string): Promise<void>;
  /** Start a rotation; resolves true once it is done on this box (the org's clients finish it). */
  rotate(kind: OrgRotationKind, seatId: string): Promise<boolean>;
}

/** What to rotate after `seatId` leaves; the disk key only on servers where it could unlock at boot. */
export function orgRotationsFor(pinned: OrgPinned | null, seatId: string, serverDomain: string): OrgRotationKind[] {
  const out: OrgRotationKind[] = ["cgk", "directory-key", "archive-keys"];
  const seat = pinned?.book.seats.get(seatId);
  const grants = pinned?.file.grants.filter((g) => g.grant.seatId === seatId) ?? [];
  const unlock = [...(seat ? [seat.roles] : []), ...grants.map((g) => g.roles)].some((roles) =>
    roles.some((r) => r.role === "unlock" && r.servers.includes(serverDomain)),
  );
  if (unlock) out.push("disk-key");
  return out;
}

/**
 * Runs the offboarding hooks for every departed seat and keeps what is not finished in
 * `rotationsPending`, so the next sync retries and the console can say "Key rotation pending".
 */
export async function runOrgOffboarding(
  prev: OrgPinned | null,
  result: OrgSyncResult,
  hooks: OrgOffboardingHooks,
  serverDomain: string,
  now: number,
): Promise<OrgRotationPending[]> {
  const pending = new Map(result.pinned.file.rotationsPending.map((p) => [p.seatId, p]));
  for (const seatId of result.departed) {
    await hooks.closeSessions(seatId).catch(() => undefined);
    await hooks.dropEnrolledAppIds(seatId).catch(() => undefined);
    await hooks.freezeInvitesBy(seatId).catch(() => undefined);
    if (!pending.has(seatId)) pending.set(seatId, { seatId, left: now, remaining: orgRotationsFor(prev, seatId, serverDomain) });
  }
  for (const p of pending.values()) {
    const left: OrgRotationKind[] = [];
    for (const kind of p.remaining) {
      const done = await hooks.rotate(kind, p.seatId).catch(() => false);
      if (!done) left.push(kind);
    }
    if (left.length === 0) pending.delete(p.seatId);
    else pending.set(p.seatId, { ...p, remaining: left });
  }
  result.pinned.file.rotationsPending = [...pending.values()];
  return result.pinned.file.rotationsPending;
}

export interface OrgSyncDeps {
  orgId: string;
  genesisHash: string;
  serverDomain: string;
  store: OrgPinStore;
  fetchServed: () => Promise<OrgServed>;
  hooks: OrgOffboardingHooks;
  now: () => number;
  /** The org plan's seat backstop (OrgPlanCheck.admitsNewSeat). */
  admitNewSeat?: (grantIssuedAt: number, liveSeats: number) => boolean;
}

/** One sync: fetch, verify, merge, offboard, persist. Returns the pin the box uses for decisions. */
export async function syncOrgAuthority(deps: OrgSyncDeps, prev: OrgPinned | null): Promise<OrgPinned> {
  const now = deps.now();
  const expected = { orgId: deps.orgId, genesisHash: deps.genesisHash };
  const result = mergeOrgServed(prev, await deps.fetchServed(), expected, now, deps.admitNewSeat);
  await runOrgOffboarding(prev, result, deps.hooks, deps.serverDomain, now);
  await deps.store.write(result.pinned.file);
  return result.pinned;
}

/** Loads the pin from disk (verified again), or null when there is none yet. */
export async function loadOrgPin(store: OrgPinStore, expected: { orgId: string; genesisHash: string }, now: number): Promise<OrgPinned | null> {
  const f = await store.read();
  return f ? verifyOrgPin(f, expected, now) : null;
}

/**
 * The org branch of the sensitive-order gate: true only when the approvals authorize the order
 * for the action under the pinned chain and seat book. No pin = refused.
 */
export function authorizeOrgSensitiveOrder(
  pinned: OrgPinned | null,
  action: OrgAction,
  order: Uint8Array,
  approvals: readonly OrgApproval[],
  now: number,
): { ok: true; signers: string[]; scopedSeat: string | null } | { ok: false; code: string } {
  if (!pinned) return { ok: false, code: "org-not-pinned" };
  try {
    return { ok: true, ...authorizeOrgOrder({ state: pinned.state, book: pinned.book, action, order, approvals, now }) };
  } catch (e) {
    return { ok: false, code: `org-${(e as { code?: string }).code ?? "malformed"}` };
  }
}

/** The sign-in class of a key on an org box: a live seat and its default rank in this app, or null. */
export function orgSignIn(
  pinned: OrgPinned | null,
  ed25519PubHex: string,
  server: string,
  serviceRef: string,
  now: number,
): { seatId: string; rank: "member" | "manager" | "master" } | null {
  if (!pinned) return null;
  const seat = orgSeatForKey(pinned.book, ed25519PubHex, now);
  if (!seat) return null;
  if (pinned.book.freezes.some((f) => f.seatId === seat.seatId && f.issuedAt <= now && now < f.untilMs)) return null;
  return { seatId: seat.seatId, rank: orgSeatRank(pinned.state, seat, server, serviceRef) };
}

let current: OrgPinned | null = null;

/** The pin the box decides org orders with (null on a non-org box or before the first sync). */
export function currentOrgPin(): OrgPinned | null {
  return current;
}

export const ORG_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Arms the org sync on an org server: loads the pin from disk (offline restart), then fetches the
 * chain and seat book from `.com` every 5 minutes and on demand (`pollOnce`, e.g. when an unknown
 * key signs). A failed sync keeps the last verified pin.
 */
export async function startOrgAuthoritySync(opts: {
  orgId: string;
  genesisHash: string;
  serverDomain: string;
  controlPlaneBaseUrl: string;
  pinPath: string;
  hooks: OrgOffboardingHooks;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
  admitNewSeat?: (grantIssuedAt: number, liveSeats: number) => boolean;
}): Promise<{ pollOnce: () => Promise<void>; stop: () => void }> {
  const now = opts.now ?? (() => Date.now());
  const f = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => undefined);
  const store = fileOrgPinStore(opts.pinPath);
  const expected = { orgId: opts.orgId, genesisHash: opts.genesisHash };
  try {
    current = await loadOrgPin(store, expected, now());
  } catch (e) {
    log(`[org] pin not loaded: ${(e as Error).message}`);
  }
  const base = `${opts.controlPlaneBaseUrl.replace(/\/$/, "")}/api/orgs/${opts.orgId}`;
  const getJson = async (path: string) => {
    const r = await f(`${base}/${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  };
  let running = false;
  const pollOnce = async () => {
    if (running) return;
    running = true;
    try {
      current = await syncOrgAuthority(
        {
          ...expected,
          serverDomain: opts.serverDomain,
          store,
          hooks: opts.hooks,
          now,
          ...(opts.admitNewSeat ? { admitNewSeat: opts.admitNewSeat } : {}),
          fetchServed: async () => {
            const [a, s] = await Promise.all([getJson("authority"), getJson("seats")]);
            return {
              entries: (a.entries ?? []) as OrgServed["entries"],
              freezes: (a.freezes ?? []) as OrgServed["freezes"],
              overturns: (a.overturns ?? []) as OrgServed["overturns"],
              vetoes: (a.vetoes ?? []) as OrgServed["vetoes"],
              grants: (s.grants ?? []) as OrgServed["grants"],
              revokes: (s.revokes ?? []) as OrgServed["revokes"],
              noticeOpenedAt: (a.noticeOpenedAt ?? {}) as Record<string, number>,
            };
          },
        },
        current,
      );
    } catch (e) {
      log(`[org] sync kept the last verified pin: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void pollOnce(), ORG_SYNC_INTERVAL_MS);
  t.unref?.();
  void pollOnce();
  return { pollOnce, stop: () => clearInterval(t) };
}

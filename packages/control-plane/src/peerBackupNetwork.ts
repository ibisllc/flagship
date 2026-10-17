/**
 * `.com`'s side of peer backup between accounts (docs/peer-backup.md):
 * holder check-ins and presence, filler and its challenges, the directory,
 * blind space tokens and their redemption, and the sealed roots a restore
 * starts from.
 *
 * Everything here is box → `.com`, signed by the box's STK against the
 * server directory. `.com` learns who takes part and how much each server
 * pledges and proves; the matching itself happens on the owner box, and
 * token redemption can't be tied to the box the token was issued to.
 */
import { sha256 } from "@noble/hashes/sha256";
import {
  canonicalPbCheckin,
  canonicalPbDirectory,
  canonicalPbFillerFetch,
  canonicalPbFillerProof,
  canonicalPbPikBind,
  canonicalPbRedeem,
  canonicalPbRootDeposit,
  canonicalPbTokens,
  ed,
  blindPrepare,
  pbAccountTag,
  pbBlindedDigest,
  pbFillerAnswer,
  pbFillerBytes,
  pbFillerKey,
  pbNetTag,
  pbNetworkPrefix,
  pbSpendsDigest,
  pbTokenMessage,
  rsaBlindSign,
  rsaPssVerify,
  rsaPublicKeyToJwk,
  type PbNetwork,
  type PbSpend,
  type RsaPrivateKey,
} from "@flagship/protocol";
import type { ServerStorage } from "@flagship/storage";
import { bytesToHex, hexToBytes } from "./hex.js";
import { forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

export const PB_FRESHNESS_MS = 10 * 60_000;
export const PB_CHECKIN_LIVE_MS = 24 * 60 * 60_000;
export const PB_CHALLENGE_EVERY_MS = 60 * 60_000;
export const PB_CHALLENGE_DEADLINE_MS = 120_000;
export const PB_FILLER_BYTES_PER_DAY = 25 * 1024 ** 3;
export const PB_FILLER_REFETCH_MS = 15 * 60_000;
export const PB_TOKEN_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const PB_TOKEN_STARTER = 8;
export const PB_TOKENS_PER_CALL = 256;
export const PB_ROOTS_KEPT = 8;
export const PB_ROOT_MAX_HEX = 1_500_000;
const RING_HOURS = 720;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOT_SET_UP = "Peer backup between accounts isn't set up on this server yet.";

// ──────────────────────────────────────────────────────────────────────
// Storage
// ──────────────────────────────────────────────────────────────────────

export interface PbPendingChallenge {
  id: string;
  index: number;
  leaf: number;
  nonceHex: string;
  issuedAt: number;
}

export interface PbHolderRow {
  pikPubHex: string;
  serverDomain: string;
  username: string;
  xPubHex: string;
  poolBytes: number;
  accountTag: string;
  netTag: string;
  registeredAt: number;
  lastCheckinAt: number;
  /** 720 hour bits (hex, 180 chars): bit h % 720 set when the holder checked in during hour h. */
  presenceHex: string;
  presenceLastHour: number;
  fillerCount: number;
  /** When `fillerCount - 1` was served (a broken download may fetch it again for a while). */
  fillerLastAt: number;
  fillerDay: number;
  fillerDayBytes: number;
  pending: PbPendingChallenge | null;
  lastChallengeAt: number;
  /** Decayed counts (×0.97 a day). */
  proofsOk: number;
  proofsFailed: number;
  proofsDay: number;
  leaving: boolean;
}

export interface PbRootRow {
  serverDomain: string;
  username: string;
  generation: number;
  revision: number;
  storedAt: number;
  nonceHex: string;
  ciphertextHex: string;
}

export interface PbNetStore {
  holderByServer(serverDomain: string): Promise<PbHolderRow | null>;
  holderByPik(pikPubHex: string): Promise<PbHolderRow | null>;
  putHolder(row: PbHolderRow): Promise<void>;
  listHolders(): Promise<PbHolderRow[]>;
  /** Set a lease's slots and expiry (opening or renewing it). */
  putLease(pikPubHex: string, leaseId: string, slots: number, expiresAt: number): Promise<void>;
  liveLeaseSlots(pikPubHex: string, now: number): Promise<number>;
  /** False when the serial was already spent. */
  spendSerial(serialSha256Hex: string, pikPubHex: string, at: number): Promise<boolean>;
  tokensIssuedSince(serverDomain: string, since: number): Promise<number>;
  recordIssue(serverDomain: string, at: number, count: number): Promise<void>;
  latestRoot(serverDomain: string): Promise<PbRootRow | null>;
  listRoots(serverDomain: string): Promise<PbRootRow[]>;
  /** Insert, then keep the newest `keep` for that server. */
  putRoot(row: PbRootRow, keep: number): Promise<void>;
}

export class InMemoryPbNetStore implements PbNetStore {
  holders = new Map<string, PbHolderRow>();
  leases = new Map<string, { pik: string; slots: number; expiresAt: number }>();
  serials = new Map<string, string>();
  issues: Array<{ serverDomain: string; at: number; count: number }> = [];
  roots: PbRootRow[] = [];

  async holderByServer(d: string) {
    for (const h of this.holders.values()) if (h.serverDomain === d) return structuredClone(h);
    return null;
  }
  async holderByPik(p: string) {
    const h = this.holders.get(p);
    return h ? structuredClone(h) : null;
  }
  async putHolder(row: PbHolderRow) {
    this.holders.set(row.pikPubHex, structuredClone(row));
  }
  async listHolders() {
    return [...this.holders.values()].map((h) => structuredClone(h));
  }
  async putLease(pik: string, leaseId: string, slots: number, expiresAt: number) {
    this.leases.set(`${pik}/${leaseId}`, { pik, slots, expiresAt });
  }
  async liveLeaseSlots(pik: string, now: number) {
    let n = 0;
    for (const l of this.leases.values()) if (l.pik === pik && l.expiresAt > now) n += l.slots;
    return n;
  }
  async spendSerial(h: string, pik: string) {
    if (this.serials.has(h)) return false;
    this.serials.set(h, pik);
    return true;
  }
  async tokensIssuedSince(d: string, since: number) {
    return this.issues.filter((i) => i.serverDomain === d && i.at >= since).reduce((n, i) => n + i.count, 0);
  }
  async recordIssue(d: string, at: number, count: number) {
    this.issues.push({ serverDomain: d, at, count });
  }
  async latestRoot(d: string) {
    const r = (await this.listRoots(d))[0];
    return r ?? null;
  }
  async listRoots(d: string) {
    return this.roots
      .filter((r) => r.serverDomain === d)
      .sort((a, b) => b.generation - a.generation || b.revision - a.revision)
      .map((r) => ({ ...r }));
  }
  async putRoot(row: PbRootRow, keep: number) {
    this.roots.push({ ...row });
    const mine = await this.listRoots(row.serverDomain);
    const drop = new Set(mine.slice(keep).map((r) => `${r.generation}/${r.revision}`));
    this.roots = this.roots.filter((r) => r.serverDomain !== row.serverDomain || !drop.has(`${r.generation}/${r.revision}`));
  }
}

// ──────────────────────────────────────────────────────────────────────
// Deps
// ──────────────────────────────────────────────────────────────────────

export interface PbNetDeps {
  servers: ServerStorage;
  store: PbNetStore;
  network: PbNetwork;
  /** The relay owners send mailbox traffic to, e.g. https://flagship.services:8443. */
  relayBase: string;
  tokenKey: RsaPrivateKey | null;
  fillerSecret: Uint8Array | null;
  tagSecret: Uint8Array | null;
  /** Filler bytes; the Worker passes a WebCrypto AES-CTR version. */
  fillerBytes?: (key: Uint8Array, offset: number, len: number) => Promise<Uint8Array> | Uint8Array;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

function configured(d: PbNetDeps): d is PbNetDeps & { tokenKey: RsaPrivateKey; fillerSecret: Uint8Array; tagSecret: Uint8Array } {
  return !!(d.tokenKey && d.fillerSecret && d.tagSecret);
}

const notSetUp = (): HandlerResponseWithHeaders => ({ status: 503, body: { error: NOT_SET_UP } });
const rb = (d: PbNetDeps, n: number) => (d.randomBytes ? d.randomBytes(n) : crypto.getRandomValues(new Uint8Array(n)));
const nowOf = (d: PbNetDeps) => (d.now ?? Date.now)();

const HEX = (len: number) => new RegExp(`^[0-9a-f]{${len}}$`);
const HEX64 = HEX(64);
const HEX32 = HEX(32);
const HEX128 = HEX(128);

async function verifyServer(
  d: PbNetDeps,
  serverDomain: unknown,
  sigHex: unknown,
  issuedAt: unknown,
  canonical: () => Uint8Array,
): Promise<{ ok: true; username: string; serverDomain: string } | { ok: false; res: HandlerResponseWithHeaders }> {
  if (typeof serverDomain !== "string" || serverDomain.length === 0 || serverDomain.length > 253) {
    return { ok: false, res: malformed("missing serverDomain") };
  }
  if (typeof sigHex !== "string" || !HEX128.test(sigHex)) return { ok: false, res: malformed("malformed signature") };
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt)) return { ok: false, res: malformed("malformed issuedAt") };
  const reg = await d.servers.get(serverDomain);
  if (!reg) return { ok: false, res: notFound("unknown server") };
  if (reg.revokedAt) return { ok: false, res: forbidden("server is revoked") };
  let msg: Uint8Array;
  try {
    msg = canonical();
  } catch (e) {
    return { ok: false, res: malformed((e as Error).message) };
  }
  let good = false;
  try {
    good = ed.verify(hexToBytes(sigHex), msg, hexToBytes(reg.identityPubKeyHex));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, res: forbidden("invalid signature") };
  if (Math.abs(nowOf(d) - issuedAt) > PB_FRESHNESS_MS) return { ok: false, res: forbidden("stale request") };
  return { ok: true, username: reg.username, serverDomain: reg.serverDomain };
}

// ──────────────────────────────────────────────────────────────────────
// Scores
// ──────────────────────────────────────────────────────────────────────

function ringGet(hexStr: string): Uint8Array {
  const b = hexStr.length === RING_HOURS / 4 ? hexToBytes(hexStr) : new Uint8Array(RING_HOURS / 8);
  return b;
}

function markPresence(row: PbHolderRow, now: number): void {
  const ring = ringGet(row.presenceHex);
  const h = Math.floor(now / HOUR);
  const clear = (hour: number) => {
    const i = ((hour % RING_HOURS) + RING_HOURS) % RING_HOURS;
    ring[i >> 3] = ring[i >> 3]! & ~(1 << (i & 7));
  };
  if (row.presenceLastHour > 0 && h > row.presenceLastHour) {
    const gap = Math.min(h - row.presenceLastHour - 1, RING_HOURS);
    for (let k = 1; k <= gap; k++) clear(row.presenceLastHour + k);
  }
  const i = h % RING_HOURS;
  ring[i >> 3] = ring[i >> 3]! | (1 << (i & 7));
  row.presenceHex = bytesToHex(ring);
  row.presenceLastHour = Math.max(row.presenceLastHour, h);
}

function presenceFraction(row: PbHolderRow, now: number): number {
  const ring = ringGet(row.presenceHex);
  const h = Math.floor(now / HOUR);
  const age = Math.max(1, Math.min(RING_HOURS, h - Math.floor(row.registeredAt / HOUR) + 1));
  let set = 0;
  for (let k = 0; k < age; k++) {
    const hour = h - k;
    if (hour > row.presenceLastHour) continue;
    const i = ((hour % RING_HOURS) + RING_HOURS) % RING_HOURS;
    if (ring[i >> 3]! & (1 << (i & 7))) set++;
  }
  return Math.min(1, set / age);
}

function decayProofs(row: PbHolderRow, now: number): void {
  const day = Math.floor(now / DAY);
  if (day > row.proofsDay) {
    const f = Math.pow(0.97, day - row.proofsDay);
    row.proofsOk *= f;
    row.proofsFailed *= f;
    row.proofsDay = day;
  }
}

/** 0..100 in steps of 10; at most 50 in a holder's first week. */
export function pbReliability(row: PbHolderRow, now: number): number {
  const pass = (row.proofsOk + 1) / (row.proofsOk + row.proofsFailed + 1);
  let r = Math.floor(presenceFraction(row, now) * pass * 10) * 10;
  if (now - row.registeredAt < 7 * DAY) r = Math.min(r, 50);
  return Math.max(0, Math.min(100, r));
}

function slotBytes(n: PbNetwork): number {
  return n.slotBricks * n.brickBytes;
}

export async function pbProvenSlots(d: PbNetDeps, row: PbHolderRow, now: number): Promise<number> {
  const leased = await d.store.liveLeaseSlots(row.pikPubHex, now);
  return Math.floor((row.fillerCount * d.network.brickBytes) / slotBytes(d.network)) + leased;
}

function pow2Floor(x: number): number {
  if (x < 1) return 0;
  return 2 ** Math.floor(Math.log2(x));
}

// ──────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────

export function handlePbNetwork(d: PbNetDeps): HandlerResponseWithHeaders {
  if (!configured(d)) return notSetUp();
  return ok({ network: d.network, tokenKey: rsaPublicKeyToJwk(d.tokenKey), relayBase: d.relayBase });
}

export interface PbCheckinBody {
  serverDomain?: unknown;
  pikPubHex?: unknown;
  xPubHex?: unknown;
  poolBytes?: unknown;
  fillerHeld?: unknown;
  leaving?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
  /** PIK signature over flagship/pb-pik-bind/v1 — needed the first time. */
  pikBindSigHex?: unknown;
}

export async function handlePbCheckin(d: PbNetDeps, body: PbCheckinBody, clientIp: string | null): Promise<HandlerResponseWithHeaders> {
  if (!configured(d)) return notSetUp();
  const b = body ?? {};
  if (typeof b.pikPubHex !== "string" || !HEX64.test(b.pikPubHex) || typeof b.xPubHex !== "string" || !HEX64.test(b.xPubHex)) {
    return malformed("malformed peer identity");
  }
  if (typeof b.poolBytes !== "number" || !Number.isSafeInteger(b.poolBytes) || b.poolBytes < 0) return malformed("malformed poolBytes");
  if (typeof b.fillerHeld !== "number" || !Number.isSafeInteger(b.fillerHeld) || b.fillerHeld < 0) return malformed("malformed fillerHeld");
  if (typeof b.leaving !== "boolean") return malformed("malformed leaving");
  const pik = b.pikPubHex;
  const xPub = b.xPubHex;
  const v = await verifyServer(d, b.serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbCheckin({
      serverDomain: b.serverDomain as string,
      pikPubHex: pik,
      xPubHex: xPub,
      poolBytes: b.poolBytes as number,
      fillerHeld: b.fillerHeld as number,
      leaving: b.leaving as boolean,
      issuedAt: b.issuedAt as number,
    }),
  );
  if (!v.ok) return v.res;
  const now = nowOf(d);

  let row = await d.store.holderByServer(v.serverDomain);
  if (row && row.pikPubHex !== pik) row = null;
  if (!row) {
    if (typeof b.pikBindSigHex !== "string" || !HEX128.test(b.pikBindSigHex)) return malformed("the first check-in needs the peer identity's own signature");
    let bound = false;
    try {
      bound = ed.verify(hexToBytes(b.pikBindSigHex), canonicalPbPikBind(v.serverDomain, pik, xPub), hexToBytes(pik));
    } catch {
      bound = false;
    }
    if (!bound) return forbidden("invalid peer identity signature");
    const other = await d.store.holderByPik(pik);
    if (other && other.serverDomain !== v.serverDomain) return forbidden("that peer identity belongs to another server");
    row = {
      pikPubHex: pik,
      serverDomain: v.serverDomain,
      username: v.username,
      xPubHex: xPub,
      poolBytes: 0,
      accountTag: pbAccountTag(d.tagSecret, v.username),
      netTag: "",
      registeredAt: now,
      lastCheckinAt: 0,
      presenceHex: "",
      presenceLastHour: 0,
      fillerCount: 0,
      fillerLastAt: 0,
      fillerDay: 0,
      fillerDayBytes: 0,
      pending: null,
      lastChallengeAt: now,
      proofsOk: 0,
      proofsFailed: 0,
      proofsDay: Math.floor(now / DAY),
      leaving: false,
    };
  }
  decayProofs(row, now);
  row.xPubHex = xPub;
  row.poolBytes = b.poolBytes;
  row.leaving = b.leaving;
  row.fillerCount = Math.min(row.fillerCount, b.fillerHeld);
  row.lastCheckinAt = now;
  const prefix = clientIp ? pbNetworkPrefix(clientIp) : null;
  if (prefix) row.netTag = pbNetTag(d.tagSecret, prefix);
  markPresence(row, now);

  if (row.pending && now - row.pending.issuedAt > PB_CHALLENGE_DEADLINE_MS) {
    row.proofsFailed += 1;
    row.pending = null;
  }
  let challenge: (PbPendingChallenge & { leafBytes: number; deadlineAt: number }) | null = null;
  if (!row.pending && row.fillerCount > 0 && now - row.lastChallengeAt >= PB_CHALLENGE_EVERY_MS) {
    const r = rb(d, 24);
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const leaves = d.network.brickBytes / d.network.leafBytes;
    row.pending = {
      id: bytesToHex(r.subarray(0, 16)),
      index: dv.getUint32(16) % row.fillerCount,
      leaf: dv.getUint32(20) % leaves,
      nonceHex: bytesToHex(rb(d, 16)),
      issuedAt: now,
    };
    row.lastChallengeAt = now;
  }
  if (row.pending && now - row.pending.issuedAt <= PB_CHALLENGE_DEADLINE_MS) {
    challenge = { ...row.pending, leafBytes: d.network.leafBytes, deadlineAt: row.pending.issuedAt + PB_CHALLENGE_DEADLINE_MS };
  }
  await d.store.putHolder(row);

  const day = Math.floor(now / DAY);
  const usedToday = row.fillerDay === day ? row.fillerDayBytes : 0;
  const fillerWanted = row.leaving ? 0 : Math.floor(Math.max(0, PB_FILLER_BYTES_PER_DAY - usedToday) / d.network.brickBytes);
  return ok({
    network: d.network,
    fillerNext: row.fillerCount,
    fillerWanted,
    challenge,
    reliability: pbReliability(row, now),
    provenSlots: await pbProvenSlots(d, row, now),
  });
}

export interface PbFillerBody {
  serverDomain?: unknown;
  index?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
}

/** 200 with the brick's bytes (`body` is a Uint8Array), or a JSON error. */
export async function handlePbFillerFetch(d: PbNetDeps, body: PbFillerBody): Promise<HandlerResponseWithHeaders> {
  if (!configured(d)) return notSetUp();
  const b = body ?? {};
  if (typeof b.index !== "number" || !Number.isSafeInteger(b.index) || b.index < 0) return malformed("malformed index");
  const index = b.index;
  const v = await verifyServer(d, b.serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbFillerFetch(b.serverDomain as string, index, b.issuedAt as number),
  );
  if (!v.ok) return v.res;
  const row = await d.store.holderByServer(v.serverDomain);
  if (!row) return notFound("check in first");
  if (row.leaving) return forbidden("a server leaving peer backup gets no filler");
  const now = nowOf(d);
  const B = d.network.brickBytes;
  if (index === row.fillerCount) {
    if (row.fillerCount * B + B > row.poolBytes) return forbidden("the pool is full");
    const day = Math.floor(now / DAY);
    if (row.fillerDay !== day) {
      row.fillerDay = day;
      row.fillerDayBytes = 0;
    }
    if (row.fillerDayBytes + B > PB_FILLER_BYTES_PER_DAY) {
      return { status: 429, body: { error: "That's all the filler for today. More comes tomorrow." } };
    }
    row.fillerDayBytes += B;
    row.fillerCount += 1;
    row.fillerLastAt = now;
    await d.store.putHolder(row);
  } else if (!(index === row.fillerCount - 1 && now - row.fillerLastAt <= PB_FILLER_REFETCH_MS)) {
    return { status: 409, body: { error: "that filler brick was already delivered" } };
  }
  const key = pbFillerKey(d.fillerSecret, row.pikPubHex, index);
  const bytes = await (d.fillerBytes ?? pbFillerBytes)(key, 0, B);
  return { status: 200, body: bytes, headers: { "content-type": "application/octet-stream" } };
}

export interface PbProofBody {
  serverDomain?: unknown;
  challengeId?: unknown;
  answerHex?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
}

export async function handlePbFillerProof(d: PbNetDeps, body: PbProofBody): Promise<HandlerResponseWithHeaders> {
  if (!configured(d)) return notSetUp();
  const b = body ?? {};
  if (typeof b.challengeId !== "string" || !HEX32.test(b.challengeId)) return malformed("malformed challengeId");
  if (typeof b.answerHex !== "string" || !HEX64.test(b.answerHex)) return malformed("malformed answer");
  const id = b.challengeId;
  const answer = b.answerHex;
  const v = await verifyServer(d, b.serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbFillerProof(b.serverDomain as string, id, answer, b.issuedAt as number),
  );
  if (!v.ok) return v.res;
  const row = await d.store.holderByServer(v.serverDomain);
  if (!row || !row.pending || row.pending.id !== id) return notFound("no such challenge");
  const now = nowOf(d);
  decayProofs(row, now);
  const p = row.pending;
  row.pending = null;
  let passed = false;
  if (now - p.issuedAt <= PB_CHALLENGE_DEADLINE_MS) {
    const key = pbFillerKey(d.fillerSecret, row.pikPubHex, p.index);
    const leaf = await (d.fillerBytes ?? pbFillerBytes)(key, p.leaf * d.network.leafBytes, d.network.leafBytes);
    passed = pbFillerAnswer(hexToBytes(p.nonceHex), leaf) === answer;
  }
  if (passed) row.proofsOk += 1;
  else row.proofsFailed += 1;
  await d.store.putHolder(row);
  return ok({ passed, reliability: pbReliability(row, now) });
}

export interface PbDirectoryBody {
  serverDomain?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
}

export interface PbDirectoryEntry {
  pikPubHex: string;
  xPubHex: string;
  freeSlots: number;
  reliability: number;
  accountTag: string;
  netTag: string;
}

export async function handlePbDirectory(d: PbNetDeps, body: PbDirectoryBody): Promise<HandlerResponseWithHeaders> {
  if (!configured(d)) return notSetUp();
  const b = body ?? {};
  const v = await verifyServer(d, b.serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbDirectory(b.serverDomain as string, b.issuedAt as number),
  );
  if (!v.ok) return v.res;
  const me = await d.store.holderByServer(v.serverDomain);
  if (!me) return forbidden("only a server that holds bricks for others can place its own");
  const now = nowOf(d);
  const sb = slotBytes(d.network);
  const entries: PbDirectoryEntry[] = [];
  for (const h of await d.store.listHolders()) {
    if (h.leaving || now - h.lastCheckinAt > PB_CHECKIN_LIVE_MS) continue;
    if (h.username.toLowerCase() === v.username.toLowerCase()) continue;
    const leased = await d.store.liveLeaseSlots(h.pikPubHex, now);
    entries.push({
      pikPubHex: h.pikPubHex,
      xPubHex: h.xPubHex,
      freeSlots: pow2Floor(Math.floor(h.poolBytes / sb) - leased),
      reliability: pbReliability(h, now),
      accountTag: h.accountTag,
      netTag: h.netTag,
    });
  }
  // Same order for everyone: nothing about the asker leaks through it.
  entries.sort((a, b) => (a.pikPubHex < b.pikPubHex ? -1 : 1));
  return ok({ network: d.network, entries, self: { accountTag: me.accountTag, netTag: me.netTag } });
}

export interface PbTokensBody {
  serverDomain?: unknown;
  blindedHex?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
}

export async function handlePbTokens(d: PbNetDeps, body: PbTokensBody): Promise<HandlerResponseWithHeaders> {
  if (!configured(d)) return notSetUp();
  const b = body ?? {};
  const kHex = Math.ceil(d.tokenKey.n.toString(16).length / 2) * 2;
  if (
    !Array.isArray(b.blindedHex) ||
    b.blindedHex.length === 0 ||
    b.blindedHex.length > PB_TOKENS_PER_CALL ||
    b.blindedHex.some((x) => typeof x !== "string" || x.length !== kHex || !/^[0-9a-f]+$/.test(x))
  ) {
    return malformed(`send 1 to ${PB_TOKENS_PER_CALL} blinded tokens`);
  }
  const blinded = b.blindedHex as string[];
  const v = await verifyServer(d, b.serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbTokens(b.serverDomain as string, blinded.length, pbBlindedDigest(blinded), b.issuedAt as number),
  );
  if (!v.ok) return v.res;
  const row = await d.store.holderByServer(v.serverDomain);
  if (!row) return forbidden("only a server that holds bricks for others gets space on theirs");
  const now = nowOf(d);
  const allowance = 3 * (await pbProvenSlots(d, row, now)) + PB_TOKEN_STARTER;
  const used = await d.store.tokensIssuedSince(v.serverDomain, now - PB_TOKEN_WINDOW_MS);
  if (used + blinded.length > allowance) {
    return {
      status: 429,
      body: {
        error: "This server has used the space it has earned on other servers for now. It earns more as it holds more for others.",
        allowance,
        used,
      },
    };
  }
  const signatures: string[] = [];
  for (const x of blinded) {
    try {
      signatures.push(bytesToHex(rsaBlindSign(d.tokenKey, hexToBytes(x))));
    } catch {
      return malformed("a blinded token is out of range");
    }
  }
  await d.store.recordIssue(v.serverDomain, now, blinded.length);
  return ok({ signatures, allowance, used: used + blinded.length });
}

export interface PbRedeemBody {
  serverDomain?: unknown;
  pikPubHex?: unknown;
  spends?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
}

export async function handlePbRedeem(d: PbNetDeps, body: PbRedeemBody): Promise<HandlerResponseWithHeaders> {
  if (!configured(d)) return notSetUp();
  const b = body ?? {};
  if (typeof b.pikPubHex !== "string" || !HEX64.test(b.pikPubHex)) return malformed("malformed pikPubHex");
  if (!Array.isArray(b.spends) || b.spends.length === 0 || b.spends.length > 1024) return malformed("send 1 to 1024 spends");
  const spends: PbSpend[] = [];
  for (const s of b.spends as unknown[]) {
    const r = s as Record<string, unknown>;
    if (
      typeof r?.leaseId !== "string" || !HEX32.test(r.leaseId) ||
      typeof r.serialHex !== "string" || !HEX64.test(r.serialHex) ||
      typeof r.prefixHex !== "string" || !HEX64.test(r.prefixHex) ||
      typeof r.sigHex !== "string" || !/^[0-9a-f]+$/.test(r.sigHex)
    ) {
      return malformed("malformed spend");
    }
    spends.push({ leaseId: r.leaseId, serialHex: r.serialHex, prefixHex: r.prefixHex, sigHex: r.sigHex });
  }
  const pik = b.pikPubHex;
  const v = await verifyServer(d, b.serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbRedeem(b.serverDomain as string, pik, pbSpendsDigest(spends), b.issuedAt as number),
  );
  if (!v.ok) return v.res;
  const row = await d.store.holderByServer(v.serverDomain);
  if (!row || row.pikPubHex !== pik) return forbidden("that peer identity isn't this server's");
  const now = nowOf(d);
  const results: Array<{ serialHex: string; ok: boolean; reason?: string }> = [];
  const perLease = new Map<string, number>();
  for (const s of spends) {
    const prepared = blindPrepare(pbTokenMessage(s.serialHex), hexToBytes(s.prefixHex));
    if (!rsaPssVerify(d.tokenKey, prepared, hexToBytes(s.sigHex))) {
      results.push({ serialHex: s.serialHex, ok: false, reason: "invalid" });
      continue;
    }
    const fresh = await d.store.spendSerial(bytesToHex(sha256(hexToBytes(s.serialHex))), pik, now);
    if (!fresh) {
      results.push({ serialHex: s.serialHex, ok: false, reason: "spent" });
      continue;
    }
    results.push({ serialHex: s.serialHex, ok: true });
    perLease.set(s.leaseId, (perLease.get(s.leaseId) ?? 0) + 1);
  }
  for (const [leaseId, slots] of perLease) await d.store.putLease(pik, leaseId, slots, now + d.network.leaseMs);
  return ok({ results });
}

export interface PbRootPutBody {
  generation?: unknown;
  revision?: unknown;
  nonceHex?: unknown;
  ciphertextHex?: unknown;
  issuedAt?: unknown;
  signatureHex?: unknown;
}

export async function handlePbRootPut(d: PbNetDeps, serverDomain: string, body: PbRootPutBody): Promise<HandlerResponseWithHeaders> {
  const b = body ?? {};
  if (typeof b.generation !== "number" || !Number.isSafeInteger(b.generation) || b.generation < 1) return malformed("malformed generation");
  if (typeof b.revision !== "number" || !Number.isSafeInteger(b.revision) || b.revision < 1) return malformed("malformed revision");
  if (typeof b.nonceHex !== "string" || !/^[0-9a-f]{24}$/.test(b.nonceHex)) return malformed("malformed nonce");
  if (typeof b.ciphertextHex !== "string" || b.ciphertextHex.length === 0 || b.ciphertextHex.length % 2 || !/^[0-9a-f]+$/.test(b.ciphertextHex)) {
    return malformed("malformed ciphertext");
  }
  if (b.ciphertextHex.length > PB_ROOT_MAX_HEX) return malformed("the peer-backup record is too large");
  const gen = b.generation;
  const rev = b.revision;
  const ct = b.ciphertextHex;
  const v = await verifyServer(d, serverDomain, b.signatureHex, b.issuedAt, () =>
    canonicalPbRootDeposit(serverDomain, gen, rev, bytesToHex(sha256(hexToBytes(ct))), b.issuedAt as number),
  );
  if (!v.ok) return v.res;
  const latest = await d.store.latestRoot(v.serverDomain);
  if (latest && (gen < latest.generation || (gen === latest.generation && rev <= latest.revision))) {
    return { status: 409, body: { error: "a newer peer-backup record is already stored" } };
  }
  await d.store.putRoot(
    { serverDomain: v.serverDomain, username: v.username, generation: gen, revision: rev, storedAt: nowOf(d), nonceHex: b.nonceHex, ciphertextHex: ct },
    PB_ROOTS_KEPT,
  );
  return ok({ stored: true });
}

/**
 * Public and non-consuming: the root is sealed under a key only the account
 * can make, and a restore after the box is gone (or revoked) must still find
 * it. `?all=1` lists the kept revisions so a device can pick an older one.
 */
export async function handlePbRootGet(
  d: Pick<PbNetDeps, "store">,
  serverDomain: string,
  opts: { generation?: number; revision?: number; all?: boolean } = {},
): Promise<HandlerResponseWithHeaders> {
  const rows = await d.store.listRoots(serverDomain);
  if (rows.length === 0) return notFound("no peer backup for that server");
  if (opts.all) {
    return ok({ roots: rows.map((r) => ({ generation: r.generation, revision: r.revision, storedAt: r.storedAt, nonceHex: r.nonceHex, ciphertextHex: r.ciphertextHex })) });
  }
  const r = opts.generation !== undefined ? rows.find((x) => x.generation === opts.generation && (opts.revision === undefined || x.revision === opts.revision)) : rows[0];
  if (!r) return notFound("no such peer-backup record");
  return ok({ generation: r.generation, revision: r.revision, storedAt: r.storedAt, nonceHex: r.nonceHex, ciphertextHex: r.ciphertextHex });
}

/**
 * One router for the Worker and the tests. `json` is the parsed body (or
 * undefined); null means the path isn't a peer-backup one. A 200 filler
 * reply carries a Uint8Array body.
 */
export async function routePbNet(
  d: PbNetDeps,
  req: { method: string; path: string; json?: unknown; clientIp: string | null; query?: URLSearchParams },
): Promise<HandlerResponseWithHeaders | null> {
  const m = req.method.toUpperCase();
  const p = req.path;
  const body = (req.json ?? {}) as Record<string, unknown>;
  if (p === "/api/peer-backup/network" && m === "GET") return handlePbNetwork(d);
  if (p === "/api/peer-backup/holder/checkin" && m === "POST") return handlePbCheckin(d, body, req.clientIp);
  if (p === "/api/peer-backup/filler" && m === "POST") return handlePbFillerFetch(d, body);
  if (p === "/api/peer-backup/holder/proof" && m === "POST") return handlePbFillerProof(d, body);
  if (p === "/api/peer-backup/directory" && m === "POST") return handlePbDirectory(d, body);
  if (p === "/api/peer-backup/tokens" && m === "POST") return handlePbTokens(d, body);
  if (p === "/api/peer-backup/holder/redeem" && m === "POST") return handlePbRedeem(d, body);
  const root = /^\/api\/peer-backup\/root\/([^/]+)$/.exec(p);
  if (root) {
    let server: string;
    try {
      server = decodeURIComponent(root[1]!).toLowerCase();
    } catch {
      return malformed("bad server name");
    }
    if (m === "PUT") return handlePbRootPut(d, server, body);
    if (m === "GET") {
      const q = req.query;
      const gen = q?.get("generation");
      const rev = q?.get("revision");
      return handlePbRootGet(d, server, {
        ...(gen ? { generation: Number(gen) } : {}),
        ...(rev ? { revision: Number(rev) } : {}),
        all: q?.get("all") === "1",
      });
    }
  }
  return null;
}

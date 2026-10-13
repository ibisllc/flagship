/**
 * Share this server — the `.com` relay (docs/share-a-server.md §6.2).
 *
 * `.com` stores an opaque share id, a hash of the link's bearer token and
 * ciphertext it cannot open; it never learns who the second account is. The
 * owner's writes are signed with the owner's sensitive key; the second
 * account authenticates with the link token (and, for leaving, its per-share
 * key). The box re-verifies every revoke and leave it reads back.
 */
import {
  parseServerShareLeave,
  parseServerShareList,
  parseServerShareOffer,
  parseServerShareRevoke,
  parseServerShareUnlock,
  parseShareInboxRequest,
  shareSha256Hex,
  SHARE_UNLOCK_OFF,
  verifyServerShareLeave,
  verifyServerShareList,
  verifyServerShareOffer,
  verifyServerShareRevoke,
  verifyServerShareUnlock,
  verifyShareInboxRequest,
} from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  ServerShareRecord,
  ServerShareStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { equalBytes, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import { conflict, forbidden, gone, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";
import { sha256 } from "@noble/hashes/sha256";

export interface ServerShareDeps {
  shares: ServerShareStorage;
  usernames: UsernameStorage;
  servers: ServerStorage;
  grants?: DeviceCapabilityGrantStorage;
  now?: () => number;
  /** Replay window for signed envelopes. Default 5 min. */
  freshnessMs?: number;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const SEALED_HEX = /^([0-9a-f]{2})+$/;
/** Bounds on what `.com` keeps per row; a share carries a few hundred bytes. */
const MAX_SEALED_HEX = 16_384;
const MAX_UNLOCK_HEX = 4_096;
export const SHARE_INBOX_CAP = 200;
const MAX_ENDS = 200;

type Res = HandlerResponseWithHeaders;

function clock(deps: ServerShareDeps): number {
  return (deps.now ?? (() => Date.now()))();
}

function fresh(deps: ServerShareDeps, issuedAt: number): boolean {
  return Math.abs(clock(deps) - issuedAt) <= (deps.freshnessMs ?? 5 * 60_000);
}

function sig(v: unknown): Uint8Array | null {
  return typeof v === "string" && HEX128.test(v) ? hexToBytes(v) : null;
}

function sealedHex(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max && SEALED_HEX.test(v) ? v : null;
}

/** The token header must hash to the row's `token_hash` (constant-time). */
function tokenMatches(row: ServerShareRecord, token: string | null): boolean {
  if (!token || !HEX64.test(token)) return false;
  return equalBytes(sha256(hexToBytes(token)), hexToBytes(row.tokenHash));
}

function state(row: ServerShareRecord): "offered" | "accepted" | "ended" {
  if (row.endedAt !== null) return "ended";
  return row.acceptHex !== null ? "accepted" : "offered";
}

async function ownerAuthorized(
  deps: ServerShareDeps,
  username: string,
  verifyWith: (pubHex: string) => boolean,
): Promise<Res | null> {
  const userRec = await deps.usernames.get(username);
  if (!userRec) return notFound("username not registered");
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    { username, userRec, verifyWith, now: clock(deps) },
  );
  return authz.ok ? null : forbidden("invalid signature");
}

async function liveServerOf(deps: ServerShareDeps, username: string, serverDomain: string): Promise<boolean> {
  const s = await deps.servers.get(serverDomain.toLowerCase());
  return !!s && s.username === username && !s.revokedAt;
}

// POST /api/users/:u/server-shares — the owner offers a share.
export async function handleCreateServerShare(deps: ServerShareDeps, username: string, body: unknown): Promise<Res> {
  const u = validateUserLabel(username);
  if (!u.ok) return malformed(u.reason);
  const b = (body ?? {}) as Record<string, unknown>;
  const offer = parseServerShareOffer(b.offer);
  const s = sig(b.signature);
  const offerHex = sealedHex(b.offerHex, MAX_SEALED_HEX);
  const ownerHex = sealedHex(b.ownerHex, MAX_SEALED_HEX);
  if (!offer || !s || !offerHex || !ownerHex) return malformed("malformed share offer");
  if (offer.username !== u.label) return forbidden("offer is for another account");
  if (shareSha256Hex(offerHex) !== offer.offerSha256 || shareSha256Hex(ownerHex) !== offer.ownerSha256) {
    return forbidden("sealed payloads are not the ones that were signed");
  }
  if (!fresh(deps, offer.issuedAt)) return forbidden("stale request");
  const now = clock(deps);
  if (offer.expiresAt <= now || offer.expiresAt > now + 30 * 24 * 3600 * 1000) return malformed("bad expiresAt");
  const denied = await ownerAuthorized(deps, u.label, (pub) => verifyServerShareOffer(offer, s, hexToBytes(pub)));
  if (denied) return denied;
  if (!(await liveServerOf(deps, u.label, offer.serverDomain))) return notFound("no such server on this account");
  const res = await deps.shares.create({
    shareId: offer.shareId,
    ownerUsername: u.label,
    serverDomain: offer.serverDomain.toLowerCase(),
    tokenHash: offer.tokenHash,
    offerHex,
    ownerHex,
    createdAt: now,
    expiresAt: offer.expiresAt,
  });
  if (!res.ok) return conflict("share id already used");
  return ok({ ok: true, shareId: offer.shareId });
}

// POST /api/users/:u/server-shares/list — every share the owner offered.
export async function handleListServerShares(deps: ServerShareDeps, username: string, body: unknown): Promise<Res> {
  const u = validateUserLabel(username);
  if (!u.ok) return malformed(u.reason);
  const b = (body ?? {}) as Record<string, unknown>;
  const list = parseServerShareList(b.list);
  const s = sig(b.signature);
  if (!list || !s) return malformed("malformed list request");
  if (list.username !== u.label) return forbidden("request is for another account");
  if (!fresh(deps, list.issuedAt)) return forbidden("stale request");
  // A read of ciphertext only the owner's devices can open: any of the
  // account's keys may sign it, so listing never needs the admin root.
  const userRec = await deps.usernames.get(u.label);
  if (!userRec) return notFound("username not registered");
  const keys = [userRec.irkPubHex, userRec.aidPubHex, userRec.adminRootPubHex].filter((k): k is string => typeof k === "string" && HEX64.test(k.toLowerCase()));
  if (!keys.some((k) => verifyServerShareList(list, s, hexToBytes(k.toLowerCase())))) return forbidden("invalid signature");
  const rows = await deps.shares.listForOwner(u.label);
  const shares = await Promise.all(
    rows.map(async (r) => ({
      shareId: r.shareId,
      serverDomain: r.serverDomain,
      state: state(r),
      owner: r.ownerHex,
      acceptance: r.acceptHex,
      acceptedAt: r.acceptedAt,
      endKind: r.endKind,
      endedAt: r.endedAt,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      unlock: (await deps.shares.getUnlock(r.shareId)) !== null,
    })),
  );
  return ok({ shares });
}

// POST /api/users/:u/server-shares/:id/revoke — the owner ends a share.
export async function handleRevokeServerShare(
  deps: ServerShareDeps,
  username: string,
  shareId: string,
  body: unknown,
): Promise<Res> {
  const u = validateUserLabel(username);
  if (!u.ok) return malformed(u.reason);
  if (!HEX32.test(shareId)) return malformed("bad share id");
  const b = (body ?? {}) as Record<string, unknown>;
  const revoke = parseServerShareRevoke(b.revoke);
  const s = sig(b.signature);
  if (!revoke || !s) return malformed("malformed revoke");
  if (revoke.shareId !== shareId) return forbidden("revoke is for another share");
  if (!fresh(deps, revoke.issuedAt)) return forbidden("stale request");
  const row = await deps.shares.get(shareId);
  if (!row || row.ownerUsername !== u.label) return notFound("no such share");
  if (revoke.serverDomain.toLowerCase() !== row.serverDomain) return forbidden("revoke is for another server");
  const denied = await ownerAuthorized(deps, u.label, (pub) => verifyServerShareRevoke(revoke, s, hexToBytes(pub)));
  if (denied) return denied;
  if (row.endedAt !== null) {
    await deps.shares.deleteUnlock(shareId);
    return ok({ ok: true, alreadyEnded: true });
  }
  await deps.shares.end(shareId, "revoke", JSON.stringify({ revoke, signature: b.signature }), clock(deps));
  return ok({ ok: true });
}

// POST /api/users/:u/server-shares/:id/unlock — put or withdraw the boot copy.
export async function handleServerShareUnlock(
  deps: ServerShareDeps,
  username: string,
  shareId: string,
  body: unknown,
): Promise<Res> {
  const u = validateUserLabel(username);
  if (!u.ok) return malformed(u.reason);
  if (!HEX32.test(shareId)) return malformed("bad share id");
  const b = (body ?? {}) as Record<string, unknown>;
  const unlock = parseServerShareUnlock(b.unlock);
  const s = sig(b.signature);
  if (!unlock || !s) return malformed("malformed unlock deposit");
  if (unlock.shareId !== shareId) return forbidden("deposit is for another share");
  if (!fresh(deps, unlock.issuedAt)) return forbidden("stale request");
  const row = await deps.shares.get(shareId);
  if (!row || row.ownerUsername !== u.label) return notFound("no such share");
  if (row.endedAt !== null) return gone("share ended");
  if (unlock.serverDomain.toLowerCase() !== row.serverDomain) return forbidden("deposit is for another server");
  let sealed: string | null = null;
  if (unlock.sealedSha256 !== SHARE_UNLOCK_OFF) {
    sealed = sealedHex(b.sealedKey, MAX_UNLOCK_HEX);
    if (!sealed) return malformed("sealedKey required");
    if (shareSha256Hex(sealed) !== unlock.sealedSha256) return forbidden("sealed copy is not the one that was signed");
  }
  const denied = await ownerAuthorized(deps, u.label, (pub) => verifyServerShareUnlock(unlock, s, hexToBytes(pub)));
  if (denied) return denied;
  const prev = await deps.shares.getUnlock(shareId);
  if (prev && prev.issuedAt >= unlock.issuedAt) return conflict("a newer deposit is already on file");
  if (sealed === null) {
    await deps.shares.deleteUnlock(shareId);
    return ok({ ok: true, unlock: false });
  }
  await deps.shares.putUnlock({
    shareId,
    serverDomain: row.serverDomain,
    memberPubHex: unlock.memberPubHex,
    sealedKeyHex: sealed,
    depositJson: JSON.stringify(unlock),
    signatureHex: String(b.signature),
    issuedAt: unlock.issuedAt,
  });
  return ok({ ok: true, unlock: true });
}

// GET /api/server-shares/:id — anyone holding the link token.
export async function handleGetServerShare(deps: ServerShareDeps, shareId: string, token: string | null): Promise<Res> {
  if (!HEX32.test(shareId)) return malformed("bad share id");
  const row = await deps.shares.get(shareId);
  if (!row || !tokenMatches(row, token)) return notFound("no such share");
  if (row.acceptHex === null && row.endedAt === null && row.expiresAt <= clock(deps)) return gone("this link has expired");
  return ok({
    shareId: row.shareId,
    serverDomain: row.serverDomain,
    state: state(row),
    offer: row.offerHex,
    acceptance: row.acceptHex,
    endKind: row.endKind,
    expiresAt: row.expiresAt,
    unlock: (await deps.shares.getUnlock(shareId)) !== null,
  });
}

// POST /api/server-shares/:id/accept — first acceptance wins.
export async function handleAcceptServerShare(
  deps: ServerShareDeps,
  shareId: string,
  token: string | null,
  body: unknown,
): Promise<Res> {
  if (!HEX32.test(shareId)) return malformed("bad share id");
  const acceptance = sealedHex((body as Record<string, unknown> | null)?.acceptance, MAX_SEALED_HEX);
  if (!acceptance) return malformed("acceptance required");
  const row = await deps.shares.get(shareId);
  if (!row || !tokenMatches(row, token)) return notFound("no such share");
  const r = await deps.shares.accept(shareId, acceptance, clock(deps));
  if (r.ok) return ok({ ok: true });
  if (r.reason === "already-accepted") return conflict("this link was already used");
  if (r.reason === "unknown") return notFound("no such share");
  return gone(r.reason === "expired" ? "this link has expired" : "this share has ended");
}

// POST /api/server-shares/:id/leave — the second account ends its share.
export async function handleLeaveServerShare(
  deps: ServerShareDeps,
  shareId: string,
  token: string | null,
  body: unknown,
): Promise<Res> {
  if (!HEX32.test(shareId)) return malformed("bad share id");
  const b = (body ?? {}) as Record<string, unknown>;
  const leave = parseServerShareLeave(b.leave);
  const s = sig(b.signature);
  if (!leave || !s || leave.shareId !== shareId) return malformed("malformed leave");
  if (!fresh(deps, leave.issuedAt)) return forbidden("stale request");
  const row = await deps.shares.get(shareId);
  if (!row || !tokenMatches(row, token)) return notFound("no such share");
  if (leave.serverDomain.toLowerCase() !== row.serverDomain) return forbidden("leave is for another server");
  if (!verifyServerShareLeave(leave, s, hexToBytes(leave.memberPubHex))) return forbidden("invalid signature");
  const copy = await deps.shares.getUnlock(shareId);
  if (copy && copy.memberPubHex !== leave.memberPubHex) return forbidden("not this share's key");
  if (row.endedAt !== null) return ok({ ok: true, alreadyEnded: true });
  await deps.shares.end(shareId, "leave", JSON.stringify({ leave, signature: b.signature }), clock(deps));
  return ok({ ok: true });
}

// GET /api/server/:domain/share-ends?since= — public; the box verifies each.
export async function handleServerShareEnds(deps: ServerShareDeps, serverDomain: string, since: number): Promise<Res> {
  if (!Number.isSafeInteger(since) || since < 0) return malformed("bad since");
  const ends = await deps.shares.endsForServer(serverDomain.toLowerCase(), since, MAX_ENDS);
  const out = [];
  for (const e of ends) {
    try {
      out.push({ shareId: e.shareId, kind: e.kind, endedAt: e.endedAt, ...(JSON.parse(e.endJson) as object) });
    } catch {
      /* a row we can't parse carries nothing the box could verify */
    }
  }
  return ok({ ends: out, now: clock(deps) });
}

// POST /api/share-inbox — the second account's "Shared with me" entries.
export async function handleShareInbox(deps: ServerShareDeps, body: unknown): Promise<Res> {
  const b = (body ?? {}) as Record<string, unknown>;
  const req = parseShareInboxRequest(b.request);
  const s = sig(b.signature);
  if (!req || !s) return malformed("malformed inbox request");
  if (!fresh(deps, req.issuedAt)) return forbidden("stale request");
  if (!verifyShareInboxRequest(req, s, hexToBytes(req.inboxPubHex))) return forbidden("invalid signature");
  if (req.op === "list") {
    const entries = await deps.shares.inboxList(req.inboxPubHex);
    return ok({ entries: entries.map((e) => ({ entryId: e.entryId, ct: e.ctHex, createdAt: e.createdAt })) });
  }
  if (req.op === "delete") {
    return ok({ ok: true, deleted: await deps.shares.inboxDelete(req.inboxPubHex, req.entryId) });
  }
  const ct = sealedHex(b.ct, MAX_SEALED_HEX);
  if (!ct) return malformed("ct required");
  if (shareSha256Hex(ct) !== req.ctSha256) return forbidden("entry is not the one that was signed");
  const put = await deps.shares.inboxPut(
    { inboxId: req.inboxPubHex, entryId: req.entryId, ctHex: ct, createdAt: clock(deps) },
    SHARE_INBOX_CAP,
  );
  return put ? ok({ ok: true }) : conflict("the inbox is full");
}

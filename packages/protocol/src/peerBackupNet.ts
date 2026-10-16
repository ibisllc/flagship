/**
 * Peer backup between accounts (docs/peer-backup.md): keys, bricks, Merkle
 * proofs, mailbox ids, filler, the sealed root, and the canonical bytes every
 * signed message uses. Pure and runtime-agnostic: the box, `.com`, the relay
 * and the apps' ports all derive the same bytes from this module.
 */
import { ctr, gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { assertCanonicalField, hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

const te = new TextEncoder();

// ──────────────────────────────────────────────────────────────────────
// Network constants (served by .com, bounded here)
// ──────────────────────────────────────────────────────────────────────

export interface PbNetwork {
  /** Brick (and filler) size, bytes. A power of two. */
  brickBytes: number;
  /** Merkle leaf size, bytes. A power of two dividing brickBytes. */
  leafBytes: number;
  k: number;
  n: number;
  /** Bricks one token pays for at one holder. */
  slotBricks: number;
  /** Lease length, ms. */
  leaseMs: number;
  /** Placement needs distinct accounts and networks (prod) or accounts only (gym). */
  diversity: "account+network" | "account";
}

export const PB_NETWORK_DEFAULT: PbNetwork = {
  brickBytes: 4 * 1024 * 1024,
  leafBytes: 1024,
  k: 4,
  n: 8,
  slotBricks: 64,
  leaseMs: 90 * 24 * 60 * 60_000,
  diversity: "account+network",
};

function isPow2(x: number): boolean {
  return Number.isInteger(x) && x > 0 && (x & (x - 1)) === 0;
}

/** The network constants from untrusted JSON, or a sentence saying what's wrong. */
export function parsePbNetwork(v: unknown): PbNetwork | string {
  if (typeof v !== "object" || v === null) return "the peer-backup network settings are missing";
  const r = v as Record<string, unknown>;
  const int = (x: unknown) => typeof x === "number" && Number.isInteger(x);
  if (!int(r.brickBytes) || !isPow2(r.brickBytes as number) || (r.brickBytes as number) < 4096 || (r.brickBytes as number) > 16 * 1024 * 1024)
    return "brick size must be a power of two from 4 KiB to 16 MiB";
  if (!int(r.leafBytes) || !isPow2(r.leafBytes as number) || (r.leafBytes as number) < 64 || (r.leafBytes as number) > (r.brickBytes as number))
    return "leaf size must be a power of two no bigger than a brick";
  if (!int(r.k) || !int(r.n) || (r.k as number) < 1 || (r.n as number) < (r.k as number) || (r.n as number) > 32)
    return "k and n must satisfy 1 <= k <= n <= 32";
  if (!int(r.slotBricks) || (r.slotBricks as number) < 1 || (r.slotBricks as number) > 4096) return "slotBricks out of range";
  if (!int(r.leaseMs) || (r.leaseMs as number) < 60_000) return "leaseMs out of range";
  if (r.diversity !== "account+network" && r.diversity !== "account") return "unknown diversity rule";
  return {
    brickBytes: r.brickBytes as number,
    leafBytes: r.leafBytes as number,
    k: r.k as number,
    n: r.n as number,
    slotBricks: r.slotBricks as number,
    leaseMs: r.leaseMs as number,
    diversity: r.diversity,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Keys (§3)
// ──────────────────────────────────────────────────────────────────────

const INFO_PBK = "flagship/peer-backup-key/v1";
const INFO_ROOT = "flagship/pb-root/v1";
const INFO_BRICK = "flagship/pb-brick/v1|";
const TAG_BRICK_ID = "flagship/pb-brick-id/v1";

/** PBK = HKDF(SWK, "flagship/peer-backup-key/v1"); SWK = deriveSWK(UMK, serverId). */
export function derivePeerBackupKey(swk: Bytes): Bytes {
  if (swk.length !== 32) throw new Error("SWK must be 32 bytes");
  return hkdf(sha256, swk, new Uint8Array(0), te.encode(INFO_PBK), 32);
}

export function derivePbRootKey(pbk: Bytes): Bytes {
  return hkdf(sha256, pbk, new Uint8Array(0), te.encode(INFO_ROOT), 32);
}

export function derivePbBrickKey(pbk: Bytes, brickIdHex: string): Bytes {
  if (!/^[0-9a-f]{32}$/.test(brickIdHex)) throw new Error("brick id must be 16 bytes of hex");
  return hkdf(sha256, pbk, new Uint8Array(0), te.encode(INFO_BRICK + brickIdHex), 32);
}

/** brickId = HMAC(PBK, tag|gen|seg|shard|rev)[0..16], lowercase hex. */
export function derivePbBrickId(pbk: Bytes, generation: number, segment: number, shard: number, rev: number): string {
  for (const x of [generation, segment, shard, rev]) {
    if (!Number.isInteger(x) || x < 0) throw new Error("brick id inputs must be non-negative integers");
  }
  const mac = hmac(sha256, pbk, te.encode(`${TAG_BRICK_ID}|${generation}|${segment}|${shard}|${rev}`));
  return hex(mac.subarray(0, 16));
}

const ZERO_IV = new Uint8Array(16);

/** AES-256-CTR, IV 0 (each key is used for exactly one brick). Encrypt and decrypt are the same. */
export function pbBrickCrypt(key: Bytes, data: Bytes): Bytes {
  return ctr(key, ZERO_IV).encrypt(data);
}

// ──────────────────────────────────────────────────────────────────────
// Merkle tree over a brick's leaves (§4, §6.1)
// ──────────────────────────────────────────────────────────────────────

const LEAF_PREFIX = new Uint8Array([0]);
const NODE_PREFIX = new Uint8Array([1]);

function cat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pbLeafHash(leaf: Bytes): Bytes {
  return sha256(cat(LEAF_PREFIX, leaf));
}

function nodeHash(l: Bytes, r: Bytes): Bytes {
  return sha256(cat(NODE_PREFIX, l, r));
}

/** Every level of the tree, leaves first; the last level holds the root. */
export function pbMerkleLevels(brick: Bytes, leafBytes: number): Bytes[][] {
  if (!isPow2(leafBytes) || brick.length % leafBytes !== 0 || !isPow2(brick.length / leafBytes)) {
    throw new Error("a brick must be a power-of-two number of leaves");
  }
  const leaves: Bytes[] = [];
  for (let o = 0; o < brick.length; o += leafBytes) leaves.push(pbLeafHash(brick.subarray(o, o + leafBytes)));
  const levels: Bytes[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Bytes[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(nodeHash(prev[i]!, prev[i + 1]!));
    levels.push(next);
  }
  return levels;
}

export function pbMerkleRoot(brick: Bytes, leafBytes: number): Bytes {
  const levels = pbMerkleLevels(brick, leafBytes);
  return levels[levels.length - 1]![0]!;
}

/** Sibling hashes from the leaf up. */
export function pbMerklePath(levels: Bytes[][], leafIndex: number): Bytes[] {
  const path: Bytes[] = [];
  let i = leafIndex;
  for (let l = 0; l < levels.length - 1; l++) {
    path.push(levels[l]![i ^ 1]!);
    i >>= 1;
  }
  return path;
}

export function pbVerifyLeaf(root: Bytes, leaf: Bytes, leafIndex: number, path: ReadonlyArray<Bytes>, leafCount: number): boolean {
  if (!isPow2(leafCount) || leafIndex < 0 || leafIndex >= leafCount) return false;
  if (path.length !== Math.log2(leafCount)) return false;
  let h = pbLeafHash(leaf);
  let i = leafIndex;
  for (const sib of path) {
    if (sib.length !== 32) return false;
    h = i & 1 ? nodeHash(sib, h) : nodeHash(h, sib);
    i >>= 1;
  }
  if (h.length !== root.length) return false;
  let d = 0;
  for (let j = 0; j < h.length; j++) d |= h[j]! ^ root[j]!;
  return d === 0;
}

// ──────────────────────────────────────────────────────────────────────
// Mailboxes (§5.3)
// ──────────────────────────────────────────────────────────────────────

export const PB_MAILBOX_EPOCH_MS = 7 * 24 * 60 * 60_000;
const TAG_MAILBOX = "flagship/pb-mailbox/v1";
const TAG_MAILBOX_ANNOUNCE = "flagship/pb-mailbox-announce/v1";

export function pbMailboxEpoch(now: number): number {
  return Math.floor(now / PB_MAILBOX_EPOCH_MS);
}

/** mailboxId = SHA-256(tag|pikPubHex|epoch)[0..16], lowercase hex. */
export function pbMailboxId(pikPubHex: string, epoch: number): string {
  assertHex(pikPubHex, 64, "pikPubHex");
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("epoch must be a non-negative integer");
  return hex(sha256(te.encode(`${TAG_MAILBOX}|${pikPubHex}|${epoch}`)).subarray(0, 16));
}

export function canonicalPbMailboxAnnounce(pikPubHex: string, epoch: number): Bytes {
  assertHex(pikPubHex, 64, "pikPubHex");
  return te.encode(`${TAG_MAILBOX_ANNOUNCE}|${pikPubHex}|${epoch}`);
}

// ──────────────────────────────────────────────────────────────────────
// Filler (§5.5)
// ──────────────────────────────────────────────────────────────────────

const TAG_FILLER = "flagship/pb-filler/v1";

export function pbFillerKey(fillerSecret: Bytes, pikPubHex: string, index: number): Bytes {
  assertHex(pikPubHex, 64, "pikPubHex");
  if (!Number.isInteger(index) || index < 0) throw new Error("filler index must be a non-negative integer");
  return hmac(sha256, fillerSecret, te.encode(`${TAG_FILLER}|${pikPubHex}|${index}`));
}

/** `len` bytes of filler starting at byte `offset` (a multiple of 16). */
export function pbFillerBytes(key: Bytes, offset: number, len: number): Bytes {
  if (offset % 16 !== 0) throw new Error("filler offset must be a multiple of 16");
  const iv = new Uint8Array(16);
  let block = Math.floor(offset / 16);
  for (let i = 15; i >= 0 && block > 0; i--) {
    iv[i] = block & 0xff;
    block = Math.floor(block / 256);
  }
  return ctr(key, iv).encrypt(new Uint8Array(len));
}

/** The answer to a filler challenge: SHA-256(nonce ‖ leaf). */
export function pbFillerAnswer(nonce: Bytes, leaf: Bytes): string {
  return hex(sha256(cat(nonce, leaf)));
}

// ──────────────────────────────────────────────────────────────────────
// Tags .com publishes in the directory (§5.2)
// ──────────────────────────────────────────────────────────────────────

export function pbAccountTag(tagSecret: Bytes, username: string): string {
  return hex(hmac(sha256, tagSecret, te.encode(`flagship/pb-account-tag/v1|${username.toLowerCase()}`)).subarray(0, 8));
}

/** The /24 of an IPv4 address or the /48 of an IPv6 one, or null when it isn't an address. */
export function pbNetworkPrefix(ip: string): string | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) {
    const p = v4.slice(1, 4).map(Number);
    if (p.some((x) => x > 255)) return null;
    return `${p.join(".")}.0/24`;
  }
  if (!ip.includes(":")) return null;
  const [head, tail] = ip.trim().toLowerCase().split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail.length > 0 ? tail.split(":") : [];
  if (tail === undefined && h.length !== 8) return null;
  const groups = [...h, ...new Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(":")}::/48`;
}

export function pbNetTag(tagSecret: Bytes, prefix: string): string {
  return hex(hmac(sha256, tagSecret, te.encode(`flagship/pb-net-tag/v1|${prefix}`)).subarray(0, 8));
}

// ──────────────────────────────────────────────────────────────────────
// Space tokens (§5.4): the blind-signed message
// ──────────────────────────────────────────────────────────────────────

export function pbTokenMessage(serialHex: string): Bytes {
  assertHex(serialHex, 64, "serialHex");
  return te.encode(`flagship/pb-token/v1|${serialHex}`);
}

// ──────────────────────────────────────────────────────────────────────
// The root (§9)
// ──────────────────────────────────────────────────────────────────────

export interface PbRootMember {
  pikPubHex: string;
  xPubHex: string;
  leaseId: string;
  /** Ed25519 seed of this member's lease key, hex. */
  leaseKeySeedHex: string;
  /** Placement revision; bumped when the member is replaced. */
  rev: number;
  /** Lease expiry the holder last confirmed. */
  expiresAt: number;
}

export interface PbRoot {
  v: 1;
  serverId: string;
  generation: number;
  revision: number;
  createdAt: number;
  network: PbNetwork;
  archive: {
    archiveId: string;
    createdAt: number;
    bytes: number;
    sha256: string;
    /** The small backup file (key slots + sealed body), as written. */
    backupFile: string;
  };
  /** Payload length (the data file). */
  payloadBytes: number;
  /** Data segments 0..S-1. */
  segments: number;
  /** Index segments S..S+T-1. */
  indexSegments: number;
  /** Stripe j holds segments s with s % stripes.length === j. Each has n members. */
  stripes: PbRootMember[][];
  /** Merkle roots of the index bricks, segment-major then shard, hex. */
  indexRoots: string[];
}

const TAG_ROOT_AAD = "flagship/pb-root/v1";

export function pbRootAad(serverId: string): Bytes {
  assertCanonicalField(serverId, "peer-backup", "serverId");
  return te.encode(`${TAG_ROOT_AAD}|${serverId}`);
}

export interface SealedPbRoot {
  nonceHex: string;
  ciphertextHex: string;
}

export function sealPbRoot(root: PbRoot, pbk: Bytes, nonce?: Bytes): SealedPbRoot {
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(derivePbRootKey(pbk), n, pbRootAad(root.serverId)).encrypt(te.encode(JSON.stringify(root)));
  return { nonceHex: hex(n), ciphertextHex: hex(ct) };
}

/** Throws on a wrong key or a changed blob. */
export function openPbRoot(sealed: SealedPbRoot, pbk: Bytes, serverId: string): PbRoot {
  const pt = gcm(derivePbRootKey(pbk), fromHex(sealed.nonceHex), pbRootAad(serverId)).decrypt(fromHex(sealed.ciphertextHex));
  const root = JSON.parse(new TextDecoder().decode(pt)) as PbRoot;
  if (root.v !== 1 || root.serverId !== serverId) throw new Error("that peer-backup record is for another server");
  return root;
}

// ──────────────────────────────────────────────────────────────────────
// Canonical bytes of the STK-signed box → .com calls
// ──────────────────────────────────────────────────────────────────────

function u(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer`);
  return String(n);
}

function assertHex(s: string, len: number, what: string): void {
  if (typeof s !== "string" || s.length !== len || !/^[0-9a-f]*$/.test(s)) throw new Error(`${what} must be ${len / 2} bytes of lowercase hex`);
}

export interface PbCheckin {
  serverDomain: string;
  pikPubHex: string;
  xPubHex: string;
  poolBytes: number;
  fillerHeld: number;
  leaving: boolean;
  issuedAt: number;
}

export function canonicalPbCheckin(c: PbCheckin): Bytes {
  assertCanonicalField(c.serverDomain, "peer-backup", "serverDomain");
  assertHex(c.pikPubHex, 64, "pikPubHex");
  assertHex(c.xPubHex, 64, "xPubHex");
  return te.encode(
    [
      "flagship/pb-checkin/v1",
      c.serverDomain,
      c.pikPubHex,
      c.xPubHex,
      u(c.poolBytes, "poolBytes"),
      u(c.fillerHeld, "fillerHeld"),
      c.leaving ? "1" : "0",
      u(c.issuedAt, "issuedAt"),
    ].join("|"),
  );
}

/** Signed by the PIK once, so a server can't claim another holder's PIK. */
export function canonicalPbPikBind(serverDomain: string, pikPubHex: string, xPubHex: string): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  assertHex(pikPubHex, 64, "pikPubHex");
  assertHex(xPubHex, 64, "xPubHex");
  return te.encode(`flagship/pb-pik-bind/v1|${serverDomain}|${pikPubHex}|${xPubHex}`);
}

export function canonicalPbDirectory(serverDomain: string, issuedAt: number): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  return te.encode(`flagship/pb-directory/v1|${serverDomain}|${u(issuedAt, "issuedAt")}`);
}

/** digest = SHA-256 hex of the blinded messages' hex joined with "\n". */
export function pbBlindedDigest(blindedHex: ReadonlyArray<string>): string {
  return hex(sha256(te.encode(blindedHex.join("\n"))));
}

export function canonicalPbTokens(serverDomain: string, count: number, digestHex: string, issuedAt: number): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  assertHex(digestHex, 64, "digest");
  return te.encode(`flagship/pb-tokens/v1|${serverDomain}|${u(count, "count")}|${digestHex}|${u(issuedAt, "issuedAt")}`);
}

export interface PbSpend {
  leaseId: string;
  serialHex: string;
  prefixHex: string;
  sigHex: string;
}

/** digest = SHA-256 hex of "<leaseId>:<serial>:<prefix>:<sig>" lines joined with "\n". */
export function pbSpendsDigest(spends: ReadonlyArray<PbSpend>): string {
  return hex(sha256(te.encode(spends.map((s) => `${s.leaseId}:${s.serialHex}:${s.prefixHex}:${s.sigHex}`).join("\n"))));
}

export function canonicalPbRedeem(serverDomain: string, pikPubHex: string, digestHex: string, issuedAt: number): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  assertHex(pikPubHex, 64, "pikPubHex");
  assertHex(digestHex, 64, "digest");
  return te.encode(`flagship/pb-redeem/v1|${serverDomain}|${pikPubHex}|${digestHex}|${u(issuedAt, "issuedAt")}`);
}

export function canonicalPbFillerFetch(serverDomain: string, index: number, issuedAt: number): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  return te.encode(`flagship/pb-filler-fetch/v1|${serverDomain}|${u(index, "index")}|${u(issuedAt, "issuedAt")}`);
}

export function canonicalPbFillerProof(serverDomain: string, challengeId: string, answerHex: string, issuedAt: number): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  assertHex(challengeId, 32, "challengeId");
  assertHex(answerHex, 64, "answer");
  return te.encode(`flagship/pb-filler-proof/v1|${serverDomain}|${challengeId}|${answerHex}|${u(issuedAt, "issuedAt")}`);
}

export function canonicalPbRootDeposit(
  serverDomain: string,
  generation: number,
  revision: number,
  ciphertextSha256Hex: string,
  issuedAt: number,
): Bytes {
  assertCanonicalField(serverDomain, "peer-backup", "serverDomain");
  assertHex(ciphertextSha256Hex, 64, "ciphertextSha256");
  return te.encode(
    `flagship/pb-root-deposit/v1|${serverDomain}|${u(generation, "generation")}|${u(revision, "revision")}|${ciphertextSha256Hex}|${u(issuedAt, "issuedAt")}`,
  );
}

/**
 * A mailbox operation, signed by the lease key (or, for `lease.open`, by the
 * new lease key it names). `argsJson` is the exact header string sent, so no
 * side re-serialises it.
 */
export function canonicalPbOp(a: {
  op: string;
  mailboxId: string;
  leaseId: string;
  issuedAt: number;
  nonceHex: string;
  argsJson: string;
  bodySha256Hex: string;
}): Bytes {
  if (!/^[a-z]+\.[a-z]+$/.test(a.op)) throw new Error("bad op");
  assertHex(a.mailboxId, 32, "mailboxId");
  if (a.leaseId !== "-") assertHex(a.leaseId, 32, "leaseId");
  assertHex(a.nonceHex, 32, "nonce");
  assertHex(a.bodySha256Hex, 64, "bodySha256");
  return te.encode(
    [
      "flagship/pb-op/v1",
      a.op,
      a.mailboxId,
      a.leaseId,
      u(a.issuedAt, "issuedAt"),
      a.nonceHex,
      hex(sha256(te.encode(a.argsJson))),
      a.bodySha256Hex,
    ].join("|"),
  );
}

function fromHex(s: string): Bytes {
  if (!/^[0-9a-f]*$/i.test(s) || s.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

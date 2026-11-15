/**
 * The org key ring and its rotations (docs/enterprise-accounts.md §5.4, §8; phase E5).
 *
 *   flagship/org-seat-kem/v1|<orgId>|<seatId>|<kemKeyId>|<issuedAt>             seat's X-Wing key, hybrid-signed by the seat
 *   flagship/org-box-kem/v1|<orgId>|<serverDomain>|<kemKeyId>|<issuedAt>        box's X-Wing key, signed by its STK
 *   flagship/org-key-ring/v1|<orgId>|<kind>|<scope>|<version>|<prevSha256>|<keyCommitment>|<recipientsHash>|<retired>|<oarVersion>|<issuedAt>
 *   flagship/org-key-recipients/v1|<recipient>:<kemKeyId>:<sealedSha256>;...   (sorted; hash domain)
 *   flagship/org-key-commit/v1|<orgId>|<kind>|<scope>|<version>|<keyHex>       (hash domain)
 *   seal purpose flagship/org-key-seal/v1, context [orgId, kind, scope, version, recipient]
 *   flagship/org-seat-kem-seed/v1|<orgId>                                       (HKDF info from the person's UMK)
 *
 * An org has no UMK, so its shared secrets are random keys, each version hybrid-sealed (X-Wing) to
 * the recipients that need it and kept on `.com` as ciphertext. A version names the seats whose
 * departure it answers (`retired`); none of them may be a recipient, and every recipient must be live
 * and allowed that kind. Every opener checks its key against `keyCommitment`, so an admin cannot hand
 * different keys to different recipients unnoticed. A seat's rotation is done for a kind once a
 * verified version of that kind and scope was issued at or after the seat left and does not name it.
 *
 * Who may receive what (least privilege; `.com`, boxes and phones all check it):
 *   cgk            scope "*"     org admins and the org's boxes
 *   directory-key  scope "*"     org admins only
 *   archive-keys   scope server  org admins, server admins of it, that box
 *   disk-key       scope server  org admins, seats with unlock at boot on it, server admins of it, that box
 * A ring for scope "*" is approved by one org admin; a server-scoped one by an org admin or a server
 * admin of that server (the same weight as offboarding: taking access away is fast).
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hex } from "./canonicalBase.js";
import {
  OrgAuthorityError,
  authorizeOrgOrder,
  orgSha256Hex,
  verifyOrgRecordedApprovals,
  type OrgApproval,
  type OrgAuthorityState,
  type OrgSeatBook,
} from "./orgAuthority.js";
import {
  SUITE_HYBRID_SEAL_V1,
  ed25519VerifyStrict,
  hybridOpen,
  hybridSeal,
  hybridSealKeygen,
  hybridSealWithRandomness,
  hybridSign,
  parseHybridSealPublicKey,
  pqKeyId,
} from "./pqHybrid.js";
import { PqTrustError, verifyCriticalSignature, type VerifiedPqKeyBinding } from "./pqTrust.js";
import type { PolicyState } from "./assurancePolicy.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_SEAT_KEM = "flagship/org-seat-kem/v1";
export const TAG_ORG_BOX_KEM = "flagship/org-box-kem/v1";
export const TAG_ORG_KEY_RING = "flagship/org-key-ring/v1";
export const TAG_ORG_KEY_RECIPIENTS = "flagship/org-key-recipients/v1";
export const TAG_ORG_KEY_COMMIT = "flagship/org-key-commit/v1";
export const TAG_ORG_KEY_SEAL = "flagship/org-key-seal/v1";
export const TAG_ORG_SEAT_KEM_SEED = "flagship/org-seat-kem-seed/v1";

export type OrgKeyKind = "cgk" | "directory-key" | "archive-keys" | "disk-key";
export const ORG_KEY_KINDS: readonly OrgKeyKind[] = ["cgk", "directory-key", "archive-keys", "disk-key"];
export const ORG_KEY_MAX_RECIPIENTS = 256;
export const ORG_KEY_MAX_SEALED_HEX = 2 * 4096;
export const ORG_KEY_GENESIS_PREV = "0".repeat(64);
const ORG_MAX_SKEW_MS = 5 * 60 * 1000;

const HYBRID = "hybrid-ed25519-mldsa65/v1" as const;
const STRICT: PolicyState = {
  scope: { kind: "installation", id: "org" },
  profile: "strict",
  rollout: "enforced",
  generation: 1,
  headDigest: "0".repeat(128),
  enforcedEver: true,
};

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const RECIPIENT = /^(?:seat:[0-9a-f]{32}|box:[a-z0-9][a-z0-9.-]{0,252})$/;

const enc = (s: string): Bytes => new TextEncoder().encode(s);
const fail = (code: ConstructorParameters<typeof OrgAuthorityError>[0], detail?: string): never => {
  throw new OrgAuthorityError(code, detail);
};
function match(name: string, re: RegExp, v: unknown): void {
  if (typeof v !== "string" || !re.test(v)) fail("malformed", name);
}
function uint(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("malformed", name);
}
function fromHex(s: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) fail("malformed", "hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The hybrid-seal key id of an X-Wing public key, hex. */
export function orgKemKeyIdHex(kemPub: Bytes): string {
  return hex(pqKeyId(SUITE_HYBRID_SEAL_V1, parseHybridSealPublicKey(kemPub)));
}

// ── recipients' KEM keys ────────────────────────────────────────────────

/** The seat's X-Wing seed, derived from the person's UMK for this org only (every device of theirs opens). */
export function deriveOrgSeatKemSeed(umk: Bytes, orgId: string): Bytes {
  match("orgId", HEX16, orgId);
  if (umk.length !== 32) fail("malformed", "umk");
  return hkdf(sha256, umk, new Uint8Array(0), enc(`${TAG_ORG_SEAT_KEM_SEED}|${orgId}`), 32);
}

export interface OrgSeatKem {
  orgId: string;
  seatId: string;
  kemKeyId: string;
  issuedAt: number;
}

export function canonicalOrgSeatKem(s: OrgSeatKem): Bytes {
  match("orgId", HEX16, s.orgId);
  match("seatId", HEX16, s.seatId);
  match("kemKeyId", HEX32, s.kemKeyId);
  uint("issuedAt", s.issuedAt);
  return enc([TAG_ORG_SEAT_KEM, s.orgId, s.seatId, s.kemKeyId, s.issuedAt].join("|"));
}

export interface OrgBoxKem {
  orgId: string;
  serverDomain: string;
  kemKeyId: string;
  issuedAt: number;
}

export function canonicalOrgBoxKem(s: OrgBoxKem): Bytes {
  match("orgId", HEX16, s.orgId);
  match("serverDomain", DOMAIN, s.serverDomain);
  match("kemKeyId", HEX32, s.kemKeyId);
  uint("issuedAt", s.issuedAt);
  return enc([TAG_ORG_BOX_KEM, s.orgId, s.serverDomain, s.kemKeyId, s.issuedAt].join("|"));
}

/** A recipient's KEM key as it travels: the statement, the public key and the signature. */
export interface OrgSeatKemBundle {
  statement: OrgSeatKem;
  kemPubHex: string;
  signature: string;
}
export interface OrgBoxKemBundle {
  statement: OrgBoxKem;
  kemPubHex: string;
  signature: string;
}

/** A verified KEM key: who it belongs to (`seat:<id>` / `box:<domain>`) and its public key. */
export interface OrgKemKey {
  recipient: string;
  kemPub: Bytes;
  kemKeyId: string;
  issuedAt: number;
}

export function signOrgSeatKem(s: OrgSeatKem, hybridSecret: Bytes, opts: { deterministic?: boolean } = {}): string {
  return hex(hybridSign(hybridSecret, TAG_ORG_SEAT_KEM, canonicalOrgSeatKem(s), opts));
}

export function signOrgBoxKem(s: OrgBoxKem, stkSeed: Bytes): string {
  return hex(ed25519.sign(canonicalOrgBoxKem(s), stkSeed));
}

/** The key a seat signs with: its member key (a granted seat) or its admin key (an org admin in the record). */
function seatSigningKey(state: OrgAuthorityState, book: OrgSeatBook, seatId: string, now: number): VerifiedPqKeyBinding | undefined {
  const admin = state.current.admins.find((a) => a.seatId === seatId);
  if (admin) return state.bindings.get(`${state.current.version}:${seatId}`);
  if (book.revoked.has(seatId)) return undefined;
  const seat = book.seats.get(seatId);
  if (!seat || seat.grant.expiresAt <= now) return undefined;
  return seat.member;
}

/** Checks a seat's KEM statement: signed by the seat's member key, or its admin key if it is an org admin. */
export function verifyOrgSeatKem(state: OrgAuthorityState, book: OrgSeatBook, b: OrgSeatKemBundle, now: number): OrgKemKey {
  const msg = canonicalOrgSeatKem(b.statement);
  if (b.statement.orgId !== state.orgId) fail("wrong-org");
  if (b.statement.issuedAt > now + ORG_MAX_SKEW_MS) fail("future");
  const kemPub = fromHex(String(b.kemPubHex ?? ""));
  if (orgKemKeyIdHex(kemPub) !== b.statement.kemKeyId) fail("binding", "kem key id");
  const key = seatSigningKey(state, book, b.statement.seatId, now);
  if (!key) fail("seat-unknown", b.statement.seatId);
  try {
    verifyCriticalSignature({
      message: msg,
      expectedPurpose: TAG_ORG_SEAT_KEM,
      envelope: { suite: HYBRID, signature: String(b.signature ?? "") },
      signerEd25519PubHex: key!.ed25519PubHex,
      binding: key!,
      policy: STRICT,
    });
  } catch (e) {
    if (e instanceof PqTrustError) fail("bad-signature", e.code);
    throw e;
  }
  return { recipient: `seat:${b.statement.seatId}`, kemPub, kemKeyId: b.statement.kemKeyId, issuedAt: b.statement.issuedAt };
}

/** Checks a box's KEM statement under the server identity key `.com` recorded at registration. */
export function verifyOrgBoxKem(b: OrgBoxKemBundle, orgId: string, stkPubHex: string, now: number): OrgKemKey {
  const msg = canonicalOrgBoxKem(b.statement);
  if (b.statement.orgId !== orgId) fail("wrong-org");
  if (b.statement.issuedAt > now + ORG_MAX_SKEW_MS) fail("future");
  const kemPub = fromHex(String(b.kemPubHex ?? ""));
  if (orgKemKeyIdHex(kemPub) !== b.statement.kemKeyId) fail("binding", "kem key id");
  if (typeof b.signature !== "string" || !/^[0-9a-f]{128}$/.test(b.signature) || !HEX32.test(stkPubHex)) fail("bad-signature");
  if (!ed25519VerifyStrict(fromHex(b.signature), msg, fromHex(stkPubHex))) fail("bad-signature");
  return { recipient: `box:${b.statement.serverDomain}`, kemPub, kemKeyId: b.statement.kemKeyId, issuedAt: b.statement.issuedAt };
}

/** The newest verified KEM key per recipient. */
export function newestOrgKems(keys: readonly OrgKemKey[]): Map<string, OrgKemKey> {
  const out = new Map<string, OrgKemKey>();
  for (const k of keys) {
    const prev = out.get(k.recipient);
    if (!prev || prev.issuedAt < k.issuedAt) out.set(k.recipient, k);
  }
  return out;
}

// ── the ring ────────────────────────────────────────────────────────────

export interface OrgKeyRing {
  orgId: string;
  kind: OrgKeyKind;
  /** `*` for org-wide keys (cgk, directory-key); a server domain for archive-keys and disk-key. */
  scope: string;
  version: number;
  prevSha256: string;
  keyCommitment: string;
  recipientsHash: string;
  /** Seats whose departure this version answers, sorted. */
  retired: string[];
  oarVersion: number;
  issuedAt: number;
}

export interface OrgKeyRecipient {
  recipient: string;
  kemKeyId: string;
  sealedHex: string;
}

export interface OrgKeyRingBundle {
  ring: OrgKeyRing;
  recipients: OrgKeyRecipient[];
  approvals: OrgApproval[];
}

const orgWide = (k: OrgKeyKind) => k === "cgk" || k === "directory-key";

export function canonicalOrgKeyRing(r: OrgKeyRing): Bytes {
  match("orgId", HEX16, r.orgId);
  if (!ORG_KEY_KINDS.includes(r.kind)) fail("malformed", "kind");
  if (orgWide(r.kind) ? r.scope !== "*" : !DOMAIN.test(String(r.scope))) fail("malformed", "scope");
  uint("version", r.version);
  if (r.version < 1) fail("malformed", "version");
  match("prevSha256", HEX32, r.prevSha256);
  match("keyCommitment", HEX32, r.keyCommitment);
  match("recipientsHash", HEX32, r.recipientsHash);
  if (!Array.isArray(r.retired) || r.retired.length > ORG_KEY_MAX_RECIPIENTS) fail("malformed", "retired");
  for (const s of r.retired) match("retired", HEX16, s);
  const sorted = [...r.retired].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((s, i) => s !== r.retired[i])) fail("malformed", "retired not sorted");
  uint("oarVersion", r.oarVersion);
  uint("issuedAt", r.issuedAt);
  return enc(
    [TAG_ORG_KEY_RING, r.orgId, r.kind, r.scope, r.version, r.prevSha256, r.keyCommitment, r.recipientsHash, r.retired.join(","), r.oarVersion, r.issuedAt].join("|"),
  );
}

export const orgKeyRingSha256 = (r: OrgKeyRing): string => orgSha256Hex(canonicalOrgKeyRing(r));

export function orgKeyCommitment(orgId: string, kind: OrgKeyKind, scope: string, version: number, key: Bytes): string {
  if (key.length !== 32) fail("malformed", "key");
  return orgSha256Hex(enc([TAG_ORG_KEY_COMMIT, orgId, kind, scope, version, hex(key)].join("|")));
}

export function orgKeyRecipientsHash(recipients: readonly OrgKeyRecipient[]): string {
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > ORG_KEY_MAX_RECIPIENTS) fail("malformed", "recipients");
  const lines = recipients.map((x) => {
    match("recipient", RECIPIENT, x.recipient);
    match("kemKeyId", HEX32, x.kemKeyId);
    if (typeof x.sealedHex !== "string" || x.sealedHex.length === 0 || x.sealedHex.length > ORG_KEY_MAX_SEALED_HEX) fail("malformed", "sealedHex");
    return `${x.recipient}:${x.kemKeyId}:${orgSha256Hex(fromHex(x.sealedHex))}`;
  });
  if (new Set(recipients.map((x) => x.recipient)).size !== recipients.length) fail("malformed", "recipient twice");
  return orgSha256Hex(enc(`${TAG_ORG_KEY_RECIPIENTS}|${lines.sort().join(";")}`));
}

const sealContext = (r: Pick<OrgKeyRing, "orgId" | "kind" | "scope" | "version">, recipient: string): Bytes[] =>
  [r.orgId, r.kind, r.scope, String(r.version), recipient].map(enc);

/**
 * Makes a new version of a key: seals `key` to every recipient and returns the ring statement
 * (unsigned: the caller collects the approval over `canonicalOrgKeyRing(ring)`).
 */
export function buildOrgKeyRing(args: {
  orgId: string;
  kind: OrgKeyKind;
  scope: string;
  prev: OrgKeyRing | null;
  key: Bytes;
  recipients: readonly OrgKemKey[];
  retired: readonly string[];
  oarVersion: number;
  issuedAt: number;
  /** Vectors only: fixed encapsulation randomness per recipient (64 bytes each). */
  randomness?: (index: number) => Bytes;
}): { ring: OrgKeyRing; recipients: OrgKeyRecipient[] } {
  const version = args.prev ? args.prev.version + 1 : 1;
  const base = { orgId: args.orgId, kind: args.kind, scope: args.scope, version };
  const recipients = args.recipients.map((k, i) => {
    const opts = { purpose: TAG_ORG_KEY_SEAL, senderKeyId: new Uint8Array(32), issuedAt: args.issuedAt };
    const ctx = sealContext(base, k.recipient);
    const sealed = args.randomness ? hybridSealWithRandomness(k.kemPub, opts, ctx, args.key, args.randomness(i)) : hybridSeal(k.kemPub, opts, ctx, args.key);
    return { recipient: k.recipient, kemKeyId: k.kemKeyId, sealedHex: hex(sealed) };
  });
  const ring: OrgKeyRing = {
    ...base,
    prevSha256: args.prev ? orgKeyRingSha256(args.prev) : ORG_KEY_GENESIS_PREV,
    keyCommitment: orgKeyCommitment(args.orgId, args.kind, args.scope, version, args.key),
    recipientsHash: orgKeyRecipientsHash(recipients),
    retired: [...args.retired].sort(),
    oarVersion: args.oarVersion,
    issuedAt: args.issuedAt,
  };
  canonicalOrgKeyRing(ring);
  return { ring, recipients };
}

/** Opens this recipient's copy and checks it against the ring's commitment. Throws on any mismatch. */
export function openOrgKeyRing(b: Pick<OrgKeyRingBundle, "ring" | "recipients">, recipient: string, kemSecret: Bytes): Bytes {
  const mine = b.recipients.find((x) => x.recipient === recipient);
  if (!mine) fail("seat-unknown", "not a recipient");
  const { plaintext } = hybridOpen(kemSecret, TAG_ORG_KEY_SEAL, sealContext(b.ring, recipient), fromHex(mine!.sealedHex));
  if (orgKeyCommitment(b.ring.orgId, b.ring.kind, b.ring.scope, b.ring.version, plaintext) !== b.ring.keyCommitment) fail("order-mismatch", "key commitment");
  return plaintext;
}

/** The X-Wing key pair from a 32-byte seed (a seat's derived seed, or a box's stored one). */
export function orgKemKeyPair(seed: Bytes): { kemPub: Bytes; kemSecret: Bytes; kemKeyId: string } {
  const { publicKey, secretKey } = hybridSealKeygen(seed);
  return { kemPub: publicKey, kemSecret: secretKey, kemKeyId: orgKemKeyIdHex(publicKey) };
}

export interface OrgKeyRingContext {
  state: OrgAuthorityState;
  book: OrgSeatBook;
  /** Verified KEM keys, newest per recipient (`newestOrgKems`). */
  kems: Map<string, OrgKemKey>;
  /** The org's registered servers (domains). */
  servers: ReadonlySet<string>;
  now: number;
}

/** Whether `recipient` may receive a key of `kind` for `scope` (the table in the header). */
export function orgKeyRecipientAllowed(ctx: Pick<OrgKeyRingContext, "state" | "book" | "servers" | "now">, kind: OrgKeyKind, scope: string, recipient: string): boolean {
  if (recipient.startsWith("box:")) {
    const d = recipient.slice(4);
    if (!ctx.servers.has(d)) return false;
    if (kind === "cgk") return true;
    if (kind === "directory-key") return false;
    return d === scope;
  }
  const seatId = recipient.slice(5);
  if (ctx.state.current.admins.some((a) => a.seatId === seatId && a.kind === "admin")) return true;
  if (ctx.book.revoked.has(seatId)) return false;
  const seat = ctx.book.seats.get(seatId);
  if (!seat || seat.grant.expiresAt <= ctx.now) return false;
  if (ctx.book.freezes.some((f) => f.seatId === seatId && f.issuedAt <= ctx.now && ctx.now < f.untilMs)) return false;
  if (orgWide(kind)) return false;
  for (const r of seat.roles) {
    if (r.role === "server-admin" && (r.servers === "*" || r.servers.includes(scope))) return true;
    if (kind === "disk-key" && r.role === "unlock" && r.servers.includes(scope)) return true;
  }
  return false;
}

/** A seat that has left: revoked in the seat book, or an org admin in an earlier record and not in the current one. */
function departed(state: OrgAuthorityState, book: OrgSeatBook, seatId: string): boolean {
  if (book.revoked.has(seatId)) return true;
  if (state.current.admins.some((a) => a.seatId === seatId)) return false;
  return state.records.some((r) => r.admins.some((a) => a.seatId === seatId));
}

/**
 * Checks one version against the previous verified one of the same kind and scope (null for
 * version 1). `fresh` (`.com` at submission, a client before building on it) also asks that every
 * recipient may hold the key now and that the approval is current; a stored version is checked as
 * of the record it names, so it keeps verifying after a recipient later leaves (that is what the
 * next rotation answers). Throws `OrgAuthorityError`.
 */
export function verifyOrgKeyRing(ctx: OrgKeyRingContext, b: OrgKeyRingBundle, prev: OrgKeyRing | null, opts: { fresh?: boolean } = {}): void {
  const r = b.ring;
  const order = canonicalOrgKeyRing(r);
  if (r.orgId !== ctx.state.orgId) fail("wrong-org");
  if (r.issuedAt > ctx.now + ORG_MAX_SKEW_MS) fail("future");
  checkLink(r, prev);
  if (prev) {
    if (prev.kind !== r.kind || prev.scope !== r.scope) fail("malformed", "another key");
    if (r.issuedAt <= prev.issuedAt) fail("not-after-previous");
  }
  if (orgKeyRecipientsHash(b.recipients) !== r.recipientsHash) fail("order-mismatch", "recipients");
  for (const x of b.recipients) {
    if (x.recipient.startsWith("seat:") && r.retired.includes(x.recipient.slice(5))) fail("scope", "a retired seat is a recipient");
  }
  const action = r.scope === "*" ? ({ kind: "seat-revoke" } as const) : ({ kind: "operate", server: r.scope } as const);
  if (!opts.fresh) {
    verifyOrgRecordedApprovals(ctx.state, ctx.book, order, b.approvals, r.oarVersion, ctx.now, r.scope === "*" ? undefined : action);
    return;
  }
  for (const s of r.retired) {
    if (!departed(ctx.state, ctx.book, s)) fail("scope", `retired seat ${s} has not left`);
  }
  for (const x of b.recipients) {
    if (!orgKeyRecipientAllowed(ctx, r.kind, r.scope, x.recipient)) fail("scope", `${x.recipient} may not hold ${r.kind}`);
    const k = ctx.kems.get(x.recipient);
    if (!k || k.kemKeyId !== x.kemKeyId) fail("binding", `${x.recipient} kem key`);
  }
  if (b.approvals[0]?.oarVersion !== r.oarVersion) fail("stale-oar");
  authorizeOrgOrder({ state: ctx.state, book: ctx.book, action, order, approvals: b.approvals, now: ctx.now });
}

export interface OrgKeyRings {
  /** Every verified version, per `<kind>|<scope>`, oldest first. */
  chains: Map<string, OrgKeyRingBundle[]>;
  refused: Array<{ kind: string; scope: string; version: number; code: string }>;
}

export const orgKeyChainId = (kind: OrgKeyKind, scope: string) => `${kind}|${scope}`;

/**
 * Verifies every stored version, chain by chain, as of the record each names. A version that fails
 * stops its chain (a gap or a fork is never skipped over).
 */
export function buildOrgKeyRings(ctx: OrgKeyRingContext, bundles: readonly OrgKeyRingBundle[]): OrgKeyRings {
  const groups = new Map<string, OrgKeyRingBundle[]>();
  for (const b of bundles) {
    const id = orgKeyChainId(b.ring?.kind, b.ring?.scope);
    groups.set(id, [...(groups.get(id) ?? []), b]);
  }
  const chains = new Map<string, OrgKeyRingBundle[]>();
  const refused: OrgKeyRings["refused"] = [];
  for (const [id, list] of groups) {
    const sorted = [...list].sort((a, b) => a.ring.version - b.ring.version);
    const ok: OrgKeyRingBundle[] = [];
    for (const b of sorted) {
      const prev = ok[ok.length - 1]?.ring ?? null;
      try {
        verifyOrgKeyRing(ctx, b, prev);
        ok.push(b);
      } catch (e) {
        refused.push({ kind: b.ring?.kind, scope: b.ring?.scope, version: b.ring?.version, code: e instanceof OrgAuthorityError ? e.code : "malformed" });
        break;
      }
    }
    if (ok.length > 0) chains.set(id, ok);
  }
  return { chains, refused };
}

function checkLink(r: OrgKeyRing, prev: OrgKeyRing | null): void {
  canonicalOrgKeyRing(r);
  if (prev) {
    if (r.version !== prev.version + 1) fail("version-gap");
    if (r.prevSha256 !== orgKeyRingSha256(prev)) fail("prev-hash");
  } else if (r.version !== 1 || r.prevSha256 !== ORG_KEY_GENESIS_PREV) fail("version-gap");
}

/**
 * True once a version of `kind` for `scope` issued at or after `leftAt` leaves `seatId` out: the
 * seat's departure is answered for that key.
 */
export function orgRotationDone(rings: OrgKeyRings, kind: OrgKeyKind, scope: string, seatId: string, leftAt: number): boolean {
  const chain = rings.chains.get(orgKeyChainId(kind, orgWide(kind) ? "*" : scope)) ?? [];
  return chain.some((b) => b.ring.issuedAt >= leftAt && !b.recipients.some((x) => x.recipient === `seat:${seatId}`));
}

/**
 * The newest version a recipient can open, or null. A version it is no longer in is the end of its
 * access, so a stale copy is never offered.
 */
export function orgNewestRingFor(rings: OrgKeyRings, kind: OrgKeyKind, scope: string, recipient: string): OrgKeyRingBundle | null {
  const chain = rings.chains.get(orgKeyChainId(kind, orgWide(kind) ? "*" : scope)) ?? [];
  const newest = chain[chain.length - 1];
  return newest && newest.recipients.some((x) => x.recipient === recipient) ? newest : null;
}

export interface OrgPendingRotation {
  seatId: string;
  leftAt: number;
  keys: Array<{ kind: OrgKeyKind; scope: string }>;
}

/**
 * What every departed seat still leaves to rotate: each key chain whose versions ever sealed to the
 * seat and has no version since it left that leaves it out, and the disk key of every server where
 * its grants gave it unlock at boot (its copy lives in the unlock deposit, not in a ring). A seat
 * leaves at its revoke's `issuedAt`; an org admin at the first record that drops it.
 */
export function orgPendingRotations(
  state: OrgAuthorityState,
  book: OrgSeatBook,
  rings: OrgKeyRings,
  history: { revokes: ReadonlyArray<{ revoke: { seatId: string; issuedAt: number } }>; grants: ReadonlyArray<{ grant: { seatId: string }; roles: ReadonlyArray<{ role: string; servers?: unknown }> }> },
): OrgPendingRotation[] {
  const left = new Map<string, number>();
  for (const r of history.revokes) {
    if (book.revoked.has(r.revoke.seatId)) left.set(r.revoke.seatId, Math.min(left.get(r.revoke.seatId) ?? Infinity, r.revoke.issuedAt));
  }
  const current = new Set(state.current.admins.map((a) => a.seatId));
  for (let i = 1; i < state.records.length; i++) {
    const before = state.records[i - 1]!;
    const at = state.records[i]!;
    for (const a of before.admins) {
      if (!at.admins.some((x) => x.seatId === a.seatId) && !current.has(a.seatId) && !left.has(a.seatId)) left.set(a.seatId, at.issuedAt);
    }
  }
  const out: OrgPendingRotation[] = [];
  for (const [seatId, leftAt] of left) {
    const keys: OrgPendingRotation["keys"] = [];
    for (const chain of rings.chains.values()) {
      const r = chain[0]!.ring;
      if (!chain.some((b) => b.recipients.some((x) => x.recipient === `seat:${seatId}`))) continue;
      if (!orgRotationDone(rings, r.kind, r.scope, seatId, leftAt)) keys.push({ kind: r.kind, scope: r.scope });
    }
    const unlock = new Set<string>();
    for (const g of history.grants) {
      if (g.grant.seatId !== seatId) continue;
      for (const role of g.roles) if (role.role === "unlock" && Array.isArray(role.servers)) for (const s of role.servers) unlock.add(String(s));
    }
    for (const s of unlock) {
      if (!orgRotationDone(rings, "disk-key", s, seatId, leftAt) && !keys.some((k) => k.kind === "disk-key" && k.scope === s)) keys.push({ kind: "disk-key", scope: s });
    }
    if (keys.length > 0) out.push({ seatId, leftAt, keys: keys.sort((a, b) => (a.kind + a.scope < b.kind + b.scope ? -1 : 1)) });
  }
  return out.sort((a, b) => a.leftAt - b.leftAt || (a.seatId < b.seatId ? -1 : 1));
}

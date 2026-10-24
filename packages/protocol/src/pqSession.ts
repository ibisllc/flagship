/**
 * Architecture v2 milestone 4: `flagship/pq-session/v1`, a PQ-authenticated channel inside the
 * existing TLS connection. DRAFT, pending Q01 external cryptographic review.
 * Spec: docs/architecture-v2/pq-suites.md §13. Vectors: test-vectors/pq-session/.
 * Rust twin: rust/crates/flagship-crypto/src/session.rs.
 *
 * Three messages, signed-KEM in the SIGMA pattern:
 *
 *   hello    initiator → responder: who it is (bound hybrid key id), which responder key it
 *            pinned, an ephemeral X-Wing key, a nonce and the time.
 *   accept   responder → initiator: an X-Wing encapsulation to the ephemeral key, its nonce, a
 *            hybrid signature over the hello digest and everything it adds, and a key
 *            confirmation MAC under the shared secret.
 *   finish   initiator → responder: a hybrid signature over the transcript so far and its own
 *            confirmation MAC.
 *
 * Both signatures are the hybrid AND-suite under keys the other side already trusts through a
 * verified `flagship/pq-key-binding/v1`; the shared secret is X-Wing's, so the channel stays
 * confidential and authenticated if every classical primitive (X25519, Ed25519, the WebPKI
 * certificate of the TLS connection around it) falls. The ephemeral X-Wing key gives forward
 * secrecy. Records are AES-256-GCM under one key per direction with the sequence number in the
 * nonce; a response carries its request's number, so it cannot be moved onto another request.
 */
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import { gcm } from "@noble/ciphers/aes";
import {
  HYBRID_SEAL_ENC_LEN,
  HYBRID_SEAL_PUBLIC_KEY_LEN,
  HYBRID_SIG_LEN,
  hybridVerify,
  parseHybridSealPublicKey,
} from "./pqHybrid.js";
import type { PqBindingRole, VerifiedPqKeyBinding } from "./pqTrust.js";
import type { Bytes } from "./types.js";

export const TAG_PQ_SESSION = "flagship/pq-session/v1";
export const TAG_PQ_SESSION_HELLO = "flagship/pq-session-hello/v1";
export const TAG_PQ_SESSION_ACCEPT = "flagship/pq-session-accept/v1";
export const TAG_PQ_SESSION_FINISH = "flagship/pq-session-finish/v1";
export const TAG_PQ_SESSION_KEYS = "flagship/pq-session-keys/v1";
export const TAG_PQ_SESSION_RECORD = "flagship/pq-session-record/v1";

/** Roles that may open a session; the responder is always a box (`box-stk`). */
export const PQ_SESSION_INITIATOR_ROLES = ["device", "box-stk"] as const;
export type PqSessionInitiatorRole = (typeof PQ_SESSION_INITIATOR_ROLES)[number];

export const PQ_SESSION_MAX_SKEW_MS = 5 * 60 * 1000;
export const PQ_SESSION_MAX_RECORD = 16 * 1024 * 1024;
/** How far below the highest sequence number seen a request may still arrive (concurrent calls). */
export const PQ_SESSION_REPLAY_WINDOW = 1024;
export const PQ_SESSION_IDLE_MS = 15 * 60 * 1000;
export const PQ_SESSION_MAX_LIFETIME_MS = 12 * 3600 * 1000;

export const PQ_SESSION_DIR_INITIATOR = 1;
export const PQ_SESSION_DIR_RESPONDER = 2;

const SUBJECT = /^[a-z0-9][a-z0-9._:@-]{0,252}$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

export type PqSessionErrorCode =
  | "session-malformed"
  | "session-stale"
  | "responder-mismatch"
  | "unknown-initiator"
  | "bad-public-key"
  | "bad-signature"
  | "confirm-failed"
  | "decrypt-failed"
  | "replay"
  | "record-too-large"
  | "session-expired"
  | "randomness";

export class PqSessionError extends Error {
  constructor(readonly code: PqSessionErrorCode) {
    super(code);
    this.name = "PqSessionError";
  }
}

const fail = (code: PqSessionErrorCode): never => {
  throw new PqSessionError(code);
};

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

function concat(...parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

const u8 = (n: number): Bytes => Uint8Array.of(n & 0xff);
const u32be = (n: number): Bytes => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
function u64be(n: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}
const lp8 = (b: Bytes): Bytes => {
  if (b.length > 255) fail("session-malformed");
  return concat(u8(b.length), b);
};

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: unknown, len: number): Bytes {
  if (typeof s !== "string" || s.length !== len * 2 || !HEX.test(s)) return fail("session-malformed");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function exactKeys(o: unknown, keys: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return fail("session-malformed");
  if (Object.keys(o).sort().join(",") !== keys) fail("session-malformed");
  return o as Record<string, unknown>;
}

function timeOk(t: unknown): number {
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) return fail("session-malformed");
  return t;
}

// ── wire ─────────────────────────────────────────────────────────────────

export interface PqSessionHello {
  v: 1;
  responder: string;
  initiatorRole: PqSessionInitiatorRole;
  initiatorSubject: string;
  /** keyId(0x0002, initiator hybrid key), hex. */
  initiatorKeyId: string;
  /** keyId(0x0002, the responder key the initiator pinned), hex. */
  responderKeyId: string;
  /** X-Wing encapsulation key, 1216 bytes hex. */
  ephemeralPub: string;
  nonce: string;
  issuedAt: number;
}

export interface PqSessionAccept {
  v: 1;
  enc: string;
  nonce: string;
  issuedAt: number;
  signature: string;
  confirm: string;
}

export interface PqSessionFinish {
  v: 1;
  signature: string;
  confirm: string;
}

export interface PqSessionHelloFields {
  responder: string;
  initiatorRole: PqSessionInitiatorRole;
  initiatorSubject: string;
  initiatorKeyId: Bytes;
  responderKeyId: Bytes;
  ephemeralPub: Bytes;
  nonce: Bytes;
  issuedAt: number;
}

export function parsePqSessionHello(w: unknown): PqSessionHelloFields {
  const o = exactKeys(w, "ephemeralPub,initiatorKeyId,initiatorRole,initiatorSubject,issuedAt,nonce,responder,responderKeyId,v");
  if (o.v !== 1) fail("session-malformed");
  if (typeof o.responder !== "string" || !SUBJECT.test(o.responder)) fail("session-malformed");
  if (typeof o.initiatorSubject !== "string" || !SUBJECT.test(o.initiatorSubject)) fail("session-malformed");
  if (!(PQ_SESSION_INITIATOR_ROLES as readonly unknown[]).includes(o.initiatorRole)) fail("session-malformed");
  const ephemeralPub = fromHex(o.ephemeralPub, HYBRID_SEAL_PUBLIC_KEY_LEN);
  return {
    responder: o.responder as string,
    initiatorRole: o.initiatorRole as PqSessionInitiatorRole,
    initiatorSubject: o.initiatorSubject as string,
    initiatorKeyId: fromHex(o.initiatorKeyId, 32),
    responderKeyId: fromHex(o.responderKeyId, 32),
    ephemeralPub,
    nonce: fromHex(o.nonce, 32),
    issuedAt: timeOk(o.issuedAt),
  };
}

/** The hello's canonical bytes (§13.2); its SHA-512 opens the transcript. */
export function pqSessionHelloBytes(h: PqSessionHelloFields): Bytes {
  return concat(
    lp8(utf8(TAG_PQ_SESSION_HELLO)),
    lp8(utf8(h.responder)),
    lp8(utf8(h.initiatorRole)),
    lp8(utf8(h.initiatorSubject)),
    h.initiatorKeyId,
    h.responderKeyId,
    h.ephemeralPub,
    h.nonce,
    u64be(h.issuedAt),
  );
}

/**
 * What the responder signs (§13.3), in the v1 text form keyd's purpose check reads:
 * `flagship/pq-session-accept/v1|<responder>|<hex SHA-512(SHA-512(hello) || enc || nonce || time)>`.
 */
export function pqSessionAcceptTbs(helloBytes: Bytes, responder: string, enc: Bytes, nonce: Bytes, issuedAt: number): Bytes {
  const core = sha512(concat(sha512(helloBytes), enc, nonce, u64be(issuedAt)));
  return utf8(`${TAG_PQ_SESSION_ACCEPT}|${responder}|${toHex(core)}`);
}

/** What the initiator signs: `flagship/pq-session-finish/v1|<initiatorSubject>|<hex SHA-512(accept || sigR || confirmR)>`. */
export function pqSessionFinishTbs(tbsA: Bytes, sigR: Bytes, confirmR: Bytes, initiatorSubject: string): Bytes {
  return utf8(`${TAG_PQ_SESSION_FINISH}|${initiatorSubject}|${toHex(sha512(concat(tbsA, sigR, confirmR)))}`);
}

function expand(prk: Bytes, label: string, th: Bytes, n: number): Bytes {
  return hkdfExpand(sha512, prk, concat(lp8(utf8(TAG_PQ_SESSION_KEYS)), lp8(utf8(label)), th), n);
}

function confirmTag(prk: Bytes, label: string, th: Bytes): Bytes {
  const k = expand(prk, label, th, 32);
  try {
    return hmac(sha512, k, th).slice(0, 32);
  } finally {
    k.fill(0);
  }
}

// ── keys after the handshake ─────────────────────────────────────────────

export interface PqSessionKeys {
  sessionId: Bytes;
  initiatorToResponder: Bytes;
  responderToInitiator: Bytes;
}

function trafficKeys(prk: Bytes, th4: Bytes): PqSessionKeys {
  return {
    sessionId: expand(prk, "session-id", th4, 32),
    initiatorToResponder: expand(prk, "initiator-to-responder", th4, 32),
    responderToInitiator: expand(prk, "responder-to-initiator", th4, 32),
  };
}

/** Signs `payload` under `purpose` with the hybrid key named by the binding (keyd, a phone's store, a test). */
export type PqSessionSigner = (purpose: string, payload: Bytes) => Bytes | Promise<Bytes>;

export interface PqSessionIdentity {
  binding: VerifiedPqKeyBinding;
  sign: PqSessionSigner;
}

/** Fixed randomness for vectors only: reusing any of it breaks the channel. */
export interface PqSessionRandomness {
  ephemeralSeed?: Bytes;
  helloNonce?: Bytes;
  encapsulation?: Bytes;
  acceptNonce?: Bytes;
}

function random(n: number, fixed: Bytes | undefined): Bytes {
  if (fixed) {
    if (fixed.length !== n) fail("randomness");
    return Uint8Array.from(fixed);
  }
  return crypto.getRandomValues(new Uint8Array(n));
}

// ── initiator ────────────────────────────────────────────────────────────

export interface PqSessionInitiatorState {
  readonly hello: PqSessionHello;
  readonly helloBytes: Bytes;
  readonly responderBinding: VerifiedPqKeyBinding;
  readonly identity: PqSessionIdentity;
  ephemeralSecret: Bytes | null;
}

export function startPqSession(args: {
  responder: string;
  responderBinding: VerifiedPqKeyBinding;
  initiatorRole: PqSessionInitiatorRole;
  identity: PqSessionIdentity;
  now: number;
  randomness?: PqSessionRandomness;
}): PqSessionInitiatorState {
  if (!SUBJECT.test(args.responder)) fail("session-malformed");
  if (args.responderBinding.role !== "box-stk" || args.responderBinding.subjectId !== args.responder) fail("responder-mismatch");
  if (args.identity.binding.role !== (args.initiatorRole as PqBindingRole)) fail("unknown-initiator");
  const seed = random(32, args.randomness?.ephemeralSeed);
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  const fields: PqSessionHelloFields = {
    responder: args.responder,
    initiatorRole: args.initiatorRole,
    initiatorSubject: args.identity.binding.subjectId,
    initiatorKeyId: fromHex(args.identity.binding.keyIdHex, 32),
    responderKeyId: fromHex(args.responderBinding.keyIdHex, 32),
    ephemeralPub: publicKey,
    nonce: random(32, args.randomness?.helloNonce),
    issuedAt: timeOk(args.now),
  };
  const hello: PqSessionHello = {
    v: 1,
    responder: fields.responder,
    initiatorRole: fields.initiatorRole,
    initiatorSubject: fields.initiatorSubject,
    initiatorKeyId: toHex(fields.initiatorKeyId),
    responderKeyId: toHex(fields.responderKeyId),
    ephemeralPub: toHex(fields.ephemeralPub),
    nonce: toHex(fields.nonce),
    issuedAt: fields.issuedAt,
  };
  return { hello, helloBytes: pqSessionHelloBytes(fields), responderBinding: args.responderBinding, identity: args.identity, ephemeralSecret: seed };
}

/**
 * Checks the responder's accept and answers with the finish. Order: wire shape; the accept's
 * time; the responder's hybrid signature under the pinned key; decapsulation; its confirmation.
 */
export async function finishPqSession(
  st: PqSessionInitiatorState,
  acceptWire: unknown,
  now: number,
): Promise<{ finish: PqSessionFinish; session: PqSessionChannel }> {
  const seed = st.ephemeralSecret;
  if (!seed) return fail("session-expired");
  st.ephemeralSecret = null;
  try {
    const o = exactKeys(acceptWire, "confirm,enc,issuedAt,nonce,signature,v");
    if (o.v !== 1) fail("session-malformed");
    const enc = fromHex(o.enc, HYBRID_SEAL_ENC_LEN);
    const nonce = fromHex(o.nonce, 32);
    const issuedAt = timeOk(o.issuedAt);
    const sigR = fromHex(o.signature, HYBRID_SIG_LEN);
    const confirmR = fromHex(o.confirm, 32);
    if (Math.abs(issuedAt - now) > PQ_SESSION_MAX_SKEW_MS) fail("session-stale");
    const tbsA = pqSessionAcceptTbs(st.helloBytes, st.hello.responder, enc, nonce, issuedAt);
    try {
      hybridVerify(st.responderBinding.hybridPublicKey, TAG_PQ_SESSION_ACCEPT, tbsA, sigR);
    } catch {
      fail("bad-signature");
    }
    let ss: Bytes;
    try {
      ss = ml_kem768_x25519.decapsulate(enc, seed);
    } catch {
      return fail("confirm-failed");
    }
    const prk = hkdfExtract(sha512, ss, utf8(TAG_PQ_SESSION));
    ss.fill(0);
    const th1 = sha512(concat(tbsA, sigR));
    if (!equalBytes(confirmTag(prk, "responder-confirm", th1), confirmR)) fail("confirm-failed");
    const tbsF = pqSessionFinishTbs(tbsA, sigR, confirmR, st.hello.initiatorSubject);
    const sigI = await st.identity.sign(TAG_PQ_SESSION_FINISH, tbsF);
    if (sigI.length !== HYBRID_SIG_LEN) fail("bad-signature");
    const th3 = sha512(concat(tbsF, sigI));
    const confirmI = confirmTag(prk, "initiator-confirm", th3);
    const keys = trafficKeys(prk, sha512(concat(tbsF, sigI, confirmI)));
    prk.fill(0);
    return {
      finish: { v: 1, signature: toHex(sigI), confirm: toHex(confirmI) },
      session: new PqSessionChannel("initiator", keys, now, st.responderBinding.subjectId, st.responderBinding),
    };
  } finally {
    seed.fill(0);
  }
}

// ── responder ────────────────────────────────────────────────────────────

/** Finds the bound key the responder trusts for an initiator, or null (box: its device book or a pinned sibling). */
export type PqSessionInitiatorLookup = (role: PqSessionInitiatorRole, subject: string, keyIdHex: string) => VerifiedPqKeyBinding | null;

export interface PqSessionResponderPending {
  readonly initiator: VerifiedPqKeyBinding;
  readonly createdAt: number;
  readonly tbsF: Bytes;
  prk: Bytes | null;
}

/**
 * Answers a hello. Order: wire shape; the responder named and the key pinned are this box's;
 * the hello's time; the initiator is a key this box trusts; the ephemeral key; encapsulation.
 */
export async function acceptPqSession(args: {
  hello: unknown;
  identity: PqSessionIdentity;
  lookupInitiator: PqSessionInitiatorLookup;
  now: number;
  randomness?: PqSessionRandomness;
}): Promise<{ accept: PqSessionAccept; pending: PqSessionResponderPending }> {
  const h = parsePqSessionHello(args.hello);
  const self = args.identity.binding;
  if (self.role !== "box-stk" || h.responder !== self.subjectId) fail("responder-mismatch");
  if (toHex(h.responderKeyId) !== self.keyIdHex) fail("responder-mismatch");
  if (Math.abs(h.issuedAt - args.now) > PQ_SESSION_MAX_SKEW_MS) fail("session-stale");
  const initiator = args.lookupInitiator(h.initiatorRole, h.initiatorSubject, toHex(h.initiatorKeyId));
  if (
    !initiator ||
    initiator.role !== h.initiatorRole ||
    initiator.subjectId !== h.initiatorSubject ||
    initiator.keyIdHex !== toHex(h.initiatorKeyId)
  ) {
    return fail("unknown-initiator");
  }
  try {
    parseHybridSealPublicKey(h.ephemeralPub);
  } catch {
    fail("bad-public-key");
  }
  const eseed = random(64, args.randomness?.encapsulation);
  let enc: Bytes;
  let ss: Bytes;
  try {
    const r = ml_kem768_x25519.encapsulate(h.ephemeralPub, eseed);
    enc = r.cipherText;
    ss = r.sharedSecret;
  } catch {
    return fail("bad-public-key");
  } finally {
    eseed.fill(0);
  }
  const nonce = random(32, args.randomness?.acceptNonce);
  const issuedAt = timeOk(args.now);
  const tbsA = pqSessionAcceptTbs(pqSessionHelloBytes(h), h.responder, enc, nonce, issuedAt);
  const sigR = await args.identity.sign(TAG_PQ_SESSION_ACCEPT, tbsA);
  if (sigR.length !== HYBRID_SIG_LEN) fail("bad-signature");
  const prk = hkdfExtract(sha512, ss, utf8(TAG_PQ_SESSION));
  ss.fill(0);
  const confirmR = confirmTag(prk, "responder-confirm", sha512(concat(tbsA, sigR)));
  const tbsF = pqSessionFinishTbs(tbsA, sigR, confirmR, h.initiatorSubject);
  return {
    accept: { v: 1, enc: toHex(enc), nonce: toHex(nonce), issuedAt, signature: toHex(sigR), confirm: toHex(confirmR) },
    pending: { initiator, createdAt: args.now, tbsF, prk },
  };
}

/** Checks the initiator's finish; single use. Order: shape; signature; confirmation. */
export function completePqSession(p: PqSessionResponderPending, finishWire: unknown, now: number): PqSessionChannel {
  const prk = p.prk;
  if (!prk) return fail("session-expired");
  p.prk = null;
  try {
    if (now - p.createdAt > PQ_SESSION_MAX_SKEW_MS || now < p.createdAt - PQ_SESSION_MAX_SKEW_MS) fail("session-stale");
    const o = exactKeys(finishWire, "confirm,signature,v");
    if (o.v !== 1) fail("session-malformed");
    const sigI = fromHex(o.signature, HYBRID_SIG_LEN);
    const confirmI = fromHex(o.confirm, 32);
    try {
      hybridVerify(p.initiator.hybridPublicKey, TAG_PQ_SESSION_FINISH, p.tbsF, sigI);
    } catch {
      fail("bad-signature");
    }
    const th3 = sha512(concat(p.tbsF, sigI));
    if (!equalBytes(confirmTag(prk, "initiator-confirm", th3), confirmI)) fail("confirm-failed");
    const keys = trafficKeys(prk, sha512(concat(p.tbsF, sigI, confirmI)));
    return new PqSessionChannel("responder", keys, now, p.initiator.subjectId, p.initiator);
  } finally {
    prk.fill(0);
  }
}

// ── records ──────────────────────────────────────────────────────────────

function recordAad(sessionId: Bytes, dir: number, seq: number): Bytes {
  return concat(lp8(utf8(TAG_PQ_SESSION_RECORD)), sessionId, u8(dir), u64be(seq));
}

function recordNonce(dir: number, seq: number): Bytes {
  return concat(u32be(dir), u64be(seq));
}

/** Encrypts one record; exported for the vectors. */
export function pqSessionSealRecord(key: Bytes, sessionId: Bytes, dir: number, seq: number, plaintext: Bytes): Bytes {
  if (plaintext.length > PQ_SESSION_MAX_RECORD) fail("record-too-large");
  return concat(u64be(seq), gcm(key, recordNonce(dir, seq), recordAad(sessionId, dir, seq)).encrypt(plaintext));
}

export function pqSessionOpenRecord(key: Bytes, sessionId: Bytes, dir: number, record: Bytes): { seq: number; plaintext: Bytes } {
  if (record.length < 8 + 16) fail("decrypt-failed");
  if (record.length > 8 + 16 + PQ_SESSION_MAX_RECORD) fail("record-too-large");
  const seq = Number(new DataView(record.buffer, record.byteOffset, 8).getBigUint64(0));
  if (!Number.isSafeInteger(seq)) fail("decrypt-failed");
  try {
    return { seq, plaintext: gcm(key, recordNonce(dir, seq), recordAad(sessionId, dir, seq)).decrypt(record.subarray(8)) };
  } catch {
    return fail("decrypt-failed");
  }
}

/**
 * One established session. The initiator seals requests (`sealRequest`) and opens the answer to
 * that request number; the responder opens requests (refusing replays inside a window, so
 * concurrent calls may arrive out of order) and seals the answer under the request's number.
 */
export class PqSessionChannel {
  readonly sessionIdHex: string;
  private nextSeq = 0;
  private maxSeen = -1;
  private readonly seen = new Set<number>();
  private lastUsed: number;

  constructor(
    readonly side: "initiator" | "responder",
    private readonly keys: PqSessionKeys,
    readonly establishedAt: number,
    /** The other side's subject (device id or server domain). */
    readonly peerSubject: string,
    readonly peer: VerifiedPqKeyBinding,
  ) {
    this.sessionIdHex = toHex(keys.sessionId);
    this.lastUsed = establishedAt;
  }

  expired(now: number): boolean {
    return now - this.lastUsed > PQ_SESSION_IDLE_MS || now - this.establishedAt > PQ_SESSION_MAX_LIFETIME_MS;
  }

  private live(now: number): void {
    if (this.expired(now)) fail("session-expired");
    this.lastUsed = now;
  }

  sealRequest(plaintext: Bytes, now: number): { seq: number; record: Bytes } {
    if (this.side !== "initiator") fail("session-malformed");
    this.live(now);
    const seq = this.nextSeq++;
    return { seq, record: pqSessionSealRecord(this.keys.initiatorToResponder, this.keys.sessionId, PQ_SESSION_DIR_INITIATOR, seq, plaintext) };
  }

  openResponse(seq: number, record: Bytes): Bytes {
    if (this.side !== "initiator") fail("session-malformed");
    const r = pqSessionOpenRecord(this.keys.responderToInitiator, this.keys.sessionId, PQ_SESSION_DIR_RESPONDER, record);
    if (r.seq !== seq) fail("replay");
    return r.plaintext;
  }

  openRequest(record: Bytes, now: number): { seq: number; plaintext: Bytes } {
    if (this.side !== "responder") fail("session-malformed");
    this.live(now);
    const r = pqSessionOpenRecord(this.keys.initiatorToResponder, this.keys.sessionId, PQ_SESSION_DIR_INITIATOR, record);
    if (this.seen.has(r.seq) || r.seq + PQ_SESSION_REPLAY_WINDOW <= this.maxSeen) fail("replay");
    this.seen.add(r.seq);
    if (r.seq > this.maxSeen) {
      this.maxSeen = r.seq;
      for (const s of this.seen) if (s + PQ_SESSION_REPLAY_WINDOW <= this.maxSeen) this.seen.delete(s);
    }
    return r;
  }

  sealResponse(seq: number, plaintext: Bytes): Bytes {
    if (this.side !== "responder") fail("session-malformed");
    return pqSessionSealRecord(this.keys.responderToInitiator, this.keys.sessionId, PQ_SESSION_DIR_RESPONDER, seq, plaintext);
  }

  /** Wipes the traffic keys; every later call fails to decrypt. */
  close(): void {
    this.keys.initiatorToResponder.fill(0);
    this.keys.responderToInitiator.fill(0);
    this.lastUsed = -Infinity;
  }
}

// ── the inner HTTP request a record carries (§13.5) ──────────────────────

export interface PqInnerRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** base64 */
  body: string;
}

export interface PqInnerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/;

export function encodeInner(v: PqInnerRequest | PqInnerResponse): Bytes {
  return utf8(JSON.stringify(v));
}

export function decodeInnerRequest(b: Bytes): PqInnerRequest {
  let o: Record<string, unknown>;
  try {
    o = exactKeys(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)), "body,headers,method,path");
  } catch (e) {
    if (e instanceof PqSessionError) throw e;
    return fail("session-malformed");
  }
  if (typeof o.method !== "string" || !METHOD.test(o.method)) fail("session-malformed");
  if (typeof o.path !== "string" || !o.path.startsWith("/") || o.path.length > 8192 || o.path.startsWith("/api/pq-session/")) fail("session-malformed");
  if (typeof o.body !== "string") fail("session-malformed");
  const headers = o.headers;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) fail("session-malformed");
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 16384 || /[\r\n]/.test(v)) fail("session-malformed");
  }
  return o as unknown as PqInnerRequest;
}

export function decodeInnerResponse(b: Bytes): PqInnerResponse {
  let o: Record<string, unknown>;
  try {
    o = exactKeys(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)), "body,headers,status");
  } catch (e) {
    if (e instanceof PqSessionError) throw e;
    return fail("session-malformed");
  }
  if (typeof o.status !== "number" || !Number.isInteger(o.status) || o.status < 100 || o.status > 599) fail("session-malformed");
  if (typeof o.body !== "string" || typeof o.headers !== "object" || o.headers === null) fail("session-malformed");
  return o as unknown as PqInnerResponse;
}

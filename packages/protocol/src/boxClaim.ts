/**
 * `flagship/box-claim/v1`: how a phone claims a preinstalled retail box (docs/retail-box-setup.md
 * §7, §15). DRAFT, pending external review alongside `flagship/pq-session/v1`.
 *
 * Four handshake messages, then AES-256-GCM records:
 *
 *   hello   phone → box: mode, the phone's ephemeral X-Wing key, a nonce.
 *   accept  box → phone: mode, box state, an encapsulation to the phone's key, the box's own
 *           ephemeral X-Wing key, a nonce.
 *   finish  phone → box: an encapsulation to the box's key and the phone's confirmation MAC.
 *   ready   box → phone: the box's confirmation MAC.
 *
 * Both KEM secrets feed one HKDF whose salt carries the mode and, in mode `code`, a hash of the
 * box's current setup code. In mode `open` nothing authenticates the keys: the session hides the
 * claim from passive listeners only, and the timed press, the `.com` key pre-registration and the
 * internet check carry the rest (§6, §7.7). In mode `code` a party without the code fails the
 * confirmation MACs, so a relay cannot finish (§15.1, the sharing method).
 */
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { gcm } from "@noble/ciphers/aes";
import { ed } from "./edSync.js";
import {
  HYBRID_SEAL_ENC_LEN,
  HYBRID_SEAL_PUBLIC_KEY_LEN,
  HYBRID_SIG_LEN,
  HYBRID_SIG_PUBLIC_KEY_LEN,
  hybridVerify,
  parseHybridSealPublicKey,
} from "./pqHybrid.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_BOX_CLAIM = "flagship/box-claim/v1";
export const TAG_BOX_CLAIM_KEYS = "flagship/box-claim-keys/v1";
export const TAG_BOX_CLAIM_CONFIRM = "flagship/box-claim-confirm/v1";
export const TAG_BOX_CLAIM_RECORD = "flagship/box-claim-record/v1";
export const TAG_BOX_CLAIM_RECEIPT = "flagship/box-claim-receipt/v1";
export const TAG_BOX_CLAIM_KEY = "flagship/box-claim-key/v1";
export const TAG_BOX_SETUP_CODE_KEY = "flagship/box-setup-code-key/v1";
export const TAG_BOX_CLAIM_MAILBOX = "flagship/box-claim-mailbox/v1";

export const BOX_CLAIM_MODES = ["open", "code"] as const;
export type BoxClaimMode = (typeof BOX_CLAIM_MODES)[number];
export const BOX_CLAIM_STATES = ["unclaimed", "reset-window"] as const;
export type BoxClaimAdvertState = (typeof BOX_CLAIM_STATES)[number];

/** An unclaimed box advertises this long after power-on; the reset window lasts as long. */
export const BOX_CLAIM_ADVERTISE_MS = 10 * 60_000;
export const BOX_CLAIM_RESET_WINDOW_MS = 10 * 60_000;
/** The box accepts the one short press only inside this window after `arm`. */
export const BOX_CLAIM_PRESS_WINDOW_MS = 20_000;
/** The phone waits a random pause in this range before "Press the power button now". */
export const BOX_CLAIM_INSTRUCTION_PAUSE_MIN_MS = 2_000;
export const BOX_CLAIM_INSTRUCTION_PAUSE_MAX_MS = 6_000;
/** The phone accepts the press only this long after its instruction appeared. */
export const BOX_CLAIM_PRESS_AFTER_INSTRUCTION_MS = 5_000;
/** How much later than the phone's `arm` send the box may have received it (radio latency). */
export const BOX_CLAIM_ARM_LATENCY_MS = 1_000;
/** A passed press check grants one claim for this long. */
export const BOX_CLAIM_GRANT_MS = 2 * 60_000;
/** Wrong-code confirmations before the box closes its radio until the next power-on. */
export const BOX_CLAIM_MAX_CODE_FAILURES = 5;

/** Power key gestures (§7.5). A press is short when released within this time. */
export const POWER_KEY_SHORT_PRESS_MS = 1_500;
/** Presses closer than this belong to one burst; a burst ends this long after its last release. */
export const POWER_KEY_BURST_GAP_MS = 1_500;
export const POWER_KEY_BURST_END_MS = 2_000;
/** Presses in the first seconds after the service starts are bounce from power-on. */
export const POWER_KEY_BOOT_IGNORE_MS = 10_000;
export const POWER_KEY_BURST_CLAIM = 1;
export const POWER_KEY_BURST_SHOW_CODE = 3;
export const POWER_KEY_BURST_RESET = 5;

/** A setup code expires this long after it is first shown (§15.1). */
export const BOX_SETUP_CODE_TTL_MS = 24 * 3600_000;
export const BOX_SETUP_CODE_CHARS = 20;

export const BOX_CLAIM_MAX_RECORD = 64 * 1024;
export const BOX_CLAIM_DIR_PHONE = 1;
export const BOX_CLAIM_DIR_BOX = 2;

export type BoxClaimErrorCode =
  | "claim-malformed"
  | "mode-mismatch"
  | "no-code"
  | "bad-public-key"
  | "confirm-failed"
  | "wrong-code"
  | "decrypt-failed"
  | "replay"
  | "record-too-large"
  | "bad-receipt"
  | "transcript-mismatch"
  | "randomness";

export class BoxClaimError extends Error {
  constructor(readonly code: BoxClaimErrorCode) {
    super(code);
    this.name = "BoxClaimError";
  }
}

const fail = (code: BoxClaimErrorCode): never => {
  throw new BoxClaimError(code);
};

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);
const HEX = /^(?:[0-9a-f]{2})*$/;

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

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: unknown, len: number): Bytes {
  if (typeof s !== "string" || s.length !== len * 2 || !HEX.test(s)) return fail("claim-malformed");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function exactKeys(o: unknown, keys: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return fail("claim-malformed");
  if (Object.keys(o).sort().join(",") !== keys) fail("claim-malformed");
  return o as Record<string, unknown>;
}

function random(n: number, fixed: Bytes | undefined): Bytes {
  if (fixed) {
    if (fixed.length !== n) fail("randomness");
    return Uint8Array.from(fixed);
  }
  return crypto.getRandomValues(new Uint8Array(n));
}

const u32be = (n: number): Bytes => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
function u64be(n: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

const isMode = (m: unknown): m is BoxClaimMode => (BOX_CLAIM_MODES as readonly unknown[]).includes(m);
const isState = (s: unknown): s is BoxClaimAdvertState => (BOX_CLAIM_STATES as readonly unknown[]).includes(s);

// ── setup code ───────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 100 random bits as 20 Crockford base32 characters. `randomness` (13 bytes) is for vectors. */
export function generateSetupCode(randomness?: Bytes): string {
  const r = random(13, randomness);
  let acc = 0n;
  for (const b of r) acc = (acc << 8n) | BigInt(b);
  acc >>= 4n;
  let out = "";
  for (let i = BOX_SETUP_CODE_CHARS - 1; i >= 0; i--) out += CROCKFORD[Number((acc >> BigInt(i * 5)) & 31n)];
  r.fill(0);
  return out;
}

/** Typed or scanned input to the canonical 20 characters, or null. Crockford's I/L→1 and O→0. */
export function normalizeSetupCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== BOX_SETUP_CODE_CHARS) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

export function formatSetupCode(code: string): string {
  return code.match(/.{1,4}/g)!.join("-");
}

function canonicalCode(code: string): string {
  const n = normalizeSetupCode(code);
  if (n === null) return fail("claim-malformed");
  return n;
}

/** The only form of a code the box keeps for the handshake. */
export function setupCodeKey(code: string): Bytes {
  return sha256(utf8(`${TAG_BOX_SETUP_CODE_KEY}|${canonicalCode(code)}`));
}

/** The `.com` mailbox name for a remote claim. A different hash, so `.com` cannot derive the key. */
export function setupCodeMailboxId(code: string): string {
  return toHex(sha256(utf8(`${TAG_BOX_CLAIM_MAILBOX}|${canonicalCode(code)}`)));
}

export const BOX_CLAIM_MAILBOX_ID = /^[0-9a-f]{64}$/;

/** What the monitor's QR code holds. The fragment never reaches a server. */
export function setupCodeLink(code: string, apex = "flagshipserver.com"): string {
  return `https://${apex}/claim#c=${canonicalCode(code)}&v=1`;
}

export function parseSetupCodeLink(link: string): string | null {
  const m = /^https:\/\/[a-z0-9.-]+\/claim#(.*)$/.exec(link.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  if (params.get("v") !== "1") return null;
  const c = params.get("c");
  return c ? normalizeSetupCode(c) : null;
}

// ── handshake wire ───────────────────────────────────────────────────────

export interface BoxClaimHello {
  v: 1;
  t: "hello";
  mode: BoxClaimMode;
  ephemeralPub: string;
  nonce: string;
}

export interface BoxClaimAccept {
  v: 1;
  t: "accept";
  mode: BoxClaimMode;
  state: BoxClaimAdvertState;
  enc: string;
  ephemeralPub: string;
  nonce: string;
}

export interface BoxClaimFinish {
  v: 1;
  t: "finish";
  enc: string;
  confirm: string;
}

export interface BoxClaimReady {
  v: 1;
  t: "ready";
  confirm: string;
}

export interface BoxClaimRandomness {
  ephemeralSeed?: Bytes;
  nonce?: Bytes;
  encapsulation?: Bytes;
}

function helloBytes(h: BoxClaimHello): Bytes {
  return utf8([TAG_BOX_CLAIM, "hello", h.mode, h.ephemeralPub, h.nonce].join("|"));
}

function acceptBytes(a: BoxClaimAccept): Bytes {
  return utf8([TAG_BOX_CLAIM, "accept", a.mode, a.state, a.enc, a.ephemeralPub, a.nonce].join("|"));
}

function finishEncBytes(enc: string): Bytes {
  return utf8([TAG_BOX_CLAIM, "finish", enc].join("|"));
}

function parseHello(w: unknown): BoxClaimHello {
  const o = exactKeys(w, "ephemeralPub,mode,nonce,t,v");
  if (o.v !== 1 || o.t !== "hello" || !isMode(o.mode)) fail("claim-malformed");
  fromHex(o.ephemeralPub, HYBRID_SEAL_PUBLIC_KEY_LEN);
  fromHex(o.nonce, 32);
  return o as unknown as BoxClaimHello;
}

function parseAccept(w: unknown): BoxClaimAccept {
  const o = exactKeys(w, "enc,ephemeralPub,mode,nonce,state,t,v");
  if (o.v !== 1 || o.t !== "accept" || !isMode(o.mode) || !isState(o.state)) fail("claim-malformed");
  fromHex(o.enc, HYBRID_SEAL_ENC_LEN);
  fromHex(o.ephemeralPub, HYBRID_SEAL_PUBLIC_KEY_LEN);
  fromHex(o.nonce, 32);
  return o as unknown as BoxClaimAccept;
}

function parseFinish(w: unknown): BoxClaimFinish {
  const o = exactKeys(w, "confirm,enc,t,v");
  if (o.v !== 1 || o.t !== "finish") fail("claim-malformed");
  fromHex(o.enc, HYBRID_SEAL_ENC_LEN);
  fromHex(o.confirm, 32);
  return o as unknown as BoxClaimFinish;
}

function parseReady(w: unknown): BoxClaimReady {
  const o = exactKeys(w, "confirm,t,v");
  if (o.v !== 1 || o.t !== "ready") fail("claim-malformed");
  fromHex(o.confirm, 32);
  return o as unknown as BoxClaimReady;
}

interface Schedule {
  phoneKey: Bytes;
  boxKey: Bytes;
  confirmKey: Bytes;
  sessionId: Bytes;
  transcript: Bytes;
}

function schedule(mode: BoxClaimMode, codeKey: Bytes | null, ss1: Bytes, ss2: Bytes, th: Bytes): Schedule {
  const salt = sha512(concat(utf8(`${TAG_BOX_CLAIM}|${mode}|`), codeKey ?? new Uint8Array(0)));
  const prk = hkdfExtract(sha512, concat(ss1, ss2), salt);
  const ex = (label: string, n: number) => hkdfExpand(sha512, prk, concat(utf8(`${TAG_BOX_CLAIM_KEYS}|${label}|`), th), n);
  const out = {
    phoneKey: ex("phone-to-box", 32),
    boxKey: ex("box-to-phone", 32),
    confirmKey: ex("confirm", 32),
    sessionId: ex("session-id", 16),
    transcript: th,
  };
  prk.fill(0);
  return out;
}

const confirmTag = (k: Bytes, who: "phone" | "box", th: Bytes): Bytes => hmac(sha256, k, concat(utf8(`${TAG_BOX_CLAIM_CONFIRM}|${who}|`), th));

// ── phone ────────────────────────────────────────────────────────────────

export interface BoxClaimPhoneStart {
  readonly hello: BoxClaimHello;
  readonly mode: BoxClaimMode;
  readonly codeKey: Bytes | null;
  ephemeralSeed: Bytes | null;
}

/** Mode `code` needs the code the phone scanned; mode `open` takes none. */
export function startBoxClaim(args: { mode: BoxClaimMode; code?: string; randomness?: BoxClaimRandomness }): BoxClaimPhoneStart {
  if (!isMode(args.mode)) fail("claim-malformed");
  if ((args.mode === "code") !== (args.code !== undefined)) fail("claim-malformed");
  const codeKey = args.code !== undefined ? setupCodeKey(args.code) : null;
  const seed = random(32, args.randomness?.ephemeralSeed);
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  const hello: BoxClaimHello = {
    v: 1,
    t: "hello",
    mode: args.mode,
    ephemeralPub: toHex(publicKey),
    nonce: toHex(random(32, args.randomness?.nonce)),
  };
  return { hello, mode: args.mode, codeKey, ephemeralSeed: seed };
}

export interface BoxClaimPhonePending {
  readonly schedule: Schedule;
  readonly state: BoxClaimAdvertState;
  used: boolean;
}

/** Answers the box's accept. Refuses a box that answers in another mode than the phone asked. */
export function finishBoxClaim(
  st: BoxClaimPhoneStart,
  acceptWire: unknown,
  randomness?: BoxClaimRandomness,
): { finish: BoxClaimFinish; pending: BoxClaimPhonePending } {
  const seed = st.ephemeralSeed;
  if (!seed) return fail("claim-malformed");
  st.ephemeralSeed = null;
  try {
    const a = parseAccept(acceptWire);
    if (a.mode !== st.mode) fail("mode-mismatch");
    let ss1: Bytes;
    try {
      ss1 = ml_kem768_x25519.decapsulate(fromHex(a.enc, HYBRID_SEAL_ENC_LEN), seed);
    } catch {
      return fail("bad-public-key");
    }
    const boxPub = fromHex(a.ephemeralPub, HYBRID_SEAL_PUBLIC_KEY_LEN);
    try {
      parseHybridSealPublicKey(boxPub);
    } catch {
      fail("bad-public-key");
    }
    const eseed = random(64, randomness?.encapsulation);
    let enc: Bytes;
    let ss2: Bytes;
    try {
      const r = ml_kem768_x25519.encapsulate(boxPub, eseed);
      enc = r.cipherText;
      ss2 = r.sharedSecret;
    } catch {
      return fail("bad-public-key");
    } finally {
      eseed.fill(0);
    }
    const encHex = toHex(enc);
    const th = sha512(concat(helloBytes(st.hello), acceptBytes(a), finishEncBytes(encHex)));
    const s = schedule(st.mode, st.codeKey, ss1, ss2, th);
    ss1.fill(0);
    ss2.fill(0);
    return {
      finish: { v: 1, t: "finish", enc: encHex, confirm: toHex(confirmTag(s.confirmKey, "phone", th)) },
      pending: { schedule: s, state: a.state, used: false },
    };
  } finally {
    seed.fill(0);
  }
}

/** Checks the box's confirmation and opens the channel. In mode `code`, a box without the code fails here. */
export function confirmBoxClaim(p: BoxClaimPhonePending, readyWire: unknown): BoxClaimChannel {
  if (p.used) fail("claim-malformed");
  p.used = true;
  const r = parseReady(readyWire);
  const s = p.schedule;
  if (!equalBytes(fromHex(r.confirm, 32), confirmTag(s.confirmKey, "box", s.transcript))) fail("confirm-failed");
  return new BoxClaimChannel("phone", s, p.state);
}

// ── box ──────────────────────────────────────────────────────────────────

export interface BoxClaimBoxPending {
  readonly hello: BoxClaimHello;
  readonly accept: BoxClaimAccept;
  readonly mode: BoxClaimMode;
  readonly codeKey: Bytes | null;
  readonly ss1: Bytes;
  ephemeralSeed: Bytes | null;
}

/**
 * Answers a hello. `codeKey` is the hash of the box's live setup code, or null when it has none
 * (then mode `code` is refused with `no-code`). Mode `open` is always answered: it still needs the
 * timed press before the box takes a recipe.
 */
export function acceptBoxClaim(args: {
  hello: unknown;
  state: BoxClaimAdvertState;
  codeKey: Bytes | null;
  randomness?: BoxClaimRandomness;
}): { accept: BoxClaimAccept; pending: BoxClaimBoxPending } {
  const h = parseHello(args.hello);
  if (!isState(args.state)) fail("claim-malformed");
  if (h.mode === "code" && !args.codeKey) fail("no-code");
  const phonePub = fromHex(h.ephemeralPub, HYBRID_SEAL_PUBLIC_KEY_LEN);
  try {
    parseHybridSealPublicKey(phonePub);
  } catch {
    fail("bad-public-key");
  }
  const eseed = random(64, args.randomness?.encapsulation);
  let enc: Bytes;
  let ss1: Bytes;
  try {
    const r = ml_kem768_x25519.encapsulate(phonePub, eseed);
    enc = r.cipherText;
    ss1 = r.sharedSecret;
  } catch {
    return fail("bad-public-key");
  } finally {
    eseed.fill(0);
  }
  const seed = random(32, args.randomness?.ephemeralSeed);
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  const accept: BoxClaimAccept = {
    v: 1,
    t: "accept",
    mode: h.mode,
    state: args.state,
    enc: toHex(enc),
    ephemeralPub: toHex(publicKey),
    nonce: toHex(random(32, args.randomness?.nonce)),
  };
  return {
    accept,
    pending: {
      hello: h,
      accept,
      mode: h.mode,
      codeKey: h.mode === "code" ? Uint8Array.from(args.codeKey!) : null,
      ss1,
      ephemeralSeed: seed,
    },
  };
}

/**
 * Checks the phone's finish. A wrong MAC is `wrong-code` in mode `code` (the box counts these,
 * `BOX_CLAIM_MAX_CODE_FAILURES`) and `confirm-failed` in mode `open`.
 */
export function completeBoxClaim(p: BoxClaimBoxPending, finishWire: unknown): { ready: BoxClaimReady; channel: BoxClaimChannel } {
  const seed = p.ephemeralSeed;
  if (!seed) return fail("claim-malformed");
  p.ephemeralSeed = null;
  try {
    const f = parseFinish(finishWire);
    let ss2: Bytes;
    try {
      ss2 = ml_kem768_x25519.decapsulate(fromHex(f.enc, HYBRID_SEAL_ENC_LEN), seed);
    } catch {
      return fail("bad-public-key");
    }
    const th = sha512(concat(helloBytes(p.hello), acceptBytes(p.accept), finishEncBytes(f.enc)));
    const s = schedule(p.mode, p.codeKey, p.ss1, ss2, th);
    ss2.fill(0);
    p.ss1.fill(0);
    if (!equalBytes(fromHex(f.confirm, 32), confirmTag(s.confirmKey, "phone", th))) {
      fail(p.mode === "code" ? "wrong-code" : "confirm-failed");
    }
    return {
      ready: { v: 1, t: "ready", confirm: toHex(confirmTag(s.confirmKey, "box", th)) },
      channel: new BoxClaimChannel("box", s, p.accept.state),
    };
  } finally {
    seed.fill(0);
  }
}

// ── records ──────────────────────────────────────────────────────────────

function recordAad(sessionId: Bytes, dir: number, seq: number): Bytes {
  return concat(utf8(`${TAG_BOX_CLAIM_RECORD}|`), sessionId, Uint8Array.of(dir), u64be(seq));
}

const recordNonce = (dir: number, seq: number): Bytes => concat(u32be(dir), u64be(seq));

export function boxClaimSealRecord(key: Bytes, sessionId: Bytes, dir: number, seq: number, plaintext: Bytes): Bytes {
  if (plaintext.length > BOX_CLAIM_MAX_RECORD) fail("record-too-large");
  return concat(u64be(seq), gcm(key, recordNonce(dir, seq), recordAad(sessionId, dir, seq)).encrypt(plaintext));
}

export function boxClaimOpenRecord(key: Bytes, sessionId: Bytes, dir: number, record: Bytes): { seq: number; plaintext: Bytes } {
  if (record.length < 8 + 16) fail("decrypt-failed");
  if (record.length > 8 + 16 + BOX_CLAIM_MAX_RECORD) fail("record-too-large");
  const seq = Number(new DataView(record.buffer, record.byteOffset, 8).getBigUint64(0));
  if (!Number.isSafeInteger(seq)) fail("decrypt-failed");
  try {
    return { seq, plaintext: gcm(key, recordNonce(dir, seq), recordAad(sessionId, dir, seq)).decrypt(record.subarray(8)) };
  } catch {
    return fail("decrypt-failed");
  }
}

/** One side of an open claim session. Records arrive in order (BLE, the mailbox), so any gap is refused. */
export class BoxClaimChannel {
  private sendSeq = 0;
  private recvSeq = 0;
  readonly sessionIdHex: string;
  readonly transcriptHex: string;

  constructor(
    readonly role: "phone" | "box",
    private readonly keys: Schedule,
    readonly advertState: BoxClaimAdvertState,
  ) {
    this.sessionIdHex = toHex(keys.sessionId);
    this.transcriptHex = toHex(keys.transcript);
  }

  seal(plaintext: Bytes): Bytes {
    const mine = this.role === "phone";
    const out = boxClaimSealRecord(mine ? this.keys.phoneKey : this.keys.boxKey, this.keys.sessionId, mine ? BOX_CLAIM_DIR_PHONE : BOX_CLAIM_DIR_BOX, this.sendSeq, plaintext);
    this.sendSeq++;
    return out;
  }

  open(record: Bytes): Bytes {
    const mine = this.role === "phone";
    const { seq, plaintext } = boxClaimOpenRecord(mine ? this.keys.boxKey : this.keys.phoneKey, this.keys.sessionId, mine ? BOX_CLAIM_DIR_BOX : BOX_CLAIM_DIR_PHONE, record);
    if (seq !== this.recvSeq) fail("replay");
    this.recvSeq++;
    return plaintext;
  }

  sealJson(msg: BoxClaimPhoneMessage | BoxClaimBoxMessage): Bytes {
    return this.seal(utf8(JSON.stringify(msg)));
  }

  openJson(record: Bytes): unknown {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.open(record)));
    } catch (e) {
      if (e instanceof BoxClaimError) throw e;
      return fail("claim-malformed");
    }
  }
}

// ── messages inside the channel ──────────────────────────────────────────

/**
 * The Wi-Fi details the phone sends after the box's key is registered at `.com` (§4 step 8-9).
 * Same fields as `WiFiConfig` on `feat/retail`; it travels as JSON inside a sealed record, so the
 * old `|`-joined plaintext (which broke on a `|` in a password) is not used.
 */
export interface WiFiConfig {
  ssid: string;
  psk: string;
  /** ISO 3166-1 alpha-2, or "" when unknown. */
  regulatoryRegion: string;
  issuedAt: number;
}

export function validWiFiConfig(w: unknown): w is WiFiConfig {
  if (typeof w !== "object" || w === null) return false;
  const o = w as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "issuedAt,psk,regulatoryRegion,ssid") return false;
  if (typeof o.ssid !== "string" || typeof o.psk !== "string" || typeof o.regulatoryRegion !== "string") return false;
  const ssidLen = utf8(o.ssid).length;
  if (ssidLen < 1 || ssidLen > 32) return false;
  if (!(o.psk === "" || (o.psk.length >= 8 && o.psk.length <= 63) || /^[0-9a-fA-F]{64}$/.test(o.psk))) return false;
  if (!/^(?:[A-Z]{2})?$/.test(o.regulatoryRegion)) return false;
  return typeof o.issuedAt === "number" && Number.isSafeInteger(o.issuedAt) && o.issuedAt >= 0;
}

export type WifiSecurity = "open" | "wpa2" | "wpa3" | "wpa2-wpa3" | "enterprise" | "wep";

export interface WifiNetwork {
  ssid: string;
  security: WifiSecurity;
  /** 0-100. */
  signal: number;
  band: "2.4" | "5" | "6";
}

/** Why the box could not get online (§15 "Network"). The phone shows a sentence per code. */
export const NETWORK_FAILURES = [
  "no-link",
  "network-not-found",
  "wrong-password",
  "unsupported-security",
  "no-dhcp",
  "no-dns",
  "captive-portal",
  "relay-unreachable",
] as const;
export type NetworkFailure = (typeof NETWORK_FAILURES)[number];

export type PressRefusal = "no-press" | "burst" | "long-press" | "late" | "contention" | "not-armed" | "busy";

export type BoxClaimPhoneMessage =
  | { t: "arm" }
  | { t: "wifi-scan" }
  | { t: "claim"; recipe: string }
  | { t: "network"; wifi: WiFiConfig | null }
  | { t: "abort" };

export type BoxClaimBoxMessage =
  | { t: "armed" }
  | { t: "press"; atMs: number; count: number; long: boolean }
  | { t: "press-result"; ok: true }
  | { t: "press-result"; ok: false; reason: PressRefusal }
  | { t: "wifi-list"; networks: WifiNetwork[] }
  | { t: "receipt"; receipt: BoxClaimReceiptWire }
  | { t: "network-status"; stage: "connecting" | "online"; via: "ethernet" | "wifi" }
  | { t: "network-status"; stage: "failed"; via: "ethernet" | "wifi"; failure: NetworkFailure }
  | { t: "refused"; reason: BoxClaimRefusal };

export type BoxClaimRefusal =
  | "no-grant"
  | "recipe-invalid"
  | "recipe-expired"
  | "already-claimed"
  | "window-closed"
  | "entropy"
  | "out-of-order";

const PHONE_KINDS = new Set(["arm", "wifi-scan", "claim", "network", "abort"]);

/** Parses what the box received from the phone; anything else is `claim-malformed`. */
export function parsePhoneMessage(m: unknown): BoxClaimPhoneMessage {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return fail("claim-malformed");
  const o = m as Record<string, unknown>;
  if (typeof o.t !== "string" || !PHONE_KINDS.has(o.t)) return fail("claim-malformed");
  switch (o.t) {
    case "claim":
      exactKeys(o, "recipe,t");
      if (typeof o.recipe !== "string" || o.recipe.length > BOX_CLAIM_MAX_RECORD - 64) fail("claim-malformed");
      return { t: "claim", recipe: o.recipe as string };
    case "network":
      exactKeys(o, "t,wifi");
      if (o.wifi !== null && !validWiFiConfig(o.wifi)) fail("claim-malformed");
      return { t: "network", wifi: o.wifi as WiFiConfig | null };
    default:
      exactKeys(o, "t");
      return { t: o.t } as BoxClaimPhoneMessage;
  }
}

// ── the phone's press check (§7.4) ───────────────────────────────────────

/** The hidden pause before the instruction, from one random byte pair (uniform enough for 4 s). */
export function instructionPauseMs(randomness?: Bytes): number {
  const r = random(2, randomness);
  const span = BOX_CLAIM_INSTRUCTION_PAUSE_MAX_MS - BOX_CLAIM_INSTRUCTION_PAUSE_MIN_MS;
  return BOX_CLAIM_INSTRUCTION_PAUSE_MIN_MS + Math.floor((((r[0]! << 8) | r[1]!) / 65536) * (span + 1));
}

export type PressVerdict = "ok" | "early" | "late" | "burst";

/**
 * Times are the phone's own clock. `atMs` is the box's offset of the press from the moment it took
 * `arm`, which is at least `armSentAt` and at most `armSentAt + BOX_CLAIM_ARM_LATENCY_MS`. A press
 * the box reports before the phone showed the instruction means the box made it up: "early".
 */
export function judgePressReport(r: {
  armSentAt: number;
  instructionAt: number;
  atMs: number;
  count: number;
  long: boolean;
  receivedAt: number;
}): PressVerdict {
  if (r.count !== POWER_KEY_BURST_CLAIM || r.long) return "burst";
  const latest = r.armSentAt + BOX_CLAIM_ARM_LATENCY_MS + r.atMs;
  if (r.receivedAt < r.instructionAt || latest < r.instructionAt) return "early";
  const earliest = r.armSentAt + r.atMs;
  if (earliest - r.instructionAt > BOX_CLAIM_PRESS_AFTER_INSTRUCTION_MS) return "late";
  if (r.receivedAt - r.instructionAt > BOX_CLAIM_PRESS_AFTER_INSTRUCTION_MS + POWER_KEY_BURST_END_MS + BOX_CLAIM_ARM_LATENCY_MS + 2_000) return "late";
  return "ok";
}

// ── the claim receipt (§7.6) ─────────────────────────────────────────────

const RECEIPT_TEXT = /^[A-Za-z0-9._+ -]{1,64}$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SERIAL = /^[A-Za-z0-9_-]{8,64}$/;

export interface BoxClaimReceiptFields {
  mode: BoxClaimMode;
  serverDomain: string;
  serial: string;
  /** The box's new STK as a hybrid key: Ed25519 (32) ‖ ML-DSA-65 (1952). */
  stkHybridPub: string;
  /** SHA-256 of the boot key binding's canonical bytes, or "" when the box has none yet. */
  bootKeyBindingSha256: string;
  model: string;
  imageVersion: string;
  /** The claim transcript, from the box's channel. */
  transcript: string;
  issuedAt: number;
}

export interface BoxClaimReceiptWire extends BoxClaimReceiptFields {
  v: 1;
  signature: string;
}

export function canonicalBoxClaimReceipt(r: BoxClaimReceiptFields): Bytes {
  return utf8(
    [TAG_BOX_CLAIM_RECEIPT, r.mode, r.serverDomain, r.serial, r.stkHybridPub, r.bootKeyBindingSha256, r.model, r.imageVersion, r.transcript, r.issuedAt].join("|"),
  );
}

function checkReceiptFields(r: Record<string, unknown>): BoxClaimReceiptFields {
  if (!isMode(r.mode)) fail("bad-receipt");
  if (typeof r.serverDomain !== "string" || !DOMAIN.test(r.serverDomain)) fail("bad-receipt");
  if (typeof r.serial !== "string" || !SERIAL.test(r.serial)) fail("bad-receipt");
  if (typeof r.stkHybridPub !== "string" || r.stkHybridPub.length !== HYBRID_SIG_PUBLIC_KEY_LEN * 2 || !HEX.test(r.stkHybridPub)) fail("bad-receipt");
  if (typeof r.bootKeyBindingSha256 !== "string" || !/^(?:[0-9a-f]{64})?$/.test(r.bootKeyBindingSha256)) fail("bad-receipt");
  if (typeof r.model !== "string" || !RECEIPT_TEXT.test(r.model)) fail("bad-receipt");
  if (typeof r.imageVersion !== "string" || !RECEIPT_TEXT.test(r.imageVersion)) fail("bad-receipt");
  if (typeof r.transcript !== "string" || !/^[0-9a-f]{128}$/.test(r.transcript)) fail("bad-receipt");
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) fail("bad-receipt");
  return r as unknown as BoxClaimReceiptFields;
}

/** `sign` is the STK's hybrid signer (keyd on a box). */
export async function signBoxClaimReceipt(
  fields: BoxClaimReceiptFields,
  sign: (purpose: string, payload: Bytes) => Bytes | Promise<Bytes>,
): Promise<BoxClaimReceiptWire> {
  checkReceiptFields(fields as unknown as Record<string, unknown>);
  const sig = await sign(TAG_BOX_CLAIM_RECEIPT, canonicalBoxClaimReceipt(fields));
  if (sig.length !== HYBRID_SIG_LEN) fail("bad-receipt");
  return { v: 1, ...fields, signature: toHex(sig) };
}

/**
 * Checks a receipt on the phone: shape, the hybrid signature under the key it names, and that it
 * was made in THIS session (`transcript`) for the recipe the phone sent. A relay that passes the
 * real box's receipt on fails `transcript-mismatch`; one that signs its own passes here and is the
 * case the `.com` pre-registration and the internet check exist for.
 */
export function verifyBoxClaimReceipt(
  wire: unknown,
  expect: { transcriptHex: string; mode: BoxClaimMode; serverDomain: string; serial: string },
): { stkPubHex: string; stkHybridPubHex: string; receipt: BoxClaimReceiptWire } {
  const o = exactKeysOr(wire, "bootKeyBindingSha256,imageVersion,issuedAt,mode,model,serial,serverDomain,signature,stkHybridPub,transcript,v", "bad-receipt");
  if (o.v !== 1) fail("bad-receipt");
  const f = checkReceiptFields(o);
  if (typeof o.signature !== "string" || o.signature.length !== HYBRID_SIG_LEN * 2 || !HEX.test(o.signature)) fail("bad-receipt");
  if (f.transcript !== expect.transcriptHex) fail("transcript-mismatch");
  if (f.mode !== expect.mode || f.serverDomain !== expect.serverDomain || f.serial !== expect.serial) fail("bad-receipt");
  try {
    hybridVerify(fromHex(f.stkHybridPub, HYBRID_SIG_PUBLIC_KEY_LEN), TAG_BOX_CLAIM_RECEIPT, canonicalBoxClaimReceipt(f), fromHex(o.signature, HYBRID_SIG_LEN));
  } catch {
    fail("bad-receipt");
  }
  return { stkPubHex: f.stkHybridPub.slice(0, 64), stkHybridPubHex: f.stkHybridPub, receipt: o as unknown as BoxClaimReceiptWire };
}

function exactKeysOr(o: unknown, keys: string, code: BoxClaimErrorCode): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return fail(code);
  if (Object.keys(o).sort().join(",") !== keys) fail(code);
  return o as Record<string, unknown>;
}

// ── the phone's key pre-registration at `.com` (§4 step 8) ───────────────

/**
 * Signed by the admin root (or an admin-granted device; IRK on a demo account) before the phone
 * sends the Wi-Fi password: from then on `.com` registers this AuthCode's server only under
 * `stkPubHex`. A relay's real box, holding another key, is refused at registration.
 */
export interface BoxClaimKey {
  username: string;
  serial: string;
  serverDomain: string;
  stkPubHex: string;
  issuedAt: number;
}

export function canonicalBoxClaimKey(k: BoxClaimKey): Bytes {
  return utf8([TAG_BOX_CLAIM_KEY, k.username, k.serial, k.serverDomain, k.stkPubHex.toLowerCase(), k.issuedAt].join("|"));
}

export function signBoxClaimKey(k: BoxClaimKey, signer: Keypair): Bytes {
  return ed.sign(canonicalBoxClaimKey(k), signer.privateKey);
}

export function verifyBoxClaimKey(k: BoxClaimKey, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBoxClaimKey(k), pub);
  } catch {
    return false;
  }
}

// ── frames for small-MTU transports (BLE) ────────────────────────────────

export const BOX_CLAIM_FRAME_HANDSHAKE = 0x01;
export const BOX_CLAIM_FRAME_RECORD = 0x02;
export const BOX_CLAIM_MAX_MESSAGE = BOX_CLAIM_MAX_RECORD + 1024;

export function encodeClaimMessage(kind: number, payload: Bytes): Bytes {
  return concat(Uint8Array.of(kind), payload);
}

export function decodeClaimMessage(msg: Bytes): { kind: number; payload: Bytes } {
  if (msg.length < 1) fail("claim-malformed");
  const kind = msg[0]!;
  if (kind !== BOX_CLAIM_FRAME_HANDSHAKE && kind !== BOX_CLAIM_FRAME_RECORD) fail("claim-malformed");
  return { kind, payload: msg.subarray(1) };
}

/** Splits a message into frames of at most `mtu` bytes: one flag byte (0x80 first, 0x40 last), then data. */
export function fragmentClaimMessage(msg: Bytes, mtu: number): Bytes[] {
  if (!Number.isInteger(mtu) || mtu < 20) fail("claim-malformed");
  if (msg.length > BOX_CLAIM_MAX_MESSAGE) fail("record-too-large");
  const room = mtu - 1;
  const out: Bytes[] = [];
  for (let o = 0; o === 0 || o < msg.length; o += room) {
    const end = Math.min(o + room, msg.length);
    const flags = (o === 0 ? 0x80 : 0) | (end === msg.length ? 0x40 : 0);
    out.push(concat(Uint8Array.of(flags), msg.subarray(o, end)));
  }
  return out;
}

export class ClaimFrameReassembler {
  private parts: Bytes[] = [];
  private size = 0;
  private open = false;

  /** Returns a whole message when `frame` completes one. Out-of-order frames throw. */
  push(frame: Bytes): Bytes | null {
    if (frame.length < 1) fail("claim-malformed");
    const flags = frame[0]!;
    if (flags & 0x3f) fail("claim-malformed");
    const first = (flags & 0x80) !== 0;
    if (first === this.open) {
      this.parts = [];
      this.size = 0;
      this.open = false;
      fail("claim-malformed");
    }
    this.open = true;
    this.size += frame.length - 1;
    if (this.size > BOX_CLAIM_MAX_MESSAGE) {
      this.parts = [];
      this.size = 0;
      this.open = false;
      fail("record-too-large");
    }
    this.parts.push(frame.subarray(1));
    if (!(flags & 0x40)) return null;
    const msg = concat(...this.parts);
    this.parts = [];
    this.size = 0;
    this.open = false;
    return msg;
  }
}

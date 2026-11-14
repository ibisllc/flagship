/**
 * voi.ci calls (docs/voici-calls.md §2-§3, §6): the signed call set-up (request, answer, receipt, end), the per-call
 * X-Wing keys, the frame layer that seals every encoded Opus frame again under them, the sealed push and missed-call
 * payloads, the owner's call-allow order and the SDP rules. Shared vectors: packages/protocol/test-vectors/voici-calls/.
 *
 * Canonical bytes (`|`-separated UTF-8; hex lowercase; ms integers):
 *   request  flagship/voici-call-request/v1|<pageId>|<conv>|<callId>|<callerXwingPub>|<H(offerSdp)>|<issuedAt>
 *            P-256 (IEEE P1363) by the browser key B, which the cred's delegation names (as a voici-message)
 *   answer   flagship/voici-call-answer/v1|<callId>|<deviceRef>|<H(request bytes)>|<xwingCiphertext>|<H(answerSdp)>
 *              |<turnUser>|<H(turnSecret)>|<issuedAt>             Ed25519 by the page's ownerSignPub
 *   receipt  flagship/voici-call-receipt/v1|<account>|<callId>|<deviceRef>|<issuedAt>|<expiresAt>   Ed25519 by a CA key
 *   end      flagship/voici-call-end/v1|<callId>|<side>|<reason>|<issuedAt>   B (caller) or ownerSignPub (owner)
 *   allow    flagship/voici-call-allow/v1|<pageId>|<conv>|<allow|disallow>|<issuedAt>   Ed25519 by ownerSignPub
 *
 * H = SHA-256 hex. turnSecret is the UTF-8 of its hex. deviceRef = SHA-256 hex of the raw device public key.
 *
 * Frame layer (flagship/voici-call-frame/v1):
 *   ss       X-Wing decapsulation of xwingCiphertext under the caller's per-call key
 *   th       SHA-256(request bytes ‖ answer bytes)
 *   k(dir)   HKDF-SHA256(ikm ss, salt th, info "flagship/voici-call-frame/v1|<c2p|p2c>", 32)
 *   epoch e  floor(ctr / 30000) (10 minutes of 20 ms frames, which flow at a constant rate);
 *            k_{e+1} = HKDF-SHA256(ikm k_e, salt empty, info "flagship/voici-call-frame/v1|next", 32)
 *   sealed   u64be(ctr) ‖ AES-256-GCM(k_e, nonce u32be(dir code: c2p 1, p2c 2) ‖ u64be(ctr),
 *            aad UTF-8 "<callId>|<dir>|<ctr>", u8(len) ‖ frame ‖ zeros to 64 bytes): always 88 bytes
 *   A frame longer than 63 bytes is refused; a receiver drops replays (a 128-frame window), frames more than
 *   3000 ahead of the newest, frames of an epoch older than the newest minus one, and anything that fails to open.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { p256 } from "@noble/curves/nist.js";
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { checkMessagesKeyAttestation } from "./messagesAttestation.js";
import { HYBRID_SEAL_ENC_LEN, HYBRID_SEAL_PUBLIC_KEY_LEN, HYBRID_SEAL_RANDOMNESS_LEN, hybridOpen, hybridSealKeygen, hybridSealWithRandomness, parseHybridSealPublicKey } from "./pqHybrid.js";
import type { Bytes } from "./types.js";
import { checkWebDelegation, type WebDelegation } from "./webDelegation.js";
import { canonicalJson, canonicalJsonBytes, ed25519VerifyHex, hexToBytes, isLowerHex, p256VerifyP1363, sha256Hex } from "./webEnvelope.js";
import { canonicalVoiciThreadStatement, parseVoiciThreadStatement, voiciConv, type VoiciMessageCred } from "./voiciMessages.js";

export const TAG_VOICI_CALL_REQUEST = "flagship/voici-call-request/v1";
export const TAG_VOICI_CALL_ANSWER = "flagship/voici-call-answer/v1";
export const TAG_VOICI_CALL_RECEIPT = "flagship/voici-call-receipt/v1";
export const TAG_VOICI_CALL_END = "flagship/voici-call-end/v1";
export const TAG_VOICI_CALL_ALLOW = "flagship/voici-call-allow/v1";
export const TAG_VOICI_CALL_FRAME = "flagship/voici-call-frame/v1";
export const TAG_VOICI_CALL_PUSH = "flagship/voici-call-push/v1";
export const TAG_VOICI_MISSED_CALL = "flagship/voici-missed-call/v1";

/** `.com` and the phone refuse set-up records further than this from their clock. */
export const VOICI_CALL_SKEW_MS = 10 * 60_000;
export const VOICI_CALL_RING_MS = 45_000;
/** D3: a call ends after 60 minutes; the caller can call again. */
export const VOICI_CALL_MAX_MS = 60 * 60_000;
export const VOICI_CALL_RECEIPT_TTL_MS = VOICI_CALL_MAX_MS + 5 * 60_000;
export const VOICI_CALL_MAX_SDP_BYTES = 16 * 1024;
export const VOICI_CALL_MAX_REQUEST_BYTES = 40 * 1024;
export const VOICI_CALL_FRAME_PLAINTEXT = 64;
export const VOICI_CALL_FRAME_MAX = VOICI_CALL_FRAME_PLAINTEXT - 1;
export const VOICI_CALL_SEALED_FRAME = 8 + VOICI_CALL_FRAME_PLAINTEXT + 16;
export const VOICI_CALL_FRAMES_PER_EPOCH = 30_000;
export const VOICI_CALL_REPLAY_WINDOW = 128;
export const VOICI_CALL_MAX_GAP_FRAMES = 3000;
/** Counters stay below 2^32 (a 60-minute call sends 180,000 frames). */
export const VOICI_CALL_MAX_CTR = 2 ** 32;
export const VOICI_CALL_SIDES = ["caller", "owner"] as const;
export type VoiciCallSide = (typeof VOICI_CALL_SIDES)[number];
export const VOICI_CALL_END_REASONS = ["hangup", "cancel", "decline", "busy", "no-answer", "limit", "failed"] as const;
export type VoiciCallEndReason = (typeof VOICI_CALL_END_REASONS)[number];
export type VoiciCallDir = "c2p" | "p2c";
export const VOICI_CALLS_FROM = ["accepted", "signed-in"] as const;
export type VoiciCallsFrom = (typeof VOICI_CALLS_FROM)[number];

const te = new TextEncoder();
const utf8 = (s: string): Bytes => te.encode(s);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function exactKeys(r: Record<string, unknown>, keys: string[]): boolean {
  const ks = Object.keys(r);
  return ks.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));
}
const concat = (...parts: Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32be = (n: number): Bytes => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u64be = (n: number): Bytes => concat(u32be(Math.floor(n / 2 ** 32)), u32be(n >>> 0));
const readU64 = (b: Bytes): number => (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) * 2 ** 32 + (((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) >>> 0);
const join = (parts: (string | number)[]): Bytes => utf8(parts.map(String).join("|"));

export function voiciCallSdpHash(sdp: string): string {
  return sha256Hex(utf8(sdp));
}

/** H(raw device public key), so a room tells answers apart without naming devices. */
export function voiciCallDeviceRef(devicePubHex: string): string {
  return sha256Hex(hexToBytes(devicePubHex));
}

// ── SDP ────────────────────────────────────────────────────────────────────

export type VoiciCallSdpRefusal = "too-large" | "not-audio-only" | "no-opus" | "not-cbr" | "dtx" | "audio-level" | "no-fingerprint";

/**
 * The SDP rules both sides check before signing or accepting (§0.3): exactly one m=audio section and no other media,
 * Opus with cbr=1 and usedtx=0 in its fmtp, no audio-level header extension, a sha-256 DTLS fingerprint.
 */
export function checkVoiciCallSdp(sdp: unknown): VoiciCallSdpRefusal | null {
  if (typeof sdp !== "string" || utf8(sdp).length > VOICI_CALL_MAX_SDP_BYTES) return "too-large";
  const lines = sdp.split(/\r?\n/);
  const media = lines.filter((l) => l.startsWith("m="));
  if (media.length !== 1 || !media[0]!.startsWith("m=audio ")) return "not-audio-only";
  const rtpmap = lines.find((l) => /^a=rtpmap:\d+ opus\/48000(\/2)?$/i.test(l));
  if (!rtpmap) return "no-opus";
  const pt = rtpmap.slice("a=rtpmap:".length).split(" ")[0]!;
  const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${pt} `));
  const params = new Map((fmtp?.slice(`a=fmtp:${pt} `.length) ?? "").split(";").map((p) => p.trim().split("=") as [string, string]));
  if (params.get("cbr") !== "1") return "not-cbr";
  if (params.get("usedtx") !== "0") return "dtx";
  if (lines.some((l) => l.startsWith("a=extmap:") && l.includes("ssrc-audio-level"))) return "audio-level";
  if (!lines.some((l) => /^a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(l))) return "no-fingerprint";
  return null;
}

const FMTP = (pt: string) => `a=fmtp:${pt} minptime=20;useinbandfec=1;cbr=1;usedtx=0;stereo=0;sprop-stereo=0;maxaveragebitrate=24000`;

/**
 * Rewrites a WebRTC audio SDP to the call profile: only Opus (other codecs, RED, CN and telephone-event dropped
 * from the m-line and their attributes), its fmtp set to the fixed profile, ptime 20, and every header extension
 * removed except the MID one BUNDLE needs. Applied by each side to its own description before it signs it; idempotent.
 */
export function mungeVoiciCallSdp(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/).filter((l) => l !== "");
  const rtpmap = lines.find((l) => /^a=rtpmap:\d+ opus\/48000(\/2)?$/i.test(l));
  if (!rtpmap) return sdp;
  const pt = rtpmap.slice("a=rtpmap:".length).split(" ")[0]!;
  const out: string[] = [];
  let inAudio = false;
  for (const l of lines) {
    if (l.startsWith("m=")) {
      inAudio = l.startsWith("m=audio ");
      if (inAudio) {
        const f = l.split(" ");
        out.push([...f.slice(0, 3), pt].join(" "));
        continue;
      }
    }
    if (inAudio) {
      if ((l.startsWith("a=extmap:") && !l.endsWith(" urn:ietf:params:rtp-hdrext:sdes:mid")) || l === "a=extmap-allow-mixed") continue;
      const m = /^a=(rtpmap|fmtp|rtcp-fb):(\d+)[ ]/.exec(l);
      if (m && m[2] !== pt) continue;
      if (l.startsWith(`a=fmtp:${pt} `)) {
        out.push(FMTP(pt));
        continue;
      }
      if (l.startsWith("a=ptime:")) continue;
      out.push(l);
      if (l === rtpmap) {
        if (!lines.some((x) => x.startsWith(`a=fmtp:${pt} `))) out.push(FMTP(pt));
        out.push("a=ptime:20");
      }
      continue;
    }
    out.push(l);
  }
  return out.join(eol) + eol;
}

/** The DTLS fingerprint the signed SDP names ("sha-256 AB:..."), which each side compares with the live one. */
export function voiciCallSdpFingerprint(sdp: string): string | null {
  const l = sdp.split(/\r?\n/).find((x) => /^a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x));
  return l ? l.slice("a=fingerprint:".length) : null;
}

// ── request ────────────────────────────────────────────────────────────────

export interface VoiciCallRequestBody {
  pageId: string;
  conv: string;
  callId: string;
  from: string;
  callerXwingPub: string;
  offerSdp: string;
  issuedAt: number;
  cred: VoiciMessageCred;
}
export interface VoiciCallRequest extends VoiciCallRequestBody {
  v: 1;
  kind: "voici-call-request";
  sig: string;
}
const REQUEST_KEYS = ["v", "kind", "pageId", "conv", "callId", "from", "callerXwingPub", "offerSdp", "issuedAt", "cred", "sig"];

export function canonicalVoiciCallRequest(r: Pick<VoiciCallRequestBody, "pageId" | "conv" | "callId" | "callerXwingPub" | "offerSdp" | "issuedAt">): Bytes {
  if (!PAGE_ID.test(r.pageId) || !isLowerHex(r.conv, 32) || !isLowerHex(r.callId, 16) || !isLowerHex(r.callerXwingPub, HYBRID_SEAL_PUBLIC_KEY_LEN) || !isTime(r.issuedAt) || typeof r.offerSdp !== "string") {
    throw new Error(`${TAG_VOICI_CALL_REQUEST}: bad field`);
  }
  return join([TAG_VOICI_CALL_REQUEST, r.pageId, r.conv, r.callId, r.callerXwingPub, voiciCallSdpHash(r.offerSdp), r.issuedAt]);
}

/** Deterministic (RFC 6979, low-S) P-256 signature: for vectors and tests; browsers sign with WebCrypto. */
export function signVoiciCallRequestP256(body: VoiciCallRequestBody, browserPriv: Bytes): VoiciCallRequest {
  return { v: 1, kind: "voici-call-request", ...body, sig: hex(p256.sign(canonicalVoiciCallRequest(body), browserPriv, { lowS: true })) };
}

export function parseVoiciCallRequest(v: unknown): VoiciCallRequest | null {
  if (!isObj(v) || !exactKeys(v, REQUEST_KEYS) || v.v !== 1 || v.kind !== "voici-call-request" || !isLowerHex(v.sig, 64) || !isObj(v.cred) || !isLowerHex(v.from, 32)) return null;
  try {
    canonicalVoiciCallRequest(v as unknown as VoiciCallRequest);
  } catch {
    return null;
  }
  return v as unknown as VoiciCallRequest;
}

export type VoiciCallRequestRefusal =
  | "too-large"
  | "malformed"
  | "wrong-audience"
  | "calls-off"
  | "blocked"
  | "revoked"
  | "rate-limited"
  | "not-allowed"
  | "bad-attestation"
  | "bad-delegation"
  | "bad-thread"
  | "wrong-conv"
  | "bad-sdp"
  | "bad-key"
  | "bad-signature"
  | "stale";

export interface VoiciCallRequestCheckContext {
  pageId: string;
  acceptsCalls: boolean;
  origin: string;
  caKeys: readonly string[];
  now: number;
  blocked?: ReadonlySet<string>;
  revoked?: ReadonlySet<string>;
  /** After the cheap filters, before any signature: rate limits. */
  rateLimit?: (r: VoiciCallRequest) => "rate-limited" | null;
  /** After the signatures: the owner's "Who can call" rule. */
  allowed?: (r: VoiciCallRequest) => boolean;
  /** Skip the clock check (an owner device reading a missed call later). */
  skipFresh?: boolean;
}

type Fail<C> = { ok: false; code: C };

/**
 * Checks a call request cheapest first (§6): size, shape, page, calls on, blocked / banned, revoked, rate limits,
 * attestation, delegation (scope voici-messages, origin, page, principal = from), thread statement, conv, the SDP
 * profile, the caller's X-Wing key, B's signature, freshness, then the owner's caller rule.
 */
export function checkVoiciCallRequest(input: unknown, ctx: VoiciCallRequestCheckContext): { ok: true; request: VoiciCallRequest; delegation: WebDelegation } | Fail<VoiciCallRequestRefusal> {
  const no = (code: VoiciCallRequestRefusal): Fail<VoiciCallRequestRefusal> => ({ ok: false, code });
  let raw: unknown = input;
  if (typeof input === "string") {
    if (utf8(input).length > VOICI_CALL_MAX_REQUEST_BYTES) return no("too-large");
    try {
      raw = JSON.parse(input);
    } catch {
      return no("malformed");
    }
  } else {
    try {
      if (utf8(JSON.stringify(input)).length > VOICI_CALL_MAX_REQUEST_BYTES) return no("too-large");
    } catch {
      return no("malformed");
    }
  }
  const r = parseVoiciCallRequest(raw);
  if (!r) return no("malformed");
  const c = r.cred as unknown as Record<string, unknown>;
  if (!exactKeys(c, ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"])) return no("malformed");
  if (r.pageId !== ctx.pageId) return no("wrong-audience");
  if (!ctx.acceptsCalls) return no("calls-off");
  if (ctx.blocked?.has(r.from)) return no("blocked");
  const delegatePub = isObj(c.delegation) ? c.delegation.delegatePub : undefined;
  if (typeof delegatePub === "string" && ctx.revoked?.has(delegatePub)) return no("revoked");
  const limited = ctx.rateLimit?.(r);
  if (limited) return no(limited);
  const att = checkMessagesKeyAttestation(c.attestation, { caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: r.from });
  if (!att.ok) return no("bad-attestation");
  const del = checkWebDelegation(c.delegation, c.delegationSig, { scope: "voici-messages", origin: ctx.origin, audience: ctx.pageId, principalPub: r.from, now: ctx.now, notAfter: att.attestation.expiresAt });
  if (!del.ok) return no("bad-delegation");
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== r.from || typeof c.threadSig !== "string" || !ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), r.from)) return no("bad-thread");
  if (r.conv !== voiciConv(ctx.pageId, r.from)) return no("wrong-conv");
  if (checkVoiciCallSdp(r.offerSdp)) return no("bad-sdp");
  try {
    parseHybridSealPublicKey(hexToBytes(r.callerXwingPub));
  } catch {
    return no("bad-key");
  }
  if (!p256VerifyP1363(r.sig, canonicalVoiciCallRequest(r), del.delegation.delegatePub)) return no("bad-signature");
  if (!ctx.skipFresh && Math.abs(r.issuedAt - ctx.now) > VOICI_CALL_SKEW_MS) return no("stale");
  if (ctx.allowed && !ctx.allowed(r)) return no("not-allowed");
  return { ok: true, request: r, delegation: del.delegation };
}

// ── per-call keys ──────────────────────────────────────────────────────────

/** The caller's per-call X-Wing key pair from 32 fresh random bytes. */
export function voiciCallKeygen(seed: Bytes): { seed: Bytes; publicKey: Bytes } {
  const k = hybridSealKeygen(seed);
  return { seed: k.secretKey, publicKey: k.publicKey };
}

/** The answering phone's encapsulation to the caller's key (eseed: 64 random bytes). */
export function voiciCallEncapsulate(callerXwingPub: Bytes, eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN))): { ciphertext: Bytes; sharedSecret: Bytes } {
  const pk = parseHybridSealPublicKey(callerXwingPub);
  if (eseed.length !== HYBRID_SEAL_RANDOMNESS_LEN) throw new Error("voici-call: randomness");
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(pk, eseed);
  return { ciphertext: cipherText, sharedSecret };
}

export function voiciCallDecapsulate(ciphertext: Bytes, callerSeed: Bytes): Bytes {
  if (ciphertext.length !== HYBRID_SEAL_ENC_LEN) throw new Error("voici-call: ciphertext");
  return ml_kem768_x25519.decapsulate(ciphertext, callerSeed);
}

/** k_c2p and k_p2c (epoch 0) from the shared secret and the two signed records' canonical bytes. */
export function deriveVoiciCallFrameKeys(sharedSecret: Bytes, requestBytes: Bytes, answerBytes: Bytes): { c2p: Bytes; p2c: Bytes } {
  const th = sha256(concat(requestBytes, answerBytes));
  return {
    c2p: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|c2p`), 32),
    p2c: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|p2c`), 32),
  };
}

export function nextVoiciCallFrameKey(k: Bytes): Bytes {
  return hkdf(sha256, k, new Uint8Array(0), utf8(`${TAG_VOICI_CALL_FRAME}|next`), 32);
}

// ── frames ─────────────────────────────────────────────────────────────────

const DIR_CODE: Record<VoiciCallDir, number> = { c2p: 1, p2c: 2 };

function frameNonce(dir: VoiciCallDir, ctr: number): Bytes {
  return concat(u32be(DIR_CODE[dir]), u64be(ctr));
}
const frameAad = (callId: string, dir: VoiciCallDir, ctr: number) => utf8(`${callId}|${dir}|${ctr}`);

/** Seals one encoded frame under the epoch key `key` (the caller picks the key for floor(ctr / 30000)). */
export function sealVoiciCallFrameWithKey(key: Bytes, callId: string, dir: VoiciCallDir, ctr: number, frame: Bytes): Bytes {
  if (frame.length > VOICI_CALL_FRAME_MAX) throw new Error("voici-call: frame too long");
  if (!Number.isSafeInteger(ctr) || ctr < 0 || ctr >= VOICI_CALL_MAX_CTR) throw new Error("voici-call: counter");
  const pt = new Uint8Array(VOICI_CALL_FRAME_PLAINTEXT);
  pt[0] = frame.length;
  pt.set(frame, 1);
  return concat(u64be(ctr), gcm(key, frameNonce(dir, ctr), frameAad(callId, dir, ctr)).encrypt(pt));
}

/** Opens one sealed frame under `key`; null on any failure (length, tag, padding). */
export function openVoiciCallFrameWithKey(key: Bytes, callId: string, dir: VoiciCallDir, sealed: Bytes): { ctr: number; frame: Bytes } | null {
  if (sealed.length !== VOICI_CALL_SEALED_FRAME) return null;
  const ctr = readU64(sealed.subarray(0, 8));
  if (ctr >= VOICI_CALL_MAX_CTR) return null;
  let pt: Bytes;
  try {
    pt = gcm(key, frameNonce(dir, ctr), frameAad(callId, dir, ctr)).decrypt(sealed.subarray(8));
  } catch {
    return null;
  }
  const len = pt[0]!;
  if (len > VOICI_CALL_FRAME_MAX) return null;
  for (let i = 1 + len; i < pt.length; i++) if (pt[i] !== 0) return null;
  return { ctr, frame: pt.slice(1, 1 + len) };
}

export const voiciCallEpoch = (ctr: number) => Math.floor(ctr / VOICI_CALL_FRAMES_PER_EPOCH);

/** The sending half of one direction: a counter from 0 and the epoch keys, older ones wiped. */
export class VoiciCallFrameSender {
  private ctr = 0;
  private epoch = 0;
  private key: Bytes;
  constructor(
    baseKey: Bytes,
    private readonly callId: string,
    private readonly dir: VoiciCallDir,
  ) {
    this.key = Uint8Array.from(baseKey);
  }
  seal(frame: Bytes): Bytes {
    const e = voiciCallEpoch(this.ctr);
    while (this.epoch < e) {
      const next = nextVoiciCallFrameKey(this.key);
      this.key.fill(0);
      this.key = next;
      this.epoch++;
    }
    return sealVoiciCallFrameWithKey(this.key, this.callId, this.dir, this.ctr++, frame);
  }
}

/** The receiving half: replay window, gap limit, the newest two epochs' keys only. */
export class VoiciCallFrameReceiver {
  private highest = -1;
  private seen = new Set<number>();
  private keys = new Map<number, Bytes>();
  private top = 0;
  constructor(
    baseKey: Bytes,
    private readonly callId: string,
    private readonly dir: VoiciCallDir,
  ) {
    this.keys.set(0, Uint8Array.from(baseKey));
  }
  open(sealed: Bytes): Bytes | null {
    if (sealed.length !== VOICI_CALL_SEALED_FRAME) return null;
    const ctr = readU64(sealed.subarray(0, 8));
    if (ctr >= VOICI_CALL_MAX_CTR || ctr > this.highest + VOICI_CALL_MAX_GAP_FRAMES) return null;
    if (ctr <= this.highest - VOICI_CALL_REPLAY_WINDOW || this.seen.has(ctr)) return null;
    const e = voiciCallEpoch(ctr);
    if (e < this.top - 1) return null;
    const pending: Bytes[] = [];
    let k = this.keys.get(e);
    if (e > this.top) {
      let cur = this.keys.get(this.top)!;
      for (let i = this.top; i < e; i++) pending.push((cur = nextVoiciCallFrameKey(cur)));
      k = cur;
    }
    const opened = k ? openVoiciCallFrameWithKey(k, this.callId, this.dir, sealed) : null;
    if (!opened) {
      for (const p of pending) p.fill(0);
      return null;
    }
    for (const p of pending) this.keys.set(++this.top, p);
    for (const [ep, kk] of this.keys) {
      if (ep < this.top - 1) {
        kk.fill(0);
        this.keys.delete(ep);
      }
    }
    if (ctr > this.highest) this.highest = ctr;
    this.seen.add(ctr);
    for (const s of this.seen) if (s <= this.highest - VOICI_CALL_REPLAY_WINDOW) this.seen.delete(s);
    return opened.frame;
  }
}

// ── answer ─────────────────────────────────────────────────────────────────

export interface VoiciCallAnswerBody {
  callId: string;
  deviceRef: string;
  requestHash: string;
  xwingCiphertext: string;
  answerSdp: string;
  turnUser: string;
  turnSecret: string;
  issuedAt: number;
}
export interface VoiciCallAnswer extends VoiciCallAnswerBody {
  v: 1;
  kind: "voici-call-answer";
  sig: string;
}
const ANSWER_KEYS = ["v", "kind", "callId", "deviceRef", "requestHash", "xwingCiphertext", "answerSdp", "turnUser", "turnSecret", "issuedAt", "sig"];

export function canonicalVoiciCallAnswer(a: VoiciCallAnswerBody): Bytes {
  if (
    !isLowerHex(a.callId, 16) ||
    !isLowerHex(a.deviceRef, 32) ||
    !isLowerHex(a.requestHash, 32) ||
    !isLowerHex(a.xwingCiphertext, HYBRID_SEAL_ENC_LEN) ||
    typeof a.answerSdp !== "string" ||
    !isLowerHex(a.turnUser, 16) ||
    !isLowerHex(a.turnSecret, 32) ||
    !isTime(a.issuedAt)
  ) {
    throw new Error(`${TAG_VOICI_CALL_ANSWER}: bad field`);
  }
  return join([TAG_VOICI_CALL_ANSWER, a.callId, a.deviceRef, a.requestHash, a.xwingCiphertext, voiciCallSdpHash(a.answerSdp), a.turnUser, sha256Hex(utf8(a.turnSecret)), a.issuedAt]);
}

export function voiciCallRequestHash(r: VoiciCallRequestBody): string {
  return sha256Hex(canonicalVoiciCallRequest(r));
}

export function signVoiciCallAnswer(a: VoiciCallAnswerBody, ownerSignSeed: Bytes): VoiciCallAnswer {
  return { v: 1, kind: "voici-call-answer", ...a, sig: hex(ed.sign(canonicalVoiciCallAnswer(a), ownerSignSeed)) };
}

export type VoiciCallAnswerRefusal = "malformed" | "wrong-call" | "wrong-request" | "bad-sdp" | "bad-signature" | "stale";

export function checkVoiciCallAnswer(
  v: unknown,
  ctx: { request: VoiciCallRequestBody; ownerSignPub: string; now?: number },
): { ok: true; answer: VoiciCallAnswer } | Fail<VoiciCallAnswerRefusal> {
  const no = (code: VoiciCallAnswerRefusal): Fail<VoiciCallAnswerRefusal> => ({ ok: false, code });
  if (!isObj(v) || !exactKeys(v, ANSWER_KEYS) || v.v !== 1 || v.kind !== "voici-call-answer" || !isLowerHex(v.sig, 64)) return no("malformed");
  const a = v as unknown as VoiciCallAnswer;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallAnswer(a);
  } catch {
    return no("malformed");
  }
  if (a.callId !== ctx.request.callId) return no("wrong-call");
  if (a.requestHash !== voiciCallRequestHash(ctx.request)) return no("wrong-request");
  if (checkVoiciCallSdp(a.answerSdp)) return no("bad-sdp");
  if (!ed25519VerifyHex(a.sig, bytes, ctx.ownerSignPub)) return no("bad-signature");
  if (ctx.now !== undefined && Math.abs(a.issuedAt - ctx.now) > VOICI_CALL_SKEW_MS) return no("stale");
  return { ok: true, answer: a };
}

// ── receipt ────────────────────────────────────────────────────────────────

export interface VoiciCallReceiptBody {
  account: string;
  callId: string;
  deviceRef: string;
  issuedAt: number;
  expiresAt: number;
}
export interface VoiciCallReceipt extends VoiciCallReceiptBody {
  v: 1;
  kind: "voici-call-receipt";
  signedBy: string;
  signature: string;
}
const RECEIPT_KEYS = ["v", "kind", "account", "callId", "deviceRef", "issuedAt", "expiresAt", "signedBy", "signature"];

export function canonicalVoiciCallReceipt(r: VoiciCallReceiptBody): Bytes {
  if (!USERNAME.test(r.account) || !isLowerHex(r.callId, 16) || !isLowerHex(r.deviceRef, 32) || !isTime(r.issuedAt) || !isTime(r.expiresAt) || r.expiresAt <= r.issuedAt) {
    throw new Error(`${TAG_VOICI_CALL_RECEIPT}: bad field`);
  }
  return join([TAG_VOICI_CALL_RECEIPT, r.account, r.callId, r.deviceRef, r.issuedAt, r.expiresAt]);
}

export function signVoiciCallReceipt(r: VoiciCallReceiptBody, caSeed: Bytes): VoiciCallReceipt {
  return { v: 1, kind: "voici-call-receipt", ...r, signedBy: hex(ed.getPublicKey(caSeed)), signature: hex(ed.sign(canonicalVoiciCallReceipt(r), caSeed)) };
}

export type VoiciCallReceiptRefusal = "malformed" | "unknown-ca" | "bad-signature" | "too-long" | "wrong-account" | "wrong-device" | "not-yet-valid" | "expired";

export function checkVoiciCallReceipt(
  v: unknown,
  ctx: { caKeys: readonly string[]; now: number; account: string; deviceRef?: string },
): { ok: true; receipt: VoiciCallReceipt } | Fail<VoiciCallReceiptRefusal> {
  const no = (code: VoiciCallReceiptRefusal): Fail<VoiciCallReceiptRefusal> => ({ ok: false, code });
  if (!isObj(v) || !exactKeys(v, RECEIPT_KEYS) || v.v !== 1 || v.kind !== "voici-call-receipt" || !isLowerHex(v.signedBy, 32) || !isLowerHex(v.signature, 64)) return no("malformed");
  const r = v as unknown as VoiciCallReceipt;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallReceipt(r);
  } catch {
    return no("malformed");
  }
  if (!ctx.caKeys.includes(r.signedBy)) return no("unknown-ca");
  if (!ed25519VerifyHex(r.signature, bytes, r.signedBy)) return no("bad-signature");
  if (r.expiresAt - r.issuedAt > VOICI_CALL_RECEIPT_TTL_MS) return no("too-long");
  if (r.account !== ctx.account) return no("wrong-account");
  if (ctx.deviceRef !== undefined && r.deviceRef !== ctx.deviceRef) return no("wrong-device");
  if (ctx.now < r.issuedAt - VOICI_CALL_SKEW_MS) return no("not-yet-valid");
  if (ctx.now >= r.expiresAt) return no("expired");
  return { ok: true, receipt: r };
}

// ── end ────────────────────────────────────────────────────────────────────

export interface VoiciCallEndBody {
  callId: string;
  side: VoiciCallSide;
  reason: VoiciCallEndReason;
  issuedAt: number;
}
export interface VoiciCallEnd extends VoiciCallEndBody {
  v: 1;
  kind: "voici-call-end";
  sig: string;
}
const END_KEYS = ["v", "kind", "callId", "side", "reason", "issuedAt", "sig"];

export function canonicalVoiciCallEnd(e: VoiciCallEndBody): Bytes {
  if (!isLowerHex(e.callId, 16) || !VOICI_CALL_SIDES.includes(e.side) || !VOICI_CALL_END_REASONS.includes(e.reason) || !isTime(e.issuedAt)) throw new Error(`${TAG_VOICI_CALL_END}: bad field`);
  return join([TAG_VOICI_CALL_END, e.callId, e.side, e.reason, e.issuedAt]);
}

export function signVoiciCallEndOwner(e: Omit<VoiciCallEndBody, "side">, ownerSignSeed: Bytes): VoiciCallEnd {
  const body = { ...e, side: "owner" as const };
  return { v: 1, kind: "voici-call-end", ...body, sig: hex(ed.sign(canonicalVoiciCallEnd(body), ownerSignSeed)) };
}

export function signVoiciCallEndCallerP256(e: Omit<VoiciCallEndBody, "side">, browserPriv: Bytes): VoiciCallEnd {
  const body = { ...e, side: "caller" as const };
  return { v: 1, kind: "voici-call-end", ...body, sig: hex(p256.sign(canonicalVoiciCallEnd(body), browserPriv, { lowS: true })) };
}

/** An end order for `callId`: the caller's under B (P-256), the owner's under ownerSignPub (Ed25519). */
export function checkVoiciCallEnd(v: unknown, ctx: { callId: string; callerPub: string; ownerSignPub: string }): VoiciCallEnd | null {
  if (!isObj(v) || !exactKeys(v, END_KEYS) || v.v !== 1 || v.kind !== "voici-call-end" || typeof v.sig !== "string") return null;
  const e = v as unknown as VoiciCallEnd;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallEnd(e);
  } catch {
    return null;
  }
  if (e.callId !== ctx.callId) return null;
  const ok = e.side === "caller" ? p256VerifyP1363(e.sig, bytes, ctx.callerPub) : ed25519VerifyHex(e.sig, bytes, ctx.ownerSignPub);
  return ok ? e : null;
}

// ── call-allow order ───────────────────────────────────────────────────────

export interface VoiciCallAllow {
  pageId: string;
  conv: string;
  op: "allow" | "disallow";
  issuedAt: number;
}

export function canonicalVoiciCallAllow(a: VoiciCallAllow): Bytes {
  if (!PAGE_ID.test(a.pageId) || !isLowerHex(a.conv, 32) || (a.op !== "allow" && a.op !== "disallow") || !isTime(a.issuedAt)) throw new Error(`${TAG_VOICI_CALL_ALLOW}: bad field`);
  return join([TAG_VOICI_CALL_ALLOW, a.pageId, a.conv, a.op, a.issuedAt]);
}

export function signVoiciCallAllow(a: VoiciCallAllow, ownerSignSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciCallAllow(a), ownerSignSeed));
}

export function parseVoiciCallAllow(v: unknown): VoiciCallAllow | null {
  if (!isObj(v) || !exactKeys(v, ["pageId", "conv", "op", "issuedAt"])) return null;
  try {
    canonicalVoiciCallAllow(v as unknown as VoiciCallAllow);
  } catch {
    return null;
  }
  return v as unknown as VoiciCallAllow;
}

export function verifyVoiciCallAllow(a: VoiciCallAllow, signature: string, ownerSignPub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciCallAllow(a), ownerSignPub);
  } catch {
    return false;
  }
}

// ── sealed push and missed call ────────────────────────────────────────────

export interface VoiciCallPush {
  v: 1;
  callId: string;
  pageId: string;
  conv: string;
  from: string;
}

function sealOpts(purpose: string, from: string, issuedAt: number) {
  return { purpose, senderKeyId: sha256(hexToBytes(from)), issuedAt };
}

/** The caller's identity in a VoIP / FCM push, sealed to the page's inbox key (Apple and Google see none of it). */
export function sealVoiciCallPush(inboxPub: Bytes, p: Omit<VoiciCallPush, "v">, issuedAt: number, eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN))): Bytes {
  const body: VoiciCallPush = { v: 1, ...p };
  return hybridSealWithRandomness(inboxPub, sealOpts(TAG_VOICI_CALL_PUSH, p.from, issuedAt), [utf8(p.callId)], canonicalJsonBytes(body), eseed);
}

export function openVoiciCallPush(inboxSeed: Bytes, callId: string, sealed: Bytes): VoiciCallPush | null {
  try {
    const { plaintext } = hybridOpen(inboxSeed, TAG_VOICI_CALL_PUSH, [utf8(callId)], sealed);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const v = JSON.parse(text) as unknown;
    if (canonicalJson(v) !== text || !isObj(v) || !exactKeys(v, ["v", "callId", "pageId", "conv", "from"]) || v.v !== 1) return null;
    const p = v as unknown as VoiciCallPush;
    if (p.callId !== callId || !PAGE_ID.test(p.pageId) || !isLowerHex(p.conv, 32) || !isLowerHex(p.from, 32) || voiciConv(p.pageId, p.from) !== p.conv) return null;
    return p;
  } catch {
    return null;
  }
}

export const VOICI_MISSED_CALL_REASONS = ["no-answer", "busy", "cancel", "decline"] as const;
export type VoiciMissedCallReason = (typeof VOICI_MISSED_CALL_REASONS)[number];

export interface VoiciMissedCall {
  v: 1;
  request: VoiciCallRequest;
  ringingAt: number;
  endedAt: number;
  reason: VoiciMissedCallReason;
}

/** A missed call for the mailbox, sealed to the inbox key; it carries the signed request (cred, abuse tag) whole. */
export function sealVoiciMissedCall(inboxPub: Bytes, m: Omit<VoiciMissedCall, "v">, eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN))): Bytes {
  const body: VoiciMissedCall = { v: 1, ...m };
  return hybridSealWithRandomness(inboxPub, sealOpts(TAG_VOICI_MISSED_CALL, m.request.from, m.endedAt), [utf8(m.request.callId)], canonicalJsonBytes(body), eseed);
}

/**
 * Opens a missed call and checks its request's signatures (no clock check: it is read later). `ctx` is the
 * request check's, without `acceptsCalls` and `now` beyond the cred's validity at `ringingAt`.
 */
export function openVoiciMissedCall(
  inboxSeed: Bytes,
  callId: string,
  sealed: Bytes,
  ctx: { pageId: string; origin: string; caKeys: readonly string[] },
): VoiciMissedCall | null {
  try {
    const { plaintext } = hybridOpen(inboxSeed, TAG_VOICI_MISSED_CALL, [utf8(callId)], sealed);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const v = JSON.parse(text) as unknown;
    if (canonicalJson(v) !== text || !isObj(v) || !exactKeys(v, ["v", "request", "ringingAt", "endedAt", "reason"]) || v.v !== 1) return null;
    const m = v as unknown as VoiciMissedCall;
    if (!isTime(m.ringingAt) || !isTime(m.endedAt) || m.endedAt < m.ringingAt || !VOICI_MISSED_CALL_REASONS.includes(m.reason)) return null;
    const r = checkVoiciCallRequest(m.request, { pageId: ctx.pageId, acceptsCalls: true, origin: ctx.origin, caKeys: ctx.caKeys, now: m.ringingAt, skipFresh: true });
    if (!r.ok || r.request.callId !== callId) return null;
    return m;
  } catch {
    return null;
  }
}

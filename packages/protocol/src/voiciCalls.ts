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
 * Answering while locked (docs/voici-calls.md, owner decisions 2026-11-15): a device may hold a call-only P-256 key
 * (Keychain after-first-unlock / Secure Enclave; Android Keystore without user auth / StrongBox), bound once under the
 * owner messages key. It signs only three things, each under its own tag; every other verifier refuses it (it is a
 * P-256 key no other record accepts as its signer):
 *   binding  flagship/voici-call-key/v1|<username>|<deviceId>|<callKeyPub>|<createdAt>   Ed25519 by ownerSignPub
 *   revoke   flagship/voici-call-key-revoke/v1|<username>|<deviceId>|<callKeyPub>|<revokedAt>
 *            Ed25519 by ownerSignPub, or P-256 by the call key itself
 *   join     flagship/voici-call-join/v1|<username>|<callId>|<deviceId>|<callKeyPub>|<issuedAt>   P-256 by the call key:
 *            the ringing device's room WebSocket while the account key is locked
 *   answer   the answer above, P-256 (IEEE P1363) by the call key, carrying `callKey: {binding, signature}`;
 *            deviceRef = H(callKeyPub)
 *   end      an owner end order may be signed by the winning answer's call key
 * callKeyPub is SEC1 uncompressed P-256, hex (130). `.com` stores the binding and its revocation; the caller's browser
 * checks the binding under the page's ownerSignPub.
 *
 * Calling from the app with the browser's WebRTC (docs/voici-calls.md "Calling from the app"): when the app's media
 * engine is missing, the app signs a short-lived voi.ci session for the callee's page (its own pseudonym there, a
 * delegation to a P-256 key it makes for this one call) and hands it to `https://voi.ci/<callee>#call=<sid>.<k>`
 * over `/qr-pipe`: k is a fresh X25519 secret (base64url) the app made for the browser, the app says `hello` with its
 * own ephemeral key and delivers the handoff AES-256-GCM sealed under the pipe key (HKDF(X25519, "flagship/qr/v1",
 * "flagship/qr/enc/v1"), the sign-in and remote-ticket construction). The relay consumes the session on delivery, so
 * the ticket is one-use. Not a signature: the sign-in answer inside carries the signatures.
 *   handoff  {kind:"flagship/voici-call-handoff/v1", username, pageId, media, issuedAt, expiresAt (≤ 5 min after
 *            issuedAt), delegatePriv (P-256 scalar, hex 64), signIn (a flagship/voici-sign-in/v1 answer whose
 *            delegation names delegatePriv's public key and lasts at most 10 minutes)}
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
 *
 * Video (docs/voici-calls-v2.md §1): request and answer may carry `media` ("audio" | "audio,video", what that side is
 * able to send); when present it is appended to the canonical bytes as `|<media>`, so it cannot be added or changed,
 * and a record without it reads as audio (stripping it only downgrades a call to audio). The answer's media must be
 * within the request's. A video SDP has exactly m=audio then m=video, the video section VP8 only.
 *   kv(dir)  HKDF-SHA256(ikm ss, salt th, info "flagship/voici-call-frame/v1|<c2p|p2c>|video", 32), own counters,
 *            epochs as audio
 *   clear    the VP8 payload header the RTP packetizer reads: 10 bytes on a key frame (bit 0 of byte 0 clear), else 3
 *   sealed   clear ‖ u64be(ctr) ‖ AES-256-GCM(kv_e, nonce u32be(dir code) ‖ u64be(ctr),
 *            aad UTF-8 "<callId>|<dir>|video|<ctr>|" ‖ clear, u32be(len) ‖ body ‖ zeros), its total length padded
 *            up to the next size bucket: 1 KiB doubling to 1 MiB (a larger frame is refused)
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
import { x25519 } from "@noble/curves/ed25519.js";
import { canonicalVoiciCallRequestAnon, checkVoiciCallRequestAnon, type VoiciCallRequestAnon, type VoiciCallRequestAnonBody } from "./voiciCallModes.js";
import { canonicalVoiciThreadStatement, checkVoiciSignInAnswer, parseVoiciThreadStatement, TAG_VOICI_SIGN_IN_REQUEST, voiciConv, type VoiciMessageCred, type VoiciSignInAnswer } from "./voiciMessages.js";

export const TAG_VOICI_CALL_REQUEST = "flagship/voici-call-request/v1";
export const TAG_VOICI_CALL_ANSWER = "flagship/voici-call-answer/v1";
export const TAG_VOICI_CALL_RECEIPT = "flagship/voici-call-receipt/v1";
export const TAG_VOICI_CALL_END = "flagship/voici-call-end/v1";
export const TAG_VOICI_CALL_ALLOW = "flagship/voici-call-allow/v1";
export const TAG_VOICI_CALL_FRAME = "flagship/voici-call-frame/v1";
export const TAG_VOICI_CALL_PUSH = "flagship/voici-call-push/v1";
export const TAG_VOICI_MISSED_CALL = "flagship/voici-missed-call/v1";
export const TAG_VOICI_CALL_KEY = "flagship/voici-call-key/v1";
export const TAG_VOICI_CALL_KEY_REVOKE = "flagship/voici-call-key-revoke/v1";
export const TAG_VOICI_CALL_JOIN = "flagship/voici-call-join/v1";
export const TAG_VOICI_CALL_HANDOFF = "flagship/voici-call-handoff/v1";

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
export const VOICI_CALLS_FROM = ["accepted", "signed-in", "anyone", "callback"] as const;
/** What a side is able to send (§1.1 of voici-calls-v2.md); absent = audio. */
export const VOICI_CALL_MEDIA = ["audio", "audio,video"] as const;
export type VoiciCallMedia = (typeof VOICI_CALL_MEDIA)[number];
/** Sealed video frame sizes (§1.6): 1 KiB doubling to 1 MiB. */
export const VOICI_CALL_VIDEO_BUCKETS: readonly number[] = Array.from({ length: 11 }, (_, i) => 1024 * 2 ** i);
/** Room messages that say what a side's camera is doing (UI only, unsigned). */
export const VOICI_CALL_CAMERA_STATES = ["on", "off", "paused"] as const;
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

export type VoiciCallSdpRefusal = "too-large" | "not-audio-only" | "bad-media" | "no-opus" | "not-cbr" | "dtx" | "audio-level" | "not-vp8" | "video-extension" | "no-fingerprint";

const isMedia = (m: unknown): m is VoiciCallMedia => typeof m === "string" && (VOICI_CALL_MEDIA as readonly string[]).includes(m);
const hasVideo = (m: VoiciCallMedia | undefined) => m === "audio,video";
const VIDEO_EXTMAPS = ["urn:ietf:params:rtp-hdrext:sdes:mid", "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"];

/** The lines of each m= section, keyed by its media kind, in order. */
function sections(lines: string[]): { kind: string; lines: string[] }[] {
  const out: { kind: string; lines: string[] }[] = [];
  for (const l of lines) {
    if (l.startsWith("m=")) out.push({ kind: l.slice(2).split(" ")[0]!, lines: [l] });
    else if (out.length) out[out.length - 1]!.lines.push(l);
  }
  return out;
}

/**
 * The SDP rules both sides check before signing or accepting (§0.3): exactly one m=audio section and no other media,
 * Opus with cbr=1 and usedtx=0 in its fmtp, no audio-level header extension, a sha-256 DTLS fingerprint.
 */
export function checkVoiciCallSdp(sdp: unknown, media: VoiciCallMedia = "audio"): VoiciCallSdpRefusal | null {
  if (typeof sdp !== "string" || utf8(sdp).length > VOICI_CALL_MAX_SDP_BYTES) return "too-large";
  const lines = sdp.split(/\r?\n/);
  const secs = sections(lines);
  if (hasVideo(media)) {
    if (secs.length !== 2 || secs[0]!.kind !== "audio" || secs[1]!.kind !== "video") return "bad-media";
    const v = secs[1]!.lines;
    const maps = v.filter((l) => l.startsWith("a=rtpmap:"));
    if (maps.length !== 1 || !/^a=rtpmap:\d+ VP8\/90000$/i.test(maps[0]!)) return "not-vp8";
    if (v.some((l) => l.startsWith("a=extmap:") && !VIDEO_EXTMAPS.some((u) => l.endsWith(" " + u)))) return "video-extension";
  } else if (secs.length !== 1 || secs[0]!.kind !== "audio") return "not-audio-only";
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
  const vp8 = lines.find((l) => /^a=rtpmap:\d+ VP8\/90000$/i.test(l));
  const vpt = vp8?.slice("a=rtpmap:".length).split(" ")[0];
  const rtx = new Set(lines.filter((l) => l.startsWith("a=ssrc-group:FID ")).map((l) => l.split(" ")[2]!));
  const out: string[] = [];
  let inAudio = false;
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith("m=")) {
      inAudio = l.startsWith("m=audio ");
      inVideo = l.startsWith("m=video ") && vpt !== undefined;
      if (inAudio) {
        const f = l.split(" ");
        out.push([...f.slice(0, 3), pt].join(" "));
        continue;
      }
      if (inVideo) {
        const f = l.split(" ");
        out.push([...f.slice(0, 3), vpt].join(" "));
        continue;
      }
    }
    if (inVideo) {
      if (l.startsWith("a=extmap:") && !VIDEO_EXTMAPS.some((u) => l.endsWith(" " + u))) continue;
      if (l === "a=extmap-allow-mixed" || l.startsWith("a=ssrc-group:FID ")) continue;
      const m = /^a=(rtpmap|fmtp|rtcp-fb):(\d+)[ ]/.exec(l);
      if (m && m[2] !== vpt) continue;
      const ss = /^a=ssrc:(\d+) /.exec(l);
      if (ss && rtx.has(ss[1]!)) continue;
      out.push(l);
      continue;
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
  /** What the caller is able to send; absent = audio (voici-calls-v2.md §1.1). */
  media?: VoiciCallMedia;
}
export interface VoiciCallRequest extends VoiciCallRequestBody {
  v: 1;
  kind: "voici-call-request";
  sig: string;
}
const REQUEST_KEYS = ["v", "kind", "pageId", "conv", "callId", "from", "callerXwingPub", "offerSdp", "issuedAt", "cred", "sig"];

export function canonicalVoiciCallRequest(r: Pick<VoiciCallRequestBody, "pageId" | "conv" | "callId" | "callerXwingPub" | "offerSdp" | "issuedAt" | "media">): Bytes {
  if (!PAGE_ID.test(r.pageId) || !isLowerHex(r.conv, 32) || !isLowerHex(r.callId, 16) || !isLowerHex(r.callerXwingPub, HYBRID_SEAL_PUBLIC_KEY_LEN) || !isTime(r.issuedAt) || typeof r.offerSdp !== "string" || (r.media !== undefined && !isMedia(r.media))) {
    throw new Error(`${TAG_VOICI_CALL_REQUEST}: bad field`);
  }
  return join([TAG_VOICI_CALL_REQUEST, r.pageId, r.conv, r.callId, r.callerXwingPub, voiciCallSdpHash(r.offerSdp), r.issuedAt, ...(r.media !== undefined ? [r.media] : [])]);
}

/** The media a request or answer names (absent = audio). */
export const voiciCallMedia = (r: { media?: VoiciCallMedia }): VoiciCallMedia => r.media ?? "audio";

/** Deterministic (RFC 6979, low-S) P-256 signature: for vectors and tests; browsers sign with WebCrypto. */
export function signVoiciCallRequestP256(body: VoiciCallRequestBody, browserPriv: Bytes): VoiciCallRequest {
  return { v: 1, kind: "voici-call-request", ...body, sig: hex(p256.sign(canonicalVoiciCallRequest(body), browserPriv, { lowS: true })) };
}

export function parseVoiciCallRequest(v: unknown): VoiciCallRequest | null {
  if (!isObj(v) || !(exactKeys(v, REQUEST_KEYS) || exactKeys(v, [...REQUEST_KEYS, "media"])) || v.v !== 1 || v.kind !== "voici-call-request" || !isLowerHex(v.sig, 64) || !isObj(v.cred) || !isLowerHex(v.from, 32)) return null;
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
  if (checkVoiciCallSdp(r.offerSdp, voiciCallMedia(r))) return no("bad-sdp");
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

/** The video keys (voici-calls-v2.md §1.5): their own directional keys from the same secret. */
export function deriveVoiciCallVideoFrameKeys(sharedSecret: Bytes, requestBytes: Bytes, answerBytes: Bytes): { c2p: Bytes; p2c: Bytes } {
  const th = sha256(concat(requestBytes, answerBytes));
  return {
    c2p: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|c2p|video`), 32),
    p2c: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|p2c|video`), 32),
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

export type VoiciCallTrack = "audio" | "video";

/** How many leading bytes of a VP8 frame stay clear: the payload header (10 on a key frame, 3 on a delta frame). */
export function voiciCallVideoClearLen(frame: Bytes): number {
  if (frame.length === 0) return 0;
  return (frame[0]! & 1) === 0 ? 10 : 3;
}

/** The bucket a sealed video frame of `n` bytes is padded to, or null when larger than the last. */
export function voiciCallVideoBucket(n: number): number | null {
  return VOICI_CALL_VIDEO_BUCKETS.find((b) => b >= n) ?? null;
}

const videoAad = (callId: string, dir: VoiciCallDir, ctr: number, clear: Bytes) => concat(utf8(`${callId}|${dir}|video|${ctr}|`), clear);
const VIDEO_OVERHEAD = 8 + 4 + 16;

/** Seals one encoded VP8 frame (§1.5): the payload header clear and in the AAD, the rest padded to a size bucket. */
export function sealVoiciCallVideoFrameWithKey(key: Bytes, callId: string, dir: VoiciCallDir, ctr: number, frame: Bytes): Bytes {
  if (!Number.isSafeInteger(ctr) || ctr < 0 || ctr >= VOICI_CALL_MAX_CTR) throw new Error("voici-call: counter");
  const c = voiciCallVideoClearLen(frame);
  if (c === 0 || frame.length < c) throw new Error("voici-call: video frame too short");
  const clear = frame.subarray(0, c);
  const body = frame.subarray(c);
  const total = voiciCallVideoBucket(c + VIDEO_OVERHEAD + body.length);
  if (total === null) throw new Error("voici-call: video frame too long");
  const pt = new Uint8Array(total - c - 8 - 16);
  pt.set(u32be(body.length), 0);
  pt.set(body, 4);
  return concat(clear, u64be(ctr), gcm(key, frameNonce(dir, ctr), videoAad(callId, dir, ctr, clear)).encrypt(pt));
}

function videoCtr(sealed: Bytes): number | null {
  if (!VOICI_CALL_VIDEO_BUCKETS.includes(sealed.length)) return null;
  const c = voiciCallVideoClearLen(sealed);
  if (c === 0 || sealed.length < c + VIDEO_OVERHEAD) return null;
  return readU64(sealed.subarray(c, c + 8));
}

/** Opens one sealed video frame; null on any failure (bucket size, tag, length, padding). Returns the whole frame. */
export function openVoiciCallVideoFrameWithKey(key: Bytes, callId: string, dir: VoiciCallDir, sealed: Bytes): { ctr: number; frame: Bytes } | null {
  const ctr = videoCtr(sealed);
  if (ctr === null || ctr >= VOICI_CALL_MAX_CTR) return null;
  const c = voiciCallVideoClearLen(sealed);
  const clear = sealed.subarray(0, c);
  let pt: Bytes;
  try {
    pt = gcm(key, frameNonce(dir, ctr), videoAad(callId, dir, ctr, clear)).decrypt(sealed.subarray(c + 8));
  } catch {
    return null;
  }
  const len = readU64(concat(new Uint8Array(4), pt.subarray(0, 4)));
  if (len > pt.length - 4) return null;
  for (let i = 4 + len; i < pt.length; i++) if (pt[i] !== 0) return null;
  return { ctr, frame: concat(clear, pt.subarray(4, 4 + len)) };
}

const peekCtr = (sealed: Bytes, track: VoiciCallTrack): number | null =>
  track === "video" ? videoCtr(sealed) : sealed.length === VOICI_CALL_SEALED_FRAME ? readU64(sealed.subarray(0, 8)) : null;

/** The sending half of one direction: a counter from 0 and the epoch keys, older ones wiped. */
export class VoiciCallFrameSender {
  private ctr = 0;
  private epoch = 0;
  private key: Bytes;
  constructor(
    baseKey: Bytes,
    private readonly callId: string,
    private readonly dir: VoiciCallDir,
    private readonly track: VoiciCallTrack = "audio",
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
    const seal = this.track === "video" ? sealVoiciCallVideoFrameWithKey : sealVoiciCallFrameWithKey;
    return seal(this.key, this.callId, this.dir, this.ctr++, frame);
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
    private readonly track: VoiciCallTrack = "audio",
  ) {
    this.keys.set(0, Uint8Array.from(baseKey));
  }
  open(sealed: Bytes): Bytes | null {
    const ctr = peekCtr(sealed, this.track);
    if (ctr === null || ctr >= VOICI_CALL_MAX_CTR || ctr > this.highest + VOICI_CALL_MAX_GAP_FRAMES) return null;
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
    const openWith = this.track === "video" ? openVoiciCallVideoFrameWithKey : openVoiciCallFrameWithKey;
    const opened = k ? openWith(k, this.callId, this.dir, sealed) : null;
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
  /** What the answering device is able to send; absent = audio. Within the request's. */
  media?: VoiciCallMedia;
}
export interface VoiciCallAnswer extends VoiciCallAnswerBody {
  v: 1;
  kind: "voici-call-answer";
  sig: string;
  /** Present when a bound call key signed (`sig` is then P-256 IEEE P1363 by binding.callKeyPub). */
  callKey?: VoiciCallKeyProof;
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
    !isTime(a.issuedAt) ||
    (a.media !== undefined && !isMedia(a.media))
  ) {
    throw new Error(`${TAG_VOICI_CALL_ANSWER}: bad field`);
  }
  return join([TAG_VOICI_CALL_ANSWER, a.callId, a.deviceRef, a.requestHash, a.xwingCiphertext, voiciCallSdpHash(a.answerSdp), a.turnUser, sha256Hex(utf8(a.turnSecret)), a.issuedAt, ...(a.media !== undefined ? [a.media] : [])]);
}

/** H(request bytes) for a signed-in request or, by its kind, an anonymous one (voiciCallModes.ts). */
export function voiciCallRequestHash(r: VoiciCallRequestBody | VoiciCallRequestAnonBody): string {
  if ((r as { kind?: unknown }).kind === "voici-call-request-anon") return sha256Hex(canonicalVoiciCallRequestAnon(r as VoiciCallRequestAnonBody));
  return sha256Hex(canonicalVoiciCallRequest(r as VoiciCallRequestBody));
}

export function signVoiciCallAnswer(a: VoiciCallAnswerBody, ownerSignSeed: Bytes): VoiciCallAnswer {
  return { v: 1, kind: "voici-call-answer", ...a, sig: hex(ed.sign(canonicalVoiciCallAnswer(a), ownerSignSeed)) };
}

/** The answer signed by a bound call key instead of the owner messages key (§ answering while locked). */
export function signVoiciCallAnswerWithCallKey(a: VoiciCallAnswerBody, callKeyPriv: Bytes, proof: VoiciCallKeyProof): VoiciCallAnswer {
  return { v: 1, kind: "voici-call-answer", ...a, sig: hex(p256.sign(canonicalVoiciCallAnswer(a), callKeyPriv, { lowS: true })), callKey: proof };
}

export type VoiciCallAnswerRefusal = "malformed" | "wrong-call" | "wrong-request" | "bad-sdp" | "bad-signature" | "stale" | "bad-call-key";

/**
 * An answer for `ctx.request`. Signed by ownerSignPub, or by a bound call key: then its proof must verify under
 * ownerSignPub for `ctx.username`, deviceRef must be H(callKeyPub), and when `ctx.callKeyPub` is given (the room, which
 * checked `.com`'s stored binding at join) the key must be that one.
 */
export function checkVoiciCallAnswer(
  v: unknown,
  ctx: { request: VoiciCallRequestBody | VoiciCallRequestAnonBody; ownerSignPub: string; now?: number; username?: string; callKeyPub?: string },
): { ok: true; answer: VoiciCallAnswer } | Fail<VoiciCallAnswerRefusal> {
  const no = (code: VoiciCallAnswerRefusal): Fail<VoiciCallAnswerRefusal> => ({ ok: false, code });
  if (!isObj(v) || v.v !== 1 || v.kind !== "voici-call-answer" || !isLowerHex(v.sig, 64)) return no("malformed");
  const withKey = Object.prototype.hasOwnProperty.call(v, "callKey");
  const base = withKey ? [...ANSWER_KEYS, "callKey"] : ANSWER_KEYS;
  if (!(exactKeys(v, base) || exactKeys(v, [...base, "media"]))) return no("malformed");
  const a = v as unknown as VoiciCallAnswer;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallAnswer(a);
  } catch {
    return no("malformed");
  }
  if (a.callId !== ctx.request.callId) return no("wrong-call");
  if (a.requestHash !== voiciCallRequestHash(ctx.request)) return no("wrong-request");
  if (hasVideo(voiciCallMedia(a)) && !hasVideo(voiciCallMedia(ctx.request))) return no("bad-sdp");
  if (checkVoiciCallSdp(a.answerSdp, voiciCallMedia(ctx.request))) return no("bad-sdp");
  if (withKey) {
    const proof = parseVoiciCallKeyProof(a.callKey);
    if (!proof || ctx.username === undefined || !verifyVoiciCallKeyBinding(proof.binding, proof.signature, { ownerSignPub: ctx.ownerSignPub, username: ctx.username })) return no("bad-call-key");
    if (ctx.callKeyPub !== undefined && proof.binding.callKeyPub !== ctx.callKeyPub) return no("bad-call-key");
    if (a.deviceRef !== voiciCallDeviceRef(proof.binding.callKeyPub)) return no("bad-call-key");
    if (!p256VerifyP1363(a.sig, bytes, proof.binding.callKeyPub)) return no("bad-signature");
  } else if (ctx.callKeyPub !== undefined || !ed25519VerifyHex(a.sig, bytes, ctx.ownerSignPub)) {
    return no("bad-signature");
  }
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

/** The owner's end order signed by the call key that answered (P-256). */
export function signVoiciCallEndOwnerWithCallKey(e: Omit<VoiciCallEndBody, "side">, callKeyPriv: Bytes): VoiciCallEnd {
  const body = { ...e, side: "owner" as const };
  return { v: 1, kind: "voici-call-end", ...body, sig: hex(p256.sign(canonicalVoiciCallEnd(body), callKeyPriv, { lowS: true })) };
}

/**
 * An end order for `callId`: the caller's under B (P-256), the owner's under ownerSignPub (Ed25519) or, when the call
 * was answered with a call key, under that key (`ownerCallKeyPub`, P-256).
 */
export function checkVoiciCallEnd(v: unknown, ctx: { callId: string; callerPub: string; ownerSignPub: string; ownerCallKeyPub?: string }): VoiciCallEnd | null {
  if (!isObj(v) || !exactKeys(v, END_KEYS) || v.v !== 1 || v.kind !== "voici-call-end" || typeof v.sig !== "string") return null;
  const e = v as unknown as VoiciCallEnd;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallEnd(e);
  } catch {
    return null;
  }
  if (e.callId !== ctx.callId) return null;
  const ok =
    e.side === "caller"
      ? p256VerifyP1363(e.sig, bytes, ctx.callerPub)
      : ed25519VerifyHex(e.sig, bytes, ctx.ownerSignPub) || (ctx.ownerCallKeyPub !== undefined && p256VerifyP1363(e.sig, bytes, ctx.ownerCallKeyPub));
  return ok ? e : null;
}

// ── call key (answering while locked) ──────────────────────────────────────

export interface VoiciCallKeyBinding {
  username: string;
  deviceId: string;
  /** SEC1 uncompressed P-256, hex (130). */
  callKeyPub: string;
  createdAt: number;
}
export interface VoiciCallKeyProof {
  binding: VoiciCallKeyBinding;
  /** Ed25519 by the page's ownerSignPub over the binding. */
  signature: string;
}
export interface VoiciCallKeyRevoke {
  username: string;
  deviceId: string;
  callKeyPub: string;
  revokedAt: number;
}

const DEVICE_ID = /^[0-9a-f]{32}$/;
/** A valid SEC1 uncompressed P-256 point, hex. */
export function isVoiciCallKeyPub(pub: unknown): pub is string {
  if (!isLowerHex(pub, 65) || !pub.startsWith("04")) return false;
  try {
    p256.Point.fromHex(pub);
    return true;
  } catch {
    return false;
  }
}

function callKeyFields(b: { username: string; deviceId: string; callKeyPub: string }, at: number, tag: string): void {
  if (typeof b.username !== "string" || !USERNAME.test(b.username) || typeof b.deviceId !== "string" || !DEVICE_ID.test(b.deviceId) || !isVoiciCallKeyPub(b.callKeyPub) || !isTime(at)) {
    throw new Error(`${tag}: bad field`);
  }
}

export function canonicalVoiciCallKeyBinding(b: VoiciCallKeyBinding): Bytes {
  callKeyFields(b, b.createdAt, TAG_VOICI_CALL_KEY);
  return join([TAG_VOICI_CALL_KEY, b.username, b.deviceId, b.callKeyPub, b.createdAt]);
}

export function signVoiciCallKeyBinding(b: VoiciCallKeyBinding, ownerSignSeed: Bytes): VoiciCallKeyProof {
  return { binding: { username: b.username, deviceId: b.deviceId, callKeyPub: b.callKeyPub, createdAt: b.createdAt }, signature: hex(ed.sign(canonicalVoiciCallKeyBinding(b), ownerSignSeed)) };
}

const BINDING_KEYS = ["username", "deviceId", "callKeyPub", "createdAt"];

export function parseVoiciCallKeyBinding(v: unknown): VoiciCallKeyBinding | null {
  if (!isObj(v) || !exactKeys(v, BINDING_KEYS)) return null;
  const b = v as unknown as VoiciCallKeyBinding;
  try {
    canonicalVoiciCallKeyBinding(b);
  } catch {
    return null;
  }
  return { username: b.username, deviceId: b.deviceId, callKeyPub: b.callKeyPub, createdAt: b.createdAt };
}

export function parseVoiciCallKeyProof(v: unknown): VoiciCallKeyProof | null {
  if (!isObj(v) || !exactKeys(v, ["binding", "signature"]) || !isLowerHex(v.signature, 64)) return null;
  const binding = parseVoiciCallKeyBinding(v.binding);
  return binding ? { binding, signature: v.signature as string } : null;
}

export function verifyVoiciCallKeyBinding(b: VoiciCallKeyBinding, signature: string, ctx: { ownerSignPub: string; username: string }): boolean {
  if (b.username !== ctx.username) return false;
  try {
    return ed25519VerifyHex(signature, canonicalVoiciCallKeyBinding(b), ctx.ownerSignPub);
  } catch {
    return false;
  }
}

export function canonicalVoiciCallKeyRevoke(r: VoiciCallKeyRevoke): Bytes {
  callKeyFields(r, r.revokedAt, TAG_VOICI_CALL_KEY_REVOKE);
  return join([TAG_VOICI_CALL_KEY_REVOKE, r.username, r.deviceId, r.callKeyPub, r.revokedAt]);
}

export function signVoiciCallKeyRevokeOwner(r: VoiciCallKeyRevoke, ownerSignSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciCallKeyRevoke(r), ownerSignSeed));
}

export function signVoiciCallKeyRevokeSelf(r: VoiciCallKeyRevoke, callKeyPriv: Bytes): string {
  return hex(p256.sign(canonicalVoiciCallKeyRevoke(r), callKeyPriv, { lowS: true }));
}

export function parseVoiciCallKeyRevoke(v: unknown): VoiciCallKeyRevoke | null {
  if (!isObj(v) || !exactKeys(v, ["username", "deviceId", "callKeyPub", "revokedAt"])) return null;
  const r = v as unknown as VoiciCallKeyRevoke;
  try {
    canonicalVoiciCallKeyRevoke(r);
  } catch {
    return null;
  }
  return { username: r.username, deviceId: r.deviceId, callKeyPub: r.callKeyPub, revokedAt: r.revokedAt };
}

/** A revocation signed by the page's ownerSignPub (Ed25519) or by the revoked call key itself (P-256). */
export function verifyVoiciCallKeyRevoke(r: VoiciCallKeyRevoke, signature: string, ctx: { ownerSignPub: string; username: string }): boolean {
  if (r.username !== ctx.username) return false;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallKeyRevoke(r);
  } catch {
    return false;
  }
  return ed25519VerifyHex(signature, bytes, ctx.ownerSignPub) || p256VerifyP1363(signature, bytes, r.callKeyPub);
}

export interface VoiciCallJoin {
  username: string;
  callId: string;
  deviceId: string;
  callKeyPub: string;
  issuedAt: number;
}

export function canonicalVoiciCallJoin(j: VoiciCallJoin): Bytes {
  callKeyFields(j, j.issuedAt, TAG_VOICI_CALL_JOIN);
  if (!isLowerHex(j.callId, 16)) throw new Error(`${TAG_VOICI_CALL_JOIN}: bad field`);
  return join([TAG_VOICI_CALL_JOIN, j.username, j.callId, j.deviceId, j.callKeyPub, j.issuedAt]);
}

export function signVoiciCallJoin(j: VoiciCallJoin, callKeyPriv: Bytes): string {
  return hex(p256.sign(canonicalVoiciCallJoin(j), callKeyPriv, { lowS: true }));
}

/** A join by the call key `j.callKeyPub`, fresh within the skew at `now`. */
export function verifyVoiciCallJoin(j: VoiciCallJoin, signature: string, now: number): boolean {
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciCallJoin(j);
  } catch {
    return false;
  }
  return Math.abs(j.issuedAt - now) <= VOICI_CALL_SKEW_MS && p256VerifyP1363(signature, bytes, j.callKeyPub);
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
  request: VoiciCallRequest | VoiciCallRequestAnon;
  ringingAt: number;
  endedAt: number;
  reason: VoiciMissedCallReason;
}

/** A missed call for the mailbox, sealed to the inbox key; it carries the signed request (cred, abuse tag) whole. */
export function sealVoiciMissedCall(inboxPub: Bytes, m: Omit<VoiciMissedCall, "v">, eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN))): Bytes {
  const body: VoiciMissedCall = { v: 1, ...m };
  return hybridSealWithRandomness(inboxPub, sealOpts(TAG_VOICI_MISSED_CALL, "from" in m.request ? m.request.from : m.request.browserPub, m.endedAt), [utf8(m.request.callId)], canonicalJsonBytes(body), eseed);
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
    const anon = (m.request as { kind?: unknown }).kind === "voici-call-request-anon";
    const r = anon
      ? checkVoiciCallRequestAnon(m.request, { pageId: ctx.pageId, acceptsCalls: true, callsFrom: "anyone", now: m.ringingAt, skipFresh: true })
      : checkVoiciCallRequest(m.request, { pageId: ctx.pageId, acceptsCalls: true, origin: ctx.origin, caKeys: ctx.caKeys, now: m.ringingAt, skipFresh: true });
    if (!r.ok || r.request.callId !== callId) return null;
    return m;
  } catch {
    return null;
  }
}

// ── the browser handoff (calling from the app without a media engine) ───────

/** A handoff lives 5 minutes; the session it carries at most 10 (one call, then it lapses). */
export const VOICI_CALL_HANDOFF_TTL_MS = 5 * 60_000;
export const VOICI_CALL_HANDOFF_SESSION_MS = 10 * 60_000;
const HANDOFF_USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const HANDOFF_KEYS = ["kind", "username", "pageId", "media", "issuedAt", "expiresAt", "delegatePriv", "signIn"];

export interface VoiciCallHandoff {
  kind: typeof TAG_VOICI_CALL_HANDOFF;
  username: string;
  pageId: string;
  media: VoiciCallMedia;
  issuedAt: number;
  expiresAt: number;
  delegatePriv: string;
  signIn: VoiciSignInAnswer;
}

export type VoiciCallHandoffRefusal = "malformed" | "expired" | "bad-key" | "wrong-page" | "bad-attestation" | "bad-delegation" | "bad-thread";

/** The delegate's public key (uncompressed SEC1 hex) for a handoff's private scalar, or null when it isn't one. */
export function voiciCallHandoffDelegatePub(delegatePriv: unknown): string | null {
  if (!isLowerHex(delegatePriv, 32)) return null;
  try {
    return hex(p256.getPublicKey(hexToBytes(delegatePriv), false));
  } catch {
    return null;
  }
}

/**
 * Checks a handoff the browser opened (strict shape, times, the delegate key, the page, then the sign-in answer as a
 * sign-in would). `caKeys` as for a sign-in: without a CA list the attestation is checked against its own signer and
 * `.com` checks the chain when the call is placed.
 */
export function checkVoiciCallHandoff(
  v: unknown,
  ctx: { origin: string; caKeys: readonly string[]; now: number; username?: string },
): { ok: true; handoff: VoiciCallHandoff; delegatePub: string } | Fail<VoiciCallHandoffRefusal> {
  const no = (code: VoiciCallHandoffRefusal): Fail<VoiciCallHandoffRefusal> => ({ ok: false, code });
  if (!isObj(v) || !exactKeys(v, HANDOFF_KEYS) || v.kind !== TAG_VOICI_CALL_HANDOFF) return no("malformed");
  if (typeof v.username !== "string" || !HANDOFF_USERNAME.test(v.username) || typeof v.pageId !== "string" || !PAGE_ID.test(v.pageId) || !isMedia(v.media)) return no("malformed");
  if (!isTime(v.issuedAt) || !isTime(v.expiresAt) || v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > VOICI_CALL_HANDOFF_TTL_MS || !isObj(v.signIn)) return no("malformed");
  if (ctx.now > v.expiresAt || ctx.now < v.issuedAt - VOICI_CALL_SKEW_MS) return no("expired");
  if (ctx.username !== undefined && ctx.username !== v.username) return no("wrong-page");
  const delegatePub = voiciCallHandoffDelegatePub(v.delegatePriv);
  if (!delegatePub) return no("bad-key");
  if (v.signIn.pageId !== v.pageId) return no("wrong-page");
  const d = v.signIn.delegation;
  const nonce = isObj(d) && typeof d.nonce === "string" ? d.nonce : "";
  const r = checkVoiciSignInAnswer(v.signIn, { request: { kind: TAG_VOICI_SIGN_IN_REQUEST, origin: ctx.origin, pageId: v.pageId, username: v.username, delegatePub, nonce }, caKeys: ctx.caKeys, now: ctx.now });
  if (!r.ok) return no(r.code);
  if (r.answer.delegation.expiresAt - r.answer.delegation.issuedAt > VOICI_CALL_HANDOFF_SESSION_MS) return no("bad-delegation");
  return { ok: true, handoff: { ...(v as unknown as VoiciCallHandoff), signIn: r.answer }, delegatePub };
}

const b64u = (b: Bytes) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string): Bytes | null => {
  if (!B64U.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** The link the app opens: `https://<voiciHost>/<username>#call=<sid>.<browser X25519 secret>` (both base64url). */
export function voiciCallHandoffLink(o: { host: string; username: string; sid: string; browserSecret: Bytes }): string {
  if (!HANDOFF_USERNAME.test(o.username) || !B64U.test(o.sid) || o.sid.length > 64 || o.browserSecret.length !== 32) throw new Error(`${TAG_VOICI_CALL_HANDOFF}: bad link field`);
  return `https://${o.host}/${o.username}#call=${o.sid}.${b64u(o.browserSecret)}`;
}

/** The browser's reading of the fragment: the pipe session and its X25519 secret, or null. */
export function parseVoiciCallHandoffFragment(hash: string): { sid: string; browserSecret: Bytes } | null {
  const m = /^#?call=([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!m) return null;
  const k = fromB64u(m[2]!);
  return k && k.length === 32 ? { sid: m[1]!, browserSecret: k } : null;
}

/** The pipe key both sides derive (the sign-in / remote-ticket construction). */
export function voiciCallHandoffKey(mySecret: Bytes, peerPub: Bytes): Bytes {
  return hkdf(sha256, x25519.getSharedSecret(mySecret, peerPub), utf8("flagship/qr/v1"), utf8("flagship/qr/enc/v1"), 32);
}

/** The app's sealed delivery: {phonePk, nonce, ciphertext} (base64url), the plaintext the handoff's canonical JSON. */
export function sealVoiciCallHandoff(h: VoiciCallHandoff, appSecret: Bytes, browserSecret: Bytes, nonce: Bytes = crypto.getRandomValues(new Uint8Array(12))): { phonePk: string; nonce: string; ciphertext: string } {
  const key = voiciCallHandoffKey(appSecret, x25519.getPublicKey(browserSecret));
  return { phonePk: b64u(x25519.getPublicKey(appSecret)), nonce: b64u(nonce), ciphertext: b64u(gcm(key, nonce).encrypt(canonicalJsonBytes(h))) };
}

/** The browser's opening of a delivery; null when it doesn't open or isn't JSON. Check the result with checkVoiciCallHandoff. */
export function openVoiciCallHandoff(browserSecret: Bytes, d: { phonePk: string; nonce: string; ciphertext: string }): unknown {
  const pk = fromB64u(d.phonePk);
  const nonce = fromB64u(d.nonce);
  const ct = fromB64u(d.ciphertext);
  if (!pk || pk.length !== 32 || !nonce || nonce.length !== 12 || !ct) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(gcm(voiciCallHandoffKey(browserSecret, pk), nonce).decrypt(ct)));
  } catch {
    return null;
  }
}

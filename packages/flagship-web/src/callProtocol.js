// voi.ci calls, the caller's half of the protocol (docs/voici-calls.md §2-§3): browser twin of
// packages/protocol/src/voiciCalls.ts, byte for byte (vectors packages/protocol/test-vectors/voici-calls/, replayed
// by packages/flagship-web/tests/call.test.ts). Pure and synchronous, no DOM, so the encoded-transform worker
// (callWorker.js) imports it too.
//
//   mungeVoiciCallSdp, checkVoiciCallSdp, voiciCallSdpFingerprint, voiciCallSdpHash      the SDP profile
//   canonicalVoiciCallRequest, voiciCallRequestHash                                     the request's bytes
//   voiciCallKeygen, voiciCallDecapsulate, deriveVoiciCallFrameKeys, nextVoiciCallFrameKey   the per-call keys
//   checkVoiciCallAnswer, canonicalVoiciCallAnswer                                      the owner's answer
//   sealVoiciCallFrameWithKey, openVoiciCallFrameWithKey, VoiciCallFrameSender, VoiciCallFrameReceiver
//   canonicalVoiciCallEnd                                                               a signed hang-up

import { gcm, hkdf, ml_kem768_x25519, sha256 } from "./proto/vendor/noble-post-quantum/pq-seal.js";
import { ed25519VerifyHex, hex, hexToBytes, isLowerHex, parseHybridSealPublicKey, sha256Hex } from "./proto/lib/voiciCore.js";

export const TAG_VOICI_CALL_REQUEST = "flagship/voici-call-request/v1";
export const TAG_VOICI_CALL_ANSWER = "flagship/voici-call-answer/v1";
export const TAG_VOICI_CALL_END = "flagship/voici-call-end/v1";
export const TAG_VOICI_CALL_FRAME = "flagship/voici-call-frame/v1";
export const VOICI_CALL_SKEW_MS = 10 * 60_000;
export const VOICI_CALL_RING_MS = 45_000;
export const VOICI_CALL_MAX_MS = 60 * 60_000;
export const VOICI_CALL_MAX_SDP_BYTES = 16 * 1024;
export const VOICI_CALL_FRAME_PLAINTEXT = 64;
export const VOICI_CALL_FRAME_MAX = 63;
export const VOICI_CALL_SEALED_FRAME = 88;
export const VOICI_CALL_FRAMES_PER_EPOCH = 30_000;
export const VOICI_CALL_REPLAY_WINDOW = 128;
export const VOICI_CALL_MAX_GAP_FRAMES = 3000;
export const VOICI_CALL_MAX_CTR = 2 ** 32;
export const VOICI_CALL_END_REASONS = ["hangup", "cancel", "decline", "busy", "no-answer", "limit", "failed"];
/** What a side is able to send (docs/voici-calls-v2.md §1.1); absent = audio. */
export const VOICI_CALL_MEDIA = ["audio", "audio,video"];
/** Sealed video frame sizes (§1.6): 1 KiB doubling to 1 MiB. */
export const VOICI_CALL_VIDEO_BUCKETS = Array.from({ length: 11 }, (_, i) => 1024 * 2 ** i);
export const VOICI_CALL_CAMERA_STATES = ["on", "off", "paused"];

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const PAGE_ID = /^[0-9a-f]{32}$/;
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r, keys) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32be = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u64be = (n) => concat(u32be(Math.floor(n / 2 ** 32)), u32be(n >>> 0));
const readU64 = (b) => (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) * 2 ** 32 + (((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0);
const join = (parts) => utf8(parts.map(String).join("|"));

export const voiciCallSdpHash = (sdp) => sha256Hex(utf8(sdp));

// ── SDP ────────────────────────────────────────────────────────────────────

const OPUS = /^a=rtpmap:\d+ opus\/48000(\/2)?$/i;
const FINGERPRINT = /^a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const VP8 = /^a=rtpmap:\d+ VP8\/90000$/i;
const VIDEO_EXTMAPS = ["urn:ietf:params:rtp-hdrext:sdes:mid", "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"];
const isMedia = (m) => VOICI_CALL_MEDIA.includes(m);
const isVideoExtmap = (l) => VIDEO_EXTMAPS.some((u) => l.endsWith(" " + u));
function sections(lines) {
  const out = [];
  for (const l of lines) {
    if (l.startsWith("m=")) out.push({ kind: l.slice(2).split(" ")[0], lines: [l] });
    else if (out.length) out[out.length - 1].lines.push(l);
  }
  return out;
}

export function checkVoiciCallSdp(sdp, media = "audio") {
  if (typeof sdp !== "string" || utf8(sdp).length > VOICI_CALL_MAX_SDP_BYTES) return "too-large";
  const lines = sdp.split(/\r?\n/);
  const secs = sections(lines);
  if (media === "audio,video") {
    if (secs.length !== 2 || secs[0].kind !== "audio" || secs[1].kind !== "video") return "bad-media";
    const maps = secs[1].lines.filter((l) => l.startsWith("a=rtpmap:"));
    if (maps.length !== 1 || !VP8.test(maps[0])) return "not-vp8";
    if (secs[1].lines.some((l) => l.startsWith("a=extmap:") && !isVideoExtmap(l))) return "video-extension";
  } else if (secs.length !== 1 || secs[0].kind !== "audio") return "not-audio-only";
  const rtpmap = lines.find((l) => OPUS.test(l));
  if (!rtpmap) return "no-opus";
  const pt = rtpmap.slice("a=rtpmap:".length).split(" ")[0];
  const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${pt} `));
  const params = new Map((fmtp?.slice(`a=fmtp:${pt} `.length) ?? "").split(";").map((p) => p.trim().split("=")));
  if (params.get("cbr") !== "1") return "not-cbr";
  if (params.get("usedtx") !== "0") return "dtx";
  if (lines.some((l) => l.startsWith("a=extmap:") && l.includes("ssrc-audio-level"))) return "audio-level";
  if (!lines.some((l) => FINGERPRINT.test(l))) return "no-fingerprint";
  return null;
}

const FMTP = (pt) => `a=fmtp:${pt} minptime=20;useinbandfec=1;cbr=1;usedtx=0;stereo=0;sprop-stereo=0;maxaveragebitrate=24000`;

export function mungeVoiciCallSdp(sdp) {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/).filter((l) => l !== "");
  const rtpmap = lines.find((l) => OPUS.test(l));
  if (!rtpmap) return sdp;
  const pt = rtpmap.slice("a=rtpmap:".length).split(" ")[0];
  const vp8 = lines.find((l) => VP8.test(l));
  const vpt = vp8 ? vp8.slice("a=rtpmap:".length).split(" ")[0] : undefined;
  const rtx = new Set(lines.filter((l) => l.startsWith("a=ssrc-group:FID ")).map((l) => l.split(" ")[2]));
  const out = [];
  let inAudio = false;
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith("m=")) {
      inAudio = l.startsWith("m=audio ");
      inVideo = l.startsWith("m=video ") && vpt !== undefined;
      if (inAudio || inVideo) {
        out.push([...l.split(" ").slice(0, 3), inAudio ? pt : vpt].join(" "));
        continue;
      }
    }
    if (inVideo) {
      if (l.startsWith("a=extmap:") && !isVideoExtmap(l)) continue;
      if (l === "a=extmap-allow-mixed" || l.startsWith("a=ssrc-group:FID ")) continue;
      const m = /^a=(rtpmap|fmtp|rtcp-fb):(\d+)[ ]/.exec(l);
      if (m && m[2] !== vpt) continue;
      const ss = /^a=ssrc:(\d+) /.exec(l);
      if (ss && rtx.has(ss[1])) continue;
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

export function voiciCallSdpFingerprint(sdp) {
  const l = sdp.split(/\r?\n/).find((x) => FINGERPRINT.test(x));
  return l ? l.slice("a=fingerprint:".length) : null;
}

// ── request, answer, end ───────────────────────────────────────────────────

export function canonicalVoiciCallRequest(r) {
  if (!PAGE_ID.test(r.pageId) || !isLowerHex(r.conv, 32) || !isLowerHex(r.callId, 16) || !isLowerHex(r.callerXwingPub, 1216) || !isTime(r.issuedAt) || typeof r.offerSdp !== "string" || (r.media !== undefined && !isMedia(r.media))) {
    throw new Error(`${TAG_VOICI_CALL_REQUEST}: bad field`);
  }
  return join([TAG_VOICI_CALL_REQUEST, r.pageId, r.conv, r.callId, r.callerXwingPub, voiciCallSdpHash(r.offerSdp), r.issuedAt, ...(r.media !== undefined ? [r.media] : [])]);
}

/** The media a request or answer names (absent = audio). */
export const voiciCallMedia = (r) => r.media ?? "audio";

export const voiciCallRequestHash = (r) => sha256Hex(canonicalVoiciCallRequest(r));

export function canonicalVoiciCallAnswer(a) {
  if (
    !isLowerHex(a.callId, 16) ||
    !isLowerHex(a.deviceRef, 32) ||
    !isLowerHex(a.requestHash, 32) ||
    !isLowerHex(a.xwingCiphertext, 1120) ||
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

const ANSWER_KEYS = ["v", "kind", "callId", "deviceRef", "requestHash", "xwingCiphertext", "answerSdp", "turnUser", "turnSecret", "issuedAt", "sig"];

/** The owner's answer to `request`, under the verified page's ownerSignPub: {ok, answer} or {ok:false, code}. */
export function checkVoiciCallAnswer(v, { request, ownerSignPub, now }) {
  const no = (code) => ({ ok: false, code });
  if (!isObj(v) || !(exactKeys(v, ANSWER_KEYS) || exactKeys(v, [...ANSWER_KEYS, "media"])) || v.v !== 1 || v.kind !== "voici-call-answer" || !isLowerHex(v.sig, 64)) return no("malformed");
  let bytes;
  try {
    bytes = canonicalVoiciCallAnswer(v);
  } catch {
    return no("malformed");
  }
  if (v.callId !== request.callId) return no("wrong-call");
  if (v.requestHash !== voiciCallRequestHash(request)) return no("wrong-request");
  if (voiciCallMedia(v) === "audio,video" && voiciCallMedia(request) !== "audio,video") return no("bad-sdp");
  if (checkVoiciCallSdp(v.answerSdp, voiciCallMedia(request))) return no("bad-sdp");
  if (!ed25519VerifyHex(v.sig, bytes, ownerSignPub)) return no("bad-signature");
  if (now !== undefined && Math.abs(v.issuedAt - now) > VOICI_CALL_SKEW_MS) return no("stale");
  return { ok: true, answer: v };
}

export function canonicalVoiciCallEnd(e) {
  if (!isLowerHex(e.callId, 16) || (e.side !== "caller" && e.side !== "owner") || !VOICI_CALL_END_REASONS.includes(e.reason) || !isTime(e.issuedAt)) {
    throw new Error(`${TAG_VOICI_CALL_END}: bad field`);
  }
  return join([TAG_VOICI_CALL_END, e.callId, e.side, e.reason, e.issuedAt]);
}

// ── keys ───────────────────────────────────────────────────────────────────

/** A fresh per-call X-Wing key pair (seed: 32 random bytes; the caller keeps it only for this call). */
export function voiciCallKeygen(seed = crypto.getRandomValues(new Uint8Array(32))) {
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  return { seed, publicKey: parseHybridSealPublicKey(publicKey) };
}

export function voiciCallDecapsulate(ciphertext, seed) {
  if (ciphertext.length !== 1120) throw new Error("voici-call: ciphertext");
  return ml_kem768_x25519.decapsulate(ciphertext, seed);
}

export function deriveVoiciCallFrameKeys(sharedSecret, requestBytes, answerBytes) {
  const th = sha256(concat(requestBytes, answerBytes));
  return {
    c2p: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|c2p`), 32),
    p2c: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|p2c`), 32),
  };
}

/** The video keys (voici-calls-v2.md §1.5): their own directional keys from the same secret. */
export function deriveVoiciCallVideoFrameKeys(sharedSecret, requestBytes, answerBytes) {
  const th = sha256(concat(requestBytes, answerBytes));
  return {
    c2p: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|c2p|video`), 32),
    p2c: hkdf(sha256, sharedSecret, th, utf8(`${TAG_VOICI_CALL_FRAME}|p2c|video`), 32),
  };
}

export const nextVoiciCallFrameKey = (k) => hkdf(sha256, k, new Uint8Array(0), utf8(`${TAG_VOICI_CALL_FRAME}|next`), 32);
export const voiciCallEpoch = (ctr) => Math.floor(ctr / VOICI_CALL_FRAMES_PER_EPOCH);

// ── frames ─────────────────────────────────────────────────────────────────

const DIR_CODE = { c2p: 1, p2c: 2 };
const frameNonce = (dir, ctr) => concat(u32be(DIR_CODE[dir]), u64be(ctr));
const frameAad = (callId, dir, ctr) => utf8(`${callId}|${dir}|${ctr}`);

export function sealVoiciCallFrameWithKey(key, callId, dir, ctr, frame) {
  if (frame.length > VOICI_CALL_FRAME_MAX) throw new Error("voici-call: frame too long");
  if (!Number.isSafeInteger(ctr) || ctr < 0 || ctr >= VOICI_CALL_MAX_CTR) throw new Error("voici-call: counter");
  const pt = new Uint8Array(VOICI_CALL_FRAME_PLAINTEXT);
  pt[0] = frame.length;
  pt.set(frame, 1);
  return concat(u64be(ctr), gcm(key, frameNonce(dir, ctr), frameAad(callId, dir, ctr)).encrypt(pt));
}

export function openVoiciCallFrameWithKey(key, callId, dir, sealed) {
  if (sealed.length !== VOICI_CALL_SEALED_FRAME) return null;
  const ctr = readU64(sealed.subarray(0, 8));
  if (ctr >= VOICI_CALL_MAX_CTR) return null;
  let pt;
  try {
    pt = gcm(key, frameNonce(dir, ctr), frameAad(callId, dir, ctr)).decrypt(sealed.subarray(8));
  } catch {
    return null;
  }
  const len = pt[0];
  if (len > VOICI_CALL_FRAME_MAX) return null;
  for (let i = 1 + len; i < pt.length; i++) if (pt[i] !== 0) return null;
  return { ctr, frame: pt.slice(1, 1 + len) };
}

// ── video frames (voici-calls-v2.md §1.5, §1.6) ──────────────────────────────

/** The VP8 payload header that stays clear: 10 bytes on a key frame (bit 0 of byte 0 clear), else 3. */
export const voiciCallVideoClearLen = (frame) => (frame.length === 0 ? 0 : (frame[0] & 1) === 0 ? 10 : 3);
export const voiciCallVideoBucket = (n) => VOICI_CALL_VIDEO_BUCKETS.find((b) => b >= n) ?? null;
const VIDEO_OVERHEAD = 8 + 4 + 16;
const videoAad = (callId, dir, ctr, clear) => concat(utf8(`${callId}|${dir}|video|${ctr}|`), clear);

export function sealVoiciCallVideoFrameWithKey(key, callId, dir, ctr, frame) {
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

function videoCtr(sealed) {
  if (!VOICI_CALL_VIDEO_BUCKETS.includes(sealed.length)) return null;
  const c = voiciCallVideoClearLen(sealed);
  if (c === 0 || sealed.length < c + VIDEO_OVERHEAD) return null;
  return readU64(sealed.subarray(c, c + 8));
}

export function openVoiciCallVideoFrameWithKey(key, callId, dir, sealed) {
  const ctr = videoCtr(sealed);
  if (ctr === null || ctr >= VOICI_CALL_MAX_CTR) return null;
  const c = voiciCallVideoClearLen(sealed);
  const clear = sealed.subarray(0, c);
  let pt;
  try {
    pt = gcm(key, frameNonce(dir, ctr), videoAad(callId, dir, ctr, clear)).decrypt(sealed.subarray(c + 8));
  } catch {
    return null;
  }
  const len = ((pt[0] << 24) | (pt[1] << 16) | (pt[2] << 8) | pt[3]) >>> 0;
  if (len > pt.length - 4) return null;
  for (let i = 4 + len; i < pt.length; i++) if (pt[i] !== 0) return null;
  return { ctr, frame: concat(clear, pt.subarray(4, 4 + len)) };
}

const peekCtr = (sealed, track) => (track === "video" ? videoCtr(sealed) : sealed.length === VOICI_CALL_SEALED_FRAME ? readU64(sealed.subarray(0, 8)) : null);

/** `track` "video" uses the video frame layer on its own counters; default audio. */
export class VoiciCallFrameSender {
  constructor(baseKey, callId, dir, track = "audio") {
    this.track = track;
    this.ctr = 0;
    this.epoch = 0;
    this.key = Uint8Array.from(baseKey);
    this.callId = callId;
    this.dir = dir;
  }
  seal(frame) {
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

export class VoiciCallFrameReceiver {
  constructor(baseKey, callId, dir, track = "audio") {
    this.track = track;
    this.highest = -1;
    this.seen = new Set();
    this.keys = new Map([[0, Uint8Array.from(baseKey)]]);
    this.top = 0;
    this.callId = callId;
    this.dir = dir;
  }
  open(sealed) {
    const ctr = peekCtr(sealed, this.track);
    if (ctr === null || ctr >= VOICI_CALL_MAX_CTR || ctr > this.highest + VOICI_CALL_MAX_GAP_FRAMES) return null;
    if (ctr <= this.highest - VOICI_CALL_REPLAY_WINDOW || this.seen.has(ctr)) return null;
    const e = voiciCallEpoch(ctr);
    if (e < this.top - 1) return null;
    const pending = [];
    let k = this.keys.get(e);
    if (e > this.top) {
      let cur = this.keys.get(this.top);
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

export { hex, hexToBytes };

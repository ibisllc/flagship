#!/usr/bin/env -S npx tsx
/**
 * Writes packages/protocol/test-vectors/voici-calls/vectors.json from packages/protocol/src/voiciCalls.ts
 * (docs/voici-calls.md §2-§3): the SDP profile, the signed request and every refusal, the per-call X-Wing keys, the
 * answer, the frame keys, sealed frames and a scripted receiver run (replays, gaps, epochs), the receipt, end orders,
 * the call-allow order, the sealed push and the sealed missed call. Keys and the request's cred come from
 * test-vectors/messages/ (the same page, visitor and CA), so the ports reuse their fixtures.
 *
 *   npx tsx tools/voici-calls-vectors.ts          write
 *   npx tsx tools/voici-calls-vectors.ts --check  fail when the file is stale
 *
 * Every case carries its expected answer and the generator stops when the TypeScript answer differs. P-256
 * signatures are RFC 6979 here, so ports verify them rather than reproduce them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gcm } from "@noble/ciphers/aes";
import { p256 } from "@noble/curves/nist.js";
import * as P from "../packages/protocol/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "packages/protocol/test-vectors/voici-calls/vectors.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/messages/vectors.json"), "utf8"));

const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const h = (s: string) => P.hexToBytes(s);
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
function want<T>(name: string, got: T, expected: T): T {
  if (P.canonicalJson(got ?? null) !== P.canonicalJson(expected ?? null)) throw new Error(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  return got;
}
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code!);

const d = M.derivations;
const k = M.keys;
const PAGE_ID: string = d.pageId;
const PPUB: string = d.pseudonymPub;
const CONV: string = d.conv;
const ORIGIN = P.VOICI_WEB_ORIGIN;
const NOW = M.t0 + 30_000;
const cred = M.message.envelope.cred;
const browserPriv = h(k.browserPriv);
const otherBrowserPriv = fill(32, 0x67);
const ownerSignSeed = h(d.ownerSignSeed);
const OWNER_SIGN_PUB: string = d.ownerSignPub;
const caSeed = h(k.caSeed);
const CA_PUB: string = k.caPub;

// ── SDP ────────────────────────────────────────────────────────────────────

const FP = "sha-256 " + Array.from({ length: 32 }, (_, i) => (0x10 + i).toString(16).toUpperCase().padStart(2, "0")).join(":");
const FP2 = "sha-256 " + Array.from({ length: 32 }, (_, i) => (0xa0 + i).toString(16).toUpperCase().padStart(2, "0")).join(":");
const sdpOf = (fp: string, setup: string) =>
  [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:Wq3t",
    "a=ice-pwd:5c1Jd2rS9cVb4yAqLx0pE7kT",
    "a=ice-options:trickle",
    `a=fingerprint:${fp}`,
    `a=setup:${setup}`,
    "a=mid:0",
    "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
    "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
    "a=sendrecv",
    "a=msid:- 7d1f3a3c-6f0e-4b39-9f2e-3f0f3c6a1e55",
    "a=rtcp-mux",
    "a=rtcp-rsize",
    "a=rtpmap:111 opus/48000/2",
    "a=rtcp-fb:111 transport-cc",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "a=rtpmap:63 red/48000/2",
    "a=fmtp:63 111/111",
    "a=rtpmap:9 G722/8000",
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:13 CN/8000",
    "a=rtpmap:110 telephone-event/48000",
    "a=rtpmap:126 telephone-event/8000",
    "a=ssrc:1001 cname:q8Xl1xVb4c2r3Yz5",
    "a=ssrc:1001 msid:- 7d1f3a3c-6f0e-4b39-9f2e-3f0f3c6a1e55",
    "",
  ].join("\r\n");
const offerRaw = sdpOf(FP, "actpass");
const answerRaw = sdpOf(FP2, "active").replace("a=extmap-allow-mixed\r\n", "");
const offer = P.mungeVoiciCallSdp(offerRaw);
const answerSdp = P.mungeVoiciCallSdp(answerRaw);
want("munge idempotent", P.mungeVoiciCallSdp(offer), offer);
want("munge idempotent lf", P.mungeVoiciCallSdp(offer.replaceAll("\r\n", "\n")), offer.replaceAll("\r\n", "\n"));
const sdpChecks = (
  [
    ["munged offer", offer, null],
    ["munged answer", answerSdp, null],
    ["raw offer (no cbr)", offerRaw, "not-cbr"],
    ["dtx on", offer.replace("usedtx=0", "usedtx=1"), "dtx"],
    ["audio level header", offer.replace("a=mid:0\r\n", "a=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n"), "audio-level"],
    ["a video section", offer + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n", "not-audio-only"],
    ["a data channel", offer.replace("m=audio", "m=application"), "not-audio-only"],
    ["no opus", offer.replace("opus/48000/2", "G722/8000"), "no-opus"],
    ["no fingerprint", offer.replace(`a=fingerprint:${FP}\r\n`, ""), "no-fingerprint"],
    ["sha-1 fingerprint", offer.replace(`a=fingerprint:${FP}`, "a=fingerprint:sha-1 " + FP.slice(8, 8 + 59)), "no-fingerprint"],
    ["too large", offer + "a=x:" + "y".repeat(P.VOICI_CALL_MAX_SDP_BYTES) + "\r\n", "too-large"],
  ] as const
).map(([name, sdp, expected]) => ({ name, sdp, expected: want(`sdp ${name}`, P.checkVoiciCallSdp(sdp), expected) }));

// ── request ────────────────────────────────────────────────────────────────

const CALL_ID = "ca11ca11ca11ca11ca11ca11ca11ca11";
const callerSeed = fill(32, 0x81);
const caller = P.voiciCallKeygen(callerSeed);
const requestBody: P.VoiciCallRequestBody = { pageId: PAGE_ID, conv: CONV, callId: CALL_ID, from: PPUB, callerXwingPub: H(caller.publicKey), offerSdp: offer, issuedAt: M.t0, cred };
const request = P.signVoiciCallRequestP256(requestBody, browserPriv);
const requestBytes = P.canonicalVoiciCallRequest(request);
const ctx = { pageId: PAGE_ID, acceptsCalls: true, origin: ORIGIN, caKeys: [CA_PUB], now: NOW };
type R = Record<string, unknown>;
const reqT = (f: (r: R) => void, resign = false) => {
  const r = clone(request) as unknown as R;
  f(r);
  return resign ? P.signVoiciCallRequestP256(r as unknown as P.VoiciCallRequestBody, browserPriv) : r;
};
const otherP = P.deriveMessagesPseudonymKey(h(d.messagesSecret), "aa".repeat(16));
const requestChecks = (
  [
    ["valid", request, ctx, "ok"],
    ["as a JSON string", JSON.stringify(request), ctx, "ok"],
    ["too large", JSON.stringify({ ...request, offerSdp: "x".repeat(P.VOICI_CALL_MAX_REQUEST_BYTES) }), ctx, "too-large"],
    ["not JSON", "{", ctx, "malformed"],
    ["extra key", { ...request, extra: 1 }, ctx, "malformed"],
    ["version 2", { ...request, v: 2 }, ctx, "malformed"],
    ["callId too short", { ...request, callId: "ca11" }, ctx, "malformed"],
    ["cred missing threadSig", reqT((r) => delete (r.cred as R).threadSig), ctx, "malformed"],
    ["another page", request, { ...ctx, pageId: "aa".repeat(16) }, "wrong-audience"],
    ["calls off", request, { ...ctx, acceptsCalls: false }, "calls-off"],
    ["blocked", request, { ...ctx, blocked: [PPUB] }, "blocked"],
    ["browser key revoked", request, { ...ctx, revoked: [k.browserPub] }, "revoked"],
    ["attestation from an unknown CA", request, { ...ctx, caKeys: [k.adminRootPub] }, "bad-attestation"],
    ["attestation expired", request, { ...ctx, now: cred.attestation.expiresAt }, "bad-attestation"],
    ["from another pseudonym", reqT((r) => (r.from = H(otherP.publicKey)), true), ctx, "bad-attestation"],
    ["delegation for the gym origin", request, { ...ctx, origin: P.VOICI_WEB_ORIGIN_GYM }, "bad-delegation"],
    ["thread statement for another page", reqT((r) => ((r.cred as R).threadStmt = { ...cred.threadStmt, pageId: "aa".repeat(16) })), ctx, "bad-thread"],
    ["conv of another page", reqT((r) => (r.conv = "bb".repeat(32)), true), ctx, "wrong-conv"],
    ["offer without cbr", reqT((r) => (r.offerSdp = offerRaw), true), ctx, "bad-sdp"],
    ["caller key not X-Wing", reqT((r) => (r.callerXwingPub = "00".repeat(P.HYBRID_SEAL_PUBLIC_KEY_LEN)), true), ctx, "bad-key"],
    ["offer swapped after signing", reqT((r) => (r.offerSdp = answerSdp)), ctx, "bad-signature"],
    ["signed by another browser", P.signVoiciCallRequestP256(requestBody, otherBrowserPriv), ctx, "bad-signature"],
    ["stale", request, { ...ctx, now: M.t0 + P.VOICI_CALL_SKEW_MS + 1 }, "stale"],
    ["stale but skipFresh", request, { ...ctx, now: M.t0 + P.VOICI_CALL_SKEW_MS + 1, skipFresh: true }, "ok"],
    ["not allowed by the owner", request, { ...ctx, notAllowed: true }, "not-allowed"],
  ] as const
).map(([name, r, c, expected]) => {
  const cc = c as R;
  const run = {
    pageId: cc.pageId as string,
    acceptsCalls: cc.acceptsCalls as boolean,
    origin: cc.origin as string,
    caKeys: cc.caKeys as string[],
    now: cc.now as number,
    ...(cc.blocked ? { blocked: new Set(cc.blocked as string[]) } : {}),
    ...(cc.revoked ? { revoked: new Set(cc.revoked as string[]) } : {}),
    ...(cc.skipFresh ? { skipFresh: true } : {}),
    ...(cc.notAllowed ? { allowed: () => false } : {}),
  };
  return { name, request: r, ctx: c, expected: want(`request ${name}`, code(P.checkVoiciCallRequest(r, run)), expected) };
});

// ── keys, answer ───────────────────────────────────────────────────────────

const eseed = fill(64, 0x82);
const encap = P.voiciCallEncapsulate(caller.publicKey, eseed);
want("decapsulate", H(P.voiciCallDecapsulate(encap.ciphertext, callerSeed)), H(encap.sharedSecret));
const devicePub = k.devicePub as string;
const deviceRef = P.voiciCallDeviceRef(devicePub);
const answerBody: P.VoiciCallAnswerBody = {
  callId: CALL_ID,
  deviceRef,
  requestHash: P.voiciCallRequestHash(request),
  xwingCiphertext: H(encap.ciphertext),
  answerSdp,
  turnUser: "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e",
  turnSecret: "5ec7".repeat(16),
  issuedAt: M.t0 + 5_000,
};
const answer = P.signVoiciCallAnswer(answerBody, ownerSignSeed);
const answerBytes = P.canonicalVoiciCallAnswer(answer);
const answerCtx = { ownerSignPub: OWNER_SIGN_PUB, now: NOW };
const answerChecks = (
  [
    ["valid", answer, answerCtx, "ok"],
    ["no clock", answer, { ownerSignPub: OWNER_SIGN_PUB }, "ok"],
    ["extra key", { ...answer, extra: 1 }, answerCtx, "malformed"],
    ["short ciphertext", { ...answer, xwingCiphertext: "00" }, answerCtx, "malformed"],
    ["another call", P.signVoiciCallAnswer({ ...answerBody, callId: "00".repeat(16) }, ownerSignSeed), answerCtx, "wrong-call"],
    ["another request", P.signVoiciCallAnswer({ ...answerBody, requestHash: "00".repeat(32) }, ownerSignSeed), answerCtx, "wrong-request"],
    ["answer with dtx", P.signVoiciCallAnswer({ ...answerBody, answerSdp: answerSdp.replace("usedtx=0", "usedtx=1") }, ownerSignSeed), answerCtx, "bad-sdp"],
    ["turn secret swapped", { ...answer, turnSecret: "00".repeat(32) }, answerCtx, "bad-signature"],
    ["signed by the pseudonym", P.signVoiciCallAnswer(answerBody, h(d.pseudonymSeed)), answerCtx, "bad-signature"],
    ["stale", answer, { ownerSignPub: OWNER_SIGN_PUB, now: answer.issuedAt + P.VOICI_CALL_SKEW_MS + 1 }, "stale"],
  ] as const
).map(([name, a, c, expected]) => ({ name, answer: a, ctx: c, expected: want(`answer ${name}`, code(P.checkVoiciCallAnswer(a, { request, ...c })), expected) }));

// ── frames ─────────────────────────────────────────────────────────────────

const fk = P.deriveVoiciCallFrameKeys(encap.sharedSecret, requestBytes, answerBytes);
const fkFromCaller = P.deriveVoiciCallFrameKeys(P.voiciCallDecapsulate(h(answer.xwingCiphertext), callerSeed), requestBytes, answerBytes);
want("both ends derive the same keys", [H(fkFromCaller.c2p), H(fkFromCaller.p2c)], [H(fk.c2p), H(fk.p2c)]);
const epoch1 = P.nextVoiciCallFrameKey(fk.c2p);
const epoch2 = P.nextVoiciCallFrameKey(epoch1);
const opus60 = Uint8Array.from({ length: 60 }, (_, i) => (i * 7 + 3) & 0xff);
const frameCases = (
  [
    ["c2p", 0, opus60, fk.c2p],
    ["c2p", 1, opus60.subarray(0, 3), fk.c2p],
    ["p2c", 0, opus60, fk.p2c],
    ["c2p", 29_999, new Uint8Array(0), fk.c2p],
    ["c2p", 30_000, opus60, epoch1],
    ["c2p", 60_001, Uint8Array.from({ length: 63 }, (_, i) => i), epoch2],
  ] as const
).map(([dir, ctr, frame, key]) => {
  const sealed = P.sealVoiciCallFrameWithKey(key, CALL_ID, dir, ctr, frame);
  want("sealed size", sealed.length, P.VOICI_CALL_SEALED_FRAME);
  want(`open ${dir} ${ctr}`, H(P.openVoiciCallFrameWithKey(key, CALL_ID, dir, sealed)!.frame), H(frame));
  return { dir, ctr, epoch: P.voiciCallEpoch(ctr), key: H(key), frame: H(frame), sealed: H(sealed) };
});
const s0 = h(frameCases[0]!.sealed);
const flip = (b: Uint8Array, i: number) => {
  const c = Uint8Array.from(b);
  c[i]! ^= 1;
  return c;
};
const nonzeroPad = (() => {
  const pt = new Uint8Array(64);
  pt[0] = 2;
  pt[1] = 9;
  pt[2] = 9;
  pt[40] = 1;
  const nonce = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 5]);
  const ct = gcm(fk.c2p, nonce, new TextEncoder().encode(`${CALL_ID}|c2p|5`)).encrypt(pt);
  return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5, ...ct]);
})();
const lenTooLong = (() => {
  const pt = new Uint8Array(64);
  pt[0] = 64;
  const nonce = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 6]);
  const ct = gcm(fk.c2p, nonce, new TextEncoder().encode(`${CALL_ID}|c2p|6`)).encrypt(pt);
  return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 6, ...ct]);
})();
const frameRefusals = (
  [
    ["wrong direction", "p2c", s0, fk.c2p],
    ["wrong call", "c2p", s0, fk.c2p, "00".repeat(16)],
    ["counter changed", "c2p", flip(s0, 7), fk.c2p],
    ["ciphertext changed", "c2p", flip(s0, 20), fk.c2p],
    ["tag changed", "c2p", flip(s0, 87), fk.c2p],
    ["truncated", "c2p", s0.subarray(0, 87), fk.c2p],
    ["wrong key", "c2p", s0, fk.p2c],
    ["nonzero padding", "c2p", nonzeroPad, fk.c2p],
    ["length byte over 63", "c2p", lenTooLong, fk.c2p],
  ] as const
).map(([name, dir, sealed, key, callId]) => ({ name, dir, callId: callId ?? CALL_ID, key: H(key), sealed: H(sealed), expected: want(`frame ${name}`, P.openVoiciCallFrameWithKey(key, callId ?? CALL_ID, dir, sealed), null) }));
let sealTooLong = "ok";
try {
  P.sealVoiciCallFrameWithKey(fk.c2p, CALL_ID, "c2p", 0, new Uint8Array(64));
} catch {
  sealTooLong = "refused";
}
want("seal 64-byte frame", sealTooLong, "refused");

// Scripted receiver: frames sealed by a sender, delivered in a chosen order.
const payload = (i: number) => Uint8Array.from({ length: 60 }, (_, j) => (i + j) & 0xff);
const sealAt = (i: number) => P.sealVoiciCallFrameWithKey(i >= 30_000 ? epoch1 : fk.c2p, CALL_ID, "c2p", i, payload(i));
const sender = new P.VoiciCallFrameSender(fk.c2p, CALL_ID, "c2p");
for (let i = 0; i < 3; i++) want(`sender frame ${i}`, H(sender.seal(payload(i))), H(sealAt(i)));
const sent = new Proxy([] as Uint8Array[], { get: (_t, key) => sealAt(Number(key)) });
const order: [number | "forged", string][] = [
  [0, "first"],
  [1, "next"],
  [1, "replay"],
  [5, "skip ahead"],
  [3, "late, inside the window"],
  [3, "late replay"],
  [200, "ahead"],
  [60, "older than the window"],
  [4000, "too far ahead"],
  [2999, "ahead inside the gap limit"],
  [5900, "ahead again"],
  [29_999, "too far ahead of 5900"],
  ["forged", "forged frame"],
];
const recv = new P.VoiciCallFrameReceiver(fk.c2p, CALL_ID, "c2p");
const receiverRun = order.map(([i, note]) => {
  const sealed = i === "forged" ? flip(sent[6000]!, 30) : sent[i]!;
  const got = recv.open(sealed);
  return { note, sealed: H(sealed), frame: got ? H(got) : null };
});
const expectOk = new Set(["first", "next", "skip ahead", "late, inside the window", "ahead", "ahead inside the gap limit", "ahead again"]);
for (const r of receiverRun) want(`receiver ${r.note}`, r.frame !== null, expectOk.has(r.note));
// Across an epoch: a receiver that has reached 29,990 takes 30,000 (epoch 1), a late 29,995 (epoch 0), 30,001.
const recv2 = new P.VoiciCallFrameReceiver(fk.c2p, CALL_ID, "c2p");
const epochOrder: [number, boolean][] = [
  [27_500, true],
  [29_990, true],
  [30_000, true],
  [29_995, true],
  [30_001, true],
  [30_002, true],
];
const prelude: { sealed: string; frame: string | null }[] = [];
for (let i = 0; i < 27_500; i += 2_500) {
  const got = recv2.open(sent[i]!);
  prelude.push({ sealed: H(sent[i]!), frame: got ? H(got) : null });
  want(`epoch prelude ${i}`, got !== null, true);
}
const epochRun = epochOrder.map(([i, ok]) => {
  const got = recv2.open(sent[i]!);
  want(`epoch ${i}`, got !== null, ok);
  return { ctr: i, sealed: H(sent[i]!), frame: got ? H(got) : null };
});

// ── receipt, end, allow ────────────────────────────────────────────────────

const receiptBody = { account: "alice", callId: CALL_ID, deviceRef, issuedAt: M.t0 + 6_000, expiresAt: M.t0 + 6_000 + P.VOICI_CALL_RECEIPT_TTL_MS };
const receipt = P.signVoiciCallReceipt(receiptBody, caSeed);
const rctx = { caKeys: [CA_PUB], now: NOW, account: "alice", deviceRef };
const receiptChecks = (
  [
    ["valid", receipt, rctx, "ok"],
    ["any device", receipt, { caKeys: [CA_PUB], now: NOW, account: "alice" }, "ok"],
    ["extra key", { ...receipt, extra: 1 }, rctx, "malformed"],
    ["unknown CA", receipt, { ...rctx, caKeys: [k.adminRootPub] }, "unknown-ca"],
    ["device swapped", { ...receipt, deviceRef: "00".repeat(32) }, rctx, "bad-signature"],
    ["too long", P.signVoiciCallReceipt({ ...receiptBody, expiresAt: receiptBody.issuedAt + P.VOICI_CALL_RECEIPT_TTL_MS + 1 }, caSeed), rctx, "too-long"],
    ["another account", receipt, { ...rctx, account: "bob" }, "wrong-account"],
    ["another device", receipt, { ...rctx, deviceRef: "00".repeat(32) }, "wrong-device"],
    ["expired", receipt, { ...rctx, now: receipt.expiresAt }, "expired"],
    ["not yet valid", receipt, { ...rctx, now: receipt.issuedAt - P.VOICI_CALL_SKEW_MS - 1 }, "not-yet-valid"],
  ] as const
).map(([name, r, c, expected]) => ({ name, receipt: r, ctx: c, expected: want(`receipt ${name}`, code(P.checkVoiciCallReceipt(r, c)), expected) }));

const endOwner = P.signVoiciCallEndOwner({ callId: CALL_ID, reason: "hangup", issuedAt: M.t0 + 60_000 }, ownerSignSeed);
const endCaller = P.signVoiciCallEndCallerP256({ callId: CALL_ID, reason: "cancel", issuedAt: M.t0 + 20_000 }, browserPriv);
const ectx = { callId: CALL_ID, callerPub: k.browserPub, ownerSignPub: OWNER_SIGN_PUB };
const endChecks = (
  [
    ["owner hangs up", endOwner, ectx, true],
    ["caller cancels", endCaller, ectx, true],
    ["owner end claimed as caller", { ...endOwner, side: "caller" }, ectx, false],
    ["another call", endOwner, { ...ectx, callId: "00".repeat(16) }, false],
    ["unknown reason", { ...endOwner, reason: "bored" }, ectx, false],
    ["caller key swapped", endCaller, { ...ectx, callerPub: k.otherBrowserPub }, false],
  ] as const
).map(([name, e, c, expected]) => ({ name, end: e, ctx: c, expected: want(`end ${name}`, P.checkVoiciCallEnd(e, c) !== null, expected) }));

const allow = { pageId: PAGE_ID, conv: CONV, op: "allow" as const, issuedAt: M.t0 };
const allowSig = P.signVoiciCallAllow(allow, ownerSignSeed);
want("browser key", H(p256.getPublicKey(browserPriv, false)), k.browserPub);
want("allow verifies", P.verifyVoiciCallAllow(allow, allowSig, OWNER_SIGN_PUB), true);
want("allow op swapped", P.verifyVoiciCallAllow({ ...allow, op: "disallow" }, allowSig, OWNER_SIGN_PUB), false);

// ── push, missed call ──────────────────────────────────────────────────────

const inboxPub = h(d.inboxPub);
const inboxSeed = h(d.inboxSeed);
const pushEseed = fill(64, 0x83);
const pushSealed = P.sealVoiciCallPush(inboxPub, { callId: CALL_ID, pageId: PAGE_ID, conv: CONV, from: PPUB }, M.t0 + 1_000, pushEseed);
want("push opens", P.openVoiciCallPush(inboxSeed, CALL_ID, pushSealed), { v: 1, callId: CALL_ID, pageId: PAGE_ID, conv: CONV, from: PPUB });
want("push for another call", P.openVoiciCallPush(inboxSeed, "00".repeat(16), pushSealed), null);
want("push with the thread key", P.openVoiciCallPush(h(d.threadSeed), CALL_ID, pushSealed), null);
const pushBadConv = P.sealVoiciCallPush(inboxPub, { callId: CALL_ID, pageId: PAGE_ID, conv: "bb".repeat(32), from: PPUB }, M.t0 + 1_000, pushEseed);
want("push conv mismatch", P.openVoiciCallPush(inboxSeed, CALL_ID, pushBadConv), null);
const missedEseed = fill(64, 0x84);
const missed = { request, ringingAt: M.t0 + 1_000, endedAt: M.t0 + 46_000, reason: "no-answer" as const };
const missedSealed = P.sealVoiciMissedCall(inboxPub, missed, missedEseed);
const mctx = { pageId: PAGE_ID, origin: ORIGIN, caKeys: [CA_PUB] };
want("missed opens", P.openVoiciMissedCall(inboxSeed, CALL_ID, missedSealed, mctx), { v: 1, ...missed });
want("missed for another call", P.openVoiciMissedCall(inboxSeed, "00".repeat(16), missedSealed, mctx), null);
want("missed unknown CA", P.openVoiciMissedCall(inboxSeed, CALL_ID, missedSealed, { ...mctx, caKeys: [k.adminRootPub] }), null);
const missedForged = P.sealVoiciMissedCall(inboxPub, { ...missed, request: { ...request, offerSdp: answerSdp } }, missedEseed);
want("missed with a forged request", P.openVoiciMissedCall(inboxSeed, CALL_ID, missedForged, mctx), null);

// ── page index v2 (acceptsCalls, callsFrom) ─────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VP: any = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/voici/vectors.json"), "utf8"));
const adminRootSeed = h(k.adminRootSeed);
const pageV2Body = { ...VP.index.body, seq: 8, acceptsCalls: 1 as const, callsFrom: "accepted" as const };
delete (pageV2Body as Record<string, unknown>).signerPub;
const pageV2 = P.signVoiciPageIndex(pageV2Body, adminRootSeed);
want("v2 version", pageV2.version, 2);
const pctx = { username: "alice", sensitiveKind: "admin-root" as const, sensitivePub: k.adminRootPub };
const pageV2Checks = (
  [
    ["v2 valid", pageV2, "ok"],
    ["v1 still read", VP.index.signed, "ok"],
    ["v2 without callsFrom", (() => { const x = clone(pageV2) as R; delete x.callsFrom; return x; })(), "malformed"],
    ["v1 carrying acceptsCalls", { ...VP.index.signed, acceptsCalls: 1, callsFrom: "accepted" }, "malformed"],
    ["v2 keys under version 1", { ...pageV2, version: 1 }, "malformed"],
    ["unknown callsFrom", { ...pageV2, callsFrom: "anyone" }, "malformed"],
    ["acceptsCalls 2", { ...pageV2, acceptsCalls: 2 }, "malformed"],
    ["calls switched off after signing", { ...pageV2, acceptsCalls: 0 }, "bad-signature"],
    ["callsFrom widened after signing", { ...pageV2, callsFrom: "signed-in" }, "bad-signature"],
  ] as const
).map(([name, index, expected]) => ({ name, index, expected: want(`page v2 ${name}`, code(P.checkVoiciPageIndex(index, pctx)), expected) }));
want("v1 has no calls", P.voiciPageAcceptsCalls(VP.index.signed), false);
want("v2 calls on", P.voiciPageAcceptsCalls(pageV2), true);

// ── write ──────────────────────────────────────────────────────────────────

const doc = {
  description:
    "voi.ci calls (docs/voici-calls.md §2-§3): SDP profile, signed request / answer / receipt / end / allow, per-call X-Wing keys, frame keys, sealed frames, a scripted receiver, the sealed push and missed call. Generated by tools/voici-calls-vectors.ts from packages/protocol/src/voiciCalls.ts. Keys and the request's cred are those of test-vectors/messages/.",
  t0: M.t0,
  now: NOW,
  constants: {
    skewMs: P.VOICI_CALL_SKEW_MS,
    ringMs: P.VOICI_CALL_RING_MS,
    maxCallMs: P.VOICI_CALL_MAX_MS,
    receiptTtlMs: P.VOICI_CALL_RECEIPT_TTL_MS,
    maxSdpBytes: P.VOICI_CALL_MAX_SDP_BYTES,
    maxRequestBytes: P.VOICI_CALL_MAX_REQUEST_BYTES,
    framePlaintext: P.VOICI_CALL_FRAME_PLAINTEXT,
    frameMax: P.VOICI_CALL_FRAME_MAX,
    sealedFrame: P.VOICI_CALL_SEALED_FRAME,
    framesPerEpoch: P.VOICI_CALL_FRAMES_PER_EPOCH,
    replayWindow: P.VOICI_CALL_REPLAY_WINDOW,
    maxGapFrames: P.VOICI_CALL_MAX_GAP_FRAMES,
    origin: ORIGIN,
  },
  keys: {
    pageId: PAGE_ID,
    pseudonymPub: PPUB,
    conv: CONV,
    browserPriv: k.browserPriv,
    browserPub: k.browserPub,
    otherBrowserPub: k.otherBrowserPub,
    ownerSignSeed: d.ownerSignSeed,
    ownerSignPub: OWNER_SIGN_PUB,
    inboxSeed: d.inboxSeed,
    caSeed: k.caSeed,
    caPub: CA_PUB,
    devicePub,
    deviceRef,
    callerSeed: H(callerSeed),
    callerXwingPub: H(caller.publicKey),
    eseed: H(eseed),
    xwingCiphertext: H(encap.ciphertext),
    sharedSecret: H(encap.sharedSecret),
  },
  sdp: { offerRaw, offer, answerRaw, answer: answerSdp, offerFingerprint: P.voiciCallSdpFingerprint(offer), answerFingerprint: P.voiciCallSdpFingerprint(answerSdp), checks: sdpChecks },
  request: { body: requestBody, signed: request, canonical: new TextDecoder().decode(requestBytes), hash: P.voiciCallRequestHash(request), offerSdpHash: P.voiciCallSdpHash(offer), checks: requestChecks },
  answer: { body: answerBody, signed: answer, canonical: new TextDecoder().decode(answerBytes), checks: answerChecks },
  frames: {
    c2p: H(fk.c2p),
    p2c: H(fk.p2c),
    c2pEpoch1: H(epoch1),
    c2pEpoch2: H(epoch2),
    cases: frameCases,
    refusals: frameRefusals,
    receiver: receiverRun,
    epochPrelude: prelude,
    epochRun,
  },
  receipt: { body: receiptBody, signed: receipt, canonical: new TextDecoder().decode(P.canonicalVoiciCallReceipt(receipt)), checks: receiptChecks },
  end: { owner: endOwner, caller: endCaller, ownerCanonical: new TextDecoder().decode(P.canonicalVoiciCallEnd(endOwner)), checks: endChecks },
  allow: { order: allow, canonical: new TextDecoder().decode(P.canonicalVoiciCallAllow(allow)), signature: allowSig },
  push: { payload: { v: 1, callId: CALL_ID, pageId: PAGE_ID, conv: CONV, from: PPUB }, issuedAt: M.t0 + 1_000, eseed: H(pushEseed), sealed: P.b64Encode(pushSealed), badConvSealed: P.b64Encode(pushBadConv) },
  pageV2: { body: pageV2Body, signed: pageV2, canonical: new TextDecoder().decode(P.canonicalVoiciPageIndex(pageV2)), ctx: pctx, checks: pageV2Checks },
  missedCall: { entry: missed, eseed: H(missedEseed), sealed: P.b64Encode(missedSealed), forgedSealed: P.b64Encode(missedForged) },
};

const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(OUT, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== text) {
    console.error(`${OUT} is stale; run npx tsx tools/voici-calls-vectors.ts`);
    process.exit(1);
  }
  console.log("voici-calls vectors up to date");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${text.length} bytes)`);
}

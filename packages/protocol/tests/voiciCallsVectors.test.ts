// Replays packages/protocol/test-vectors/voici-calls/ (tools/voici-calls-vectors.ts) against the TypeScript and checks
// the generator's output is fresh. Swift, Kotlin and flagship-web read the same file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", "voici-calls", "vectors.json"), "utf8"));
const h = (s: string) => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requestCtx(c: any): P.VoiciCallRequestCheckContext {
  return {
    pageId: c.pageId,
    acceptsCalls: c.acceptsCalls,
    origin: c.origin,
    caKeys: c.caKeys,
    now: c.now,
    ...(c.blocked ? { blocked: new Set<string>(c.blocked) } : {}),
    ...(c.revoked ? { revoked: new Set<string>(c.revoked) } : {}),
    ...(c.skipFresh ? { skipFresh: true } : {}),
    ...(c.notAllowed ? { allowed: () => false } : {}),
  };
}

describe("voici-calls vectors", () => {
  it("the SDP profile", () => {
    expect(P.mungeVoiciCallSdp(V.sdp.offerRaw)).toBe(V.sdp.offer);
    expect(P.mungeVoiciCallSdp(V.sdp.answerRaw)).toBe(V.sdp.answer);
    expect(P.voiciCallSdpFingerprint(V.sdp.offer)).toBe(V.sdp.offerFingerprint);
    for (const c of V.sdp.checks) expect(P.checkVoiciCallSdp(c.sdp), c.name).toBe(c.expected);
  });

  it("the request: bytes, signature, checks", () => {
    expect(dec(P.canonicalVoiciCallRequest(V.request.signed))).toBe(V.request.canonical);
    expect(P.voiciCallRequestHash(V.request.signed)).toBe(V.request.hash);
    expect(P.signVoiciCallRequestP256(V.request.body, h(V.keys.browserPriv))).toEqual(V.request.signed);
    for (const c of V.request.checks) expect(code(P.checkVoiciCallRequest(c.request, requestCtx(c.ctx))), c.name).toBe(c.expected);
  });

  it("per-call keys and the answer", () => {
    expect(H(P.voiciCallKeygen(h(V.keys.callerSeed)).publicKey)).toBe(V.keys.callerXwingPub);
    const e = P.voiciCallEncapsulate(h(V.keys.callerXwingPub), h(V.keys.eseed));
    expect([H(e.ciphertext), H(e.sharedSecret)]).toEqual([V.keys.xwingCiphertext, V.keys.sharedSecret]);
    expect(H(P.voiciCallDecapsulate(h(V.keys.xwingCiphertext), h(V.keys.callerSeed)))).toBe(V.keys.sharedSecret);
    expect(P.voiciCallDeviceRef(V.keys.devicePub)).toBe(V.keys.deviceRef);
    expect(dec(P.canonicalVoiciCallAnswer(V.answer.signed))).toBe(V.answer.canonical);
    expect(P.signVoiciCallAnswer(V.answer.body, h(V.keys.ownerSignSeed))).toEqual(V.answer.signed);
    for (const c of V.answer.checks) expect(code(P.checkVoiciCallAnswer(c.answer, { request: V.request.signed, ...c.ctx })), c.name).toBe(c.expected);
  });

  it("frame keys, frames, refusals", () => {
    const fk = P.deriveVoiciCallFrameKeys(h(V.keys.sharedSecret), P.canonicalVoiciCallRequest(V.request.signed), P.canonicalVoiciCallAnswer(V.answer.signed));
    expect([H(fk.c2p), H(fk.p2c)]).toEqual([V.frames.c2p, V.frames.p2c]);
    expect(H(P.nextVoiciCallFrameKey(fk.c2p))).toBe(V.frames.c2pEpoch1);
    for (const c of V.frames.cases) {
      expect(H(P.sealVoiciCallFrameWithKey(h(c.key), V.request.signed.callId, c.dir, c.ctr, h(c.frame)))).toBe(c.sealed);
      expect(P.voiciCallEpoch(c.ctr)).toBe(c.epoch);
    }
    for (const c of V.frames.refusals) expect(P.openVoiciCallFrameWithKey(h(c.key), c.callId, c.dir, h(c.sealed)), c.name).toBeNull();
    expect(() => P.sealVoiciCallFrameWithKey(fk.c2p, V.request.signed.callId, "c2p", 0, new Uint8Array(64))).toThrow();
  });

  it("the scripted receivers", () => {
    const r = new P.VoiciCallFrameReceiver(h(V.frames.c2p), V.request.signed.callId, "c2p");
    for (const s of V.frames.receiver) {
      const got = r.open(h(s.sealed));
      expect(got ? H(got) : null, s.note).toBe(s.frame);
    }
    const r2 = new P.VoiciCallFrameReceiver(h(V.frames.c2p), V.request.signed.callId, "c2p");
    for (const s of [...V.frames.epochPrelude, ...V.frames.epochRun]) {
      const got = r2.open(h(s.sealed));
      expect(got ? H(got) : null).toBe(s.frame);
    }
    const s = new P.VoiciCallFrameSender(h(V.frames.p2c), V.request.signed.callId, "p2c");
    const rp = new P.VoiciCallFrameReceiver(h(V.frames.p2c), V.request.signed.callId, "p2c");
    expect(H(rp.open(s.seal(new Uint8Array([1, 2, 3])))!)).toBe("010203");
  });

  it("a sender moves to the next epoch key at frame 30,000", () => {
    const s = new P.VoiciCallFrameSender(h(V.frames.c2p), V.request.signed.callId, "c2p");
    let last = new Uint8Array();
    for (let i = 0; i <= P.VOICI_CALL_FRAMES_PER_EPOCH; i++) last = s.seal(new Uint8Array([i & 0xff]));
    expect(P.openVoiciCallFrameWithKey(h(V.frames.c2pEpoch1), V.request.signed.callId, "c2p", last)?.ctr).toBe(P.VOICI_CALL_FRAMES_PER_EPOCH);
    expect(P.openVoiciCallFrameWithKey(h(V.frames.c2p), V.request.signed.callId, "c2p", last)).toBeNull();
  }, 60_000);

  it("receipt, end, allow", () => {
    expect(dec(P.canonicalVoiciCallReceipt(V.receipt.signed))).toBe(V.receipt.canonical);
    expect(P.signVoiciCallReceipt(V.receipt.body, h(V.keys.caSeed))).toEqual(V.receipt.signed);
    for (const c of V.receipt.checks) expect(code(P.checkVoiciCallReceipt(c.receipt, c.ctx)), c.name).toBe(c.expected);
    expect(dec(P.canonicalVoiciCallEnd(V.end.owner))).toBe(V.end.ownerCanonical);
    for (const c of V.end.checks) expect(P.checkVoiciCallEnd(c.end, c.ctx) !== null, c.name).toBe(c.expected);
    expect(dec(P.canonicalVoiciCallAllow(V.allow.order))).toBe(V.allow.canonical);
    expect(P.signVoiciCallAllow(V.allow.order, h(V.keys.ownerSignSeed))).toBe(V.allow.signature);
    expect(P.parseVoiciCallAllow({ ...V.allow.order, extra: 1 })).toBeNull();
  });

  it("sealed push and missed call", () => {
    const inboxSeed = h(V.keys.inboxSeed);
    const inboxPub = P.hybridSealKeygen(inboxSeed).publicKey;
    const { v: _v, ...push } = V.push.payload;
    expect(P.b64Encode(P.sealVoiciCallPush(inboxPub, push, V.push.issuedAt, h(V.push.eseed)))).toBe(V.push.sealed);
    expect(P.openVoiciCallPush(inboxSeed, push.callId, P.b64Decode(V.push.sealed)!)).toEqual(V.push.payload);
    expect(P.openVoiciCallPush(inboxSeed, push.callId, P.b64Decode(V.push.badConvSealed)!)).toBeNull();
    expect(P.b64Encode(P.sealVoiciMissedCall(inboxPub, V.missedCall.entry, h(V.missedCall.eseed)))).toBe(V.missedCall.sealed);
    const mctx = { pageId: V.keys.pageId, origin: V.constants.origin, caKeys: [V.keys.caPub] };
    expect(P.openVoiciMissedCall(inboxSeed, push.callId, P.b64Decode(V.missedCall.sealed)!, mctx)).toEqual({ v: 1, ...V.missedCall.entry });
    expect(P.openVoiciMissedCall(inboxSeed, push.callId, P.b64Decode(V.missedCall.forgedSealed)!, mctx)).toBeNull();
  });

  it("page index v2", () => {
    expect(dec(P.canonicalVoiciPageIndex(V.pageV2.signed))).toBe(V.pageV2.canonical);
    expect(P.signVoiciPageIndex(V.pageV2.body, h("33".repeat(32)))).toEqual(V.pageV2.signed);
    for (const c of V.pageV2.checks) expect(code(P.checkVoiciPageIndex(c.index, V.pageV2.ctx)), c.name).toBe(c.expected);
    expect(P.voiciPageAcceptsCalls(V.pageV2.signed)).toBe(true);
  });

  it("the vectors file is fresh", () => {
    execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "..", "tools", "voici-calls-vectors.ts"), "--check"], { stdio: "pipe" });
  }, 60_000);
});

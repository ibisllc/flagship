// Replays packages/protocol/test-vectors/voici-calls/ (tools/voici-calls-vectors.ts) against the TypeScript and checks
// the generator's output is fresh. Swift, Kotlin and flagship-web read the same file.
import { p256 } from "@noble/curves/nist.js";
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

  it("the call key: binding, answer, join, revocation, end (answering while locked)", () => {
    const c = V.callKey;
    expect(H(p256.getPublicKey(h(c.priv), false))).toBe(c.pub);
    expect(dec(P.canonicalVoiciCallKeyBinding(c.binding.binding))).toBe(c.bindingCanonical);
    for (const t of c.bindingChecks) expect(P.verifyVoiciCallKeyBinding(t.binding, t.signature, t.ctx), t.name).toBe(t.expected);
    for (const t of c.bindingShapes) expect(P.parseVoiciCallKeyBinding(t.binding) !== null, t.name).toBe(t.expected);
    expect(P.voiciCallDeviceRef(c.pub)).toBe(c.answer.deviceRef);
    for (const t of c.answer.checks) expect(code(P.checkVoiciCallAnswer(t.answer, { request: V.request.signed, ...t.ctx })), t.name).toBe(t.expected);
    expect(dec(P.canonicalVoiciCallJoin(c.join.body))).toBe(c.join.canonical);
    for (const t of c.join.checks) expect(P.verifyVoiciCallJoin(t.join, t.signature, t.now), t.name).toBe(t.expected);
    expect(dec(P.canonicalVoiciCallKeyRevoke(c.revoke.body))).toBe(c.revoke.canonical);
    for (const t of c.revoke.checks) expect(P.verifyVoiciCallKeyRevoke(t.revoke, t.signature, t.ctx), t.name).toBe(t.expected);
    for (const t of c.end.checks) {
      const ctx = { callId: V.request.signed.callId, callerPub: V.keys.browserPub, ownerSignPub: V.keys.ownerSignPub, ...(t.ownerCallKeyPub ? { ownerCallKeyPub: t.ownerCallKeyPub } : {}) };
      expect(P.checkVoiciCallEnd(t.end, ctx) !== null, t.name).toBe(t.expected);
    }
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

  it("video: the SDP, media in request and answer, keys, frames, buckets", () => {
    const X = V.video;
    expect(X.buckets).toEqual(P.VOICI_CALL_VIDEO_BUCKETS);
    expect(P.mungeVoiciCallSdp(X.sdp.offerRaw)).toBe(X.sdp.offer);
    expect(P.mungeVoiciCallSdp(X.sdp.answerRaw)).toBe(X.sdp.answer);
    for (const c of X.sdp.checks) expect(P.checkVoiciCallSdp(c.sdp, c.media), c.name).toBe(c.expected);
    expect(dec(P.canonicalVoiciCallRequest(X.request.signed))).toBe(X.request.canonical);
    expect(P.voiciCallRequestHash(X.request.signed)).toBe(X.request.hash);
    for (const c of X.request.checks) expect(code(P.checkVoiciCallRequest(c.request, requestCtx(X.request.ctx))), c.name).toBe(c.expected);
    expect(dec(P.canonicalVoiciCallAnswer(X.answer.signed))).toBe(X.answer.canonical);
    expect(P.signVoiciCallAnswer(X.answer.body, h(V.keys.ownerSignSeed))).toEqual(X.answer.signed);
    for (const c of X.answer.checks) expect(code(P.checkVoiciCallAnswer(c.answer, { request: c.request, ownerSignPub: V.keys.ownerSignPub, now: V.now })), c.name).toBe(c.expected);
    const rb = P.canonicalVoiciCallRequest(X.request.signed);
    const ab = P.canonicalVoiciCallAnswer(X.answer.signed);
    const vk = P.deriveVoiciCallVideoFrameKeys(h(X.keys.sharedSecret), rb, ab);
    const ak = P.deriveVoiciCallFrameKeys(h(X.keys.sharedSecret), rb, ab);
    expect([H(vk.c2p), H(vk.p2c), H(ak.c2p), H(ak.p2c)]).toEqual([X.keys.c2p, X.keys.p2c, X.keys.audioC2p, X.keys.audioP2c]);
    const callId = X.request.signed.callId;
    for (const c of X.frames.cases) {
      const sealed = P.sealVoiciCallVideoFrameWithKey(h(c.key), callId, c.dir, c.ctr, h(c.frame));
      expect([H(sealed), sealed.length, P.voiciCallVideoClearLen(h(c.frame))]).toEqual([c.sealed, c.sealedLen, c.clearLen]);
      expect(H(P.openVoiciCallVideoFrameWithKey(h(c.key), callId, c.dir, sealed)!.frame)).toBe(c.frame);
    }
    for (const c of X.frames.refusals) expect(P.openVoiciCallVideoFrameWithKey(h(c.key), callId, c.dir, h(c.sealed)), c.name).toBeNull();
    for (const c of X.frames.seal) {
      const f = new Uint8Array(c.frameLen);
      if (c.frameLen) f[0] = c.firstByte;
      let got = "ok";
      try {
        P.sealVoiciCallVideoFrameWithKey(vk.c2p, callId, "c2p", 0, f);
      } catch {
        got = "refused";
      }
      expect(got, c.name).toBe(c.expected);
    }
    const r = new P.VoiciCallFrameReceiver(vk.c2p, callId, "c2p", "video");
    for (const s of X.frames.receiver) {
      const got = r.open(h(s.sealed));
      expect(got ? H(got) : null).toBe(s.frame);
    }
  });

  it("the browser handoff: shape, times, key, page, the sign-in inside, the link and the pipe seal", () => {
    const X = V.handoff;
    expect(dec(P.canonicalJsonBytes(X.handoff))).toBe(X.canonical);
    expect(P.voiciCallHandoffDelegatePub(X.handoff.delegatePriv)).toBe(X.delegatePub);
    for (const c of X.checks) expect(code(P.checkVoiciCallHandoff(c.input, X.ctx)), c.name).toBe(c.expect);
    expect(code(P.checkVoiciCallHandoff(X.handoff, { ...X.ctx, now: X.lateNow }))).toBe("expired");
    expect(code(P.checkVoiciCallHandoff(X.handoff, { ...X.ctx, username: "bob" }))).toBe("wrong-page");
    expect(P.voiciCallHandoffLink({ host: X.link.host, username: X.handoff.username, sid: X.link.sid, browserSecret: h(X.link.browserSecret) })).toBe(X.link.url);
    const frag = P.parseVoiciCallHandoffFragment(new URL(X.link.url).hash)!;
    expect([frag.sid, H(frag.browserSecret)]).toEqual([X.link.sid, X.link.browserSecret]);
    for (const f of X.link.badFragments) expect(P.parseVoiciCallHandoffFragment(f), f).toBeNull();
    expect(H(P.voiciCallHandoffKey(h(X.link.browserSecret), h(X.pipe.appPub)))).toBe(X.pipe.key);
    expect(P.sealVoiciCallHandoff(X.handoff, h(X.pipe.appSecret), h(X.link.browserSecret), h(X.pipe.nonce))).toEqual(X.pipe.sealed);
    expect(P.openVoiciCallHandoff(h(X.link.browserSecret), X.pipe.sealed)).toEqual(JSON.parse(X.canonical));
    expect(P.openVoiciCallHandoff(h(X.pipe.appSecret), X.pipe.sealed)).toBeNull();
  });

  it("the vectors file is fresh", () => {
    execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "..", "tools", "voici-calls-vectors.ts"), "--check"], { stdio: "pipe" });
  }, 60_000);
});

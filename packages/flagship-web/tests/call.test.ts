// flagship-web's call protocol (src/callProtocol.js) against packages/protocol/test-vectors/voici-calls/, byte for byte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as C from "../src/callProtocol.js";
import * as P from "../src/proto/lib/voiciProtocol.js";
import { buildVoiciCallRequest, voiciCallIceServer, VOICI_CALL_AUDIO } from "../src/call.js";
import { p256 } from "../src/proto/vendor/noble-post-quantum/pq-seal.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "protocol", "test-vectors", "voici-calls", "vectors.json"), "utf8"));
const h = (s: string): Uint8Array => C.hexToBytes(s);
const H = (b: Uint8Array) => C.hex(b);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const callId: string = V.request.signed.callId;

describe("flagship-web call protocol (test-vectors/voici-calls)", () => {
  it("SDP profile", () => {
    expect(C.mungeVoiciCallSdp(V.sdp.offerRaw)).toBe(V.sdp.offer);
    expect(C.mungeVoiciCallSdp(V.sdp.answerRaw)).toBe(V.sdp.answer);
    expect(C.voiciCallSdpFingerprint(V.sdp.answer)).toBe(V.sdp.answerFingerprint);
    for (const c of V.sdp.checks) expect(C.checkVoiciCallSdp(c.sdp), c.name).toBe(c.expected);
  });

  it("request bytes and hash", () => {
    expect(dec(C.canonicalVoiciCallRequest(V.request.signed))).toBe(V.request.canonical);
    expect(C.voiciCallRequestHash(V.request.signed)).toBe(V.request.hash);
  });

  it("keys, answer, frame keys", () => {
    expect(H(C.voiciCallKeygen(h(V.keys.callerSeed)).publicKey)).toBe(V.keys.callerXwingPub);
    const ss = C.voiciCallDecapsulate(h(V.answer.signed.xwingCiphertext), h(V.keys.callerSeed));
    expect(H(ss)).toBe(V.keys.sharedSecret);
    expect(dec(C.canonicalVoiciCallAnswer(V.answer.signed))).toBe(V.answer.canonical);
    for (const c of V.answer.checks) {
      const r = C.checkVoiciCallAnswer(c.answer, { request: V.request.signed, ...c.ctx });
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
    const fk = C.deriveVoiciCallFrameKeys(ss, C.canonicalVoiciCallRequest(V.request.signed), C.canonicalVoiciCallAnswer(V.answer.signed));
    expect([H(fk.c2p), H(fk.p2c)]).toEqual([V.frames.c2p, V.frames.p2c]);
    expect(H(C.nextVoiciCallFrameKey(fk.c2p))).toBe(V.frames.c2pEpoch1);
  });

  it("frames, refusals and the scripted receivers", () => {
    for (const c of V.frames.cases) expect(H(C.sealVoiciCallFrameWithKey(h(c.key), callId, c.dir, c.ctr, h(c.frame)))).toBe(c.sealed);
    for (const c of V.frames.refusals) expect(C.openVoiciCallFrameWithKey(h(c.key), c.callId, c.dir, h(c.sealed)), c.name).toBeNull();
    const r = new C.VoiciCallFrameReceiver(h(V.frames.c2p), callId, "c2p");
    for (const s of V.frames.receiver) {
      const got = r.open(h(s.sealed));
      expect(got ? H(got) : null, s.note).toBe(s.frame);
    }
    const r2 = new C.VoiciCallFrameReceiver(h(V.frames.c2p), callId, "c2p");
    for (const s of [...V.frames.epochPrelude, ...V.frames.epochRun]) {
      const got = r2.open(h(s.sealed));
      expect(got ? H(got) : null).toBe(s.frame);
    }
    const tx = new C.VoiciCallFrameSender(h(V.frames.c2p), callId, "c2p");
    expect(H(tx.seal(h(V.frames.cases[0].frame)))).toBe(V.frames.cases[0].sealed);
  });

  it("page index v2 (the webapp port, copied here)", () => {
    expect(dec(P.canonicalVoiciPageIndex(V.pageV2.signed))).toBe(V.pageV2.canonical);
    expect(P.signVoiciPageIndex(V.pageV2.body, h("33".repeat(32)))).toEqual(V.pageV2.signed);
    for (const c of V.pageV2.checks) {
      const r = P.checkVoiciPageIndex(c.index, V.pageV2.ctx);
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
    expect(P.voiciPageAcceptsCalls(V.pageV2.signed)).toBe(true);
  });

  it("end bytes", () => {
    expect(dec(C.canonicalVoiciCallEnd(V.end.owner))).toBe(V.end.ownerCanonical);
    expect(() => C.canonicalVoiciCallEnd({ ...V.end.owner, reason: "bored" })).toThrow();
  });

  it("the browser signs the request with its WebCrypto key in the form .com and the phone check", async () => {
    const d = h(V.keys.browserPriv);
    const pub = p256.getPublicKey(d, false);
    const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: false },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const cred = V.request.signed.cred;
    const session = { pageId: V.keys.pageId, pseudonymPub: V.keys.pseudonymPub, privateKey, ...cred };
    const r = await buildVoiciCallRequest(session, { callId: V.request.signed.callId, callerXwingPub: h(V.keys.callerXwingPub), offerSdp: V.sdp.offer, issuedAt: V.t0 });
    const { sig, ...rest } = r;
    const { sig: _vsig, ...want } = V.request.signed;
    expect(rest).toEqual(want);
    expect(P.p256VerifyP1363(sig, C.canonicalVoiciCallRequest(r), V.keys.browserPub)).toBe(true);
  });

  it("the only ICE server is the owner's phone, TURN over TLS on 443", () => {
    expect(voiciCallIceServer("alice", "flagship.services", V.answer.signed)).toEqual({
      urls: "turns:alice.flagship.services:443?transport=tcp",
      username: V.answer.signed.turnUser,
      credential: V.answer.signed.turnSecret,
    });
    expect(VOICI_CALL_AUDIO.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });
});

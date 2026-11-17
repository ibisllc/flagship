// flagship-web's call protocol (src/callProtocol.js) against packages/protocol/test-vectors/voici-calls/, byte for byte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as C from "../src/callProtocol.js";
import * as P from "../src/proto/lib/voiciProtocol.js";
import { buildVoiciCallRequest, voiciCallIceServer, voiciCallSteps, VOICI_CALL_AUDIO, VOICI_CALL_CONNECT_LIMIT_MS, VOICI_CALL_STEP_SLOW_MS, VOICI_CALL_STEPS } from "../src/call.js";
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

  it("an answer signed by a bound call key (answering while locked)", () => {
    const K = V.callKey;
    for (const c of K.bindingChecks) expect(C.verifyVoiciCallKeyBinding({ binding: c.binding, signature: c.signature }, c.ctx), c.name).toBe(c.expected);
    expect(dec(C.canonicalVoiciCallKeyBinding(K.binding.binding))).toBe(K.bindingCanonical);
    // ctx.callKeyPub is the room's (the key `.com` admitted at join); the browser checks the binding itself.
    for (const c of K.answer.checks.filter((x: { ctx: { callKeyPub?: string } }) => x.ctx.callKeyPub === undefined)) {
      const r = C.checkVoiciCallAnswer(c.answer, { request: V.request.signed, ...c.ctx });
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
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

  it("video: SDP, media, keys, frames and buckets (voici-calls-v2.md §1)", () => {
    const X = V.video;
    expect(C.VOICI_CALL_VIDEO_BUCKETS).toEqual(X.buckets);
    expect(C.mungeVoiciCallSdp(X.sdp.offerRaw)).toBe(X.sdp.offer);
    expect(C.mungeVoiciCallSdp(X.sdp.answerRaw)).toBe(X.sdp.answer);
    for (const c of X.sdp.checks) expect(C.checkVoiciCallSdp(c.sdp, c.media), c.name).toBe(c.expected);
    expect(dec(C.canonicalVoiciCallRequest(X.request.signed))).toBe(X.request.canonical);
    expect(C.voiciCallRequestHash(X.request.signed)).toBe(X.request.hash);
    expect(dec(C.canonicalVoiciCallAnswer(X.answer.signed))).toBe(X.answer.canonical);
    for (const c of X.answer.checks) {
      const r = C.checkVoiciCallAnswer(c.answer, { request: c.request, ownerSignPub: V.keys.ownerSignPub, now: V.now });
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
    const rb = C.canonicalVoiciCallRequest(X.request.signed);
    const ab = C.canonicalVoiciCallAnswer(X.answer.signed);
    const vk = C.deriveVoiciCallVideoFrameKeys(h(X.keys.sharedSecret), rb, ab);
    expect([H(vk.c2p), H(vk.p2c)]).toEqual([X.keys.c2p, X.keys.p2c]);
    for (const c of X.frames.cases) {
      const sealed = C.sealVoiciCallVideoFrameWithKey(h(c.key), callId, c.dir, c.ctr, h(c.frame));
      expect([H(sealed), C.voiciCallVideoClearLen(h(c.frame))]).toEqual([c.sealed, c.clearLen]);
      expect(H(C.openVoiciCallVideoFrameWithKey(h(c.key), callId, c.dir, sealed)!.frame)).toBe(c.frame);
    }
    for (const c of X.frames.refusals) expect(C.openVoiciCallVideoFrameWithKey(h(c.key), callId, c.dir, h(c.sealed)), c.name).toBeNull();
    const r = new C.VoiciCallFrameReceiver(vk.c2p, callId, "c2p", "video");
    for (const s of X.frames.receiver) {
      const got = r.open(h(s.sealed));
      expect(got ? H(got) : null).toBe(s.frame);
    }
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

describe("the browser handoff (test-vectors/voici-calls handoff)", () => {
  const X = V.handoff;
  const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
  it("checks, link, pipe key and seal as the TypeScript reference", async () => {
    const Ho = await import("../src/proto/lib/voiciCallHandoff.js");
    expect(Ho.voiciCallHandoffDelegatePub(X.handoff.delegatePriv)).toBe(X.delegatePub);
    for (const c of X.checks) expect(code(Ho.checkVoiciCallHandoff(c.input, X.ctx)), c.name).toBe(c.expect);
    expect(code(Ho.checkVoiciCallHandoff(X.handoff, { ...X.ctx, now: X.lateNow }))).toBe("expired");
    expect(Ho.voiciCallHandoffLink({ host: X.link.host, username: X.handoff.username, sid: X.link.sid, browserSecret: h(X.link.browserSecret) })).toBe(X.link.url);
    for (const f of X.link.badFragments) expect(Ho.parseVoiciCallHandoffFragment(f), f).toBeNull();
    expect(H(Ho.voiciCallHandoffKey(h(X.link.browserSecret), h(X.pipe.appPub)))).toBe(X.pipe.key);
    expect(Ho.sealVoiciCallHandoff(X.handoff, h(X.pipe.appSecret), h(X.link.browserSecret), h(X.pipe.nonce))).toEqual(X.pipe.sealed);
    expect(Ho.openVoiciCallHandoff(h(X.link.browserSecret), X.pipe.sealed)).toEqual(JSON.parse(X.canonical));
  });
});

describe("receiveVoiciCallHandoff (the voi.ci tab's side of the pipe)", () => {
  const X = V.handoff;
  class FakeWs {
    static last: FakeWs | null = null;
    listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    url: string;
    constructor(url: string) {
      this.url = url;
      FakeWs.last = this;
    }
    addEventListener(k: string, f: (ev: { data?: unknown }) => void) {
      (this.listeners[k] ??= []).push(f);
    }
    emit(m: unknown) {
      for (const f of this.listeners.message ?? []) f({ data: JSON.stringify(m) });
    }
    close() {}
  }
  const hash = new URL(X.link.url).hash;

  it("opens the delivery, checks it and imports the delegate key; the session signs what it names", async () => {
    const W = await import("../src/handoff.js");
    const rx = W.receiveVoiciCallHandoff({ hash, username: X.handoff.username, origin: X.ctx.origin, apex: "flagshipserver.com", caKeys: X.ctx.caKeys, now: () => X.ctx.now, WebSocketImpl: FakeWs });
    const ws = FakeWs.last!;
    expect(ws.url).toBe(`wss://flagshipserver.com/qr-pipe/${X.link.sid}?role=browser`);
    ws.emit({ kind: "accepted" });
    ws.emit({ kind: "peer-hello", phonePk: X.pipe.sealed.phonePk });
    ws.emit({ kind: "peer-deliver", nonce: X.pipe.sealed.nonce, ciphertext: X.pipe.sealed.ciphertext });
    const got = await rx.done;
    expect(got.media).toBe("audio,video");
    expect([got.session.pageId, got.session.delegatePub, got.session.handoff]).toEqual([X.handoff.pageId, X.delegatePub, true]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, got.session.privateKey, new Uint8Array([1, 2, 3])));
    expect(p256.verify(sig, new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3]))), h(X.delegatePub), { prehash: false, lowS: false, format: "compact" } as never)).toBe(true);
  });

  it("refuses a used session, another page, a bad fragment and a delivery that doesn't open", async () => {
    const W = await import("../src/handoff.js");
    const start = (o: Record<string, unknown> = {}) => W.receiveVoiciCallHandoff({ hash, username: X.handoff.username, origin: X.ctx.origin, apex: "a", caKeys: X.ctx.caKeys, now: () => X.ctx.now, WebSocketImpl: FakeWs, ...o });
    const used = start();
    FakeWs.last!.emit({ kind: "rebind" });
    await expect(used.done).rejects.toMatchObject({ code: "used" });
    const other = start({ username: "bob" });
    FakeWs.last!.emit({ kind: "peer-hello", phonePk: X.pipe.sealed.phonePk });
    FakeWs.last!.emit({ kind: "peer-deliver", nonce: X.pipe.sealed.nonce, ciphertext: X.pipe.sealed.ciphertext });
    await expect(other.done).rejects.toMatchObject({ code: "wrong-page" });
    await expect(start({ hash: "#call=abc" }).done).rejects.toMatchObject({ code: "malformed" });
    const garbled = start();
    FakeWs.last!.emit({ kind: "peer-hello", phonePk: X.pipe.sealed.phonePk });
    FakeWs.last!.emit({ kind: "peer-deliver", nonce: X.pipe.sealed.nonce, ciphertext: X.pipe.sealed.ciphertext.slice(0, -4) + "AAAA" });
    await expect(garbled.done).rejects.toMatchObject({ code: "malformed" });
  });

  it("takes the fragment off the address bar", async () => {
    const W = await import("../src/handoff.js");
    let replaced = "";
    const win = { location: { hash, pathname: "/alice", search: "" }, history: { replaceState: (_a: unknown, _b: string, u: string) => (replaced = u) } };
    expect(W.takeVoiciCallHandoffFragment(win)).toBe(hash);
    expect(replaced).toBe("/alice");
    expect(W.takeVoiciCallHandoffFragment({ location: { hash: "#x" } })).toBeNull();
  });
});

describe("the connecting steps (the status line while a call connects)", () => {
  const clock = () => {
    let now = 0;
    let next = 1;
    const due = new Map<number, { at: number; f: () => void }>();
    return {
      timers: {
        setTimeout: (f: () => void, ms: number) => (due.set(next, { at: now + ms, f }), next++),
        clearTimeout: (id: number) => void due.delete(id),
      },
      advance(ms: number) {
        now += ms;
        for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
          if (t.at <= now && due.has(id)) {
            due.delete(id);
            t.f();
          }
        }
      },
    };
  };

  it("goes forward only, says when a step runs long, and gives up at the limit", () => {
    const c = clock();
    const seen: string[] = [];
    let gaveUp = 0;
    const s = voiciCallSteps({ timers: c.timers, onStep: (n: string, d: { slow: boolean }) => seen.push(d.slow ? `${n}:slow` : n), onGiveUp: () => gaveUp++ });
    s.step("secure");
    s.step("reach");
    s.step("secure");
    s.step("reach");
    expect(seen).toEqual(["secure", "reach"]);
    c.advance(VOICI_CALL_STEP_SLOW_MS);
    expect(seen.at(-1)).toBe("reach:slow");
    s.step("path");
    c.advance(VOICI_CALL_CONNECT_LIMIT_MS - VOICI_CALL_STEP_SLOW_MS);
    expect(gaveUp).toBe(1);
    s.step("audio");
    expect(seen.at(-1)).toBe("path:slow");
  });

  it("stops both clocks once connected", () => {
    const c = clock();
    const seen: string[] = [];
    let gaveUp = 0;
    const s = voiciCallSteps({ timers: c.timers, onStep: (n: string) => seen.push(n), onGiveUp: () => gaveUp++ });
    s.step("secure");
    s.stop();
    c.advance(VOICI_CALL_CONNECT_LIMIT_MS * 2);
    expect(gaveUp).toBe(0);
    expect(seen).toEqual(["secure"]);
    expect(VOICI_CALL_STEPS).toEqual(["secure", "reach", "path", "audio"]);
  });
});

describe("startVoiciCall attaches every transform before media can arrive", () => {
  it("the audio and video receivers open frames from the start, not only in ontrack", async () => {
    const { startVoiciCall } = await import("../src/call.js");
    class Rx {}
    class Tx {}
    const transceivers: { sender: Tx; receiver: Rx }[] = [];
    class FakePc {
      ontrack: unknown = null;
      addTrack() {
        const t = { sender: new Tx(), receiver: new Rx() };
        transceivers.push(t);
        return t.sender;
      }
      addTransceiver() {
        const t = { sender: new Tx(), receiver: new Rx() };
        transceivers.push(t);
        return t;
      }
      getTransceivers() {
        return transceivers;
      }
      createOffer() {
        return new Promise(() => {});
      }
      close() {}
    }
    class FakeTransform {
      constructor(
        public worker: unknown,
        public options: { side: string; track: string },
      ) {}
    }
    const worker = { postMessage() {}, addEventListener() {} };
    (globalThis as any).MediaStream ??= class {
      addTrack() {}
    };
    const call = startVoiciCall({
      username: "alex",
      index: { pageId: "p" },
      cfg: { apiBase: "https://x", services: "s" },
      session: {},
      worker,
      videoAble: true,
      stream: { getAudioTracks: () => [{}], getTracks: () => [] },
      deps: { fetch: () => new Promise(() => {}), WebSocket: class {}, RTCPeerConnection: FakePc, RTCRtpScriptTransform: FakeTransform, timers: { setTimeout: () => 0, clearTimeout() {} } },
    } as any);
    expect(call).toBeTruthy();
    const opts = transceivers.map((t) => (t.receiver as any).transform?.options);
    expect(opts).toEqual([
      { side: "receive", track: "audio" },
      { side: "receive", track: "video" },
    ]);
  });
});

describe("the call screen's camera helpers (docs/voici-calls.md \"Call screen\")", () => {
  it("faces the person or away from them, with the same size and rate", async () => {
    const { voiciCallVideoFacing, VOICI_CALL_VIDEO } = await import("../src/call.js");
    expect(voiciCallVideoFacing("environment").video.facingMode).toBe("environment");
    expect(voiciCallVideoFacing("user").video.facingMode).toBe("user");
    expect(voiciCallVideoFacing("sideways").video.facingMode).toBe("user");
    expect({ ...voiciCallVideoFacing("environment").video, facingMode: "user" }).toEqual(VOICI_CALL_VIDEO.video);
    expect(VOICI_CALL_VIDEO.video.facingMode).toBe("user");
  });

  it("counts the cameras without asking for one", async () => {
    const { voiciCallCameraCount } = await import("../src/call.js");
    const md = (kinds: string[]) => ({ enumerateDevices: async () => kinds.map((kind) => ({ kind })) });
    expect(await voiciCallCameraCount(md(["audioinput", "videoinput", "videoinput"]) as any)).toBe(2);
    expect(await voiciCallCameraCount(md(["audioinput"]) as any)).toBe(0);
    expect(await voiciCallCameraCount({ enumerateDevices: async () => { throw new Error("no"); } } as any)).toBe(0);
  });

  it("can't flip a camera that isn't running", async () => {
    const { startVoiciCall } = await import("../src/call.js");
    class FakePc {
      addTrack() { return {}; }
      addTransceiver() { return { sender: {}, receiver: {} }; }
      getTransceivers() { return []; }
      createOffer() { return new Promise(() => {}); }
      close() {}
    }
    (globalThis as any).MediaStream ??= class { addTrack() {} };
    const call = startVoiciCall({
      username: "alex", index: { pageId: "p" }, cfg: { apiBase: "https://x", services: "s" }, session: {},
      worker: { postMessage() {}, addEventListener() {} }, videoAble: true,
      stream: { getAudioTracks: () => [{}], getTracks: () => [] },
      deps: { fetch: () => new Promise(() => {}), WebSocket: class {}, RTCPeerConnection: FakePc, RTCRtpScriptTransform: class { constructor(public w: unknown, public options: unknown) {} }, timers: { setTimeout: () => 0, clearTimeout() {} } },
    } as any);
    let asked = 0;
    expect(await call.flipCamera(async () => { asked++; return { getVideoTracks: () => [{ stop() {} }] }; })).toBe(false);
    expect(asked).toBe(0);
    expect(call.cameraFacing).toBe("user");
  });
});

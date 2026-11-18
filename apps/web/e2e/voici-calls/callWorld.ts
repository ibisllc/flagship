/**
 * A local world for the voi.ci call test (docs/voici-calls.md §10): the built voi.ci site, a stand-in `.com` that runs
 * the real request check and room (`handleVoiciCallRequest`, `VoiciCallRoomCore` over in-memory storage), a /qr-pipe
 * relay with the production one's wire, and a "phone" side whose WebRTC runs in a second browser context while this
 * process signs its answer with the page's owner messages key. Test-vector keys only, never a real key.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { p256 } from "@noble/curves/nist.js";
import * as P from "@flagship/protocol";
import { handleVoiciCallChallenge, handleVoiciCallRequest, VoiciCallRoomCore, type VoiciCallRoomAction, type VoiciCallRoomInit } from "@flagship/control-plane";
import { InMemoryVoiciCallStorage, InMemoryVoiciStorage } from "@flagship/storage";
// @ts-expect-error plain ES modules without types
import { buildSite } from "../../../voici-site/build.mjs";
// @ts-expect-error plain ES modules without types
import { samplePage } from "../../../voici-site/dev/fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = join(here, "..", "..", "..", "..", "packages", "protocol", "test-vectors");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(join(vectors, "messages", "vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VK: any = JSON.parse(readFileSync(join(vectors, "voici", "vectors.json"), "utf8"));
const D = M.derivations;
const h = (s: string) => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const USER = "alice";
const ORIGIN = "https://voi.ci";
const caSeed = h(M.keys.caSeed);
const devicePub = H(P.ed.getPublicKey(new Uint8Array(32).fill(0x41)));

export interface CallWorld {
  origin: string;
  /** The app's side of a handoff: signs a session for alice's page and delivers it once the tab listens. */
  handoffUrl(): Promise<string>;
  /** What the phone saw and did, for assertions. */
  log: { request?: P.VoiciCallRequest; answer?: P.VoiciCallAnswer; requestRefusal?: string; roomSentToCaller: string[]; apiAddresses: string[] };
  close(): Promise<void>;
}

/** A v2 index for alice with calls on for anyone signed in, over the fixture's pieces. */
function alicePage(now: number, callsFrom: "signed-in" | "anyone" | "callback") {
  const base = samplePage(USER, {}, now);
  const i = base.index;
  const index = P.signVoiciPageIndex(
    { username: i.username, pageId: i.pageId, seq: i.seq, issuedAt: i.issuedAt, acceptsMessages: i.acceptsMessages, acceptsCalls: 1, callsFrom, inboxEpoch: i.inboxEpoch, inboxPub: i.inboxPub, ownerSignPub: i.ownerSignPub, pieces: i.pieces, signerKind: i.signerKind },
    h(VK.keys.adminRootSeed),
  );
  return { ...base, index };
}

/** A sign-in answer for alice's page as the visitor's app would make it, for a delegate key made for one call. */
function handoffFor(now: number): P.VoiciCallHandoff {
  const p = P.deriveMessagesPseudonymKey(h(D.messagesSecret), D.pageId);
  const ppub = H(p.publicKey);
  const tag = P.sealVoiciAbuseTag(h(M.keys.abusePub), ppub, { v: 1, username: "visitor", accountCreatedAt: now - 90 * 86_400_000, issuedAt: now });
  const attestation = P.signMessagesKeyAttestation({ pseudonymPub: ppub, abuseEpoch: 1, issuedAt: now - 60_000, expiresAt: now + 30 * 86_400_000 }, tag, caSeed);
  const delegatePriv = randomBytes(32);
  const delegation = {
    scope: "voici-messages" as const,
    origin: ORIGIN,
    audience: D.pageId,
    principalPub: ppub,
    delegateAlg: "p256" as const,
    delegatePub: H(p256.getPublicKey(delegatePriv, false)),
    issuedAt: now - 1_000,
    expiresAt: now + 9 * 60_000,
    nonce: H(randomBytes(16)),
  };
  const signIn = {
    kind: P.TAG_VOICI_SIGN_IN,
    pageId: D.pageId,
    pseudonymPub: ppub,
    attestation,
    delegation,
    delegationSig: P.signWebDelegation(delegation, p.seed),
    threadStmt: M.threadStatement.statement,
    threadSig: M.threadStatement.signature,
    threadSeed: D.threadSeed,
  };
  return { kind: P.TAG_VOICI_CALL_HANDOFF, username: USER, pageId: D.pageId, media: "audio,video", issuedAt: now, expiresAt: now + 4 * 60_000, delegatePriv: H(delegatePriv), signIn } as P.VoiciCallHandoff;
}

const PHONE_PAGE = `<!doctype html><meta charset="utf-8"><title>phone</title><body><p id="s">idle</p><script type="module">
const s = document.getElementById("s");
const ws = new WebSocket("ws://" + location.host + "/__phone-ws");
let pc = null;
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.t === "offer") {
    s.textContent = "ringing";
    pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    for (const t of pc.getTransceivers()) if (t.receiver.track.kind === "audio") { await t.sender.replaceTrack(mic.getAudioTracks()[0]); t.direction = "sendrecv"; }
    const a = await pc.createAnswer();
    await pc.setLocalDescription(a);
    ws.send(JSON.stringify({ t: "answer-sdp", sdp: pc.localDescription.sdp }));
    s.textContent = "answered";
  }
  if (m.t === "won") s.textContent = "won";
};
</script>`;

/**
 * The phone with the frame layer (docs/voici-calls.md §3), for the test that carries media: it answers with its own
 * WebRTC, waits for its candidates so they ride in the signed answer, takes the caller's candidates from the room, and
 * puts encoded streams on its sender (sealing p2c) and receiver (opening c2p) through a worker that uses the voi.ci
 * site's own frame code. The keys come from this process, derived from the X-Wing secret of the answer it signs, as
 * the phone's call engine derives them. #f shows the worker's counts.
 */
const PHONE_FRAMES_PAGE = (dir: string) => `<!doctype html><meta charset="utf-8"><title>phone</title><body><p id="s">idle</p><p id="f">{}</p><script type="module">
const s = document.getElementById("s");
const f = document.getElementById("f");
const worker = new Worker("/__phone-worker.js?d=${dir}", { type: "module" });
worker.onmessage = (e) => { if (e.data?.kind === "stats") f.textContent = JSON.stringify(e.data.counts); };
const ws = new WebSocket("ws://" + location.host + "/__phone-ws");
let pc = null;
// The stand-in phone uses Chrome's createEncodedStreams: its RTCRtpScriptTransform, set after the remote offer as an
// answerer must, never delivered the receiver's frames to the worker here.
const attach = (target, side) => {
  const { readable, writable } = target.createEncodedStreams();
  worker.postMessage({ kind: "streams", side, readable, writable }, [readable, writable]);
};
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.t === "offer") {
    s.textContent = "ringing";
    pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", encodedInsertableStreams: true });
    pc.onconnectionstatechange = () => { if (pc.connectionState === "connected") s.textContent = "connected"; };
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track.kind !== "audio") { t.direction = "inactive"; continue; }
      await t.sender.replaceTrack(mic.getAudioTracks()[0]);
      t.direction = "sendrecv";
      attach(t.sender, "send");
      attach(t.receiver, "recv");
    }
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") await new Promise((r) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") r(); }; });
    ws.send(JSON.stringify({ t: "answer-sdp", sdp: pc.localDescription.sdp }));
    s.textContent = "answered";
  }
  if (m.t === "keys") worker.postMessage({ kind: "keys", callId: m.callId, c2p: m.c2p, p2c: m.p2c });
  if (m.t === "ice" && pc && typeof m.candidate === "string") pc.addIceCandidate({ candidate: m.candidate, sdpMid: "0" }).catch(() => {});
  if (m.t === "won") s.textContent = s.textContent === "connected" ? "connected" : "won";
};
</script>`;

/** The phone's frame worker: seals what it sends under p2c, opens what it receives under c2p, counts both. */
const PHONE_WORKER = (dir: string) => `import { VoiciCallFrameReceiver, VoiciCallFrameSender, VOICI_CALL_SEALED_FRAME, hexToBytes } from "/-/${dir}/flagship-web/callProtocol.js";
let sender = null, receiver = null;
const counts = { sealOk: 0, openOk: 0, openFail: 0, openSize: 0, openNoKey: 0, inSizes: [] };
setInterval(() => self.postMessage({ kind: "stats", counts }), 500);
const t = (side) => new TransformStream({ transform(frame, c) {
  const data = new Uint8Array(frame.data);
  if (side === "send") { if (!sender) return; const out = sender.seal(data); counts.sealOk++; frame.data = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); return c.enqueue(frame); }
  if (!counts.inSizes.includes(data.length) && counts.inSizes.length < 8) counts.inSizes.push(data.length);
  if (!receiver) { counts.openNoKey++; return; }
  if (data.length !== VOICI_CALL_SEALED_FRAME) { counts.openSize++; return; }
  const opened = receiver.open(data);
  if (!opened) { counts.openFail++; return; }
  counts.openOk++;
  frame.data = opened.buffer.slice(opened.byteOffset, opened.byteOffset + opened.byteLength);
  c.enqueue(frame);
} });
const pipe = (r, w, side) => r.pipeThrough(t(side)).pipeTo(w).catch(() => {});
self.onmessage = (e) => {
  const m = e.data;
  if (m.kind === "keys") { sender = new VoiciCallFrameSender(hexToBytes(m.p2c), m.callId, "p2c"); receiver = new VoiciCallFrameReceiver(hexToBytes(m.c2p), m.callId, "c2p"); }
  if (m.kind === "streams") pipe(m.readable, m.writable, m.side);
};`;

export async function startCallWorld(o: { callsFrom?: "signed-in" | "anyone" | "callback"; frames?: boolean } = {}): Promise<CallWorld> {
  const powSecret = randomBytes(32);
  const build = buildSite();
  const voici = new InMemoryVoiciStorage();
  const calls = new InMemoryVoiciCallStorage();
  const log: CallWorld["log"] = { roomSentToCaller: [], apiAddresses: [] };
  let port = 0;
  const rooms = new Map<string, { core: VoiciCallRoomCore; caller: WebSocket | null; tokenHash: string }>();
  let phone: WebSocket | null = null;
  const deviceRef = P.voiciCallDeviceRef(devicePub);
  const pipes = new Map<string, { browser: WebSocket | null; consumed: boolean }>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(req.url ?? "/", origin);
    const p = url.pathname;
    if (p.startsWith("/api/")) log.apiAddresses.push(`${req.method} ${req.url}`);
    const devConfig = { origin: ORIGIN, host: "voi.ci", apex: `127.0.0.1:${port}`, services: "flagship.services", files: `${origin}/files`, apiBase: origin, secure: false };
    const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; worker-src 'self'; connect-src 'self' ws://127.0.0.1:${port}; frame-ancestors 'none'; base-uri 'none'`;
    const headers = { "content-security-policy": csp, "cache-control": "no-store", "permissions-policy": "microphone=(self), camera=(self)" };
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(v));
    };
    let m: RegExpExecArray | null;
    if ((m = /^\/-\/([0-9a-f]{16})\/(.+)$/.exec(p)) && m[1] === build.dir && build.files.has(m[2]!)) {
      const f = m[2]!;
      const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".svg") ? "image/svg+xml" : f.endsWith(".woff2") ? "font/woff2" : "application/json";
      res.writeHead(200, { ...headers, "content-type": type });
      return res.end(build.files.get(f));
    }
    if (p === "/files/v1/u/alice.json") return json(200, world.page.index);
    if ((m = /^\/files\/v1\/p\/([0-9a-f]{32})\/([0-9a-f]{64})$/.exec(p)) && world.page.pieces.has(m[2]!)) {
      res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
      return res.end(Buffer.from(world.page.pieces.get(m[2]!)));
    }
    if (p === "/api/username/alice") return json(200, { ...world.page.account, claimedAt: 1, accountType: "single", totpEnrolledAt: null });
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" });
      return res.end();
    }
    if (p === "/api/voici/calls" && req.method === "POST") {
      const body = await new Promise<string>((r) => {
        const parts: Buffer[] = [];
        req.on("data", (c: Buffer) => parts.push(c));
        req.on("end", () => r(Buffer.concat(parts).toString("utf8")));
      });
      const out = await handleVoiciCallRequest(
        {
          voici,
          calls,
          origin: ORIGIN,
          caKeys: () => [M.keys.caPub],
          isPseudonymBanned: async () => false,
          limitIp: async () => null,
          limitCaller: async () => null,
          limitPage: async () => null,
          limitAnonPage: async () => null,
          powSecret,
          openRoom: async (init: VoiciCallRoomInit) => {
            const s = VoiciCallRoomCore.start(init);
            rooms.set(init.callId, { core: new VoiciCallRoomCore(s.state, { seed: caSeed }), caller: null, tokenHash: init.callerTokenHash });
            return true;
          },
          ring: async (_u, call) => {
            const room = rooms.get(call.callId)!;
            log.request = room.core.state.init.request;
            phone?.send(JSON.stringify({ t: "offer", sdp: log.request.offerSdp, callId: call.callId }));
            return 1;
          },
          apex: `127.0.0.1:${port}`,
          sha256Hex: async (b) => createHash("sha256").update(b).digest("hex"),
        },
        body,
      );
      const b = out.body as Record<string, unknown>;
      if (out.status !== 200) log.requestRefusal = String(b.code);
      if (typeof b.room === "string") b.room = b.room.replace(/^wss:/, "ws:");
      return json(out.status, b);
    }
    if (p === "/api/voici/pages/alice/call-challenge") {
      const out = await handleVoiciCallChallenge({ voici, powSecret, limitIp: async () => null, bits: 12 }, "alice");
      return json(out.status, out.body);
    }
    if (p === "/__phone") {
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": `default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self' ws://127.0.0.1:${port}` });
      return res.end(o.frames ? PHONE_FRAMES_PAGE(build.dir) : PHONE_PAGE);
    }
    if (p === "/__phone-worker.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end(PHONE_WORKER(build.dir));
    }
    if (p === "/" || p === "/favicon.ico") return json(404, { error: "not found" });
    const meta = JSON.stringify(devConfig).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
    res.end((build.shell as string).replace("<title>", `<meta name="voici-dev" content="${meta}">\n<title>`));
  });

  const perform = (callId: string, actions: VoiciCallRoomAction[]) => {
    const room = rooms.get(callId);
    if (!room) return;
    for (const a of actions) {
      if (a.kind !== "send") continue;
      const text = JSON.stringify(a.msg);
      if (a.to === "caller") {
        log.roomSentToCaller.push(String(a.msg.t));
        room.caller?.send(text);
      } else phone?.send(text);
    }
  };

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/")) log.apiAddresses.push(`WS ${url.pathname}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      let m: RegExpExecArray | null;
      if (url.pathname === "/__phone-ws") {
        phone = ws;
        ws.on("message", (data) => {
          const msg = JSON.parse(String(data));
          const call = [...rooms.entries()].find(([, r]) => r.core.state.phase === "ringing");
          if (msg.t !== "answer-sdp" || !call || !log.request) return;
          const [callId, room] = call;
          const req2 = log.request;
          const answerSdp = P.mungeVoiciCallSdp(msg.sdp);
          const encap = P.voiciCallEncapsulate(h(req2.callerXwingPub));
          const answer = P.signVoiciCallAnswer(
            { callId, deviceRef, requestHash: P.voiciCallRequestHash(req2), xwingCiphertext: H(encap.ciphertext), answerSdp, turnUser: H(randomBytes(16)), turnSecret: H(randomBytes(32)), issuedAt: Date.now(), ...(req2.media ? { media: req2.media } : {}) },
            h(D.ownerSignSeed),
          );
          log.answer = answer;
          perform(callId, room.core.joined({ role: "device", deviceRef }));
          perform(callId, room.core.message({ role: "device", deviceRef }, { t: "answer", answer }, Date.now()));
          if (o.frames) {
            // The phone's frame keys from the X-Wing secret this answer carries, bound to both signed messages.
            const anon = (req2 as unknown as { kind: string }).kind === "voici-call-request-anon";
            const rb = anon ? P.canonicalVoiciCallRequestAnon(req2 as unknown as P.VoiciCallRequestAnon) : P.canonicalVoiciCallRequest(req2);
            const k = P.deriveVoiciCallFrameKeys(encap.sharedSecret, rb, P.canonicalVoiciCallAnswer(answer));
            phone?.send(JSON.stringify({ t: "keys", callId, c2p: H(k.c2p), p2c: H(k.p2c) }));
          }
        });
        return;
      }
      if ((m = /^\/api\/voici\/calls\/([0-9a-f]{32})\/caller$/.exec(url.pathname))) {
        const callId = m[1]!;
        const room = rooms.get(callId);
        const t = url.searchParams.get("t") ?? "";
        if (!room || createHash("sha256").update(t).digest("hex") !== room.tokenHash) return ws.close();
        room.caller = ws;
        perform(callId, room.core.joined({ role: "caller" }));
        ws.on("message", (data) => perform(callId, room.core.message({ role: "caller" }, JSON.parse(String(data)), Date.now())));
        ws.on("close", () => perform(callId, room.core.callerLeft(Date.now())));
        return;
      }
      if ((m = /^\/qr-pipe\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname))) {
        const sid = m[1]!;
        const role = url.searchParams.get("role");
        const s = pipes.get(sid) ?? { browser: null, consumed: false };
        pipes.set(sid, s);
        if (role === "browser") {
          if (s.consumed || s.browser) {
            ws.send(JSON.stringify({ kind: "rebind" }));
            return ws.close();
          }
          s.browser = ws;
          ws.send(JSON.stringify({ kind: "accepted" }));
          return;
        }
        ws.on("message", (data) => {
          const msg = JSON.parse(String(data));
          if (!s.browser) return ws.send(JSON.stringify({ kind: "peer-missing" }));
          if (msg.kind === "hello") {
            s.browser.send(JSON.stringify({ kind: "peer-hello", phonePk: msg.phonePk }));
            ws.send(JSON.stringify({ kind: "ack" }));
          } else if (msg.kind === "deliver" && !s.consumed) {
            s.browser.send(JSON.stringify({ kind: "peer-deliver", ciphertext: msg.ciphertext, nonce: msg.nonce }));
            s.consumed = true;
            ws.send(JSON.stringify({ kind: "delivered" }));
          }
        });
        return;
      }
      ws.close();
    });
  });

  const now = Date.now();
  const world = { page: alicePage(now, o.callsFrom ?? "signed-in") };
  await voici.publishPage(
    { username: USER, pageId: D.pageId, seq: world.page.index.seq, issuedAt: world.page.index.issuedAt, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: D.ownerSignPub, indexJson: JSON.stringify(world.page.index), publishedAt: now },
    0,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    log,
    async handoffUrl() {
      const browserSecret = randomBytes(32);
      const sid = randomBytes(16).toString("base64url");
      const link = P.voiciCallHandoffLink({ host: "voi.ci", username: USER, sid, browserSecret });
      const sealed = P.sealVoiciCallHandoff(handoffFor(Date.now()), randomBytes(32), browserSecret);
      // The app's side: say hello until the tab listens, then deliver once (as the apps do after opening the link).
      void (async () => {
        for (let i = 0; i < 120; i++) {
          const ok = await new Promise<boolean>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/qr-pipe/${sid}?role=phone`);
            ws.on("open", () => ws.send(JSON.stringify({ kind: "hello", phonePk: sealed.phonePk })));
            ws.on("message", (d) => {
              const m = JSON.parse(String(d));
              if (m.kind === "peer-missing") {
                ws.close();
                resolve(false);
              } else if (m.kind === "ack") ws.send(JSON.stringify({ kind: "deliver", nonce: sealed.nonce, ciphertext: sealed.ciphertext }));
              else if (m.kind === "delivered") {
                ws.close();
                resolve(true);
              }
            });
            ws.on("error", () => resolve(false));
          });
          if (ok) return;
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      return `${origin}${new URL(link).pathname}${new URL(link).hash}`;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// A visitor's voi.ci call to a page owner (docs/voici-calls.md §1, §7): WebRTC audio whose only ICE server is the
// owner's phone (`turns:<u>.<services>:443?transport=tcp`, relay only), every frame sealed again in callWorker.js
// under keys from the X-Wing exchange in the signed set-up. `.com` only arranges: the request goes to
// POST /api/voici/calls and the set-up messages through the call's room WebSocket.
//
//   startVoiciCall(o) -> call   o = {session (a signed-in page session), index (the verified page index), username,
//                               cfg {apiBase, apex, services, origin}, stream (the microphone MediaStream), worker
//                               (a module Worker of callWorker.js), onState(state, detail), deps? (fetch, WebSocket,
//                               RTCPeerConnection, RTCRtpScriptTransform, now)}
//   call.hangUp(), call.setMuted(bool), call.remoteStream
//   call.setCamera(on, getUserMedia) -> Promise<bool>   video as an upgrade of the audio call (voici-calls-v2.md §1.4):
//                               only when o.videoAble (this browser has a camera) made the offer carry a video section;
//                               the camera is asked for on the tap that calls it. onCamera(state) reports the other
//                               side's camera: "on", "off" or "paused".
//
// States: "requesting", "ringing", "connecting" (again with {step, slow} per step, VOICI_CALL_STEPS), "connected",
// "ended" with detail {reason} or "failed" {code, retryAfterSec?}; connecting past VOICI_CALL_CONNECT_LIMIT_MS fails
// with "unreachable". The offer is made before the request (its hash is signed) and applied only once the answer brings
// the phone's one-time TURN credential, so no candidate is gathered before the call is answered.

import {
  canonicalVoiciCallAnswer,
  canonicalVoiciCallEnd,
  canonicalVoiciCallRequest,
  canonicalVoiciCallRequestAnon,
  checkVoiciCallAnswer,
  deriveVoiciCallFrameKeys,
  deriveVoiciCallVideoFrameKeys,
  hex,
  hexToBytes,
  mungeVoiciCallSdp,
  voiciCallDecapsulate,
  voiciCallKeygen,
  VOICI_CALL_CAMERA_STATES,
  VOICI_CALL_MAX_MS,
} from "./callProtocol.js";
import { messageCred, randomHex, signP256 } from "./envelope.js";
import { voiciConv } from "./proto/lib/voiciProtocol.js";
import { buildAnonRequest, fetchCallChallenge, solveVoiciCallPow } from "./callModes.js";

const NO_CREDS = { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", cache: "no-store" };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/** The getUserMedia constraints of a call (echo cancellation, noise suppression and auto gain on). */
export const VOICI_CALL_AUDIO = { audio: AUDIO, video: false };

/** The camera constraints of a call's video (360p by default, voici-calls-v2.md §1.3). */
export const VOICI_CALL_VIDEO = { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 24 }, facingMode: "user" }, audio: false };

/**
 * The steps of connecting once the phone answered, in the order they happen (the caller's status line): the quantum-safe
 * key exchange of the signed answer ("secure"), the TURN allocation on their phone's bare name ("reach"), the ICE checks
 * through it ("path"), then DTLS until the first media ("audio").
 */
export const VOICI_CALL_STEPS = ["secure", "reach", "path", "audio"];
/** One step this long shows "This is taking longer than usual"; connecting this long in all ends the call as unreachable. */
export const VOICI_CALL_STEP_SLOW_MS = 20_000;
export const VOICI_CALL_CONNECT_LIMIT_MS = 45_000;

/**
 * The step line's clock: step(name) moves forward only (a later event never shows an earlier step), reports each step
 * once with {slow: false}, again with {slow: true} after VOICI_CALL_STEP_SLOW_MS on it, and calls onGiveUp once
 * VOICI_CALL_CONNECT_LIMIT_MS have passed since the first step. stop() ends both clocks.
 */
export function voiciCallSteps({ onStep, onGiveUp, timers = globalThis }) {
  let current = null;
  let slow = null;
  let limit = null;
  let done = false;
  const stop = () => {
    done = true;
    timers.clearTimeout(slow);
    timers.clearTimeout(limit);
  };
  return {
    get current() {
      return current;
    },
    step(name) {
      if (done || !VOICI_CALL_STEPS.includes(name)) return;
      if (current !== null && VOICI_CALL_STEPS.indexOf(name) <= VOICI_CALL_STEPS.indexOf(current)) return;
      current = name;
      if (limit === null) {
        limit = timers.setTimeout(() => {
          if (done) return;
          stop();
          onGiveUp();
        }, VOICI_CALL_CONNECT_LIMIT_MS);
      }
      timers.clearTimeout(slow);
      slow = timers.setTimeout(() => {
        if (!done && current === name) onStep(name, { slow: true });
      }, VOICI_CALL_STEP_SLOW_MS);
      onStep(name, { slow: false });
    },
    stop,
  };
}

/** Whether this browser has a camera at all (no permission asked): decides whether the request offers video. */
export async function voiciCallVideoAble(mediaDevices = globalThis.navigator?.mediaDevices) {
  try {
    return (await mediaDevices.enumerateDevices()).some((d) => d.kind === "videoinput");
  } catch {
    return false;
  }
}

/** The ICE server of a call: the owner's phone on its bare name, TURN over TLS on 443, with the answer's credential. */
export function voiciCallIceServer(username, services, answer) {
  return { urls: `turns:${username}.${services}:443?transport=tcp`, username: answer.turnUser, credential: answer.turnSecret };
}

/** The signed request body for POST /api/voici/calls. */
export async function buildVoiciCallRequest(session, o) {
  const conv = voiciConv(session.pageId, session.pseudonymPub);
  const body = { pageId: session.pageId, conv, callId: o.callId, from: session.pseudonymPub, callerXwingPub: hex(o.callerXwingPub), offerSdp: o.offerSdp, issuedAt: o.issuedAt, cred: messageCred(session), ...(o.media ? { media: o.media } : {}) };
  const sig = await signP256(session.privateKey, canonicalVoiciCallRequest(body), o.subtle);
  return { v: 1, kind: "voici-call-request", ...body, sig };
}

async function signEnd(session, callId, reason, issuedAt) {
  const body = { callId, side: "caller", reason, issuedAt };
  return { v: 1, kind: "voici-call-end", ...body, sig: await signP256(session.privateKey, canonicalVoiciCallEnd(body)) };
}

/**
 * An anonymous call (a page open to anyone, docs/voici-calls.md "Who may call a page"): the page's challenge, the
 * work (a second or two, in slices), then the request signed by this browser's anonymous key alone.
 */
async function buildAnonymousRequest(o, cfg, fields) {
  const ch = await fetchCallChallenge({ apiBase: cfg.apiBase, username: o.username, fetch: o.deps?.fetch });
  if (!ch.ok) return { refused: ch };
  const nonce = await solveVoiciCallPow(ch.challenge, { cancelled: o.cancelled });
  if (nonce === null) return { refused: { code: "unavailable" } };
  return { request: await buildAnonRequest(o.anonymous, { ...fields, pageId: o.index.pageId, challenge: ch.challenge, nonce }) };
}

function attachTransform(deps, worker, target, side, track = "audio") {
  if (deps.RTCRtpScriptTransform) {
    target.transform = new deps.RTCRtpScriptTransform(worker, { side, track });
    return true;
  }
  if (typeof target.createEncodedStreams === "function") {
    const { readable, writable } = target.createEncodedStreams();
    worker.postMessage({ kind: "streams", side, track, readable, writable }, [readable, writable]);
    return true;
  }
  return false;
}

export function startVoiciCall(o) {
  const deps = {
    fetch: o.deps?.fetch ?? globalThis.fetch.bind(globalThis),
    WebSocket: o.deps?.WebSocket ?? globalThis.WebSocket,
    RTCPeerConnection: o.deps?.RTCPeerConnection ?? globalThis.RTCPeerConnection,
    RTCRtpScriptTransform: o.deps?.RTCRtpScriptTransform ?? globalThis.RTCRtpScriptTransform,
    now: o.deps?.now ?? (() => Date.now()),
    timers: o.deps?.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (t) => globalThis.clearTimeout(t) },
  };
  const { index, cfg } = o;
  // An anonymous call signs with the browser's anonymous key; a signed-in one with B (the session's key).
  const session = o.anonymous ? { privateKey: o.anonymous.privateKey } : o.session;
  const scriptTransform = !!deps.RTCRtpScriptTransform;
  const pc = new deps.RTCPeerConnection({ iceServers: [], iceTransportPolicy: "relay", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", ...(scriptTransform ? {} : { encodedInsertableStreams: true }) });
  const remoteStream = new MediaStream();
  let ws = null;
  let state = "requesting";
  const callId = randomHex(16);
  let request = null;
  let callerKey = null;
  let limitTimer = null;
  const pendingIce = [];
  const track = o.stream.getAudioTracks()[0];
  const videoAble = !!o.videoAble;
  let video = null;
  let camera = null;

  const set = (s, detail = {}) => {
    if (state === "ended" || state === "failed") return;
    state = s;
    if (s !== "connecting") steps.stop();
    o.onState?.(s, detail);
    if (s === "ended" || s === "failed") cleanup();
  };
  // While connecting, "connecting" is reported again with {step, slow} as each step starts and when one runs long.
  const steps = voiciCallSteps({
    timers: deps.timers,
    onStep: (step, d) => {
      if (state === "connecting") o.onState?.("connecting", { step, slow: d.slow });
    },
    onGiveUp: () => {
      if (state === "connecting") set("failed", { code: "unreachable" });
    },
  });
  const cleanup = () => {
    clearTimeout(limitTimer);
    try {
      ws?.close(1000);
    } catch {
      /* closed */
    }
    try {
      pc.close();
    } catch {
      /* closed */
    }
    o.worker.postMessage({ kind: "stop" });
    for (const t of o.stream.getTracks()) t.stop();
    camera?.stop();
    if (callerKey) callerKey.seed.fill(0);
  };
  const send = (m) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(m));
  };

  const sender = pc.addTrack(track, o.stream);
  if (!attachTransform(deps, o.worker, sender, "send")) {
    queueMicrotask(() => set("failed", { code: "unsupported" }));
    return { hangUp() {}, setMuted() {}, async setCamera() { return false; }, remoteStream };
  }
  if (videoAble) {
    // Negotiated now, sending nothing until the camera is turned on: no new offer when it is (voici-calls-v2.md §1.4).
    video = pc.addTransceiver("video", { direction: "sendrecv" });
    attachTransform(deps, o.worker, video.sender, "send", "video");
  }
  pc.ontrack = (e) => {
    attachTransform(deps, o.worker, e.receiver, "receive", e.track.kind === "video" ? "video" : "audio");
    remoteStream.addTrack(e.track);
  };
  pc.onicecandidate = (e) => {
    // A candidate here is a relay candidate: their phone's TURN allocated it.
    if (e.candidate) steps.step("path");
    if (state === "connecting" || state === "connected") send({ t: "ice", candidate: e.candidate ? e.candidate.candidate : null });
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") steps.step("audio");
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") set("connected");
    if (pc.connectionState === "failed") set("failed", { code: "unreachable" });
  };

  async function onAnswer(answer) {
    const r = checkVoiciCallAnswer(answer, { request, ownerSignPub: index.ownerSignPub, now: deps.now(), username: o.username });
    if (!r.ok) return set("failed", { code: "bad-answer" });
    set("connecting");
    steps.step("secure");
    const ss = voiciCallDecapsulate(hexToBytes(answer.xwingCiphertext), callerKey.seed);
    const rb = request.kind === "voici-call-request-anon" ? canonicalVoiciCallRequestAnon(request) : canonicalVoiciCallRequest(request);
    const ab = canonicalVoiciCallAnswer(answer);
    const k = deriveVoiciCallFrameKeys(ss, rb, ab);
    const vk = videoAble ? deriveVoiciCallVideoFrameKeys(ss, rb, ab) : null;
    ss.fill(0);
    o.worker.postMessage({ kind: "keys", callId, c2p: hex(k.c2p), p2c: hex(k.p2c), ...(vk ? { vc2p: hex(vk.c2p), vp2c: hex(vk.p2c) } : {}) });
    for (const key of [k.c2p, k.p2c, vk?.c2p, vk?.p2c]) key?.fill(0);
    pc.setConfiguration({ iceServers: [voiciCallIceServer(o.username, cfg.services, answer)], iceTransportPolicy: "relay", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    await pc.setLocalDescription({ type: "offer", sdp: request.offerSdp });
    await pc.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
    steps.step("reach");
    for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c === null ? null : { candidate: c, sdpMid: "0" }).catch(() => {});
    limitTimer = setTimeout(() => set("ended", { reason: "limit" }), VOICI_CALL_MAX_MS);
  }

  function onRoom(msg) {
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "ringing") set("ringing");
    else if (msg.t === "answer") onAnswer(msg.answer).catch(() => set("failed", { code: "unreachable" }));
    else if (msg.t === "ice" && (msg.candidate === null || typeof msg.candidate === "string")) {
      if (pc.remoteDescription) pc.addIceCandidate(msg.candidate === null ? null : { candidate: msg.candidate, sdpMid: "0" }).catch(() => {});
      else pendingIce.push(msg.candidate);
    } else if (msg.t === "camera" && VOICI_CALL_CAMERA_STATES.includes(msg.state)) o.onCamera?.(msg.state);
    else if (msg.t === "ended") set("ended", { reason: typeof msg.reason === "string" ? msg.reason : "hangup" });
  }

  (async () => {
    callerKey = voiciCallKeygen();
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    const fields = { callId, callerXwingPub: callerKey.publicKey, offerSdp: mungeVoiciCallSdp(offer.sdp), issuedAt: deps.now(), ...(videoAble ? { media: "audio,video" } : {}) };
    if (o.anonymous) {
      o.onState?.("working", {});
      const a = await buildAnonymousRequest(o, cfg, fields);
      if (a.refused) return set("failed", { code: a.refused.code, ...(a.refused.retryAfterSec ? { retryAfterSec: a.refused.retryAfterSec } : {}) });
      request = a.request;
      if (state !== "requesting") return;
    } else request = await buildVoiciCallRequest(session, fields);
    const res = await deps.fetch(`${cfg.apiBase}/api/voici/calls`, { ...NO_CREDS, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }) });
    let j = null;
    try {
      j = await res.json();
    } catch {
      j = null;
    }
    if (!res.ok || typeof j?.room !== "string" || !/^[0-9a-f]{64}$/.test(j?.token ?? "")) {
      const code = typeof j?.code === "string" && /^[a-z0-9-]{1,40}$/.test(j.code) ? j.code : "unavailable";
      return set("failed", { code, ...(Number.isSafeInteger(j?.retryAfterSec) ? { retryAfterSec: j.retryAfterSec } : {}) });
    }
    if (j.room !== `${cfg.secure === false ? "ws" : "wss"}://${cfg.apex}/api/voici/calls/${callId}/caller`) return set("failed", { code: "unavailable" });
    if (state !== "requesting") return;
    ws = new deps.WebSocket(`${j.room}?t=${j.token}`);
    ws.onmessage = (e) => {
      try {
        onRoom(JSON.parse(typeof e.data === "string" ? e.data : ""));
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      if (state === "requesting" || state === "ringing") set("failed", { code: "unavailable" });
    };
  })().catch(() => set("failed", { code: "unavailable" }));

  return {
    remoteStream,
    get callId() {
      return callId;
    },
    async hangUp() {
      if (state === "ended" || state === "failed") return;
      const reason = state === "connected" || state === "connecting" ? "hangup" : "cancel";
      if (ws && request) send({ t: "end", end: await signEnd(session, callId, reason, deps.now()) });
      set("ended", { reason });
    },
    setMuted(m) {
      track.enabled = !m;
    },
    /** Turns this side's camera on (asking for it now, on the person's tap) or off; false when it can't. */
    async setCamera(on, getUserMedia) {
      if (!video || (state !== "connecting" && state !== "connected")) return false;
      if (!on) {
        camera?.stop();
        camera = null;
        await video.sender.replaceTrack(null);
        send({ t: "camera", state: "off" });
        return true;
      }
      if (camera) return true;
      let s;
      try {
        s = await getUserMedia(VOICI_CALL_VIDEO);
      } catch {
        return false;
      }
      camera = s.getVideoTracks()[0] ?? null;
      if (!camera) return false;
      try {
        const p = video.sender.getParameters();
        p.degradationPreference = "maintain-framerate";
        if (p.encodings?.[0]) p.encodings[0].maxBitrate = 600_000;
        await video.sender.setParameters(p);
      } catch {
        /* defaults are fine */
      }
      await video.sender.replaceTrack(camera);
      send({ t: "camera", state: "on" });
      return true;
    },
    get cameraTrack() {
      return camera;
    },
  };
}

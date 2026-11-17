// The encoded-transform worker of a voi.ci call (docs/voici-calls.md §3): every outgoing Opus frame is sealed under
// the call's c2p key and every incoming one opened under p2c before the decoder sees it. Frames before the keys
// arrive are dropped, never passed through; so are frames that fail to open, replays and frames longer than 63
// bytes. Two entry points: `rtctransform` (RTCRtpScriptTransform: Safari, Firefox, Chrome) and a message carrying
// the streams of `createEncodedStreams` (older Chrome). Video frames (docs/voici-calls-v2.md §1.5) go through the
// video frame layer on their own keys and counters: the VP8 payload header clear, the rest padded to a size bucket.

import { hexToBytes, VOICI_CALL_SEALED_FRAME, VoiciCallFrameReceiver, VoiciCallFrameSender } from "./callProtocol.js";

const state = { audio: { sender: null, receiver: null }, video: { sender: null, receiver: null } };
const pick = (track) => (track === "video" ? state.video : state.audio);

// Diagnostic counts, posted to the page every 2 s while frames move (no contents, sizes only).
const zero = () => ({ sealOk: 0, sealRefused: 0, sealMax: 0, openOk: 0, openSize: 0, openFail: 0, openNoKey: 0, openMax: 0, outMax: 0 });
const counts = { audio: zero(), video: zero() };
let reporter = null;
function startReporter() {
  if (reporter) return;
  reporter = setInterval(() => {
    const busy = (c) => c.sealOk + c.sealRefused + c.openOk + c.openSize + c.openFail + c.openNoKey > 0;
    if (!busy(counts.audio) && !busy(counts.video)) return;
    try {
      self.postMessage({ kind: "frame-stats", audio: counts.audio, video: counts.video });
    } catch {
      /* page gone */
    }
    counts.audio = zero();
    counts.video = zero();
  }, 2000);
}

function sealer(track) {
  const s = pick(track);
  const c = () => counts[track === "video" ? "video" : "audio"];
  startReporter();
  return new TransformStream({
    transform(frame, controller) {
      if (!s.sender) return;
      const data = new Uint8Array(frame.data);
      c().sealMax = Math.max(c().sealMax, data.length);
      let sealed;
      try {
        sealed = s.sender.seal(data);
      } catch {
        c().sealRefused++;
        return;
      }
      c().sealOk++;
      frame.data = sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength);
      controller.enqueue(frame);
    },
  });
}

function opener(track) {
  const s = pick(track);
  const c = () => counts[track === "video" ? "video" : "audio"];
  startReporter();
  return new TransformStream({
    transform(frame, controller) {
      const data = new Uint8Array(frame.data);
      if (!s.receiver) {
        c().openNoKey++;
        return;
      }
      c().openMax = Math.max(c().openMax, data.length);
      if (track !== "video" && data.length !== VOICI_CALL_SEALED_FRAME) {
        c().openSize++;
        return;
      }
      const opened = s.receiver.open(data);
      if (!opened) {
        c().openFail++;
        return;
      }
      c().openOk++;
      c().outMax = Math.max(c().outMax, opened.length);
      frame.data = opened.buffer.slice(opened.byteOffset, opened.byteOffset + opened.byteLength);
      controller.enqueue(frame);
    },
  });
}

function pipe(readable, writable, side, track) {
  readable
    .pipeThrough(side === "send" ? sealer(track) : opener(track))
    .pipeTo(writable)
    .catch(() => {});
}

function keys(m) {
  if (!m || !/^[0-9a-f]{32}$/.test(m.callId) || !/^[0-9a-f]{64}$/.test(m.c2p) || !/^[0-9a-f]{64}$/.test(m.p2c)) return;
  state.audio.sender = new VoiciCallFrameSender(hexToBytes(m.c2p), m.callId, "c2p");
  state.audio.receiver = new VoiciCallFrameReceiver(hexToBytes(m.p2c), m.callId, "p2c");
  if (/^[0-9a-f]{64}$/.test(m.vc2p ?? "") && /^[0-9a-f]{64}$/.test(m.vp2c ?? "")) {
    state.video.sender = new VoiciCallFrameSender(hexToBytes(m.vc2p), m.callId, "c2p", "video");
    state.video.receiver = new VoiciCallFrameReceiver(hexToBytes(m.vp2c), m.callId, "p2c", "video");
  }
}

self.onrtctransform = (event) => {
  const t = event.transformer;
  pipe(t.readable, t.writable, t.options?.side, t.options?.track);
};

self.onmessage = (event) => {
  const m = event.data;
  if (m?.kind === "keys") keys(m);
  else if (m?.kind === "streams" && m.readable && m.writable) pipe(m.readable, m.writable, m.side, m.track);
  else if (m?.kind === "stop") {
    for (const s of [state.audio, state.video]) {
      s.sender = null;
      s.receiver = null;
    }
  }
};

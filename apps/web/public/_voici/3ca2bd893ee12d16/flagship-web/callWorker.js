// The encoded-transform worker of a voi.ci call (docs/voici-calls.md §3): every outgoing Opus frame is sealed under
// the call's c2p key and every incoming one opened under p2c before the decoder sees it. Frames before the keys
// arrive are dropped, never passed through; so are frames that fail to open, replays and frames longer than 63
// bytes. Two entry points: `rtctransform` (RTCRtpScriptTransform: Safari, Firefox, Chrome) and a message carrying
// the streams of `createEncodedStreams` (older Chrome).

import { hexToBytes, VoiciCallFrameReceiver, VoiciCallFrameSender } from "./callProtocol.js";

const state = { sender: null, receiver: null };

function sealer() {
  return new TransformStream({
    transform(frame, controller) {
      if (!state.sender) return;
      const data = new Uint8Array(frame.data);
      let sealed;
      try {
        sealed = state.sender.seal(data);
      } catch {
        return;
      }
      frame.data = sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength);
      controller.enqueue(frame);
    },
  });
}

function opener() {
  return new TransformStream({
    transform(frame, controller) {
      if (!state.receiver) return;
      const opened = state.receiver.open(new Uint8Array(frame.data));
      if (!opened) return;
      frame.data = opened.buffer.slice(opened.byteOffset, opened.byteOffset + opened.byteLength);
      controller.enqueue(frame);
    },
  });
}

function pipe(readable, writable, side) {
  readable
    .pipeThrough(side === "send" ? sealer() : opener())
    .pipeTo(writable)
    .catch(() => {});
}

function keys(m) {
  if (!m || !/^[0-9a-f]{32}$/.test(m.callId) || !/^[0-9a-f]{64}$/.test(m.c2p) || !/^[0-9a-f]{64}$/.test(m.p2c)) return;
  state.sender = new VoiciCallFrameSender(hexToBytes(m.c2p), m.callId, "c2p");
  state.receiver = new VoiciCallFrameReceiver(hexToBytes(m.p2c), m.callId, "p2c");
}

self.onrtctransform = (event) => {
  const t = event.transformer;
  pipe(t.readable, t.writable, t.options?.side);
};

self.onmessage = (event) => {
  const m = event.data;
  if (m?.kind === "keys") keys(m);
  else if (m?.kind === "streams" && m.readable && m.writable) pipe(m.readable, m.writable, m.side);
  else if (m?.kind === "stop") {
    state.sender = null;
    state.receiver = null;
  }
};

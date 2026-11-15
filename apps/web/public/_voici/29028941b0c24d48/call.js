// "Call" (docs/voici-calls.md §7): shown beside "Send me a message" only while the verified page index says calls are
// on. The microphone is asked for on the tap, never on load. A visitor who isn't signed in to this page signs in
// first (the Messages sign-in). The call itself is flagship-web's startVoiciCall: WebRTC to the owner's phone only,
// every frame sealed again under the call's X-Wing keys. Video is an upgrade of the audio call (voici-calls-v2.md §1.4):
// the call starts as audio, and the camera is asked for only when the visitor taps "Camera".

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "./i18n.js";
import { closeSheet, openSheet } from "./sheet.js";
import { openMessages } from "./messages.js";

/** The sentence for a call refusal or failure code (never shown raw). */
export function callRefusal(code, o = {}) {
  switch (code) {
    case "calls-off":
      return t("They aren't taking calls right now.");
    case "not-allowed":
      return t("They take calls only from people whose messages they accepted. Send a message first.");
    case "busy":
      return t("They're on another call. Try again later, or send a message.");
    case "rate-limited":
      return o.retryAfterSec ? t("Too many calls. Try again in about {0} minutes.", Math.max(1, Math.ceil(o.retryAfterSec / 60))) : t("Too many calls. Try again later.");
    case "camera":
      return t("voi.ci needs your camera to show your video. Allow it in your browser, or keep talking without it.");
    case "microphone":
      return t("voi.ci needs your microphone for the call. Allow it in your browser and try again.");
    case "unsupported":
      return t("This browser can't make quantum-safe calls. Try a current Chrome, Safari or Firefox.");
    case "unreachable":
      return t("The call couldn't connect. Check your connection and try again.");
    default:
      return t("Couldn't reach Flagship. Check your connection and try again.");
  }
}

function endedLine(reason) {
  switch (reason) {
    case "no-answer":
      return t("No answer.");
    case "decline":
      return t("They can't take your call right now.");
    case "limit":
      return t("Calls end after 60 minutes.");
    default:
      return t("Call ended");
  }
}

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The sentence for a handoff that couldn't be opened (never shown raw). */
export function handoffRefusal(code) {
  switch (code) {
    case "used":
    case "expired":
      return t("This call link was already used or has expired. Start the call again from your Flagship app.");
    case "unreachable":
    case "relay":
      return t("Couldn't reach Flagship. Check your connection and try again.");
    default:
      return t("This call link isn't valid. Start the call again from your Flagship app.");
  }
}

/**
 * The Flagship app handed this tab a call (docs/voici-calls.md "Calling from the app": its media engine is missing):
 * the session arrives over /qr-pipe, lives in this tab only, and the call starts on the visitor's tap (the
 * microphone is asked for then, never on load).
 */
export async function openHandoffCall(ctx, hash) {
  const { doc, lib, cfg, page } = ctx;
  const status = h(doc, "p", { class: "call-status", role: "status" }, t("Getting the call from your Flagship app…"));
  const controls = h(doc, "div", { class: "call-controls" });
  const sheet = openSheet(doc, { title: page.profile.displayName, onClose: () => rx.cancel() });
  replace(sheet.body, status, controls);
  const rx = lib.receiveVoiciCallHandoff({ hash, username: page.username, origin: cfg.origin, apex: cfg.apex, secure: cfg.secure });
  let got;
  try {
    got = await rx.done;
  } catch (e) {
    replace(status, handoffRefusal(e?.code));
    return;
  }
  if (got.session.pageId !== page.index.pageId) return replace(status, handoffRefusal("wrong-page"));
  replace(status, t("Your Flagship app is ready to call {0}.", page.profile.displayName));
  replace(controls, h(doc, "button", { class: "btn btn-primary", type: "button", on: { click: () => (closeSheet(), startCall(ctx, got.session)) } }, icon(doc, "call"), h(doc, "span", {}, t("Call"))));
}

export async function openCall(ctx) {
  const session = await ctx.lib.loadVoiciSession(ctx.store, ctx.page.index.pageId, { origin: ctx.cfg.origin });
  if (!session) return openMessages(ctx);
  startCall(ctx, session);
}

async function startCall(ctx, session) {
  const { doc, win, lib, cfg, page } = ctx;
  let call = null;
  const status = h(doc, "p", { class: "call-status", role: "status" }, t("Calling {0}…", page.profile.displayName));
  const timer = h(doc, "p", { class: "call-timer", hidden: true }, "0:00");
  const audio = h(doc, "audio", { autoplay: true });
  const remoteVideo = h(doc, "video", { class: "call-video", autoplay: true, playsinline: true, muted: true, hidden: true });
  const selfView = h(doc, "video", { class: "call-self", autoplay: true, playsinline: true, muted: true, hidden: true });
  const cameraNote = h(doc, "p", { class: "call-camera-note", role: "status", hidden: true });
  const mute = h(doc, "button", { class: "btn btn-secondary", type: "button", "aria-pressed": "false" }, t("Mute"));
  const camera = h(doc, "button", { class: "btn btn-secondary", type: "button", "aria-pressed": "false", hidden: true }, t("Camera"));
  const hang = h(doc, "button", { class: "btn btn-danger", type: "button" }, icon(doc, "call"), h(doc, "span", {}, t("Hang up")));
  const why = h(doc, "details", { class: "alt-flow" }, h(doc, "summary", {}, t("Quantum-safe call")), h(doc, "p", { class: "fine" }, t("The call goes straight to their phone. Every sound is sealed with keys that a future quantum computer can't break, and Flagship can't hear it.")));
  const controls = h(doc, "div", { class: "call-controls" }, mute, camera, hang);
  const sheet = openSheet(doc, { title: page.profile.displayName, onClose: () => call?.hangUp() });
  replace(sheet.body, status, timer, remoteVideo, selfView, cameraNote, audio, controls, why);
  let muted = false;
  let started = 0;
  let tick = null;
  mute.addEventListener("click", () => {
    muted = !muted;
    call?.setMuted(muted);
    mute.setAttribute("aria-pressed", String(muted));
    replace(mute, muted ? t("Unmute") : t("Mute"));
  });
  hang.addEventListener("click", () => call?.hangUp());
  let cameraOn = false;
  camera.addEventListener("click", async () => {
    if (!call) return;
    const want = !cameraOn;
    const ok = await call.setCamera(want, (c) => win.navigator.mediaDevices.getUserMedia(c));
    if (!ok) {
      if (want) {
        cameraNote.hidden = false;
        replace(cameraNote, callRefusal("camera"));
      }
      return;
    }
    cameraOn = want;
    camera.setAttribute("aria-pressed", String(cameraOn));
    replace(camera, cameraOn ? t("Camera off") : t("Camera"));
    selfView.hidden = !cameraOn;
    selfView.srcObject = cameraOn && call.cameraTrack ? new win.MediaStream([call.cameraTrack]) : null;
  });
  const onCamera = (st) => {
    remoteVideo.hidden = st !== "on";
    cameraNote.hidden = st === "off" && !remoteVideo.hidden;
    if (st === "on") {
      remoteVideo.srcObject = call?.remoteStream ?? null;
      cameraNote.hidden = false;
      replace(cameraNote, t("{0} turned on their camera.", page.profile.displayName));
    } else if (st === "paused") {
      cameraNote.hidden = false;
      replace(cameraNote, t("Camera paused"));
    } else {
      cameraNote.hidden = true;
    }
  };

  const finish = (line) => {
    clearInterval(tick);
    replace(status, line);
    replace(controls, h(doc, "button", { class: "btn btn-primary", type: "button", on: { click: () => (closeSheet(), startCall(ctx, session)) } }, t("Call again")));
  };

  let stream;
  try {
    stream = await win.navigator.mediaDevices.getUserMedia(lib.VOICI_CALL_AUDIO);
  } catch {
    return finish(callRefusal("microphone"));
  }
  let worker;
  try {
    worker = new win.Worker(new URL("./flagship-web/callWorker.js", import.meta.url), { type: "module" });
  } catch {
    for (const tr of stream.getTracks()) tr.stop();
    return finish(callRefusal("unsupported"));
  }
  const videoAble = await lib.voiciCallVideoAble(win.navigator.mediaDevices);
  call = lib.startVoiciCall({
    videoAble,
    onCamera,
    session,
    index: page.index,
    username: page.username,
    cfg,
    stream,
    worker,
    onState(state, d) {
      if (state === "ringing") replace(status, t("Ringing…"));
      else if (state === "connecting") replace(status, t("Connecting…"));
      else if (state === "connected") {
        audio.srcObject = call.remoteStream;
        camera.hidden = !videoAble;
        replace(status, t("Quantum-safe call"));
        timer.hidden = false;
        started = Date.now();
        tick = setInterval(() => replace(timer, mmss(Date.now() - started)), 1000);
      } else if (state === "ended") {
        worker.terminate();
        finish(endedLine(d.reason));
      } else if (state === "failed") {
        worker.terminate();
        finish(callRefusal(d.code, d));
      }
    },
  });
}

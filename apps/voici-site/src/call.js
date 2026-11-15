// "Call" (docs/voici-calls.md §7): shown beside "Send me a message" only while the verified page index says calls are
// on. The microphone is asked for on the tap, never on load. A visitor who isn't signed in to this page signs in
// first (the Messages sign-in). The call itself is flagship-web's startVoiciCall: WebRTC to the owner's phone only,
// every frame sealed again under the call's X-Wing keys.

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
  const mute = h(doc, "button", { class: "btn btn-secondary", type: "button", "aria-pressed": "false" }, t("Mute"));
  const hang = h(doc, "button", { class: "btn btn-danger", type: "button" }, icon(doc, "call"), h(doc, "span", {}, t("Hang up")));
  const why = h(doc, "details", { class: "alt-flow" }, h(doc, "summary", {}, t("Quantum-safe call")), h(doc, "p", { class: "fine" }, t("The call goes straight to their phone. Every sound is sealed with keys that a future quantum computer can't break, and Flagship can't hear it.")));
  const controls = h(doc, "div", { class: "call-controls" }, mute, hang);
  const sheet = openSheet(doc, { title: page.profile.displayName, onClose: () => call?.hangUp() });
  replace(sheet.body, status, timer, audio, controls, why);
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
  call = lib.startVoiciCall({
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

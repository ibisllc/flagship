// "Call" (docs/voici-calls.md §7): shown beside "Send me a message" only while the verified page index says calls are
// on. The microphone is asked for on the tap, never on load. A visitor who isn't signed in to this page signs in
// first (the Messages sign-in). The call itself is flagship-web's startVoiciCall: WebRTC to the owner's phone only,
// every frame sealed again under the call's X-Wing keys. Video is an upgrade of the audio call (voici-calls-v2.md §1.4):
// the call starts as audio, and the camera is asked for only when the visitor taps "Camera".
//
// The call screen (docs/voici-calls.md "Call screen", the same stage as the iOS and Android apps): a dark full-screen
// stage with the owner's photo or initial and name, the connecting steps and then the timer; one row of round
// buttons (Audio when the browser can pick an output, Mute, Camera, Flip while ours runs with two cameras) over a
// red End; in video their picture fills the stage and ours is a corner tile that moves to the corner it is dragged
// to (or with the arrow keys); a tap hides or shows the controls, a mouse move or a key shows them.

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "./i18n.js";
import { closeSheet, openSheet } from "./sheet.js";
import { openMessages } from "./messages.js";
import { avatarEl } from "./page.js";

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
    case "no-microphone":
      return t("No microphone found on this device. Connect one, or call from your phone.");
    case "unsupported":
      return t("This browser can't make quantum-safe calls. Try a current Chrome, Safari or Firefox.");
    case "unreachable":
      return t("The call couldn't connect. Check your connection and try again.");
    case "ring-back-required":
      return t("They take calls only from people they can call back. Choose \"Call and allow call-back\".");
    case "bad-pow":
      return t("The call couldn't start. Try again.");
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

/** m:ss, or h:mm:ss after an hour (the call timer). */
export function callElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** The corner nearest to (x, y) in a w × h stage: "tl", "tr", "bl" or "br". */
export function nearestCorner(x, y, w, h) {
  return (y < h / 2 ? "t" : "b") + (x < w / 2 ? "l" : "r");
}

/** The corner an arrow key moves the tile to from `corner` (or the same one). */
export function cornerAfterKey(corner, key) {
  const v = corner[0];
  const hz = corner[1];
  if (key === "ArrowUp") return "t" + hz;
  if (key === "ArrowDown") return "b" + hz;
  if (key === "ArrowLeft") return v + "l";
  if (key === "ArrowRight") return v + "r";
  return corner;
}

/** Their video counts as live this long after its last frame (or after it was announced, before the first one). */
export const REMOTE_STALL_MS = 1200;

/**
 * Whether their video is live: the room says their camera is on, the track is neither muted nor ended, and a frame
 * came within REMOTE_STALL_MS. Anything else shows the audio layout, never a black rectangle.
 */
export function remoteVideoLive({ room, trackLive, lastFrameAt, now }) {
  return room === "on" && trackLive && now - lastFrameAt <= REMOTE_STALL_MS;
}

/**
 * The stage's layout: "video" while their video is live (wide on a computer or in landscape), "self" when only our
 * camera is on (our tile over the audio layout), else "audio".
 */
export function callLayout(theirs, ours) {
  return theirs ? "video" : ours ? "self" : "audio";
}

/** One round control with its label under it (kind: "plain", "on", "end" or "answer"). */
function roundButton(doc, iconName, label, kind = "plain", on = {}) {
  const text = h(doc, "span", { class: "call-round-label" }, label);
  const disc = h(doc, "span", { class: "call-round-disc", "aria-hidden": "true" }, icon(doc, iconName));
  const el = h(doc, "button", { class: `call-round is-${kind}`, type: "button", on }, disc, text);
  return {
    el,
    set(iconName2, label2, kind2) {
      replace(disc, icon(doc, iconName2));
      replace(text, label2);
      el.className = `call-round is-${kind2}`;
    },
  };
}

/**
 * The full-screen stage both the call and the ringing screen use: a modal dialog that keeps focus inside it.
 * Returns {el, ui, close}.
 */
function openStage(ctx, labelledBy) {
  const { doc } = ctx;
  closeSheet();
  closeStage();
  const back = doc.activeElement;
  const ui = h(doc, "div", { class: "call-ui" });
  const el = h(doc, "div", { class: "call-stage", role: "dialog", "aria-modal": "true", "aria-labelledby": labelledBy, tabindex: "-1" }, ui);
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const all = [...el.querySelectorAll("button, [tabindex='0']")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    if (e.shiftKey && (doc.activeElement === first || doc.activeElement === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  el.addEventListener("keydown", onKey);
  doc.body.appendChild(el);
  doc.body.classList.add("has-call");
  const api = {
    el,
    ui,
    close() {
      if (stage !== api) return;
      stage = null;
      el.remove();
      doc.body.classList.remove("has-call");
      if (back && typeof back.focus === "function") back.focus();
    },
  };
  stage = api;
  el.focus();
  return api;
}

let stage = null;

function closeStage() {
  stage?.close();
}

/** The owner's photo or initial, large. */
function stageAvatar(ctx) {
  return h(ctx.doc, "div", { class: "call-avatar" }, avatarEl(ctx.doc, ctx.page.profile, ctx.page.avatarUrl));
}

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
  const mode = ctx.lib.pageCallMode(ctx.page.index);
  if (mode === "anyone" || mode === "callback") return showCallChoice(ctx, mode);
  const session = await ctx.lib.loadVoiciSession(ctx.store, ctx.page.index.pageId, { origin: ctx.cfg.origin });
  if (!session) return openMessages(ctx);
  startCall(ctx, session);
}

/**
 * The pop-up before a call on a page that takes calls from anyone or rings callers back (docs/voici-calls.md, owner
 * additions 2026-11-15): "Call anonymously" (no account, no ring-back) and "Call and allow call-back" (signed in; the
 * conversation's ring-back channel is attached first). A callback-only page shows only the second, with the reason.
 */
function showCallChoice(ctx, mode) {
  const { doc, lib, cfg, page } = ctx;
  const name = page.profile.displayName;
  const note = h(doc, "p", { class: "call-status", role: "status", hidden: true });
  const anon = h(doc, "button", { class: "btn btn-secondary btn-wide", type: "button" }, t("Call anonymously"));
  const allow = h(doc, "button", { class: "btn btn-primary btn-wide", type: "button" }, icon(doc, "call"), h(doc, "span", {}, t("Call and allow call-back")));
  const sheet = openSheet(doc, { title: t("Let {0} call you back?", name) });
  replace(
    sheet.body,
    mode === "callback" ? h(doc, "p", { class: "lede" }, t("{0} takes calls only from people they can call back.", name)) : null,
    h(doc, "p", { class: "fine" }, t("{0} won't learn who you are. Flagship will know this conversation can ring your phone.", name)),
    allow,
    mode === "anyone" ? anon : null,
    note,
  );
  anon.addEventListener("click", async () => {
    const key = await lib.anonKey(ctx.store, page.index.pageId);
    closeSheet();
    startCall(ctx, null, { anonymous: key });
  });
  allow.addEventListener("click", async () => {
    const session = await lib.loadVoiciSession(ctx.store, page.index.pageId, { origin: cfg.origin });
    if (!session) {
      closeSheet();
      return openMessages(ctx);
    }
    allow.disabled = true;
    const r = await lib.postRingBack(session, "attach", { apiBase: cfg.apiBase, store: ctx.store });
    allow.disabled = false;
    if (!r.ok) {
      note.hidden = false;
      return replace(note, callRefusal(r.code));
    }
    closeSheet();
    watchRings(ctx, session);
    startCall(ctx, session);
  });
}

let watching = null;

/**
 * While this tab is open and the conversation allows call-back, it rings when the page owner calls back: the ring
 * shows in the thread fetch, its hint opens with this browser's thread key, and answering dials out to the owner.
 */
export function watchRings(ctx, session) {
  if (watching === session.pageId) return;
  watching = session.pageId;
  const seen = new Set();
  const tick = async () => {
    if (watching !== session.pageId) return;
    if (ctx.doc.visibilityState !== "hidden") {
      const r = await ctx.lib.fetchThread(session, { apiBase: ctx.cfg.apiBase });
      const ring = r.ok ? ctx.lib.ringOf(r) : null;
      if (ring && !seen.has(ring.ringId)) {
        seen.add(ring.ringId);
        showIncomingRing(ctx, session, ring);
      }
    }
    ctx.win.setTimeout(tick, 10_000);
  };
  tick();
}

/** Stops watching (after "Stop call-backs"). */
export function stopWatchingRings() {
  watching = null;
}

export function showIncomingRing(ctx, session, ring) {
  const { doc, lib, page } = ctx;
  const conv = lib.protocol.voiciConv(session.pageId, session.pseudonymPub);
  const hint = lib.openVoiciRingHint(lib.threadSeedOf(session), conv, ring.ringId, ring.hint);
  if (!hint || hint.pageId !== page.index.pageId) return;
  const st = openStage(ctx, "call-stage-name");
  const decline = roundButton(doc, "callEnd", t("Decline"), "end", { click: () => st.close() });
  const answer = roundButton(doc, "call", t("Answer"), "answer", { click: () => (st.close(), startCall(ctx, session)) });
  replace(
    st.ui,
    h(
      doc,
      "div",
      { class: "call-head" },
      stageAvatar(ctx),
      h(doc, "h2", { class: "call-name", id: "call-stage-name" }, page.profile.displayName),
      h(doc, "p", { class: "call-status", role: "status" }, t("{0} is calling you back.", page.profile.displayName)),
      h(doc, "p", { class: "call-e2e" }, icon(doc, "lock"), h(doc, "span", {}, t("End-to-end encrypted · quantum-safe"))),
    ),
    h(doc, "div", { class: "call-spacer" }),
    h(doc, "div", { class: "call-bottom" }, h(doc, "div", { class: "call-row call-row-ring" }, decline.el, answer.el)),
  );
  answer.el.focus();
}

/** The status line for one connecting step (flagship-web VOICI_CALL_STEPS, in the order they happen). */
function connectStepLine(step) {
  switch (step) {
    case "secure":
      return t("Securing the line (quantum-safe)…");
    case "reach":
      return t("Reaching their phone…");
    case "path":
      return t("Opening a direct path…");
    case "audio":
      return t("Starting audio…");
    default:
      return t("Connecting…");
  }
}

async function startCall(ctx, session, opts = {}) {
  const { doc, win, lib, cfg, page } = ctx;
  const name = page.profile.displayName;
  let call = null;
  const st = openStage(ctx, "call-stage-name");
  const stageEl = st.el;
  const status = h(doc, "p", { class: "call-status", role: "status" }, t("Calling {0}…", name));
  const slowNote = h(doc, "p", { class: "call-note", hidden: true }, t("This is taking longer than usual"));
  const timer = h(doc, "p", { class: "call-timer", role: "timer", hidden: true }, "0:00");
  const e2e = h(doc, "p", { class: "call-e2e" }, icon(doc, "lock"), h(doc, "span", {}, t("End-to-end encrypted · quantum-safe")));
  const paused = h(doc, "p", { class: "call-note", hidden: true }, t("Camera paused"));
  const head = h(doc, "div", { class: "call-head" }, stageAvatar(ctx), h(doc, "h2", { class: "call-name", id: "call-stage-name" }, name), status, timer, slowNote, e2e, paused);
  const audio = h(doc, "audio", { autoplay: true });
  const remoteVideo = h(doc, "video", { class: "call-remote", autoplay: true, playsinline: true, muted: true, hidden: true, "aria-label": t("Their camera") });
  const selfView = h(doc, "video", { class: "call-self at-br", autoplay: true, playsinline: true, muted: true, hidden: true, tabindex: "0", "aria-label": t("Your camera") });
  const notice = h(doc, "p", { class: "call-notice", role: "status", hidden: true });
  const shade = h(doc, "div", { class: "call-shade", "aria-hidden": "true" });
  let muted = false;
  let cameraOn = false;
  let cameras = 0;
  const mute = roundButton(doc, "mic", t("Mute"), "plain", {
    click: () => {
      muted = !muted;
      call?.setMuted(muted);
      mute.set(muted ? "micOff" : "mic", muted ? t("Unmute") : t("Mute"), muted ? "on" : "plain");
    },
  });
  const camera = roundButton(doc, "videoOff", t("Camera"), "plain", { click: () => toggleCamera() });
  const flip = roundButton(doc, "flip", t("Flip"), "plain", { click: () => flipCamera() });
  const end = roundButton(doc, "callEnd", t("End"), "end", { click: () => (call ? call.hangUp() : st.close()) });
  camera.el.hidden = true;
  flip.el.hidden = true;
  // Full screen and picture in picture: on a computer-sized screen, while their video shows, where the browser can.
  const canFull = typeof stageEl.requestFullscreen === "function" && doc.fullscreenEnabled !== false;
  const canPip = doc.pictureInPictureEnabled === true && typeof remoteVideo.requestPictureInPicture === "function";
  const full = roundButton(doc, "expand", t("Full screen"), "plain", {
    click: () => {
      if (doc.fullscreenElement) doc.exitFullscreen?.()?.catch?.(() => {});
      else stageEl.requestFullscreen?.()?.catch?.(() => {});
    },
  });
  const pip = roundButton(doc, "pip", t("Picture in picture"), "plain", {
    click: () => {
      if (doc.pictureInPictureElement) doc.exitPictureInPicture?.()?.catch?.(() => {});
      else remoteVideo.requestPictureInPicture?.()?.catch?.(() => {});
    },
  });
  for (const b of [full, pip]) {
    b.el.setAttribute("data-wide", "");
    b.el.hidden = true;
  }
  stageEl.addEventListener("fullscreenchange", () => {
    const on = doc.fullscreenElement === stageEl;
    full.set(on ? "contract" : "expand", on ? t("Exit full screen") : t("Full screen"), on ? "on" : "plain");
  });
  const route = audioRouteButton(ctx, audio);
  const row = h(doc, "div", { class: "call-row" }, route?.el ?? null, mute.el, camera.el, flip.el, full.el, pip.el);
  const bottom = h(doc, "div", { class: "call-bottom" }, row, h(doc, "div", { class: "call-end-row" }, end.el));
  const why = h(doc, "details", { class: "call-why" }, h(doc, "summary", {}, t("Quantum-safe call")), h(doc, "p", {}, t("The call goes straight to their phone. Every sound is sealed with keys that a future quantum computer can't break, and Flagship can't hear it.")));
  replace(st.ui, head, h(doc, "div", { class: "call-spacer" }), why, bottom);
  stageEl.insertBefore(shade, st.ui);
  stageEl.insertBefore(remoteVideo, shade);
  stageEl.append(selfView, notice, audio);
  if (route) stageEl.append(route.menu);

  // ── the video layout: their picture fills, ours is a corner tile; a tap hides the controls ──
  // Our tile keeps one corner while their video shows and another while only ours runs: low on the right by
  // default, so it never covers the name and status of the audio layout.
  const corners = { video: "tr", self: "br" };
  let corner = corners.self;
  let hideTimer = null;
  // Their video is "live" (has-remote) only while remoteVideoLive says so; the element keeps decoding underneath
  // (transparent, not display:none) so the frame watch can see it come back.
  const videoMode = () => stageEl.classList.contains("has-remote");
  const applyCorner = () => {
    const c = corners[videoMode() ? "video" : "self"];
    if (c === corner) return;
    selfView.classList.remove("at-" + corner);
    corner = c;
    selfView.classList.add("at-" + corner);
  };
  const layout = () => {
    applyCorner();
    const mode = callLayout(videoMode(), cameraOn);
    stageEl.classList.toggle("is-video", mode === "video");
    stageEl.classList.toggle("has-self", cameraOn);
    full.el.hidden = mode !== "video" || !canFull;
    pip.el.hidden = mode !== "video" || !canPip;
    if (mode !== "video") {
      showControls();
      if (doc.fullscreenElement === stageEl) doc.exitFullscreen?.()?.catch?.(() => {});
      if (doc.pictureInPictureElement === remoteVideo) doc.exitPictureInPicture?.()?.catch?.(() => {});
    } else hideLater();
  };
  let roomCamera = "off";
  let trackLive = true;
  let lastFrame = 0;
  let lastTime = -1;
  let watch = null;
  let watched = null;
  const refreshRemote = () => {
    const live = remoteVideoLive({ room: roomCamera, trackLive, lastFrameAt: lastFrame, now: Date.now() });
    if (live === videoMode()) return;
    stageEl.classList.toggle("has-remote", live);
    layout();
  };
  const onFrame = () => {
    lastFrame = Date.now();
    refreshRemote();
    if (roomCamera === "on") remoteVideo.requestVideoFrameCallback(onFrame);
  };
  const watchTrack = () => {
    const track = call?.remoteStream?.getVideoTracks?.()[0] ?? null;
    if (!track || track === watched) return;
    watched = track;
    trackLive = !track.muted && track.readyState !== "ended";
    track.addEventListener?.("mute", () => {
      trackLive = false;
      refreshRemote();
    });
    track.addEventListener?.("unmute", () => {
      trackLive = true;
      lastFrame = Date.now();
      refreshRemote();
    });
    track.addEventListener?.("ended", () => {
      trackLive = false;
      refreshRemote();
    });
  };
  const startWatch = () => {
    if (watch !== null) return;
    if (typeof remoteVideo.requestVideoFrameCallback === "function") remoteVideo.requestVideoFrameCallback(onFrame);
    // Every half second: the stall check, and the frame check where requestVideoFrameCallback is missing (Firefox).
    watch = win.setInterval(() => {
      const time = remoteVideo.currentTime;
      if (typeof remoteVideo.requestVideoFrameCallback !== "function" && typeof time === "number" && time !== lastTime) {
        lastTime = time;
        lastFrame = Date.now();
      }
      refreshRemote();
    }, 500);
  };
  const stopWatch = () => {
    win.clearInterval(watch);
    watch = null;
  };
  const showControls = () => {
    stageEl.classList.remove("controls-hidden");
    win.clearTimeout(hideTimer);
  };
  const hideLater = () => {
    win.clearTimeout(hideTimer);
    hideTimer = win.setTimeout(() => {
      if (videoMode() && !st.ui.contains(doc.activeElement) && !stageEl.classList.contains("is-over")) stageEl.classList.add("controls-hidden");
    }, 4000);
  };
  stageEl.addEventListener("click", (e) => {
    if (!videoMode() || stageEl.classList.contains("is-over")) return;
    if (e.target.closest("button, summary, details, .call-self, .call-menu")) return;
    if (stageEl.classList.toggle("controls-hidden")) win.clearTimeout(hideTimer);
  });
  stageEl.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || !videoMode()) return;
    showControls();
    hideLater();
  });
  stageEl.addEventListener("keydown", (e) => {
    if (e.target === selfView) return;
    showControls();
  });
  stageEl.addEventListener("focusin", () => showControls());
  const moveTile = (c) => {
    corners[videoMode() ? "video" : "self"] = c;
    applyCorner();
  };
  let dragging = null;
  selfView.addEventListener("pointerdown", (e) => {
    dragging = e.pointerId;
    selfView.setPointerCapture?.(e.pointerId);
    selfView.classList.add("is-dragging");
    e.preventDefault();
  });
  selfView.addEventListener("pointermove", (e) => {
    if (dragging !== e.pointerId) return;
    const r = stageEl.getBoundingClientRect();
    const c = nearestCorner(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (c !== corner) moveTile(c);
  });
  const drop = (e) => {
    if (dragging !== e.pointerId) return;
    dragging = null;
    selfView.classList.remove("is-dragging");
  };
  selfView.addEventListener("pointerup", drop);
  selfView.addEventListener("pointercancel", drop);
  selfView.addEventListener("keydown", (e) => {
    const c = cornerAfterKey(corner, e.key);
    if (c === corner) return;
    e.preventDefault();
    moveTile(c);
  });

  const say = (line) => {
    notice.hidden = !line;
    if (line) replace(notice, line);
  };
  const showSelf = () => {
    selfView.hidden = !cameraOn;
    selfView.classList.toggle("is-mirrored", call?.cameraFacing !== "environment");
    selfView.srcObject = cameraOn && call?.cameraTrack ? new win.MediaStream([call.cameraTrack]) : null;
    camera.set(cameraOn ? "video" : "videoOff", cameraOn ? t("Camera off") : t("Camera"), cameraOn ? "on" : "plain");
    flip.el.hidden = !cameraOn || cameras < 2;
    layout();
  };
  const toggleCamera = async () => {
    if (!call) return;
    const want = !cameraOn;
    say(null);
    const ok = await call.setCamera(want, (c) => win.navigator.mediaDevices.getUserMedia(c));
    if (!ok) {
      if (want) say(callRefusal("camera"));
      return;
    }
    cameraOn = want;
    if (cameraOn) cameras = await lib.voiciCallCameraCount(win.navigator.mediaDevices);
    showSelf();
  };
  const flipCamera = async () => {
    if (!call || !cameraOn) return;
    await call.flipCamera((c) => win.navigator.mediaDevices.getUserMedia(c));
    cameraOn = !!call.cameraTrack;
    showSelf();
  };
  const onCamera = (s) => {
    roomCamera = s;
    paused.hidden = s !== "paused";
    remoteVideo.hidden = s !== "on";
    if (s === "on") {
      remoteVideo.srcObject = call?.remoteStream ?? null;
      // A grace period until the first frame: shown at once if the track already flows, hidden again if nothing comes.
      lastFrame = Date.now();
      watchTrack();
      startWatch();
    } else stopWatch();
    refreshRemote();
  };

  let started = 0;
  let tick = null;
  const finish = (line) => {
    win.clearInterval(tick);
    win.clearTimeout(hideTimer);
    stopWatch();
    roomCamera = "off";
    if (doc.fullscreenElement === stageEl) doc.exitFullscreen?.()?.catch?.(() => {});
    if (doc.pictureInPictureElement) doc.exitPictureInPicture?.()?.catch?.(() => {});
    full.el.hidden = true;
    pip.el.hidden = true;
    stageEl.classList.add("is-over");
    stageEl.classList.remove("controls-hidden", "is-video", "has-remote", "has-self");
    remoteVideo.hidden = true;
    selfView.hidden = true;
    selfView.srcObject = null;
    route?.close();
    timer.hidden = true;
    slowNote.hidden = true;
    paused.hidden = true;
    status.classList.remove("call-sr");
    replace(status, line);
    const close = roundButton(doc, "close", t("Close"), "plain", { click: () => st.close() });
    const again = roundButton(doc, "call", t("Call again"), "answer", { click: () => startCall(ctx, session, opts) });
    replace(bottom, h(doc, "div", { class: "call-row call-row-ring" }, close.el, again.el));
    again.el.focus();
  };

  let stream;
  try {
    stream = await win.navigator.mediaDevices.getUserMedia(lib.VOICI_CALL_AUDIO);
  } catch (e) {
    const missing = e && (e.name === "NotFoundError" || e.name === "OverconstrainedError" || e.name === "DevicesNotFoundError");
    return finish(callRefusal(missing ? "no-microphone" : "microphone"));
  }
  let worker;
  try {
    worker = new win.Worker(new URL("./flagship-web/callWorker.js", import.meta.url), { type: "module" });
  } catch {
    for (const tr of stream.getTracks()) tr.stop();
    return finish(callRefusal("unsupported"));
  }
  // Output names are readable once the microphone is allowed.
  route?.refresh();
  const videoAble = await lib.voiciCallVideoAble(win.navigator.mediaDevices);
  call = lib.startVoiciCall({
    videoAble,
    onCamera,
    session,
    ...(opts.anonymous ? { anonymous: opts.anonymous } : {}),
    index: page.index,
    username: page.username,
    cfg,
    stream,
    worker,
    onState(state, d) {
      if (state === "working") replace(status, t("Getting ready to call…"));
      else if (state === "ringing") replace(status, t("Ringing…"));
      else if (state === "connecting") {
        replace(status, connectStepLine(d.step));
        slowNote.hidden = !d.slow;
      } else if (state === "connected") {
        slowNote.hidden = true;
        audio.srcObject = call.remoteStream;
        camera.el.hidden = !videoAble;
        // The timer takes the status line's place; screen readers hear "Quantum-safe call" once, not every second.
        replace(status, t("Quantum-safe call"));
        status.classList.add("call-sr");
        timer.hidden = false;
        started = Date.now();
        tick = win.setInterval(() => replace(timer, callElapsed(Date.now() - started)), 1000);
      } else if (state === "ended") {
        worker.terminate();
        finish(endedLine(d.reason));
      } else if (state === "failed") {
        worker.terminate();
        finish(callRefusal(d.code, d));
      }
    },
  });
  if (stage !== st) call.hangUp();
}

/**
 * Audio (where the call's sound plays), only where the browser can choose: selectAudioOutput (the browser's own
 * picker) or setSinkId with a menu of this device's outputs. Null otherwise: no button.
 */
function audioRouteButton(ctx, audio) {
  const { doc, win } = ctx;
  const md = win.navigator.mediaDevices;
  if (typeof audio.setSinkId !== "function") return null;
  const picker = typeof md?.selectAudioOutput === "function";
  let outputs = [];
  let current = "default";
  const menu = h(doc, "div", { class: "call-menu", role: "menu", "aria-label": t("Audio"), hidden: true });
  const close = () => {
    menu.hidden = true;
    btn.el.setAttribute("aria-expanded", "false");
  };
  const choose = async (id) => {
    close();
    try {
      await audio.setSinkId(id);
      current = id;
    } catch {
      /* the output went away: the sound stays where it was */
    }
    btn.el.focus();
  };
  const open = () => {
    const items = outputs.map((d, i) =>
      h(doc, "button", { class: "call-menu-item", type: "button", role: "menuitemradio", "aria-checked": String(d.deviceId === current), tabindex: "-1", on: { click: () => choose(d.deviceId) } }, d.label || t("Audio output {0}", i + 1)),
    );
    replace(menu, items);
    menu.hidden = false;
    btn.el.setAttribute("aria-expanded", "true");
    (items.find((x) => x.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  };
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".call-menu-item")];
    const i = items.indexOf(doc.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.el.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === "Tab") close();
  });
  const btn = roundButton(doc, "speaker", t("Audio"), "plain", {
    click: async () => {
      if (picker) {
        try {
          const d = await md.selectAudioOutput();
          await audio.setSinkId(d.deviceId);
          current = d.deviceId;
        } catch {
          /* dismissed, or not allowed */
        }
        return;
      }
      if (menu.hidden) open();
      else close();
    },
  });
  if (!picker) {
    btn.el.setAttribute("aria-haspopup", "menu");
    btn.el.setAttribute("aria-expanded", "false");
    btn.el.hidden = true;
  }
  return {
    el: btn.el,
    menu,
    close,
    async refresh() {
      if (picker) return;
      try {
        outputs = (await md.enumerateDevices()).filter((d) => d.kind === "audiooutput");
      } catch {
        outputs = [];
      }
      btn.el.hidden = outputs.length < 2;
    },
  };
}

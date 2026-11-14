// The pairing page: shows the QR the owner's phone scans, the 6-digit code to compare, and redeems the phone's ticket.
import { CONTROL_APEX, SITE_ORIGINS } from "../lib/config.js";
import { t, localize } from "../lib/i18n.js";
import { encodeQr } from "../lib/qrEncoder.js";
import {
  aeadOpen, deriveMaterial, freshKeypair, freshSid, initialState, next, pairingUrl, parsePairPayload, parseRedeemReply,
} from "../lib/pairing.js";
import { updateBox } from "../lib/store.js";

const $ = (id) => document.getElementById(id);
let state = initialState();
let socket = null;

const STATUS = {
  connecting: "pairConnecting",
  waiting: "pairWaiting",
  matching: "pairMatching",
  redeeming: "pairRedeeming",
  paired: "pairDone",
  expired: "pairExpired",
};
const FAILURE = {
  unreachable: "pairUnreachable",
  "relay-closed": "pairRelayClosed",
  "remote-ticket": "pairWrongKind",
  "not-extension-session": "pairWrongKind",
  unreadable: "pairUnreadable",
  "bad-ticket": "pairUnreadable",
  "bad-account": "pairUnreadable",
  "bad-key": "pairUnreadable",
  "bad-server": "pairBadServer",
  "redeem-failed": "pairRedeemFailed",
};

function qrSvg(text) {
  const m = encodeQr(text, "M");
  const n = m.length + 4;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("pairQrLabel"));
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (m[y][x] !== 1) continue;
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", String(x + 2));
      r.setAttribute("y", String(y + 2));
      r.setAttribute("width", "1");
      r.setAttribute("height", "1");
      r.setAttribute("fill", "#000");
      svg.append(r);
    }
  }
  return svg;
}

function render() {
  const s = state;
  const status = $("status");
  if (s.phase === "failed") {
    status.textContent = t(FAILURE[s.reason] ?? "pairFailed");
    status.className = "bad";
  } else if (s.phase === "paired") {
    status.textContent = t("pairDone", s.server);
    status.className = "ok";
  } else if (s.phase === "redeeming") {
    status.textContent = t("pairRedeeming", s.server);
    status.className = "";
  } else {
    status.textContent = STATUS[s.phase] ? t(STATUS[s.phase]) : "";
    status.className = "";
  }
  const qr = $("qr");
  const showQr = s.phase === "waiting" || s.phase === "matching";
  qr.classList.toggle("hidden", !showQr || s.phase === "matching");
  if (showQr && s.url && qr.dataset.url !== s.url) {
    qr.replaceChildren(qrSvg(s.url));
    qr.dataset.url = s.url;
  }
  $("code").classList.toggle("hidden", s.phase !== "matching");
  $("code-hint").classList.toggle("hidden", s.phase !== "matching");
  if (s.phase === "matching") $("code").textContent = s.code;
  $("again").classList.toggle("hidden", !(s.phase === "failed" || s.phase === "expired" || s.phase === "paired"));
}

function dispatch(event) {
  state = next(state, event);
  render();
}

async function redeem(payload) {
  let res;
  try {
    res = await fetch(`${payload.podBaseUrl}/api/companion/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: payload.ticketId, ticketSecret: payload.ticketSecret }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return dispatch({ type: "redeemed", ok: false, error: "redeem-failed" });
  }
  const body = res.ok ? await res.json().catch(() => null) : null;
  const reply = parseRedeemReply(body, payload, Date.now());
  if (!reply.ok) return dispatch({ type: "redeemed", ok: false, error: reply.error });
  await updateBox(payload.serverDomain, () => reply.box);
  dispatch({ type: "redeemed", ok: true });
  void browser.runtime.sendMessage({ type: "refresh", serverDomain: payload.serverDomain }).catch(() => {});
}

async function start() {
  try { socket?.close(); } catch { /* ignore */ }
  dispatch({ type: "start" });
  const sid = freshSid();
  const { sk, pkB64u } = await freshKeypair();
  const ws = new WebSocket(`wss://${CONTROL_APEX}/qr-pipe/${encodeURIComponent(sid)}?role=browser`);
  socket = ws;
  let key = null;
  let accepted = false;
  ws.addEventListener("open", () => dispatch({ type: "opened", url: pairingUrl({ sid, pkB64u }) }));
  ws.addEventListener("message", async (ev) => {
    if (ws !== socket) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m?.kind === "accepted") accepted = true;
    else if (m?.kind === "peer-hello") {
      try {
        const mat = await deriveMaterial(sk, m.phonePk);
        key = mat.key;
        dispatch({ type: "peer-hello", code: mat.code });
      } catch { /* a malformed hello: wait for a real phone */ }
    } else if (m?.kind === "peer-deliver" && key) {
      let parsed;
      try {
        parsed = parsePairPayload(await aeadOpen(key, m.ciphertext, m.nonce));
      } catch {
        parsed = { ok: false, error: "unreadable" };
      }
      socket = null;
      try { ws.close(1000, "done"); } catch { /* ignore */ }
      dispatch(parsed.ok ? { type: "delivered", ok: true, payload: parsed.payload } : { type: "delivered", ok: false, error: parsed.error });
      if (parsed.ok) await redeem(parsed.payload);
    } else if (m?.kind === "rebind" || m?.kind === "expired") {
      dispatch({ type: "expired" });
    } else if (m?.kind === "error") {
      dispatch({ type: "closed", accepted: true });
    }
  });
  ws.addEventListener("close", () => {
    if (ws === socket) dispatch({ type: "closed", accepted });
  });
}

// Without the site permission the box's redeem answer is unreadable (no CORS) and the pin check never runs.
async function begin() {
  const allowed = await browser.permissions.contains({ origins: SITE_ORIGINS });
  $("perm").classList.toggle("hidden", allowed);
  $("pairing").classList.toggle("hidden", !allowed);
  if (allowed) void start();
}

document.addEventListener("DOMContentLoaded", () => {
  localize();
  $("again").addEventListener("click", () => void start());
  $("grant").addEventListener("click", async () => {
    await browser.permissions.request({ origins: SITE_ORIGINS }).catch(() => false);
    await begin();
  });
  void begin();
});

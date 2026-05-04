// Flagship webapp — UI orchestration on top of keystore.js + qrScanner.js.
//
// State machine:
//   no UMK in IDB                 → bootstrap view
//   wrapped UMK present, no seed   → unlock view
//   unwrapped seed in memory       → home view (identity + servers)
//   user starts pairing            → pair view (camera or paste)
//
// Sensitive material (UMK seed, IRK private key, scanned session id)
// lives only in this module's closure — never on `window`, never logged.

import {
  bootstrapNewIdentity,
  unlockUmk,
  hasWrappedUmk,
  resetDevice,
  deriveIrkFromSeed,
  signWithIrk,
  generateEphemeralPub,
  bytesToHex,
  hexToBytes,
} from "/webapp/keystore.js";
import { hasBarcodeDetector, parseQrPayload, scanWithCamera } from "/webapp/qrScanner.js";

const $ = (id) => document.getElementById(id);
const setSubtitle = (s) => ($("subtitle").textContent = s);

const VIEWS = ["view-bootstrap", "view-unlock", "view-home", "view-pair"];
function show(view) {
  for (const v of VIEWS) $(v).classList.toggle("hidden", v !== view);
}

let toastTimer = null;
function toast(text, kind) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden", "err");
  if (kind === "err") el.classList.add("err");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

/* ---------- session-scoped derived state ---------- */

const session = {
  umk: null,
  irk: null,
  username: null,
};

async function unlock(seed, username) {
  session.umk = seed;
  session.irk = await deriveIrkFromSeed(seed);
  session.username = username ?? localStorage.getItem("flagship.username") ?? "";
  await renderHome();
  show("view-home");
}

function lock() {
  session.umk = null;
  session.irk = null;
  session.username = null;
}

/* ---------- views ---------- */

async function renderHome() {
  setSubtitle(session.username ? `signed in as ${session.username}` : "signed in");
  $("home-username").textContent = session.username || "(not set)";
  $("home-irkpub").textContent = session.irk
    ? bytesToHex(session.irk.publicKey).slice(0, 16) + "…" + bytesToHex(session.irk.publicKey).slice(-4)
    : "—";

  const sid = localStorage.getItem("flagship.sessionId");
  const sessionStatusEl = $("session-status");
  const list = $("servers-list");
  list.innerHTML = "";
  if (!sid) {
    sessionStatusEl.textContent = "unpaired";
    sessionStatusEl.classList.remove("ok");
    list.innerHTML = '<div class="card"><p style="margin:0;color:var(--fg-mute);font-size:0.9rem;">No paired session yet. Tap "Pair to a server" to start.</p></div>';
    return;
  }
  try {
    const r = await fetch(`/api/me/servers?sessionId=${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = await r.json();
    sessionStatusEl.textContent = "paired";
    sessionStatusEl.classList.add("ok");
    if (!body.servers.length) {
      list.innerHTML = '<div class="card"><p style="margin:0;color:var(--fg-mute);font-size:0.9rem;">No servers registered yet.</p></div>';
      return;
    }
    for (const s of body.servers) {
      const card = document.createElement("div");
      card.className = "card";
      const status = s.revoked
        ? `<span class="pill err">revoked: ${escapeHtml(s.revoked.reason)}</span>`
        : '<span class="pill ok">active</span>';
      card.innerHTML = `<div class="row"><span class="value">${escapeHtml(s.serverId)}</span>${status}</div>`;
      list.appendChild(card);
    }
  } catch (e) {
    sessionStatusEl.textContent = "error";
    list.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(String(e))}</p></div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ---------- pairing flow ---------- */

async function startCameraScan() {
  const video = $("pair-video");
  const status = $("pair-status");
  if (!hasBarcodeDetector()) {
    status.textContent = "this browser can't open the camera scanner — paste below";
    return;
  }
  try {
    status.textContent = "starting camera…";
    const text = await scanWithCamera(video, { timeoutMs: 60_000 });
    status.textContent = "QR found, confirming…";
    await confirmPairing(text);
  } catch (e) {
    status.textContent = `camera failed: ${e.message}`;
  }
}

async function ensureUsername() {
  if (session.username) return session.username;
  const handle = prompt(
    "Pick a username (DNS-safe label, will appear at <name>.flagship.services):",
    "",
  );
  if (!handle || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(handle)) {
    throw new Error("invalid username");
  }
  localStorage.setItem("flagship.username", handle);
  session.username = handle;
  return handle;
}

async function confirmPairing(qrText) {
  if (!session.umk) {
    toast("unlock first", "err");
    return;
  }
  let parsed;
  try {
    parsed = parseQrPayload(qrText);
  } catch (e) {
    toast(`invalid QR: ${e.message}`, "err");
    return;
  }
  let username;
  try {
    username = await ensureUsername();
  } catch (e) {
    toast(e.message, "err");
    return;
  }

  const phonePub = await generateEphemeralPub();
  const issuedAt = Date.now();

  // Pairing claim shape mirrors @flagship/protocol's canonicalRebuild —
  // see /api/desktop/pair/confirm in apps/web/src/routes/desktopPair.ts.
  const canonical = canonicalPairingClaim({
    userId: username,
    newServerId: `desktop-pair:${parsed.sessionId}`,
    wifiSsid: parsed.desktopPubKeyHex,
    wifiPskHashHex: bytesToHex(phonePub),
    shareRatio: 0,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);

  try {
    const r = await fetch("/api/desktop/pair/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: parsed.sessionId,
        userId: username,
        phonePubKey: bytesToHex(phonePub),
        irkSignature: bytesToHex(sig),
        issuedAt,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`status ${r.status}: ${body}`);
    }
    localStorage.setItem("flagship.sessionId", parsed.sessionId);
    toast("paired");
    await renderHome();
    show("view-home");
  } catch (e) {
    toast(`pair failed: ${e.message}`, "err");
  }
}

function canonicalPairingClaim(c) {
  return new TextEncoder().encode(
    [
      "flagship/rebuild/v1",
      c.userId,
      c.newServerId,
      c.wifiSsid,
      c.wifiPskHashHex,
      c.shareRatio,
      c.issuedAt,
    ].join("|"),
  );
}

/* ---------- handlers ---------- */

async function handleBootstrap() {
  const a = $("bootstrap-passphrase").value;
  const b = $("bootstrap-passphrase-2").value;
  if (a !== b) return toast("passphrases don't match", "err");
  if (a.length < 8) return toast("passphrase must be 8+ chars", "err");
  try {
    const seed = await bootstrapNewIdentity(a);
    await unlock(seed);
    toast("device key generated");
  } catch (e) {
    toast(String(e), "err");
  }
}

async function handleUnlock() {
  const a = $("unlock-passphrase").value;
  try {
    const seed = await unlockUmk(a);
    await unlock(seed);
    toast("unlocked");
  } catch {
    toast("wrong passphrase", "err");
  }
}

async function handlePairToServer() {
  if (!session.irk) return toast("unlock first", "err");
  show("view-pair");
  // Kick off the camera scan in the background; the paste-fallback works in parallel.
  startCameraScan();
}

async function handlePastePair() {
  const text = $("pair-paste").value.trim();
  if (!text) return toast("paste a QR payload first", "err");
  await confirmPairing(text);
}

async function handleReset() {
  if (!confirm("Reset removes this device's local key. Continue?")) return;
  await resetDevice();
  localStorage.removeItem("flagship.sessionId");
  localStorage.removeItem("flagship.username");
  lock();
  setSubtitle("device reset");
  show("view-bootstrap");
}

/* ---------- boot ---------- */

async function boot() {
  $("bootstrap-go").addEventListener("click", handleBootstrap);
  $("unlock-go").addEventListener("click", handleUnlock);
  $("pair-with-server").addEventListener("click", handlePairToServer);
  $("pair-paste-go").addEventListener("click", handlePastePair);
  $("reset-device").addEventListener("click", handleReset);
  $("pair-cancel").addEventListener("click", () => show("view-home"));

  if (await hasWrappedUmk()) {
    setSubtitle("locked");
    show("view-unlock");
  } else {
    setSubtitle("first run");
    show("view-bootstrap");
  }
}

// Avoid unused-import lint warnings for the helper we only use indirectly.
void hexToBytes;

boot().catch((e) => {
  setSubtitle("startup failed");
  toast(String(e), "err");
});

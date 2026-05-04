// Flagship webapp — UI orchestration on top of keystore.js.
//
// State machine:
//   no UMK in IDB → bootstrap view
//   wrapped UMK present, no in-memory seed → unlock view
//   unwrapped seed in memory → home view (identity + servers)
//
// Sensitive material (the unwrapped UMK seed, IRK private key) lives only
// in this module's closure — never on `window`, never serialized.

import {
  bootstrapNewIdentity,
  unlockUmk,
  hasWrappedUmk,
  resetDevice,
  deriveIrkFromSeed,
  bytesToHex,
} from "/webapp/keystore.js";

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
  umk: null, // unwrapped seed
  irk: null, // { privateKey, publicKey }
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

  // Try /api/me/servers if we have a recent paired session id stored.
  const sid = localStorage.getItem("flagship.sessionId");
  const sessionStatusEl = $("session-status");
  const list = $("servers-list");
  list.innerHTML = "";
  if (!sid) {
    sessionStatusEl.textContent = "unpaired";
    sessionStatusEl.classList.remove("ok");
    list.innerHTML =
      '<div class="card"><p style="margin:0;color:var(--fg-mute);font-size:0.9rem;">No paired session yet. Tap "Pair to a server" to start.</p></div>';
    return;
  }
  try {
    const r = await fetch(`/api/me/servers?sessionId=${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = await r.json();
    sessionStatusEl.textContent = "paired";
    sessionStatusEl.classList.add("ok");
    if (!body.servers.length) {
      list.innerHTML =
        '<div class="card"><p style="margin:0;color:var(--fg-mute);font-size:0.9rem;">No servers registered yet.</p></div>';
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
  const handle = prompt("Username (DNS-safe label):", session.username || "");
  if (!handle) return;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(handle)) {
    return toast("invalid username", "err");
  }
  localStorage.setItem("flagship.username", handle);
  session.username = handle;
  await renderHome();
  toast("identity ready — server pairing flow ships next");
}

async function handleReset() {
  if (!confirm("Reset removes this device's local key. Continue?")) return;
  await resetDevice();
  lock();
  setSubtitle("device reset");
  show("view-bootstrap");
}

/* ---------- boot ---------- */

async function boot() {
  $("bootstrap-go").addEventListener("click", handleBootstrap);
  $("unlock-go").addEventListener("click", handleUnlock);
  $("pair-with-server").addEventListener("click", handlePairToServer);
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

boot().catch((e) => {
  setSubtitle("startup failed");
  toast(String(e), "err");
});

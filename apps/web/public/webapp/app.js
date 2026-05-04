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
} from "./keystore.js";
import { hasBarcodeDetector, parseQrPayload, scanWithCamera } from "./qrScanner.js";
import {
  loadProviders,
  addProvider,
  removeProvider,
  setActive,
  PROMO_ID,
} from "./providers.js";

const $ = (id) => document.getElementById(id);
const setSubtitle = (s) => ($("subtitle").textContent = s);

const VIEWS = ["view-bootstrap", "view-unlock", "view-home", "view-pair", "view-settings"];
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
  await renderActiveProviderChip();
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

/* ---------- providers (promo + BYOK) ---------- */

function maskKey(k) {
  if (!k) return "";
  if (k.length < 12) return "••••";
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

function renderQuotaMeter(quota) {
  const lifeFrac = Math.min(1, quota.lifetimeUsed / Math.max(1, quota.lifetimeTotal));
  const winFrac = Math.min(1, quota.windowUsed / Math.max(1, quota.windowTotal));
  const fmt = (n) => Math.round(n).toLocaleString();
  return `
    <div style="margin-top: 0.6rem;">
      <div style="display:flex; justify-content:space-between; font-size:0.78rem; color:var(--fg-mute);">
        <span>Lifetime</span><span>${fmt(quota.lifetimeUsed)} / ${fmt(quota.lifetimeTotal)}</span>
      </div>
      <div style="height: 6px; background: #ffffff10; border-radius: 999px; overflow:hidden; margin-top: 0.25rem;">
        <div style="height: 100%; width: ${(lifeFrac * 100).toFixed(0)}%; background: ${lifeFrac >= 0.8 ? "var(--warn)" : "var(--accent)"};"></div>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:0.78rem; color:var(--fg-mute); margin-top: 0.5rem;">
        <span>Last 24h</span><span>${fmt(quota.windowUsed)} / ${fmt(quota.windowTotal)}</span>
      </div>
      <div style="height: 6px; background: #ffffff10; border-radius: 999px; overflow:hidden; margin-top: 0.25rem;">
        <div style="height: 100%; width: ${(winFrac * 100).toFixed(0)}%; background: ${winFrac >= 0.8 ? "var(--warn)" : "var(--accent)"};"></div>
      </div>
    </div>
  `;
}

async function fetchPromoQuota() {
  if (!session.umk || !session.username) return null;
  const issuedAt = Date.now();
  const canonical = new TextEncoder().encode(
    `flagship/llm-promo-quota/v1|${session.username}|${issuedAt}`,
  );
  const sig = await signWithIrk(session.umk, canonical);
  try {
    const r = await fetch("/api/llm-promo/quota", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { userId: session.username, issuedAt },
        signature: bytesToHex(sig),
      }),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

async function renderProviders() {
  const list = $("providers-list");
  list.innerHTML = "";
  if (!session.umk) {
    list.innerHTML = '<div class="card placeholder">unlock first</div>';
    return;
  }
  const stored = await loadProviders(session.umk);
  const quota = await fetchPromoQuota();

  // Promo entry on top.
  const promoActive = stored.activeId === PROMO_ID;
  const promoCard = document.createElement("div");
  promoCard.className = "card";
  promoCard.style.borderLeft = `3px solid ${promoActive ? "var(--accent)" : "transparent"}`;
  promoCard.innerHTML = `
    <div class="row" style="align-items: flex-start;">
      <div>
        <div style="font-weight: 600;">Flagship promo <span class="pill">free credits</span></div>
        <div style="color: var(--fg-mute); font-size: 0.85rem; margin-top: 0.25rem;">
          Hosted GPU running an open-source coding model. Prompts are processed by flagshipserver.com on the way to our GPU.
        </div>
      </div>
      <button class="${promoActive ? "" : "secondary"}" data-action="set-active" data-id="${PROMO_ID}">${promoActive ? "active" : "use"}</button>
    </div>
    ${quota ? renderQuotaMeter(quota) : '<p style="margin: 0.6rem 0 0; color: var(--fg-mute); font-size: 0.85rem;">quota: (sign in to your account on a server first)</p>'}
  `;
  list.appendChild(promoCard);

  // "Almost out" banner toggles based on quota.
  const banner = $("promo-banner-low");
  if (banner) banner.style.display = (quota && (quota.almostOut || quota.exhausted)) ? "block" : "none";

  // BYOK entries.
  for (const e of stored.entries) {
    const isActive = stored.activeId === e.id;
    const card = document.createElement("div");
    card.className = "card";
    card.style.borderLeft = `3px solid ${isActive ? "var(--accent)" : "transparent"}`;
    card.style.marginTop = "0.6rem";
    card.innerHTML = `
      <div class="row" style="align-items: flex-start;">
        <div>
          <div style="font-weight: 600;">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="value" style="font-size: 0.78rem; margin-top: 0.25rem;">${escapeHtml(maskKey(e.apiKey))}</div>
          ${e.defaultModel ? `<div style="color: var(--fg-mute); font-size: 0.78rem;">default: ${escapeHtml(e.defaultModel)}</div>` : ""}
        </div>
        <div style="display:flex; gap: 0.4rem;">
          <button class="${isActive ? "" : "secondary"}" data-action="set-active" data-id="${escapeHtml(e.id)}">${isActive ? "active" : "use"}</button>
          <button class="secondary" data-action="remove" data-id="${escapeHtml(e.id)}">remove</button>
        </div>
      </div>
    `;
    list.appendChild(card);
  }

  // Wire button handlers (event delegation would be cleaner but the list is short).
  list.querySelectorAll('[data-action="set-active"]').forEach((b) => {
    b.addEventListener("click", async () => {
      try {
        await setActive(session.umk, b.getAttribute("data-id"));
        await renderProviders();
        await renderActiveProviderChip();
        toast("active provider updated");
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
  list.querySelectorAll('[data-action="remove"]').forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("Remove this provider?")) return;
      try {
        await removeProvider(session.umk, b.getAttribute("data-id"));
        await renderProviders();
        await renderActiveProviderChip();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
}

async function renderActiveProviderChip() {
  const chip = $("home-active-provider");
  if (!chip || !session.umk) return;
  const stored = await loadProviders(session.umk);
  if (stored.activeId === PROMO_ID) {
    const quota = await fetchPromoQuota();
    chip.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight: 600;">Flagship promo</div>
          <div style="color: var(--fg-mute); font-size: 0.82rem;">free credits — prompts proxied by flagshipserver.com</div>
        </div>
        <button class="secondary" id="chip-settings">manage</button>
      </div>
      ${quota ? renderQuotaMeter(quota) : ""}
    `;
  } else {
    const e = stored.entries.find((x) => x.id === stored.activeId);
    if (!e) {
      chip.innerHTML = '<p style="margin:0; color:var(--fg-mute); font-size:0.9rem;">no active provider — open settings</p>';
      return;
    }
    chip.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight: 600;">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div style="color: var(--fg-mute); font-size: 0.82rem;">key on this device — flagshipserver.com cannot read prompts</div>
        </div>
        <button class="secondary" id="chip-settings">manage</button>
      </div>
    `;
  }
  $("chip-settings")?.addEventListener("click", async () => {
    show("view-settings");
    await renderProviders();
  });
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

async function handleAddProvider() {
  $("add-provider-form").classList.remove("hidden");
}

async function handleSaveProvider() {
  if (!session.umk) return toast("unlock first", "err");
  const provider = $("np-provider").value;
  const label = $("np-label").value.trim();
  const apiKey = $("np-key").value;
  const baseUrl = $("np-base").value.trim();
  const defaultModel = $("np-model").value.trim();
  if (!label) return toast("label required", "err");
  if (!apiKey) return toast("api key required", "err");
  try {
    await addProvider(session.umk, {
      provider,
      label,
      apiKey,
      baseUrl: baseUrl || undefined,
      defaultModel: defaultModel || undefined,
    });
  } catch (e) {
    return toast(e.message, "err");
  }
  // Wipe inputs and re-render.
  $("np-label").value = "";
  $("np-key").value = "";
  $("np-base").value = "";
  $("np-model").value = "";
  $("add-provider-form").classList.add("hidden");
  await renderProviders();
  toast("provider saved");
}

async function boot() {
  $("bootstrap-go").addEventListener("click", handleBootstrap);
  $("unlock-go").addEventListener("click", handleUnlock);
  $("pair-with-server").addEventListener("click", handlePairToServer);
  $("pair-paste-go").addEventListener("click", handlePastePair);
  $("pair-cancel").addEventListener("click", () => show("view-home"));

  $("open-settings")?.addEventListener("click", async () => {
    show("view-settings");
    await renderProviders();
  });
  $("settings-back")?.addEventListener("click", async () => {
    show("view-home");
    await renderActiveProviderChip();
  });
  $("settings-reset")?.addEventListener("click", handleReset);
  $("add-provider-go")?.addEventListener("click", handleAddProvider);
  $("np-save")?.addEventListener("click", handleSaveProvider);
  $("np-cancel")?.addEventListener("click", () => $("add-provider-form").classList.add("hidden"));

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

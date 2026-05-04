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

/* ---------- providers (BYOK + Flagship-promo issuance) ---------- */

const FLAGSHIP_PROMO_LABEL_PREFIX = "Flagship promo";

function maskKey(k) {
  if (!k) return "";
  if (k.length < 12) return "••••";
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

function isPromoEntry(e) {
  return e?.label?.startsWith(FLAGSHIP_PROMO_LABEL_PREFIX);
}

async function renderProviders() {
  const list = $("providers-list");
  list.innerHTML = "";
  if (!session.umk) {
    list.innerHTML = '<div class="card placeholder">unlock first</div>';
    return;
  }
  const stored = await loadProviders(session.umk);
  const hasPromoEntry = stored.entries.some(isPromoEntry);

  // CTA card for the issuance flow when the user doesn't have a promo entry yet.
  if (!hasPromoEntry) {
    const cta = document.createElement("div");
    cta.className = "card";
    cta.innerHTML = `
      <div style="font-weight: 600;">Flagship free credits</div>
      <div style="color: var(--fg-mute); font-size: 0.85rem; margin-top: 0.25rem;">
        500k tokens / 100k per day on our hosted coding model. Verify a phone number to claim once.
        Once issued, the key lives on this device — flagshipserver.com cannot read your prompts.
      </div>
      <button id="promo-claim-go" style="margin-top: 0.7rem; width: 100%;">Get free credits</button>
    `;
    list.appendChild(cta);
  }

  // BYOK entries (including any minted promo entry — it's just a regular entry now).
  for (const e of stored.entries) {
    const isActive = stored.activeId === e.id;
    const card = document.createElement("div");
    card.className = "card";
    card.style.borderLeft = `3px solid ${isActive ? "var(--accent)" : "transparent"}`;
    card.style.marginTop = "0.6rem";
    const promoBadge = isPromoEntry(e)
      ? '<span class="pill ok">free credits</span>'
      : "";
    card.innerHTML = `
      <div class="row" style="align-items: flex-start;">
        <div>
          <div style="font-weight: 600;">${escapeHtml(e.label)} ${promoBadge} <span class="pill">${escapeHtml(e.provider)}</span></div>
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
  $("promo-claim-go")?.addEventListener("click", () => {
    $("promo-issuance-form")?.classList.remove("hidden");
    $("promo-step-otp")?.classList.add("hidden");
    $("promo-step-phone")?.classList.remove("hidden");
  });
}

async function renderActiveProviderChip() {
  const chip = $("home-active-provider");
  if (!chip || !session.umk) return;
  const stored = await loadProviders(session.umk);
  const e = stored.entries.find((x) => x.id === stored.activeId);
  if (!e) {
    chip.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight: 600;">No active provider</div>
          <div style="color: var(--fg-mute); font-size: 0.82rem;">claim free credits or add your own key</div>
        </div>
        <button class="secondary" id="chip-settings">settings</button>
      </div>
    `;
  } else {
    const promo = isPromoEntry(e);
    chip.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight: 600;">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div style="color: var(--fg-mute); font-size: 0.82rem;">${promo ? "Flagship-issued key — flagshipserver.com cannot read prompts" : "key on this device — flagshipserver.com cannot read prompts"}</div>
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

// Holds the live issuance ticket between the /start and /complete steps.
let promoIssuanceCtx = null;

async function startPromoIssuance() {
  if (!session.umk) return toast("unlock first", "err");
  const username = await ensureUsername().catch((e) => {
    toast(e.message, "err");
    return null;
  });
  if (!username) return;
  const phone = $("promo-phone").value.trim();
  if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) {
    return toast("phone number must be E.164 (e.g. +15555550100)", "err");
  }
  const identityHash = await sha256Bytes(new TextEncoder().encode(phone));
  const issuedAt = Date.now();
  const canonical = new TextEncoder().encode(
    `flagship/llm-promo-issue-start/v1|${username}|phone-otp|${bytesToHex(identityHash)}|${issuedAt}`,
  );
  const sig = await signWithIrk(session.umk, canonical);
  try {
    const r = await fetch("/api/llm-promo/issue/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          userId: username,
          method: "phone-otp",
          identityHash: bytesToHex(identityHash),
          issuedAt,
        },
        signature: bytesToHex(sig),
        identity: phone,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`status ${r.status}: ${body}`);
    }
    const body = await r.json();
    promoIssuanceCtx = { ticket: body.ticket, username };
    $("promo-step-phone")?.classList.add("hidden");
    $("promo-step-otp")?.classList.remove("hidden");
    toast("we sent you a code");
  } catch (e) {
    toast(`could not start: ${e.message}`, "err");
  }
}

async function completePromoIssuance() {
  if (!session.umk || !promoIssuanceCtx) return;
  const otp = $("promo-otp").value.trim();
  if (!/^[0-9]{6}$/.test(otp)) return toast("OTP must be 6 digits", "err");
  const otpHash = await sha256Bytes(new TextEncoder().encode(otp));
  const issuedAt = Date.now();
  const canonical = new TextEncoder().encode(
    `flagship/llm-promo-issue-complete/v1|${promoIssuanceCtx.username}|${promoIssuanceCtx.ticket}|${bytesToHex(otpHash)}|${issuedAt}`,
  );
  const sig = await signWithIrk(session.umk, canonical);
  try {
    const r = await fetch("/api/llm-promo/issue/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          userId: promoIssuanceCtx.username,
          ticket: promoIssuanceCtx.ticket,
          otpHash: bytesToHex(otpHash),
          issuedAt,
        },
        signature: bytesToHex(sig),
        otp,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`status ${r.status}: ${body}`);
    }
    const { key } = await r.json();
    // Persist as a normal BYOK provider entry. The OpenAI adapter handles
    // OpenAI-compatible APIs against an arbitrary baseUrl.
    await addProvider(session.umk, {
      provider: "openai",
      label: `Flagship promo (${key.keyId})`,
      apiKey: key.apiKey,
      baseUrl: key.baseUrl,
      defaultModel: key.model,
    });
    promoIssuanceCtx = null;
    $("promo-issuance-form")?.classList.add("hidden");
    $("promo-otp").value = "";
    $("promo-phone").value = "";
    await renderProviders();
    await renderActiveProviderChip();
    toast("free credits ready — selected as active provider");
  } catch (e) {
    toast(`could not complete: ${e.message}`, "err");
  }
}

async function sha256Bytes(input) {
  const buf = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(buf);
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

  $("promo-start-go")?.addEventListener("click", startPromoIssuance);
  $("promo-complete-go")?.addEventListener("click", completePromoIssuance);
  $("promo-cancel")?.addEventListener("click", () => {
    promoIssuanceCtx = null;
    $("promo-issuance-form")?.classList.add("hidden");
    $("promo-otp").value = "";
    $("promo-phone").value = "";
  });

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

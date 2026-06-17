// Phase 3b — admin "Add device" view (the desktop QR generator + sender).
//
// Settings → Trusted devices → Add device. Shows a pairing QR (the
// universal /join link) carrying the relay session + the admin's
// ephemeral X25519 pubkey. The incoming collaborator scans/opens it;
// once their device connects we derive the SAS, the admin confirms the
// codes match, then we sign a DeviceAdmit binding their fresh device key
// and seal { umkSeed, admit, admitSig } over the relay's AEAD channel.
//
// Safeguards on this screen (docs/login-and-account-redesign.md
// §"Safeguards"): a prominent "don't screenshot this code" warning (the
// webapp can't hard-block capture), the explicit risk warning, and a
// short single-use relay TTL.
//
// The relay choreography reuses the QrRelay v2 protocol
// (apps/web/public/heroQr.js + views/create-server.js). The orchestration
// + vouch crypto live in lib/crossDevicePairing.js (pure, injected) so
// this view stays a thin DOM shell.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { getSession } from "../lib/state.js";
import { signWithIrk, bytesToHex } from "../keystore.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
  runAdminAddDevice,
  buildJoinLink,
  ADMIN_RISK_WARNING,
  NO_SCREENSHOT_WARNING,
  PAIRING_TTL_MS,
} from "../lib/crossDevicePairing.js";
import { makeAdminRelay } from "../lib/pairingRelay.js";

registerView("view-add-device");

let activePairing = null; // { abort: () => void }

function setStatus(kind, text) {
  const el = $("add-device-status");
  if (!el) return;
  el.classList.remove("ok", "err", "warn");
  if (kind === "done") el.classList.add("ok");
  else if (kind === "error") el.classList.add("err");
  else if (kind === "active") el.classList.add("warn");
  el.textContent = text;
}

function showSas(sas) {
  const el = $("add-device-sas");
  if (!el) return;
  el.textContent = sas ? `${sas.slice(0, 3)} ${sas.slice(3)}` : "— — —";
}

async function renderQr(link) {
  const box = $("add-device-qr");
  if (!box) return;
  try {
    const m = await import("/qrEncoder.js");
    box.innerHTML = m.renderQrSvg(link, {
      size: 240,
      foreground: "#0A0A09",
      background: "transparent",
    });
  } catch {
    box.textContent = link;
  }
  const linkBox = $("add-device-link");
  if (linkBox) linkBox.value = link;
}

async function startPairing() {
  const session = getSession();
  if (!session.umk || !session.username) {
    return toast("unlock the webapp first", "err");
  }
  if (activePairing) {
    try { activePairing.abort(); } catch { /* ignore */ }
    activePairing = null;
  }

  showSas(null);
  setStatus("active", "generating pairing code…");

  // The relay transport: admin is the SENDER. SAS is surfaced via the
  // onSas callback; the Confirm gate is the admin's "codes match" tap,
  // which resolves the relay's awaitConfirm() via relay._confirm().
  const relay = makeAdminRelay({
    ttlMs: PAIRING_TTL_MS,
    onSas: (sas) => {
      showSas(sas);
      setStatus("active", "compare the code on both screens, then confirm");
      const btn = $("add-device-confirm");
      if (btn) {
        btn.disabled = false;
        btn.onclick = () => { btn.disabled = true; relay._confirm(true); };
      }
    },
    onPeerWaiting: () => setStatus("active", "waiting for the other device to connect…"),
  });
  activePairing = { abort: () => { relay._confirm(false); relay.close?.(); } };

  try {
    const result = await runAdminAddDevice({
      username: session.username,
      seed: session.umk,
      signWithIrk,
      bytesToHex,
      relay,
      onJoinLink: (link) => { void renderQr(link); },
    });
    if (result.outcome === "cancelled") {
      setStatus("idle", "cancelled.");
      return;
    }
    setStatus("done", "device added — it joins under a 14-day review window.");
    toast("device added (quarantined for review)", "ok");
  } catch (e) {
    setStatus("error", String(e?.message || e));
  } finally {
    activePairing = null;
  }
}

export function renderAddDevice() {
  const root = $("add-device-content");
  if (!root) return;
  root.innerHTML = `
    <div class="card warning" data-section="risk">
      <p class="note"><strong>Heads up.</strong> ${escapeHtml(ADMIN_RISK_WARNING)}</p>
    </div>
    <div class="card" data-section="qr">
      <div id="add-device-qr" class="qr-box" aria-label="Pairing QR"></div>
      <p class="note small err-text" data-section="no-screenshot">⚠️ ${escapeHtml(NO_SCREENSHOT_WARNING)}</p>
      <label class="mt-2 small">Or share this link</label>
      <input id="add-device-link" class="modal-input" readonly value="" />
    </div>
    <div class="card mt-2" data-section="sas">
      <div class="row"><span class="label">Match code</span>
        <span class="value mono" id="add-device-sas">— — —</span></div>
      <p class="note small">When the other device connects, compare this 6-digit code on both screens. They must match before you confirm.</p>
      <button id="add-device-confirm" class="full-width mt-2" disabled>Codes match — confirm &amp; add</button>
    </div>
    <p class="note" id="add-device-status">idle</p>
    <div class="row-2 mt-2">
      <button class="secondary" id="add-device-restart">New code</button>
      <button class="secondary" id="add-device-back">← Back</button>
    </div>
  `;
  $("add-device-restart")?.addEventListener("click", () => startPairing().catch((e) => { console.error(e); toast(humanError(e), "err"); }));
  $("add-device-back")?.addEventListener("click", () => {
    if (activePairing) { try { activePairing.abort(); } catch { /* ignore */ } activePairing = null; }
    show("view-trusted-devices");
  });
  void startPairing().catch((e) => { console.error(e); toast(humanError(e), "err"); });
}

export async function enterAddDevice() {
  show("view-add-device");
}

export function initAddDeviceView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-add-device") renderAddDevice();
  });
}

// Re-export the link builder for tests / future callers.
export { buildJoinLink };

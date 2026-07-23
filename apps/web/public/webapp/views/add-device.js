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
// The relay choreography reuses the QrRelay v2 protocol implemented by
// lib/pairingRelay.js. The orchestration
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

// L10 — anti-double-tap gate (ms) for the "codes match" confirm. Mirrors the
// iOS AddDeviceViewModel 600ms `gateExpired` window: hold Confirm disabled for a
// beat after the SAS appears so a reflexive double-tap can't confirm a code the
// human hasn't compared. Belt-and-suspenders on top of the SAS compare itself.
export const SAS_CONFIRM_GATE_MS = 600;

// Slice D (D-4) — the hard warning shown beside the (default-OFF) "make this
// device an admin" toggle. Byte-stable so iOS/Android can mirror the copy.
export const PROMOTE_ADMIN_WARNING =
  "This device will be able to wipe, transfer, or decommission your cloud — full admin authority, not just access. Leave this off unless you truly intend to hand over that control.";

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
    return toast("Unlock the webapp first", "err");
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
        // L10 anti-double-tap gate (parity with iOS AddDeviceViewModel's 600ms
        // `gateExpired` window): the SAS just appeared, so hold Confirm disabled
        // briefly. A reflexive double-tap from the previous screen can't confirm
        // a code the human hasn't actually compared. The wire-up (onclick) is
        // set now; only the enabled state is delayed.
        btn.disabled = true;
        btn.onclick = () => { btn.disabled = true; relay._confirm(true); };
        setTimeout(() => {
          // Only un-gate if we're still awaiting this confirmation (the SAS
          // panel hasn't been torn down / superseded).
          if ($("add-device-confirm") === btn) btn.disabled = false;
        }, SAS_CONFIRM_GATE_MS);
      }
    },
    onPeerWaiting: () => setStatus("active", "waiting for the other device to connect…"),
  });
  activePairing = { abort: () => { relay._confirm(false); relay.close?.(); } };

  // Slice D (D-4): promote-at-add-time is offered ONLY here — the synchronous,
  // admin-initiated, SAS-confirmed HIGH-assurance ceremony (never an async
  // approve-a-request join). It is default-OFF and possible only when THIS
  // device holds the admin root to seal. Read the toggle at seal time.
  const promoteAdmin =
    !!session.adminRootSeed && $("add-device-promote-admin")?.checked === true;

  try {
    const result = await runAdminAddDevice({
      username: session.username,
      seed: session.umk,
      signWithIrk,
      bytesToHex,
      promoteAdmin,
      adminRootSeed: session.adminRootSeed ?? null,
      relay,
      onJoinLink: (link) => { void renderQr(link); },
    });
    if (result.outcome === "cancelled") {
      setStatus("idle", "cancelled.");
      return;
    }
    if (result.promotedAdmin) {
      setStatus("done", "admin device added — it joins under a 14-day review window.");
      toast("Admin device added (quarantined for review)", "ok");
    } else {
      setStatus("done", "device added — it joins under a 14-day review window.");
      toast("Device added (quarantined for review)", "ok");
    }
  } catch (e) {
    setStatus("error", String(e?.message || e));
  } finally {
    activePairing = null;
  }
}

export function renderAddDevice() {
  const root = $("add-device-content");
  if (!root) return;
  const session = getSession();
  // Slice D (D-4): the promote toggle is shown ONLY when this device can seal
  // the admin root (i.e. it holds one). Default OFF, with a hard warning. On a
  // non-admin device the section is omitted entirely (nothing to grant).
  const canPromote = !!session.adminRootSeed;
  const promoteSection = canPromote
    ? `
    <div class="card warning mt-2" data-section="promote-admin">
      <label class="inline-check">
        <input type="checkbox" id="add-device-promote-admin"
               data-add-device-promote-admin />
        Also make this device an admin
      </label>
      <p class="note small err-text" data-section="promote-admin-warning">
        ⚠️ ${escapeHtml(PROMOTE_ADMIN_WARNING)}
      </p>
    </div>`
    : "";
  root.innerHTML = `
    <div class="card warning" data-section="risk">
      <p class="note"><strong>Heads up.</strong> ${escapeHtml(ADMIN_RISK_WARNING)}</p>
    </div>
    ${promoteSection}
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

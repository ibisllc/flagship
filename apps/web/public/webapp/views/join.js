// Phase 3b — incoming /join view (the scanned-in collaborator device).
//
// Entered when the webapp boots on a /join?sid=…&pk=… deep-link (wired in
// app.js via lib/crossDevicePairing.joinLinkFromLocation), or from a
// pasted link. This is the add-profile pairing receiver:
//
//   1. mint a FRESH device key for THIS profile (its own Ed25519 seed —
//      "every install is a new device"), derive its IRK pub.
//   2. connect the relay to the admin's session, derive + SHOW the SAS;
//      the user verifies it matches the admin's screen, then confirms.
//   3. send our device pubkey; receive the sealed { umkSeed, admit,
//      admitSig }.
//   4. verify the admit under the account IRK pub (fetched via
//      /api/users/:u/pubkey-cert), persist the UMK under a NEW profile
//      (never clobbering an existing one), register push + POST
//      /api/users/:u/devices/admit, addProfile(setActive).
//   5. surface the 14-day quarantine countdown.
//
// Safeguards (docs §"Safeguards"): the no-screenshot + risk warnings are
// shown BEFORE we reveal the SAS / accept the bundle; the relay TTL is
// short. The crypto + orchestration are in lib/crossDevicePairing.js
// (pure, injected); this view is the DOM shell + the live relay wiring.

import { $, registerView, show } from "../lib/router.js";
import {
  bytesToHex,
  hexToBytes,
  deriveIrkFromSeed,
  signWithIrk,
  persistSeedForProfile,
  persistAdminRootSeed,
  setActiveKeystoreProfile,
  verifyWithEd25519Pub,
} from "../keystore.js";
import { unlockSession } from "../lib/state.js";
import { addProfile } from "../lib/profiles.js";
import { generateDeviceId } from "../lib/accountMetadata.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { toast } from "../lib/toast.js";
import { failureText } from "../lib/rateLimited.js";
import { escapeHtml } from "../lib/util.js";
import {
  parseJoinLink,
  runIncomingJoin,
  quarantineTimeline,
  INCOMING_RISK_WARNING,
  NO_SCREENSHOT_WARNING,
} from "../lib/crossDevicePairing.js";
import { makeIncomingRelay } from "../lib/pairingRelay.js";
import { set as profileSet } from "../lib/profilesStore.js";

registerView("view-join");

let pendingLink = null; // { sid, pk } parsed from the deep-link / paste
let activeRelay = null;

function setStatus(kind, text) {
  const el = $("join-status");
  if (!el) return;
  el.classList.remove("ok", "err", "warn");
  if (kind === "done") el.classList.add("ok");
  else if (kind === "error") el.classList.add("err");
  else if (kind === "active") el.classList.add("warn");
  el.textContent = text;
}

/** Mint a fresh, INDEPENDENT device key for this profile (its own
 *  Ed25519 seed — not derived from the account UMK we'll receive). Its
 *  pub is what the admin binds in the DeviceAdmit. The push registration
 *  is signed by this same fresh key. */
async function mintDeviceKey() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const irk = await deriveIrkFromSeed(seed);
  return { seed, pubHex: bytesToHex(irk.publicKey), deviceId: generateDeviceId() };
}

/** Register THIS device's push token, signed by its fresh device key.
 *  Returns the on-wire { request, signatureHex } the admit POST carries.
 *  The server skips verifying this signature (the admit is the IRK
 *  consent), but we sign it anyway for storage/forward-compat. */
function makeRegisterPush(deviceSeed) {
  return async ({ username, deviceId, deviceIrkPubHex }) => {
    void deviceIrkPubHex;
    const issuedAt = Date.now();
    // Web Push needs a real subscription; we don't force the permission
    // prompt at join (it can be wired later from Settings), so register a
    // placeholder providerToken + an ephemeral push key so the admit still
    // completes and the device joins now.
    const providerToken = JSON.stringify({ endpoint: "", keys: {} });
    const pushX25519Pub = crypto.getRandomValues(new Uint8Array(32));
    const request = {
      username,
      deviceId,
      platform: "webpush",
      providerToken,
      pushX25519Pub: bytesToHex(pushX25519Pub),
      issuedAt,
    };
    const canonical = new TextEncoder().encode(
      [
        "flagship/push-token-register/v2",
        request.username,
        request.deviceId,
        request.platform,
        request.providerToken,
        request.pushX25519Pub,
        request.issuedAt,
      ].join("|"),
    );
    const sig = await signWithIrk(deviceSeed, canonical);
    return { request, signatureHex: bytesToHex(sig) };
  };
}

async function startJoin() {
  if (!pendingLink) {
    setStatus("error", "no pairing link — open the QR link the admin showed you.");
    return;
  }
  const { sid, pk } = pendingLink;

  // Mint this profile's fresh device key BEFORE we connect.
  setStatus("active", "preparing this device…");
  const device = await mintDeviceKey();

  const relay = makeIncomingRelay({
    onConnecting: () => setStatus("active", "connecting to the admin's device…"),
  });
  activeRelay = { abort: () => relay.close?.() };

  let session;
  try {
    session = await relay.connect({
      sid,
      adminPkB64u: pk,
      deviceIrkPubHex: device.pubHex,
      deviceId: device.deviceId,
    });
  } catch (e) {
    setStatus("error", String(e?.message || e));
    return;
  }

  // Show the SAS + require the user to confirm it matches the admin's
  // screen BEFORE we accept the bundle.
  $("join-sas").textContent = `${session.sas.slice(0, 3)} ${session.sas.slice(3)}`;
  setStatus("active", "compare this code with the admin's screen, then confirm");
  const confirmed = await waitForSasConfirm();
  if (!confirmed) {
    relay.close?.();
    setStatus("idle", "cancelled.");
    return;
  }

  setStatus("active", "receiving keys…");
  let bundlePlaintext;
  try {
    bundlePlaintext = await session.awaitBundle();
  } catch (e) {
    setStatus("error", String(e?.message || e));
    return;
  }

  try {
    const result = await runIncomingJoin({
      bundlePlaintext,
      deviceIrkPubHex: device.pubHex,
      deviceId: device.deviceId,
      setActiveKeystoreProfile,
      persistSeedForProfile,
      persistAdminRootSeed,
      unlockSession,
      verifyEd25519: verifyWithEd25519Pub,
      registerPush: makeRegisterPush(device.seed),
      addProfile: (p) => addProfile(p, { setActive: true }),
      setUsername: (u) => profileSet("username", u),
      bytesToHex,
      hexToBytes,
    });
    relay.close?.();
    renderQuarantine(result);
    toast(`Joined ${result.username} — device under review`, "ok");
  } catch (e) {
    setStatus("error", failureText(e, "couldn't join: "));
  } finally {
    activeRelay = null;
  }
}

/** Render the quarantine countdown + an "open the account" action. */
function renderQuarantine(result) {
  const el = $("join-quarantine");
  if (el) {
    const t = result.quarantine ?? quarantineTimeline(result.admitResponse ?? {});
    el.innerHTML = `
      <div class="card warning">
        <div class="weight-600"><span aria-hidden="true">⏱</span> Under review</div>
        <p class="note small">${escapeHtml(t.label)}</p>
      </div>
      <button class="full-width mt-2" id="join-open">Open ${escapeHtml(result.username)}</button>
    `;
    $("join-open")?.addEventListener("click", () => { void dispatchInitialView(); });
  }
  setStatus("done", "joined.");
}

function waitForSasConfirm() {
  return new Promise((resolve) => {
    const ok = $("join-confirm");
    const cancel = $("join-cancel");
    if (!ok) return resolve(false);
    ok.disabled = false;
    const cleanup = () => {
      ok.removeEventListener("click", onOk);
      cancel?.removeEventListener("click", onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    ok.addEventListener("click", onOk, { once: true });
    cancel?.addEventListener("click", onCancel, { once: true });
  });
}

/** Called by the router boot when this load is a /join deep-link (`{sid, pk}`),
 *  or with a pasted or scanned link (a string). */
export function enterJoin(link) {
  pendingLink = typeof link === "string" ? parseJoinLink(link) : link ?? null;
  show("view-join");
  renderJoin();
}

function renderJoin() {
  const root = $("join-content");
  if (!root) return;
  root.innerHTML = `
    <div class="card warning" data-section="risk">
      <p class="note"><strong>Heads up.</strong> ${escapeHtml(INCOMING_RISK_WARNING)}</p>
    </div>
    <div class="card" data-section="sas">
      <div class="row"><span class="label">Match code</span>
        <span class="value mono" id="join-sas">— — —</span></div>
      <p class="note small">This must match the 6-digit code on the admin's screen. If it doesn't, cancel — someone may be intercepting.</p>
      <p class="note small err-text" data-section="no-screenshot">⚠️ ${escapeHtml(NO_SCREENSHOT_WARNING)}</p>
      <div class="row-2 mt-2">
        <button class="secondary" id="join-cancel">Cancel</button>
        <button id="join-confirm" disabled>Codes match — continue</button>
      </div>
    </div>
    <p class="note" id="join-status">idle</p>
    <div id="join-quarantine"></div>
  `;
  $("join-cancel")?.addEventListener("click", () => {
    if (activeRelay) { try { activeRelay.abort(); } catch { /* ignore */ } activeRelay = null; }
  });
  void startJoin().catch((e) => setStatus("error", String(e?.message || e)));
}

export function initJoinView() {
  // No router event needed — enterJoin() is called from the boot path.
}

// Settings → "Scan a pairing code": add this browser to another account (or
// another of yours) while signed in, as iOS and Android do. The join makes a
// new profile; the current one stays as it is.

export const JOIN_ANOTHER_TITLE = "Scan a pairing code";
export const JOIN_ANOTHER_MESSAGE =
  "Add this browser to another account. On a device of that account, open Settings → Trusted devices → Add device, then scan the code it shows or paste its link here.";
export const JOIN_LINK_INVALID = "That isn't a pairing link. It looks like https://flagshipserver.com/join?sid=…";
export const JOIN_SCAN_FAILED = "Couldn't scan. Paste the pairing link instead.";

/** The pairing link in what was pasted or scanned, or an error sentence. */
export function readJoinInput(text) {
  const raw = String(text ?? "").trim();
  return parseJoinLink(raw) ? { link: raw, error: "" } : { link: null, error: JOIN_LINK_INVALID };
}

export async function openJoinAnotherAccount({ canScan = null } = {}) {
  const { scanWithCamera, hasBarcodeDetector } = await import("../qrScanner.js");
  const scan = canScan ?? hasBarcodeDetector();
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", JOIN_ANOTHER_TITLE);
  dlg.innerHTML = `
    <h3 class="modal-title">${escapeHtml(JOIN_ANOTHER_TITLE)}</h3>
    <p class="modal-message">${escapeHtml(JOIN_ANOTHER_MESSAGE)}</p>
    <input class="full-width mt-2" data-join-input placeholder="https://flagshipserver.com/join?…" autocomplete="off" />
    ${scan
      ? `<button class="secondary full-width mt-2" data-join-scan>Scan QR with camera</button>
         <video class="full-width mt-2 hidden" data-join-video playsinline muted style="border-radius:8px;max-height:320px;background:#000"></video>`
      : ""}
    <p class="modal-error err-text hidden" data-join-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-join-cancel>Cancel</button>
      <button data-join-continue>Continue</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const q = (s) => dlg.querySelector(s);
  const input = q("[data-join-input]");
  const err = q("[data-join-error]");
  const video = q("[data-join-video]");
  const showError = (text) => {
    err.textContent = text;
    err.classList.remove("hidden");
  };
  const stopScan = () => {
    const stream = video?.srcObject;
    stream?.getTracks?.().forEach((t) => t.stop());
    if (video) video.srcObject = null;
  };
  const close = () => {
    stopScan();
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  const go = (text) => {
    const { link, error } = readJoinInput(text);
    if (!link) return showError(error);
    close();
    enterJoin(link);
  };
  q("[data-join-cancel]").addEventListener("click", close);
  q("[data-join-continue]").addEventListener("click", () => go(input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      go(input.value);
    }
  });
  q("[data-join-scan]")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "Scanning…";
    video?.classList.remove("hidden");
    try {
      go(String(await scanWithCamera(video, { timeoutMs: 30_000 })));
    } catch {
      showError(JOIN_SCAN_FAILED);
    } finally {
      stopScan();
      video?.classList.add("hidden");
      btn.disabled = false;
      btn.textContent = "Scan QR with camera";
    }
  });
  input.focus();
}

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
import { dispatchInitialView } from "../lib/deepLink.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
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
  return { seed, pubHex: bytesToHex(irk.publicKey) };
}

/** Register THIS device's push token, signed by its fresh device key.
 *  Returns the on-wire { request, signatureHex } the admit POST carries.
 *  The server skips verifying this signature (the admit is the IRK
 *  consent), but we sign it anyway for storage/forward-compat. */
function makeRegisterPush(deviceSeed) {
  return async ({ username, deviceIrkPubHex }) => {
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
      platform: "webpush",
      providerToken,
      pushX25519Pub: bytesToHex(pushX25519Pub),
      label: "Web (paired)",
      issuedAt,
    };
    const canonical = new TextEncoder().encode(
      [
        "flagship/push-token-register/v1",
        request.username,
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
    session = await relay.connect({ sid, adminPkB64u: pk, deviceIrkPubHex: device.pubHex });
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
    toast(`joined ${result.username} — device under review`, "ok");
  } catch (e) {
    setStatus("error", `couldn't join: ${String(e?.message || e)}`);
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

/** Called by the router boot when this load is a /join deep-link. */
export function enterJoin(link) {
  pendingLink = link ?? null;
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

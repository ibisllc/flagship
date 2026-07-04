import {
  bytesToHex,
  signWithIrk,
  generateEphemeralPub,
} from "../keystore.js";
import { hasBarcodeDetector, parseQrPayload, scanWithCamera } from "../qrScanner.js";
import { $, registerView, show } from "../lib/router.js";
import { getSession, ensureUsername } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { set as profileSet } from "../lib/profilesStore.js";

registerView("view-pair");

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

async function confirmPairing(qrText) {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock first", "err");
    return;
  }
  let parsed;
  try {
    parsed = parseQrPayload(qrText);
  } catch (e) {
    toast(`Invalid QR: ${e.message}`, "err");
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
    profileSet("sessionId", parsed.sessionId);
    toast("Paired");
    const { renderHome } = await import("./home.js");
    await renderHome();
    show("view-home");
  } catch (e) {
    toast(`Pair failed: ${e.message}`, "err");
  }
}

export function startPairing() {
  const session = getSession();
  if (!session.irk) {
    toast("Unlock first", "err");
    return;
  }
  show("view-pair");
  // Camera scan in the background; paste-fallback works in parallel.
  startCameraScan();
}

async function handlePastePair() {
  const text = $("pair-paste").value.trim();
  if (!text) return toast("Paste a QR payload first", "err");
  await confirmPairing(text);
}

export function initPairView() {
  $("pair-paste-go")?.addEventListener("click", handlePastePair);
  $("pair-cancel")?.addEventListener("click", () => show("view-home"));
}

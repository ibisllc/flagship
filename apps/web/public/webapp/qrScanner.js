// QR scanning via the browser's BarcodeDetector when available, with a
// graceful "paste the text" fallback when not.
//
// Browsers with BarcodeDetector: Chrome (mobile + desktop), Edge, Opera.
// Safari + Firefox: the user pastes the QR payload as text.

export function hasBarcodeDetector() {
  return typeof globalThis.BarcodeDetector !== "undefined";
}

/**
 * Open the back-facing camera, scan for a QR, return the decoded string.
 * Disposes the stream when done. Throws if the user denies the prompt.
 */
export async function scanWithCamera(videoEl, opts = {}) {
  if (!hasBarcodeDetector()) {
    throw new Error("BarcodeDetector not available in this browser");
  }
  const detector = new globalThis.BarcodeDetector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();

  const stop = () => {
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  };

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        const codes = await detector.detect(videoEl);
        if (codes.length > 0) {
          stop();
          return codes[0].rawValue;
        }
      } catch {
        // detector is stateful; brief errors during early frames are normal.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("QR scan timed out");
  } finally {
    stop();
  }
}

/**
 * Parse `flagship://desktop/<sessionId>/<desktopPubKeyHex>`.
 */
export function parseQrPayload(text) {
  const m = String(text).trim().match(/^flagship:\/\/desktop\/([0-9a-f]{16})\/([0-9a-f]{64,})$/i);
  if (!m) throw new Error("payload doesn't match flagship://desktop/<sid>/<pubkey>");
  return { sessionId: m[1].toLowerCase(), desktopPubKeyHex: m[2].toLowerCase() };
}

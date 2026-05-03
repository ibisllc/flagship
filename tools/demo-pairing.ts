#!/usr/bin/env tsx
/**
 * Walks the entire desktop-pairing flow end-to-end against a running
 * flagshipserver.com instance, using the same dev UMK seed as the in-browser
 * fake phone at /dev/phone.html. Useful for verifying wiring without a real
 * iOS/Android client.
 *
 * Usage:
 *   FLAGSHIP_DEV=1 PORT=3145 npm --workspace=@flagship/web run start &
 *   sleep 2
 *   npx tsx tools/demo-pairing.ts http://127.0.0.1:3145
 */
import { deriveIRK, signRebuildRequest } from "@flagship/protocol";

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const DEV_USER_ID = "harry";
const DEV_UMK_SEED = new Uint8Array(32).fill(7);

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const desktopPub = new Uint8Array(32);
  crypto.getRandomValues(desktopPub);
  const phonePub = new Uint8Array(32);
  crypto.getRandomValues(phonePub);

  console.log("→ desktop posts /api/desktop/pair/start");
  const startRes = await fetch(base + "/api/desktop/pair/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ desktopPubKey: bytesToHex(desktopPub) }),
  });
  if (!startRes.ok) throw new Error(`start failed: ${startRes.status}`);
  const start = await startRes.json();
  console.log("  sessionId:", start.sessionId);
  console.log("  qrPayload:", start.qrPayload);
  console.log("  qrDataUri length:", start.qrDataUri.length, "bytes");

  console.log("\n→ phone derives IRK from dev UMK and signs the pairing claim");
  const irk = deriveIRK({ seed: DEV_UMK_SEED });
  const issuedAt = Date.now();
  const claim = {
    userId: DEV_USER_ID,
    newServerId: `desktop-pair:${start.sessionId}`,
    wifiSsid: bytesToHex(desktopPub),
    wifiPskHash: phonePub,
    shareRatio: 0,
    issuedAt,
  };
  const sig = signRebuildRequest(claim, irk);

  console.log("→ phone posts /api/desktop/pair/confirm");
  const confirmRes = await fetch(base + "/api/desktop/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: start.sessionId,
      userId: DEV_USER_ID,
      phonePubKey: bytesToHex(phonePub),
      irkSignature: bytesToHex(sig),
      issuedAt,
    }),
  });
  console.log("  HTTP", confirmRes.status, await confirmRes.text());

  console.log("\n→ desktop polls /api/desktop/pair/:id/status");
  const statusRes = await fetch(base + `/api/desktop/pair/${start.sessionId}/status`);
  console.log("  HTTP", statusRes.status, await statusRes.text());

  console.log("\n✓ pairing flow complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

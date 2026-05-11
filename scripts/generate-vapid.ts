#!/usr/bin/env tsx
/**
 * Mint a fresh ES256 (P-256) VAPID key pair for Web Push.
 *
 * Prints both halves to stdout — load them as Worker secrets:
 *
 *   npx tsx scripts/generate-vapid.ts > /tmp/vapid.txt
 *   # paste WEBPUSH_VAPID_PRIVATE_KEY_PEM into:
 *   wrangler secret put WEBPUSH_VAPID_PRIVATE_KEY_PEM
 *   # paste WEBPUSH_VAPID_PUBLIC_KEY_B64URL into:
 *   wrangler secret put WEBPUSH_VAPID_PUBLIC_KEY_B64URL
 *   # mailto: contact (any operator email):
 *   echo -n "mailto:harry@flagship.services" | wrangler secret put WEBPUSH_CONTACT
 *
 * Run once per deployment. Rotation is also a re-run + re-load + a
 * webapp re-subscription (every browser whose subscription was tied
 * to the old VAPID public key has to call pushManager.subscribe again
 * — `lib/push.js` does this automatically when the cached key
 * doesn't match).
 *
 * The public key is the uncompressed SEC1 P-256 format: 0x04 || X || Y,
 * 65 bytes, base64url-encoded — the shape `PushManager.subscribe`
 * wants for `applicationServerKey`.
 */

import { webcrypto } from "node:crypto";

async function main(): Promise<void> {
  const kp = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", kp.privateKey);
  const pkcs8B64 = Buffer.from(pkcs8).toString("base64");
  const pemBody = pkcs8B64.match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`;

  // SubtleCrypto.exportKey "raw" on a P-256 ECDSA pubkey returns the
  // uncompressed SEC1 form (0x04 || X || Y, 65 bytes). That's exactly
  // what RFC 8292 wants for the `k=` parameter and what
  // `PushManager.subscribe` wants for `applicationServerKey`.
  const rawPub = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", kp.publicKey),
  );
  if (rawPub.length !== 65 || rawPub[0] !== 0x04) {
    throw new Error(`unexpected raw pubkey shape (got ${rawPub.length} bytes)`);
  }
  const pubB64Url = Buffer.from(rawPub)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  process.stdout.write(`# WEBPUSH_VAPID_PRIVATE_KEY_PEM (PKCS8, paste this whole block):\n${pem}\n`);
  process.stdout.write(`# WEBPUSH_VAPID_PUBLIC_KEY_B64URL (uncompressed P-256, single line):\n${pubB64Url}\n`);
}

void main();

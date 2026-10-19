// Golden vectors for the cross-device pairing relay crypto
// (apps/web/public/webapp/lib/pairingRelay.js): X25519 -> HKDF(salt
// "flagship/qr/v1", infos "flagship/qr/enc/v1" 256 bit and
// "flagship/qr/sas/v1" 32 bit) -> 6-digit SAS + AES-256-GCM.
// Deterministic: fixed keys, fixed nonce. Run: node tools/pairing-relay-vectors.mjs
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createCipheriv } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const b64u = (b) => Buffer.from(b).toString("base64url");

function keypair(fill) {
  const seed = Buffer.alloc(32, fill);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { seed, priv, pub };
}

const admin = keypair(0x11);
const incoming = keypair(0x22);

const shared = diffieHellman({
  privateKey: admin.priv,
  publicKey: createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), incoming.pub]),
    format: "der",
    type: "spki",
  }),
});
const salt = Buffer.from("flagship/qr/v1");
const expand = (info, len) => Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(info), len));
const kEnc = expand("flagship/qr/enc/v1", 32);
const sasBytes = expand("flagship/qr/sas/v1", 4);
const sas = String(sasBytes.readUInt32BE(0) % 1_000_000).padStart(6, "0");

function seal(plaintext, nonce) {
  const c = createCipheriv("aes-256-gcm", kEnc, nonce);
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { ciphertext: b64u(ct), nonce: b64u(nonce) };
}

const devicePubHex = "ab".repeat(32);
const deviceId = "00112233445566778899aabbccddeeff";
const returnSid = b64u(Buffer.alloc(16, 0x33));
const returnPkB64u = b64u(Buffer.alloc(32, 0x44));
const hello = JSON.stringify({ devicePubHex, deviceId, returnSid, returnPkB64u });
const bundle = JSON.stringify({ umkSeedHex: "cd".repeat(32), admitSig: "ef".repeat(64) });

const out = {
  note: "Golden vectors for the cross-device pairing relay (web pairingRelay.js, iOS LivePairingRelayClient, Android sibling). Fixed X25519 keys -> shared HKDF material -> SAS + AES-256-GCM. ciphertext is base64url(ct || 16-byte tag). Regenerate with `node tools/pairing-relay-vectors.mjs`.",
  hkdf: { salt: "flagship/qr/v1", encInfo: "flagship/qr/enc/v1", sasInfo: "flagship/qr/sas/v1" },
  adminSkHex: admin.seed.toString("hex"),
  adminPkB64u: b64u(admin.pub),
  incomingSkHex: incoming.seed.toString("hex"),
  incomingPkB64u: b64u(incoming.pub),
  sas,
  kEncHex: kEnc.toString("hex"),
  incomingHello: {
    plaintext: hello,
    ...seal(Buffer.from(hello), Buffer.alloc(12, 0x55)),
  },
  adminBundle: {
    plaintext: bundle,
    ...seal(Buffer.from(bundle), Buffer.alloc(12, 0x66)),
  },
};

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "test-vectors", "pairing-relay.json");
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log("wrote", target, "sas", sas);

// Writes packages/protocol/test-vectors/recovery-passkey/vectors.json: real-format passkey
// registrations (attestation objects, fmt "none") and recovery assertions, ES256 and EdDSA,
// over a fixed `.com` challenge (SEC-REPAIR-001). Signatures are made here with fixed keys.
// Run: node --import tsx tools/recovery-passkey-vectors.mjs
import { writeFileSync } from "node:fs";
import { createECDH, createHash, createPrivateKey, sign as nodeSign } from "node:crypto";
import { ed } from "../packages/protocol/src/edSync.ts";
import { issueRecoveryChallenge, recoveryPasskeyPolicy } from "../packages/control-plane/src/passkeyAssertion.ts";

const b64url = (b) => Buffer.from(b).toString("base64url");
const hex = (b) => Buffer.from(b).toString("hex");
const sha = (b) => createHash("sha256").update(b).digest();

// Minimal CBOR encoder: ints, byte strings, text, maps.
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const t = Buffer.from(v); return Buffer.concat([head(3, t.length), t]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

const SECRET = "vector-recovery-secret";
const USERNAME = "alice";
const NOW = 1_760_000_000_000;
const { challenge, expiresAt } = await issueRecoveryChallenge(SECRET, USERNAME, NOW, new Uint8Array(16).fill(0x5a));
const policy = recoveryPasskeyPolicy("flagshipserver.com");

function registration(rpId, credentialId, cose) {
  const authData = Buffer.concat([sha(rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, cose]);
  return cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
}
function assertionParts(rpId, origin, flags = 0x05, ch = challenge) {
  const authenticatorData = Buffer.concat([sha(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, 7])]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: ch, origin, crossOrigin: false }));
  return { authenticatorData, clientDataJSON, signed: Buffer.concat([authenticatorData, sha(clientDataJSON)]) };
}

// ES256: a fixed P-256 key.
const d = Buffer.alloc(32, 0x11);
const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(d);
const pt = ecdh.getPublicKey();
const ecKey = { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(pt.subarray(1, 33)), y: b64url(pt.subarray(33, 65)) };
const ecPriv = createPrivateKey({ key: ecKey, format: "jwk" });
const esCose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(ecKey.x, "base64url")], [-3, Buffer.from(ecKey.y, "base64url")]]));
// EdDSA: a fixed Ed25519 seed.
const seed = new Uint8Array(32).fill(0x22);
const edCose = cbor(new Map([[1, 1], [3, -8], [-1, 6], [-2, ed.getPublicKey(seed)]]));

const cases = [
  { name: "es256-web", alg: -7, rpId: "recovery.flagshipserver.com", origin: "https://recovery.flagshipserver.com", credentialId: Buffer.alloc(16, 0xc1), cose: esCose,
    sign: (m) => nodeSign("sha256", m, ecPriv) },
  { name: "eddsa-android", alg: -8, rpId: "flagshipserver.com", origin: policy.origins.find((o) => o.startsWith("android:")), credentialId: Buffer.alloc(20, 0xc2), cose: edCose,
    sign: (m) => ed.sign(m, seed) },
];

const entries = cases.map((c) => {
  const { authenticatorData, clientDataJSON, signed } = assertionParts(c.rpId, c.origin);
  const assertion = { credentialId: b64url(c.credentialId), authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(c.sign(signed)) };
  return {
    name: c.name, alg: c.alg, rpId: c.rpId, origin: c.origin,
    credentialIdHex: hex(c.credentialId), coseHex: hex(c.cose),
    attestationObject: b64url(registration(c.rpId, c.credentialId, c.cose)),
    assertion,
    fetchPasskeyField: { challenge, assertion },
  };
});

// Each must be refused against entries[0]'s stored key.
const e0 = cases[0];
const bad = (name, parts, over = {}) => ({
  name,
  assertion: { credentialId: b64url(e0.credentialId), authenticatorData: b64url(parts.authenticatorData), clientDataJSON: b64url(parts.clientDataJSON), signature: b64url(e0.sign(parts.signed)), ...over },
});
const invalid = [
  bad("another origin", assertionParts(e0.rpId, "https://evil.example")),
  bad("another rpId", assertionParts("evil.example", e0.origin)),
  bad("user not verified", assertionParts(e0.rpId, e0.origin, 0x01)),
  bad("another challenge", assertionParts(e0.rpId, e0.origin, 0x05, b64url(Buffer.alloc(56, 1)))),
  bad("another credential", assertionParts(e0.rpId, e0.origin), { credentialId: b64url(Buffer.alloc(16, 0xee)) }),
  bad("a signature from another key", assertionParts(e0.rpId, e0.origin), { signature: entries[1].assertion.signature }),
];

writeFileSync("packages/protocol/test-vectors/recovery-passkey/vectors.json", JSON.stringify({
  about: "SEC-REPAIR-001 recovery passkey. At enrolment the client sends the platform's attestation object (base64url) as `passkeyAttestationObject` beside the signed record; `.com` keeps the COSE key. At recovery it POSTs /api/recovery/by-username/<u>/challenge, passes the challenge's base64url-decoded bytes as the WebAuthn challenge in the same get() that evaluates the PRF, and sends `passkey: { challenge, assertion: { credentialId, authenticatorData, clientDataJSON, signature } }` (base64url) with the fetch. The challenge was issued for `username` with `secretUtf8` at `now` (nonce 0x5a×16). Every invalid assertion must be refused against the first entry's key.",
  secretUtf8: SECRET, username: USERNAME, now: NOW, challenge, challengeExpiresAt: expiresAt,
  rpIds: policy.rpIds, origins: policy.origins, entries, invalid,
}, null, 2) + "\n");
console.log("wrote");

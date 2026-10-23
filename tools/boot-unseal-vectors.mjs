// Writes packages/protocol/test-vectors/boot-unseal/vectors.json: the early-boot
// unlock wire (sealed lease, SealedSecretResponse, signed SecretRequest and
// box-auth headers) with positive and negative cases, shared by the TS
// protocol tests, the boot-core gate tests, the Go helper (through
// tools/unseal-crosscheck) and the Rust flagship-boot crate.
//
// Run: node --import tsx tools/boot-unseal-vectors.mjs
//
// Seals use fixed ephemeral keys and nonces (the protocol's sealForRecipient
// draws them at random), built from the same noble primitives encryption.ts
// uses; every positive case is checked against the real protocol opener
// before it is written. Ed25519 signatures are deterministic.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "../packages/protocol/src/edSync.ts";
import { FLAGSHIP_SEAL_TAG, openSealedFromEd25519Recipient } from "../packages/protocol/src/encryption.ts";
import { openSealedSecretResponse, signSecretRequest, verifySecretRequest } from "../packages/protocol/src/phoneEndpoint.ts";
import { canonicalBootAuth, signBootAuth } from "../packages/protocol/src/bootAuth.ts";

const OUT = new URL("../packages/protocol/test-vectors/boot-unseal/vectors.json", import.meta.url);
const PINNED = new URL("./unseal-crosscheck/tests/pinned-vector.json", import.meta.url);

const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const fill = (n, len = 32) => new Uint8Array(len).fill(n);
const seq = (len, f) => Uint8Array.from({ length: len }, (_, i) => f(i) & 0xff);

const boxA = { seed: fill(0x0b), domain: "home.alice.flagship.services" };
const boxB = { seed: fill(0x0c), domain: "home.bob.flagship.services" };
for (const b of [boxA, boxB]) {
  b.pub = ed.getPublicKey(b.seed);
  b.xpub = ed25519.utils.toMontgomery(b.pub);
}

/** sealForRecipient with chosen randomness; `ephPubBytes` lets a case alter the header. */
function seal(plaintext, recipientXPub, ephPriv, nonce, ephPubBytes) {
  const ephPub = ephPubBytes ?? x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientXPub);
  const key = hkdf(sha256, shared, ephPub, new TextEncoder().encode(FLAGSHIP_SEAL_TAG), 32);
  const ct = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(44 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 44);
  return out;
}

function responsePayload(secret, nonceHex, purpose) {
  const ctx = new TextEncoder().encode(["flagship/secret-response/v1", nonceHex, purpose].join("|"));
  const out = new Uint8Array(4 + ctx.length + secret.length);
  new DataView(out.buffer).setUint32(0, ctx.length, false);
  out.set(ctx, 4);
  out.set(secret, 4 + ctx.length);
  return out;
}

const luksKey = seq(64, (i) => i * 13 + 7);
const eph1 = fill(0x31), eph2 = fill(0x32), eph3 = fill(0x33);
const n1 = fill(0x41, 12), n2 = fill(0x42, 12), n3 = fill(0x43, 12);
const reqNonceHex = hex(fill(0x22));
const otherNonceHex = hex(fill(0x23));

const leaseBlob = seal(luksKey, boxA.xpub, eph1, n1);
const respBlob = seal(responsePayload(luksKey, reqNonceHex, "unlock-key"), boxA.xpub, eph2, n2);
const respForB = seal(responsePayload(luksKey, reqNonceHex, "unlock-key"), boxB.xpub, eph2, n2);
const flip = (b, i, mask = 1) => {
  const c = b.slice();
  c[i] ^= mask;
  return c;
};
const highBitEph = (() => {
  const p = x25519.getPublicKey(eph3);
  const q = p.slice();
  q[31] |= 0x80;
  return q;
})();

const pinned = JSON.parse(readFileSync(PINNED, "utf8"));

const GCM = "gcm open (tag mismatch / wrong key): cipher: message authentication failed";
const unseal = [];
const add = (c) => unseal.push(c);
const raw = (name, about, seed, blob, expect) =>
  add({ name, about, kind: "raw", identityPrivHex: hex(seed), sealedHex: typeof blob === "string" ? blob : hex(blob), expect });
const resp = (name, about, seed, blob, nonceHex, purpose, expect) =>
  add({ name, about, kind: "response", identityPrivHex: hex(seed), sealedHex: hex(blob), nonceHex, purpose, expect });

raw("lease-ok", "AutoUnlockLeaseV2.sealedKey for box A, a 64-byte LUKS key", boxA.seed, leaseBlob, { ok: true, secretHex: hex(luksKey) });
raw("pinned-raw", "tools/unseal-crosscheck/tests/pinned-vector.json raw, frozen from @flagship/protocol", unhex(pinned.raw.identityPrivHex), pinned.raw.sealedHex, { ok: true, secretHex: pinned.raw.expectedSecretHex });
raw("lease-high-bit-ephemeral", "bit 255 of the ephemeral u-coordinate set: every X25519 here ignores it (RFC 7748)", boxA.seed, seal(luksKey, boxA.xpub, eph3, n3, highBitEph), { ok: true, secretHex: hex(luksKey) });
raw("lease-tampered-ciphertext", "one ciphertext bit flipped", boxA.seed, flip(leaseBlob, 50), { ok: false, error: GCM });
raw("lease-tampered-tag", "one tag bit flipped", boxA.seed, flip(leaseBlob, leaseBlob.length - 1), { ok: false, error: GCM });
raw("lease-tampered-nonce", "one nonce bit flipped", boxA.seed, flip(leaseBlob, 33), { ok: false, error: GCM });
raw("lease-tampered-ephemeral", "one ephemeral-key bit flipped", boxA.seed, flip(leaseBlob, 0, 2), { ok: false, error: GCM });
raw("lease-wrong-server", "box A's lease opened by box B's STK", boxB.seed, leaseBlob, { ok: false, error: GCM });
raw("lease-truncated-header", "43 bytes: no room for the ephemeral key and nonce", boxA.seed, leaseBlob.slice(0, 43), { ok: false, error: "sealed blob too short (need at least eph_pub + nonce)" });
raw("lease-truncated-tag", "header plus 15 bytes: shorter than a GCM tag", boxA.seed, leaseBlob.slice(0, 59), { ok: false, error: GCM });
raw("lease-low-order-ephemeral", "all-zero ephemeral key: all-zero shared secret is refused", boxA.seed, new Uint8Array(76), { ok: false, error: "x25519: crypto/ecdh: bad X25519 remote ECDH input: low order point" });

resp("response-ok", "SealedSecretResponse for box A's unlock-key request", boxA.seed, respBlob, reqNonceHex, "unlock-key", { ok: true, secretHex: hex(luksKey) });
resp("pinned-response", "tools/unseal-crosscheck/tests/pinned-vector.json response", unhex(pinned.response.identityPrivHex), unhex(pinned.response.sealedHex), pinned.response.nonceHex, pinned.response.purpose, { ok: true, secretHex: pinned.response.expectedSecretHex });
resp("response-replayed", "a reply to an earlier request (other nonce) offered for this boot's request", boxA.seed, respBlob, otherNonceHex, "unlock-key", { ok: false, error: "sealed secret response bound to a different (nonce, purpose)" });
resp("response-repurposed", "an unlock-key reply offered as an entitlement", boxA.seed, respBlob, reqNonceHex, "entitlement", { ok: false, error: "sealed secret response bound to a different (nonce, purpose)" });
resp("response-wrong-server", "a reply sealed for box B offered to box A", boxA.seed, respForB, reqNonceHex, "unlock-key", { ok: false, error: GCM });
resp("response-tampered", "one ciphertext bit flipped", boxA.seed, flip(respBlob, 60), reqNonceHex, "unlock-key", { ok: false, error: GCM });
const overlong = new Uint8Array(8);
new DataView(overlong.buffer).setUint32(0, 1000, false);
resp("response-truncated-context", "length prefix points past the payload", boxA.seed, seal(overlong, boxA.xpub, eph1, n1), reqNonceHex, "unlock-key", { ok: false, error: "sealed secret response payload truncated" });
resp("response-too-short", "payload shorter than the 4-byte length prefix", boxA.seed, seal(new Uint8Array(3), boxA.xpub, eph1, n1), reqNonceHex, "unlock-key", { ok: false, error: "sealed secret response payload too short" });

// Check every case against the real protocol before writing it.
for (const c of unseal) {
  let got;
  try {
    const seed = unhex(c.identityPrivHex);
    const sealed = unhex(c.sealedHex);
    const out = c.kind === "raw"
      ? openSealedFromEd25519Recipient(sealed, seed)
      : openSealedSecretResponse(
          { serverDomain: "", requestNonceHex: c.nonceHex, purpose: c.purpose, sealed, issuedAt: 0 },
          { serverDomain: "", stkPub: new Uint8Array(32), purpose: c.purpose, nonce: unhex(c.nonceHex), issuedAt: 0 },
          seed,
        );
    got = { ok: true, secretHex: hex(out) };
  } catch {
    got = { ok: false };
  }
  if (got.ok !== c.expect.ok || (got.ok && got.secretHex !== c.expect.secretHex)) {
    throw new Error(`${c.name}: protocol says ${JSON.stringify(got)}, vector says ${JSON.stringify(c.expect)}`);
  }
}

// Signed requests. T is the box's clock; the worker's window is ±5 minutes.
const T = 1760000000000;
const MAX_AGE_MS = 5 * 60_000;
const leasePath = `/api/boot/lease/${boxA.domain}`;
const pollPath = `/api/boot/response/${boxA.domain}/${reqNonceHex}`;
function header(box, method, path, nonceByte, issuedAt, domain = box.domain) {
  const args = { role: "box", serverDomain: domain, method, path, pubKeyHex: hex(box.pub), nonceHex: hex(fill(nonceByte)), issuedAt };
  return {
    method,
    path,
    serverDomain: domain,
    pubKeyHex: args.pubKeyHex,
    nonceHex: args.nonceHex,
    issuedAt,
    canonical: new TextDecoder().decode(canonicalBootAuth(args)),
    signatureHex: hex(ed.sign(canonicalBootAuth(args), box.seed)),
    authorization: signBootAuth(args, box.seed),
  };
}
const leaseGet = header(boxA, "GET", leasePath, 0x51, T);
const requestPost = header(boxA, "POST", "/api/boot/request", 0x52, T);
const responsePoll = header(boxA, "GET", pollPath, 0x53, T);
const forgedByB = header(boxB, "GET", leasePath, 0x54, T, boxA.domain);

const secretRequest = {
  serverDomain: boxA.domain,
  stkPubHex: hex(boxA.pub),
  purpose: "unlock-key",
  nonceHex: reqNonceHex,
  issuedAt: T,
};
const srFields = { serverDomain: secretRequest.serverDomain, stkPub: boxA.pub, purpose: "unlock-key", nonce: unhex(reqNonceHex), issuedAt: T };
const srSig = hex(signSecretRequest(srFields, { privateKey: boxA.seed, publicKey: boxA.pub }));
secretRequest.canonical = ["flagship/secret-request/v1", boxA.domain, hex(boxA.pub), "unlock-key", reqNonceHex, T].join("|");
secretRequest.signatureHex = srSig;
secretRequest.body = `{"request":{"serverDomain":"${boxA.domain}","stkPub":"${hex(boxA.pub)}","purpose":"unlock-key","nonce":"${reqNonceHex}","issuedAt":${T}},"signature":"${srSig}"}`;
if (!verifySecretRequest(srFields, unhex(srSig), boxA.pub)) throw new Error("secret request does not verify");
const srByB = hex(signSecretRequest(srFields, { privateKey: boxB.seed, publicKey: boxB.pub }));

const tampered = { ...leaseGet, signatureHex: hex(flip(unhex(leaseGet.signatureHex), 0)) };
tampered.authorization = `Flagship-Boot-v1 ${Buffer.from(JSON.stringify({ role: "box", serverDomain: tampered.serverDomain, method: "GET", path: leasePath, pubKeyHex: tampered.pubKeyHex, nonceHex: tampered.nonceHex, issuedAt: T, signatureHex: tampered.signatureHex })).toString("base64url")}`;

const vectors = {
  about:
    "Early-boot unlock wire shared by TS (packages/protocol, packages/boot-core), Go (installer/unseal-helper via tools/unseal-crosscheck) and Rust (rust/crates/flagship-boot). Generated by tools/boot-unseal-vectors.mjs. Seeds are 32 repeated bytes; seals use fixed ephemeral keys and nonces; Ed25519 is deterministic. `expect.error` is the Go helper's message (stderr carries it after 'flagship-unseal: ').",
  workerMaxAgeMs: MAX_AGE_MS,
  boxes: {
    A: { seedHex: hex(boxA.seed), pubHex: hex(boxA.pub), x25519PubHex: hex(boxA.xpub), serverDomain: boxA.domain },
    B: { seedHex: hex(boxB.seed), pubHex: hex(boxB.pub), x25519PubHex: hex(boxB.xpub), serverDomain: boxB.domain },
  },
  unseal,
  secretRequest: { ...secretRequest, signatureByBoxBHex: srByB },
  bootAuth: {
    leaseGet,
    requestPost,
    responsePoll,
  },
  gateCases: [
    { name: "fresh", about: "box A's lease GET at its own time", header: "leaseGet", route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T, expect: { ok: true } },
    { name: "clock-skew-inside-window", about: "worker clock 5 minutes ahead: still fresh", header: "leaseGet", route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T + MAX_AGE_MS, expect: { ok: true } },
    { name: "expired", about: "presented 5 minutes and 1 ms after it was signed", header: "leaseGet", route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T + MAX_AGE_MS + 1, expect: { ok: false, status: 403, error: "stale request" } },
    { name: "from-the-future", about: "box clock more than 5 minutes ahead of the worker", header: "leaseGet", route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T - MAX_AGE_MS - 1, expect: { ok: false, status: 403, error: "stale request" } },
    { name: "replayed", about: "the same header a second time", header: "leaseGet", replay: true, route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T, expect: { ok: false, status: 403, error: "replayed nonce" } },
    { name: "wrong-server", about: "box A's header aimed at box B's lease", header: "leaseGet", route: { serverDomain: boxB.domain, method: "GET", path: `/api/boot/lease/${boxB.domain}` }, now: T, expect: { ok: false, status: 403, error: "serverDomain binding mismatch" } },
    { name: "wrong-route", about: "a lease GET header replayed as the request POST", header: "leaseGet", route: { serverDomain: boxA.domain, method: "POST", path: "/api/boot/request" }, now: T, expect: { ok: false, status: 403, error: "method binding mismatch" } },
    { name: "wrong-key", about: "box B's STK signing for box A's domain", header: "forgedByB", route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T, expect: { ok: false, status: 403, error: "box STK not bound to this server" } },
    { name: "tampered-signature", about: "one signature bit flipped", header: "tampered", route: { serverDomain: boxA.domain, method: "GET", path: leasePath }, now: T, expect: { ok: false, status: 403, error: "invalid signature" } },
  ],
  headers: { leaseGet: leaseGet.authorization, forgedByB: forgedByB.authorization, tampered: tampered.authorization },
  nonceSeeds: { leaseGet: 0x51, requestPost: 0x52, responsePoll: 0x53 },
};

mkdirSync(dirname(OUT.pathname), { recursive: true });
writeFileSync(OUT, JSON.stringify(vectors, null, 2) + "\n");
console.log("wrote", OUT.pathname, `(${unseal.length} unseal cases)`);

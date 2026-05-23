// Regenerate the PINNED cross-check vector. Run only intentionally — the whole
// point of the pinned vector is that it is frozen: it was produced by a known
// @flagship/protocol and the Go binary must reproduce its secret forever after.
// If a protocol change legitimately alters the wire format, the maintainer
// re-runs this AND bumps the Go binary to match, with the diff under review.
//
//   npm --workspace @flagship/unseal-crosscheck run gen-vector
//
// Writes tests/pinned-vector.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRawVector, makeResponseVector } from "../src/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../tests/pinned-vector.json");

// Fixed inputs. The seed + secret are arbitrary-but-fixed; the sealed bytes
// carry the protocol's random ephemeral key + nonce, captured at generation.
const seedHex = "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506";
const secret = new Uint8Array(32);
for (let i = 0; i < secret.length; i++) secret[i] = (i * 7 + 3) & 0xff;

const nonce = new Uint8Array(32);
for (let i = 0; i < nonce.length; i++) nonce[i] = (i * 11 + 5) & 0xff;

const raw = makeRawVector(seedHex, secret);
const response = makeResponseVector(seedHex, secret, {
  serverDomain: "kitchen.alice.flagship.services",
  purpose: "unlock-key",
  nonce,
  issuedAt: 1_700_000_000_000,
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ raw, response }, null, 2) + "\n");
console.log("wrote", out);

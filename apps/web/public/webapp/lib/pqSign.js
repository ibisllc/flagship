// Hybrid signing in the browser (docs/webapp-key-custody.md item 4; pq-suites.md §5): the suite
// flagship/hybrid-sig/ed25519-mldsa65/v1, Ed25519 half by noble (the same code the verifier
// bundles) and ML-DSA-65 half by the pinned mldsa-native WebAssembly module (lib/mldsaWasm.js).
// Port of packages/protocol/src/pqHybrid.ts hybridSign / pqTrust.ts signPqKeyBinding; the
// deterministic outputs match packages/protocol/test-vectors/pq-hybrid and pq-binding byte for byte.
//
// Callers pass seeds they unwrapped for this one action (lib/keyCustody.js) and wipe them after.
// Every signature is checked with the verifier before it is returned, so a bad module or seed never
// leaves a signature behind. Custody label of every key signed here: "software".

import { ed25519 } from "../vendor/noble-post-quantum/pq-verify.js";
import { mldsaPublicKey, mldsaSign } from "./mldsaWasm.js";
import { canonicalPqKeyBinding, hybridMessage, hybridVerify, messagePurpose, TAG_PQ_KEY_BINDING } from "./pqBinding.js";

export const SUITE_HYBRID = "hybrid-ed25519-mldsa65/v1";
const SUITE_TAG = "flagship/hybrid-sig/ed25519-mldsa65/v1";
const CONTEXT = new TextEncoder().encode(SUITE_TAG);
const PURPOSE = /^flagship(\/[a-z0-9][a-z0-9-]{0,47}){1,6}\/v[1-9][0-9]{0,3}$/;
const MAX_PAYLOAD = 1_048_576;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function seeds(edSeed, mldsaSeed) {
  if (!(edSeed instanceof Uint8Array) || edSeed.length !== 32 || !(mldsaSeed instanceof Uint8Array) || mldsaSeed.length !== 32) fail("bad-secret-key");
}

/** The 1984-byte hybrid public key (Ed25519 || ML-DSA-65) of two seeds. */
export async function hybridPublicKey(edSeed, mldsaSeed) {
  seeds(edSeed, mldsaSeed);
  return concat(ed25519.getPublicKey(edSeed), await mldsaPublicKey(mldsaSeed));
}

/** Signs `payload` under `purpose`; the result verifies or this throws. */
export async function hybridSign(edSeed, mldsaSeed, purpose, payload, opts = {}) {
  seeds(edSeed, mldsaSeed);
  if (typeof purpose !== "string" || purpose.length > 128 || !PURPOSE.test(purpose)) fail("bad-purpose");
  if (!(payload instanceof Uint8Array) || payload.length > MAX_PAYLOAD) fail("payload-too-large");
  const pk = opts.publicKey ?? (await hybridPublicKey(edSeed, mldsaSeed));
  const m = hybridMessage(pk, purpose, payload);
  const ml = await mldsaSign(mldsaSeed, m, CONTEXT, { deterministic: opts.deterministic === true });
  const sig = concat(ed25519.sign(m, edSeed), ml);
  if (!hybridVerify(pk, purpose, payload, sig)) fail("bad-signature");
  return sig;
}

/** The envelope a sensitive order carries beside its classical signature (`pqSignature`). */
export async function hybridEnvelope(message, edSeed, mldsaSeed, opts = {}) {
  const purpose = messagePurpose(message);
  if (!purpose) fail("bad-purpose");
  return { suite: SUITE_HYBRID, signature: hex(await hybridSign(edSeed, mldsaSeed, purpose, message, opts)) };
}

/** A `flagship/pq-key-binding/v1` both halves sign (role, subject, the two keys, the time). */
export async function signPqKeyBinding({ role, subjectId, issuedAt }, edSeed, mldsaSeed, opts = {}) {
  const pk = await hybridPublicKey(edSeed, mldsaSeed);
  const st = { role, subjectId, ed25519PubHex: hex(pk.subarray(0, 32)), mldsaPubHex: hex(pk.subarray(32)), issuedAt };
  const sig = await hybridSign(edSeed, mldsaSeed, TAG_PQ_KEY_BINDING, canonicalPqKeyBinding(st), { ...opts, publicKey: pk });
  return { v: 1, ...st, signature: hex(sig) };
}

// The complete, versioned cloud-recovery record (SECURITY-HARDENING-PLAN.md 18.3, N03).
// Mirrors packages/protocol/src/recoveryRecord.ts; shared vectors are
// packages/protocol/test-vectors/recovery-record/vectors.json.
//
// Every behaviour-changing value is signed: the ciphertext digests, the fetch-token and PRF-salt
// hashes, the versions and policy, the record's generation and the digest of the record it
// replaces. Optional escrows are never omitted: each is keep:<digest>, replace:<digest>, remove
// or none, so inheriting security state is a signed act.

export const TAG_RECOVERY_RECORD = "flagship/recovery-record/v2";
export const KDF_VERSION = 1;
export const ALG_VERSION = 1;
export const RECOVERY_POLICY = "passkey-and-passphrase";

const HEX64 = /^[0-9a-f]{64}$/;
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

export async function sha256Hex(bytes) {
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function escrowField(name, e) {
  if (e.change === "remove" || e.change === "none") return e.change;
  if (e.change !== "keep" && e.change !== "replace") throw new Error(`invalid ${name}`);
  if (!HEX64.test(e.digestHex)) throw new Error(`${name} digest must be 64 lowercase hex characters`);
  return `${e.change}:${e.digestHex}`;
}

export function canonicalRecoveryRecordBytes(r) {
  if (r.op !== "put" && r.op !== "delete") throw new Error("invalid op");
  for (const k of ["username", "credentialIdHex"]) {
    if (!r[k] || /[|\u0000-\u001f\u007f]/.test(r[k])) throw new Error(`bad ${k}`);
  }
  if (!HEX64.test(r.irkPubHex)) throw new Error("irkPubHex must be 64 lowercase hex characters");
  if (r.adminRootPubHex !== "none" && !HEX64.test(r.adminRootPubHex)) throw new Error("invalid adminRootPubHex");
  if (!/^[0-9a-f]{16,512}$/.test(r.credentialIdHex)) throw new Error("invalid credentialIdHex");
  for (const k of ["wrappedUmkDigestHex", "fetchTokenHashHex", "prfSaltHashHex"]) {
    if (!HEX64.test(r[k])) throw new Error(`${k} must be 64 lowercase hex characters`);
  }
  if (r.kdfVersion !== KDF_VERSION) throw new Error("unknown kdfVersion");
  if (r.algVersion !== ALG_VERSION) throw new Error("unknown algVersion");
  if (r.policy !== RECOVERY_POLICY) throw new Error("unknown policy");
  if (!Number.isSafeInteger(r.generation) || r.generation < 1) throw new Error("invalid generation");
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) throw new Error("invalid issuedAt");
  if (!/^[0-9a-f]{32}$/.test(r.nonceHex)) throw new Error("nonceHex must be 32 lowercase hex characters");
  if (r.priorDigestHex !== "genesis" && r.priorDigestHex !== "legacy" && !HEX64.test(r.priorDigestHex)) throw new Error("invalid priorDigestHex");
  if (r.priorDigestHex === "genesis" && r.generation !== 1) throw new Error("a genesis record is generation 1");
  return new TextEncoder().encode([
    TAG_RECOVERY_RECORD, r.op, r.username.toLowerCase(), r.irkPubHex, r.adminRootPubHex, r.credentialIdHex,
    r.wrappedUmkDigestHex, escrowField("adminRoot", r.adminRoot), escrowField("acmeKey", r.acmeKey),
    r.fetchTokenHashHex, r.prfSaltHashHex, r.kdfVersion, r.algVersion, r.policy, r.generation, r.nonceHex,
    r.priorDigestHex, r.issuedAt,
  ].join("|"));
}

export async function recoveryRecordDigest(r) {
  return sha256Hex(canonicalRecoveryRecordBytes(r));
}

/**
 * What to say about one escrow this write: replace it with new ciphertext, keep exactly what the
 * server holds, or state that there is none. `held` is the digest from the metadata read.
 */
export async function escrowChange(newB64, heldDigestHex) {
  if (newB64) return { change: "replace", digestHex: await sha256Hex(base64ToBytes(newB64)) };
  if (heldDigestHex) return { change: "keep", digestHex: heldDigestHex };
  return { change: "none" };
}

/**
 * Build the body for POST/DELETE /api/recovery. `current` is the metadata GET body for the
 * account's stored record, or null when there is none. `sign(bytes)` is the account-key signer.
 */
export async function buildRecoveryEnvelope({
  op, username, authority, current, credentialIdHex, wrappedUmkB64, wrappedAdminRootB64, wrappedAcmeAccountKeyB64,
  fetchTokenHashHex, prfSaltHashHex, wrappedUmkDigestHex, sign, now = Date.now,
}) {
  const priorDigestHex = current ? (current.legacy ? "legacy" : current.digestHex) : "genesis";
  const generation = current && !current.legacy ? current.generation + 1 : 1;
  const claim = {
    op,
    username,
    irkPubHex: authority.irkPubHex,
    adminRootPubHex: authority.adminRootPubHex,
    credentialIdHex,
    wrappedUmkDigestHex: wrappedUmkDigestHex ?? (await sha256Hex(base64ToBytes(wrappedUmkB64))),
    adminRoot: await escrowChange(wrappedAdminRootB64, current?.adminRootDigestHex),
    acmeKey: await escrowChange(wrappedAcmeAccountKeyB64, current?.acmeKeyDigestHex),
    fetchTokenHashHex,
    prfSaltHashHex,
    kdfVersion: KDF_VERSION,
    algVersion: ALG_VERSION,
    policy: RECOVERY_POLICY,
    generation,
    nonceHex: hexOf(crypto.getRandomValues(new Uint8Array(16))),
    priorDigestHex,
    issuedAt: now(),
  };
  const signature = hexOf(await sign(canonicalRecoveryRecordBytes(claim)));
  return {
    claim,
    signature,
    ...(wrappedUmkB64 ? { wrappedUmk: wrappedUmkB64 } : {}),
    ...(wrappedAdminRootB64 ? { wrappedAdminRoot: wrappedAdminRootB64 } : {}),
    ...(wrappedAcmeAccountKeyB64 ? { wrappedAcmeAccountKey: wrappedAcmeAccountKeyB64 } : {}),
  };
}

/** Does the claim's signature verify under the account key the recovered UMK derives? */
export async function verifySignedRecord(claim, signatureHex, irkPub, verifyEd25519) {
  try {
    if (hexOf(irkPub) !== claim.irkPubHex) return false;
    return await verifyEd25519(irkPub, bytesOf(signatureHex), canonicalRecoveryRecordBytes(claim));
  } catch {
    return false;
  }
}

/**
 * Before anything is unwrapped: is every ciphertext the server handed back the one the signed
 * claim names? Returns null when it is, else the reason.
 */
export async function ciphertextMismatch(claim, { wrappedUmkB64, wrappedAdminRootB64, wrappedAcmeAccountKeyB64 }) {
  if (!wrappedUmkB64 || (await sha256Hex(base64ToBytes(wrappedUmkB64))) !== claim.wrappedUmkDigestHex) return "wrappedUmk";
  const held = async (b64, e, name) => {
    const want = e.change === "keep" || e.change === "replace" ? e.digestHex : undefined;
    if (!want) return b64 ? name : null;
    if (!b64) return name;
    return (await sha256Hex(base64ToBytes(b64))) === want ? null : name;
  };
  return (await held(wrappedAdminRootB64, claim.adminRoot, "wrappedAdminRoot")) ?? (await held(wrappedAcmeAccountKeyB64, claim.acmeKey, "wrappedAcmeAccountKey"));
}

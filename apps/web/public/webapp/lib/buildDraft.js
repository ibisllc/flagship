// Phone-side InstallBlob draft composer (task #60).
//
// Drafts are stored in IndexedDB under the user's session so a partly-filled
// build can be picked back up later (e.g. user closes the tab to go find
// their LLM provider key). Each draft carries:
//   - serverName        (DNS label)
//   - backupPolicy      ("none" | "phone-only" | "peer")
//   - llmPreferences    ({ providerId, modelName }[])
//   - status            "draft" | "delivered" | "deployed"
//
// On "Deliver now" the composer:
//   1. Calls /api/auth-code/issue + /api/build-tickets/issue equivalents
//      via the existing dev/create-server-style canonical signed messages
//      (the webapp already has the user's IRK after unlock).
//   2. Opens a relay session on flagshipserver.com.
//   3. Generates an X25519 keypair, encrypts the canonical InstallBlob
//      + signature for the BROWSER's ephemeral pubkey (received over
//      the WebSocket), and pushes the ciphertext through.
//   4. Marks the draft `delivered` once the relay ACKs.
//
// crypto_box_seal-compatible encryption mirrors
// packages/protocol/src/encryption.ts `sealForRecipient`:
//   ikm  = X25519(ephPriv, recipientPub)
//   key  = HKDF-SHA256(ikm, salt=ephPub, info="flagship.seal.v1", L=32)
//   out  = ephPub || nonce || AES-GCM(key, nonce, plaintext)
//
// This module does NOT touch the actual phone-app code; only the webapp
// peer's draft composer is in scope. iOS/Android composers will mirror
// the same canonical-bytes shape natively (Swift + Kotlin).

const DB_NAME = "flagship-webapp";
const DRAFT_STORE = "buildDrafts";
const DB_VERSION = 2; // bumped from 1 in keystore.js — both stores live here

const TAG_INSTALL_BLOB = "flagship/install-blob/v1";

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      // keystore.js created `keystore` at v1; preserve it.
      if (!db.objectStoreNames.contains("keystore")) {
        db.createObjectStore("keystore");
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: "id" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function txStore(mode) {
  const db = await openDb();
  const tx = db.transaction(DRAFT_STORE, mode);
  return tx.objectStore(DRAFT_STORE);
}

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
}

export async function saveDraft(draft) {
  const store = await txStore("readwrite");
  const id = draft.id ?? uuid();
  const record = {
    id,
    serverName: draft.serverName ?? "",
    backupPolicy: draft.backupPolicy ?? "phone-only",
    llmPreferences: draft.llmPreferences ?? [],
    status: draft.status ?? "draft",
    createdAt: draft.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    deliveredAt: draft.deliveredAt,
    code: draft.code,
  };
  await new Promise((resolve, reject) => {
    const r = store.put(record);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
  return record;
}

export async function listDrafts() {
  const store = await txStore("readonly");
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => {
      const out = r.result ?? [];
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(out);
    };
    r.onerror = () => reject(r.error);
  });
}

export async function getDraft(id) {
  const store = await txStore("readonly");
  return new Promise((resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

export async function deleteDraft(id) {
  const store = await txStore("readwrite");
  return new Promise((resolve, reject) => {
    const r = store.delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

/**
 * Canonical-bytes for the InstallBlob — same join/format as
 * `packages/protocol/src/auth.ts canonicalInstallBlob`. Both sides
 * derive their signature input from this function so the wire-format
 * bytes are guaranteed identical.
 */
export function canonicalInstallBlob(b) {
  // v2: blob.issuedAt + blob.expiresAt dropped. Tag stays v1; the
  // inner `version` field (2) discriminates v1-vs-v2 inputs.
  const parts = [
    TAG_INSTALL_BLOB,
    b.version,
    b.serverDomain,
    b.username,
    b.serverName,
    bytesToHex(b.phoneDelegatedPubKey),
    b.registrationUrl,
    b.authCode.serial,
    bytesToHex(b.authCode.userPubKey),
    bytesToHex(b.authCodeUserSignature),
    b.installerGitRef,
    bytesToHex(b.rckPubKey),
  ];
  // Backward-compatible extension (mirror of `canonicalInstallBlob` in
  // packages/protocol/src/auth.ts): a blob WITHOUT bootUnlockMode produces
  // the exact pre-existing canonical bytes (old signatures keep verifying).
  // When present it is appended as the LAST field, so the signer commits to
  // it — a relay cannot strip the field (signature would fail) nor downgrade
  // the value. MUST stay byte-identical to the TS or the QR→burner→register
  // signature chain breaks.
  if (b.bootUnlockMode !== undefined) parts.push(b.bootUnlockMode);
  return new TextEncoder().encode(parts.join("|"));
}

function bytesToHex(b) {
  if (typeof b === "string") return b; // already hex
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * Seal an arbitrary plaintext (Uint8Array) for the browser's
 * ephemeral X25519 public key (32 raw bytes). Output layout matches
 * `sealForRecipient` in @flagship/protocol:
 *
 *   [ephPub: 32 B][nonce: 12 B][AES-GCM ciphertext + tag]
 */
export async function sealForBrowserKey(plaintext, browserPkHex) {
  const browserPub = hexToBytes(browserPkHex);
  if (browserPub.length !== 32) throw new Error("browserPk must be 32 bytes");

  const eph = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const ephPubBytes = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const recipientKey = await crypto.subtle.importKey("raw", browserPub, "X25519", false, []);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: recipientKey },
    eph.privateKey,
    256,
  );
  const sharedKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const symBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephPubBytes,
      info: new TextEncoder().encode("flagship.seal.v1"),
    },
    sharedKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(symBits),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext),
  );
  const out = new Uint8Array(32 + 12 + ct.length);
  out.set(ephPubBytes, 0);
  out.set(nonce, 32);
  out.set(ct, 44);
  return out;
}

/**
 * Derive the same 6-digit match code the relay computes server-side
 * (see apps/com/src/buildRelay.ts deriveMatchCode). Both surfaces
 * derive independently from (sessionId, browserPk); the user
 * compares both surfaces visually before approving the transfer.
 */
export async function deriveMatchCode(sessionId, browserPkHex) {
  const sessionBytes = new TextEncoder().encode(sessionId);
  const pkBytes = hexToBytes(browserPkHex);
  const ikm = new Uint8Array(sessionBytes.length + pkBytes.length);
  ikm.set(sessionBytes, 0);
  ikm.set(pkBytes, sessionBytes.length);
  const salt = new TextEncoder().encode("flagship/build-relay/v1");
  const info = new TextEncoder().encode("match-code");
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    baseKey,
    32,
  );
  const u32 = new DataView(bits).getUint32(0, false);
  return (u32 % 1_000_000).toString().padStart(6, "0");
}

export const _internal = {
  uuid,
  bytesToHex,
  hexToBytes,
  bytesToBase64,
};

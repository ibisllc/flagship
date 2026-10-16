// The two files of a server backup (docs/server-backup-and-clone.md), the
// webapp's port of packages/protocol/src/serverBackup.ts. Must pass
// packages/protocol/test-vectors/server-backup/vectors.json and
// server-restore/vectors.json, like the box, iOS and Android.
//
//   <name>.flagship-backup  small JSON: key slots + a body sealed under the content key
//   <name>.flagship-data    the apps, sealed in frames (only the box opens them)
//
// The webapp opens the backup file (account slot first, else the passcode),
// checks the data file by streaming its SHA-256 (never holding it), makes the
// slots for a new backup, and signs the restore order a new server waits on.

import { argon2idAsync } from "../vendor/noble-hashes/argon2.js";
import { sha256 } from "../vendor/noble-hashes/sha2.js";
import { bytesToHex, hexToBytes } from "../keystore.js";

export const BACKUP_MAGIC = "flagship-backup";
export const BACKUP_VERSION = 2;
export const BACKUP_DATA_MAGIC = "flagship-backup-data/v2\n";
export const BACKUP_FILE_EXTENSION = ".flagship-backup";
export const BACKUP_DATA_EXTENSION = ".flagship-data";
export const BACKUP_FILE_MAX_BYTES = 256 * 1024;
export const BACKUP_ARGON_PARAMS = { m: 65536, t: 3, p: 4 };
export const BACKUP_PASSCODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const TAG_SERVER_RESTORE = "flagship/server-restore/v1";

const TAG_SLOT = "flagship/server-backup-slot/v2";
const TAG_BODY = "flagship/server-backup-body/v2";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX24 = /^[0-9a-f]{24}$/;
const HEX96 = /^[0-9a-f]{96}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const enc = (s) => new TextEncoder().encode(s);

export class BackupError extends Error {
  /** @param {string} message @param {"malformed"|"version"|"locked"|"damaged"} code */
  constructor(message, code) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Passcodes
// ---------------------------------------------------------------------------

export function normalizePasscode(passcode) {
  return String(passcode).normalize("NFC").trim();
}

/** Why a passcode the user chose is too weak, or null. */
export function passcodeProblem(passcode) {
  const p = normalizePasscode(passcode);
  const len = [...p].length;
  if (len >= 20) return null;
  if (len < 12) return "Use at least 12 characters (or 20 if it's all one kind, like words).";
  let kinds = 0;
  if (/[a-z]/.test(p)) kinds++;
  if (/[A-Z]/.test(p)) kinds++;
  if (/[0-9]/.test(p)) kinds++;
  if (/[^A-Za-z0-9]/.test(p)) kinds++;
  return kinds >= 3 ? null : "Mix at least three of: lowercase, uppercase, digits, symbols (or use 20 characters).";
}

/** A suggested passcode: five groups of four, 100 bits. */
export function generatePasscode(rng = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    const b = rng(4);
    groups.push(Array.from(b, (x) => BACKUP_PASSCODE_ALPHABET[x & 31]).join(""));
  }
  return groups.join("-");
}

function validParams(k) {
  const ok = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  return !!k && ok(k.p, 1, 16) && ok(k.t, 1, 16) && ok(k.m, 8, 1048576) && k.m >= 8 * k.p;
}

/** Argon2id of the normalized passcode (yields to the page while it works). */
export async function passcodeKek(passcode, kdf) {
  if (!validParams(kdf) || !HEX32.test(String(kdf.saltHex))) throw new BackupError("The passcode settings in this backup are damaged.", "malformed");
  return argon2idAsync(enc(normalizePasscode(passcode)), hexToBytes(kdf.saltHex), { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32 });
}

// ---------------------------------------------------------------------------
// AES-256-GCM (WebCrypto appends the tag, like the other ports)
// ---------------------------------------------------------------------------

async function seal(key, nonce, aad, plain) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, k, plain));
}

async function open(key, nonce, aad, ct) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, k, ct));
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function slotAad(archiveId, slot) {
  const parts = [TAG_SLOT, slot.kind, archiveId];
  if (slot.kind === "passcode") {
    const k = slot.kdf;
    parts.push(k.algo, `m=${k.m}`, `t=${k.t}`, `p=${k.p}`, k.saltHex);
  }
  return enc(parts.join("|"));
}

export async function wrapAccountSlot(archiveId, contentKey, kek, nonce) {
  const slot = { kind: "account" };
  return { kind: "account", nonceHex: bytesToHex(nonce), wrappedHex: bytesToHex(await seal(kek, nonce, slotAad(archiveId, slot), contentKey)) };
}

export async function wrapPasscodeSlot(archiveId, contentKey, passcode, salt, nonce, params = BACKUP_ARGON_PARAMS) {
  const kdf = { algo: "argon2id", m: params.m, t: params.t, p: params.p, saltHex: bytesToHex(salt) };
  const kek = await passcodeKek(passcode, kdf);
  return {
    kind: "passcode",
    kdf,
    nonceHex: bytesToHex(nonce),
    wrappedHex: bytesToHex(await seal(kek, nonce, slotAad(archiveId, { kind: "passcode", kdf }), contentKey)),
  };
}

/** The content key from a slot, or null. */
export async function unwrapSlot(archiveId, slot, kek) {
  try {
    const key = await open(kek, hexToBytes(slot.nonceHex), slotAad(archiveId, slot), hexToBytes(slot.wrappedHex));
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The backup file
// ---------------------------------------------------------------------------

export function parseSlot(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof v.nonceHex !== "string" || !HEX24.test(v.nonceHex)) return null;
  if (typeof v.wrappedHex !== "string" || !HEX96.test(v.wrappedHex)) return null;
  if (v.kind === "account") return { kind: "account", nonceHex: v.nonceHex, wrappedHex: v.wrappedHex };
  if (v.kind !== "passcode") return null;
  const k = v.kdf;
  if (!k || k.algo !== "argon2id" || !validParams(k) || typeof k.saltHex !== "string" || !HEX32.test(k.saltHex)) return null;
  return { kind: "passcode", kdf: { algo: "argon2id", m: k.m, t: k.t, p: k.p, saltHex: k.saltHex }, nonceHex: v.nonceHex, wrappedHex: v.wrappedHex };
}

/** The outer layer of a backup file. Throws a readable BackupError. */
export function parseBackupFile(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new BackupError("That isn't a Flagship backup file.", "malformed");
  }
  if (!o || typeof o !== "object" || Array.isArray(o) || o.magic !== BACKUP_MAGIC) {
    throw new BackupError("That isn't a Flagship backup file.", "malformed");
  }
  if (o.v !== BACKUP_VERSION) {
    throw new BackupError(
      typeof o.v === "number" && o.v > BACKUP_VERSION
        ? "This backup is from a newer version of Flagship. Update the app and try again."
        : "This backup is from an older version of Flagship and can't be restored.",
      "version",
    );
  }
  const damaged = () => new BackupError("This backup file is damaged.", "malformed");
  if (typeof o.archiveId !== "string" || !HEX32.test(o.archiveId)) throw damaged();
  if (typeof o.bodyNonceHex !== "string" || !HEX24.test(o.bodyNonceHex)) throw damaged();
  if (typeof o.bodyHex !== "string" || !HEX.test(o.bodyHex) || o.bodyHex.length < 34) throw damaged();
  const slots = Array.isArray(o.slots) ? o.slots.map(parseSlot) : null;
  if (!slots || slots.length === 0 || slots.some((s) => s === null)) throw damaged();
  return { magic: BACKUP_MAGIC, v: BACKUP_VERSION, archiveId: o.archiveId, slots, bodyNonceHex: o.bodyNonceHex, bodyHex: o.bodyHex };
}

export function parseBackupBody(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const str = (v) => typeof v === "string";
  const s = o?.server;
  const d = o?.data;
  if (!o || !Number.isSafeInteger(o.createdAt)) return null;
  if (!s || !str(s.name) || !str(s.domain)) return null;
  if (s.bootUnlockMode !== "auto" && s.bootUnlockMode !== "approve") return null;
  if (s.diskEncryption !== "luks" && s.diskEncryption !== "none") return null;
  if (!d || !str(d.fileName) || !str(d.sha256) || !HEX64.test(d.sha256)) return null;
  if (!Number.isSafeInteger(d.bytes) || d.bytes < BACKUP_DATA_MAGIC.length) return null;
  if (!Number.isSafeInteger(d.frameBytes) || d.frameBytes < 1024 || d.frameBytes > 16 * 1024 * 1024) return null;
  if (!Array.isArray(o.apps) || !o.apps.every((a) => a && str(a.serviceId) && str(a.name))) return null;
  const left = Array.isArray(o.left) ? o.left : [];
  if (!left.every((a) => a && str(a.serviceId) && str(a.name) && str(a.reason))) return null;
  const strings = (v) => (Array.isArray(v) ? v.filter(str) : []);
  return {
    createdAt: o.createdAt,
    server: { name: s.name, domain: s.domain, bootUnlockMode: s.bootUnlockMode, diskEncryption: s.diskEncryption },
    apps: o.apps.map((a) => ({ serviceId: a.serviceId, name: a.name })),
    left: left.map((a) => ({ serviceId: a.serviceId, name: a.name, reason: a.reason })),
    includes: strings(o.includes),
    excludes: strings(o.excludes),
    data: { fileName: d.fileName, bytes: d.bytes, sha256: d.sha256, frameBytes: d.frameBytes },
  };
}

export async function openBackupBody(file, contentKey) {
  let plain;
  try {
    plain = await open(contentKey, hexToBytes(file.bodyNonceHex), enc(`${TAG_BODY}|${file.archiveId}`), hexToBytes(file.bodyHex));
  } catch {
    throw new BackupError("This backup file was changed or is damaged.", "damaged");
  }
  const body = parseBackupBody(new TextDecoder().decode(plain));
  if (!body) throw new BackupError("This backup file is damaged.", "damaged");
  return body;
}

/** Open with this account's key (deriveServerArchiveKeyFromSeed). Null if it isn't this account's backup. */
export async function openWithAccountKey(file, accountKek) {
  const slot = file.slots.find((s) => s.kind === "account");
  const key = slot ? await unwrapSlot(file.archiveId, slot, accountKek) : null;
  if (!key) return null;
  return { file, body: await openBackupBody(file, key), contentKey: key, via: "account" };
}

/** Open with the passcode. Throws `locked` for a wrong one. */
export async function openWithPasscode(file, passcode) {
  const slot = file.slots.find((s) => s.kind === "passcode");
  if (!slot) throw new BackupError("This backup has no passcode: open it on a device of the account that made it.", "locked");
  const key = await unwrapSlot(file.archiveId, slot, await passcodeKek(passcode, slot.kdf));
  if (!key) throw new BackupError("That passcode doesn't open this backup.", "locked");
  return { file, body: await openBackupBody(file, key), contentKey: key, via: "passcode" };
}

/** Body sealing, for tests and parity with the box (the box writes real backup files). */
export async function sealBackupFile(archiveId, contentKey, slots, body, nonce) {
  const ct = await seal(contentKey, nonce, enc(`${TAG_BODY}|${archiveId}`), enc(JSON.stringify(body)));
  return { magic: BACKUP_MAGIC, v: BACKUP_VERSION, archiveId, slots, bodyNonceHex: bytesToHex(nonce), bodyHex: bytesToHex(ct) };
}

export function serializeBackupFile(f) {
  return `${JSON.stringify({ magic: f.magic, v: f.v, archiveId: f.archiveId, slots: f.slots, bodyNonceHex: f.bodyNonceHex, bodyHex: f.bodyHex })}\n`;
}

// ---------------------------------------------------------------------------
// Picked files
// ---------------------------------------------------------------------------

/** "backup" | "data" | null from a picked file's first bytes. */
export async function classifyPicked(file) {
  const head = new Uint8Array(await file.slice(0, BACKUP_DATA_MAGIC.length).arrayBuffer());
  if (new TextDecoder().decode(head) === BACKUP_DATA_MAGIC) return "data";
  if (head[0] === 0x7b && file.size <= BACKUP_FILE_MAX_BYTES) {
    try {
      return JSON.parse(await file.text())?.magic === BACKUP_MAGIC ? "backup" : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check the data file against the backup file without holding it: its size,
 * its first line, and its SHA-256, read in slices. Throws a readable error.
 */
export async function checkDataFile(blob, data, { onProgress, sliceBytes = 8 * 1024 * 1024, isCancelled = () => false } = {}) {
  if (blob.size !== data.bytes) {
    throw new BackupError(`That data file isn't this backup's (it should be ${data.fileName}).`, "damaged");
  }
  const h = sha256.create();
  for (let at = 0; at < blob.size; at += sliceBytes) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    let part;
    try {
      part = new Uint8Array(await blob.slice(at, at + sliceBytes).arrayBuffer());
    } catch {
      throw new BackupError("The data file can't be read any more (was its drive removed?).", "damaged");
    }
    if (at === 0 && new TextDecoder().decode(part.subarray(0, BACKUP_DATA_MAGIC.length)) !== BACKUP_DATA_MAGIC) {
      throw new BackupError("That isn't a Flagship backup's data file.", "damaged");
    }
    h.update(part);
    onProgress?.(Math.min(at + part.length, blob.size), blob.size);
  }
  if (bytesToHex(h.digest()) !== data.sha256) {
    throw new BackupError("The data file doesn't match the backup file: it was changed or is damaged.", "damaged");
  }
}

// ---------------------------------------------------------------------------
// The restore order (rides beside the create-time pairing order)
// ---------------------------------------------------------------------------

export function serverRestoreCanonicalBytes(o) {
  if (!o.serverDomain || /[|\r\n]/.test(o.serverDomain) || /[\u0000-\u001f\u007f]/.test(o.serverDomain)) throw new Error("server-restore: bad serverDomain");
  if (!HEX32.test(o.archiveId)) throw new Error("server-restore: bad archiveId");
  if (!Number.isSafeInteger(o.bytes) || o.bytes < 1) throw new Error("server-restore: bad bytes");
  if (!HEX64.test(o.sha256)) throw new Error("server-restore: bad sha256");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("server-restore: bad issuedAt");
  return enc([TAG_SERVER_RESTORE, o.serverDomain, o.archiveId, String(o.bytes), o.sha256, String(o.issuedAt)].join("|"));
}

/** The pairing order JSON with the signed restore order beside it. */
export async function attachRestoreOrder(pairingOrderJson, { serverDomain, archiveId, bytes, sha256: hash, issuedAt = Date.now(), sign }) {
  const order = { serverDomain, archiveId, bytes, sha256: hash, issuedAt };
  const signature = await sign(serverRestoreCanonicalBytes(order));
  const o = JSON.parse(pairingOrderJson);
  o.restore = { order, signatureHex: bytesToHex(signature) };
  return JSON.stringify(o);
}

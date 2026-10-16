/**
 * A server backup is two files (docs/server-backup-and-clone.md):
 *
 *   <name>-<date>.flagship-backup   the backup file: small JSON, opened with a
 *                                   passcode or the owner's account key
 *   <name>-<date>.flagship-data     the data file: the apps, sealed in frames
 *
 * One random content key seals both. The backup file carries it in key slots
 * (like LUKS): a `passcode` slot (Argon2id of the passcode wraps it) so a backup
 * can be shared or restored after the account is lost, and an `account` slot
 * (the UMK-derived `deriveServerArchiveKey` wraps it) so the owner never types
 * the passcode for their own backups. The rest of the backup file (the saved
 * server's settings, its apps, and the data file's exact size, SHA-256 and
 * frame size) is sealed under the content key, so a changed size or hash fails
 * to open. The data file is checked by streaming its SHA-256, never by loading
 * it; the box that restores it opens it frame by frame.
 *
 * The restore order: a server created to restore a backup is told so by an
 * owner-signed `flagship/server-restore/v1` that rides beside its pairing order;
 * it binds the new server to one data file (id, size, SHA-256), so the box
 * accepts that file and no other.
 */
import { argon2id } from "@noble/hashes/argon2";
import { gcm } from "@noble/ciphers/aes";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const BACKUP_MAGIC = "flagship-backup";
export const BACKUP_VERSION = 2;
/** The data file's first line, so a picker can tell the two files apart. */
export const BACKUP_DATA_MAGIC = "flagship-backup-data/v2\n";
export const BACKUP_FILE_EXTENSION = ".flagship-backup";
export const BACKUP_DATA_EXTENSION = ".flagship-data";
export const BACKUP_FRAME_BYTES = 1024 * 1024;
/** The backup file is small; anything bigger isn't one. */
export const BACKUP_FILE_MAX_BYTES = 256 * 1024;

export interface BackupArgonParams {
  /** memory in KiB */ m: number;
  t: number;
  p: number;
}
/** The keyfile's profile: a guess costs about a second on a phone. */
export const BACKUP_ARGON_PARAMS: BackupArgonParams = { m: 65536, t: 3, p: 4 };

const TAG_SLOT = "flagship/server-backup-slot/v2";
const TAG_BODY = "flagship/server-backup-body/v2";
const TAG_DATA = "flagship/server-backup-data/v2";
export const TAG_SERVER_RESTORE = "flagship/server-restore/v1";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX24 = /^[0-9a-f]{24}$/;
const HEX96 = /^[0-9a-f]{96}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;

export class BackupFormatError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "version" | "locked" | "damaged",
  ) {
    super(message);
    this.name = "BackupFormatError";
  }
}

export interface PasscodeSlot {
  kind: "passcode";
  kdf: { algo: "argon2id"; m: number; t: number; p: number; saltHex: string };
  nonceHex: string;
  wrappedHex: string;
}
export interface AccountSlot {
  kind: "account";
  nonceHex: string;
  wrappedHex: string;
}
export type BackupSlot = PasscodeSlot | AccountSlot;

export interface BackupFile {
  magic: typeof BACKUP_MAGIC;
  v: typeof BACKUP_VERSION;
  archiveId: string;
  slots: BackupSlot[];
  bodyNonceHex: string;
  bodyHex: string;
}

export interface BackupServerSettings {
  /** The saved server's name (its first DNS label): the restore form fills it in. */
  name: string;
  /** Its full address, for "from ..." lines. */
  domain: string;
  bootUnlockMode: "auto" | "approve";
  diskEncryption: "luks" | "none";
}

export interface BackupBody {
  createdAt: number;
  server: BackupServerSettings;
  apps: Array<{ serviceId: string; name: string }>;
  left: Array<{ serviceId: string; name: string; reason: string }>;
  includes: string[];
  excludes: string[];
  data: { fileName: string; bytes: number; sha256: string; frameBytes: number };
}

const enc = (s: string): Bytes => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Passcodes
// ---------------------------------------------------------------------------

/** What every app types into the KDF: NFC, surrounding whitespace dropped. */
export function normalizeBackupPasscode(passcode: string): string {
  return passcode.normalize("NFC").trim();
}

/**
 * Why a passcode the user chose is too weak, or null. The file can be copied
 * anywhere, so guesses are offline and unlimited: at least 12 characters with
 * three kinds (lower, upper, digits, symbols), or 20 characters of anything.
 */
export function backupPasscodeProblem(passcode: string): string | null {
  const p = normalizeBackupPasscode(passcode);
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

/** No 0/o, 1/l: easy to read back and type. 32 symbols = 5 bits each. */
export const BACKUP_PASSCODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A suggested passcode: five groups of four, 100 bits (`k7qm-2xhd-...`). */
export function generateBackupPasscode(rng: (n: number) => Bytes = defaultRng): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    const b = rng(4);
    if (b.length !== 4) throw new Error("rng must return the requested length");
    groups.push(Array.from(b, (x) => BACKUP_PASSCODE_ALPHABET[x & 31]).join(""));
  }
  return groups.join("-");
}

function defaultRng(n: number): Bytes {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function validParams(k: { m?: unknown; t?: unknown; p?: unknown }): boolean {
  const ok = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
  return ok(k.p, 1, 16) && ok(k.t, 1, 16) && ok(k.m, 8, 1048576) && (k.m as number) >= 8 * (k.p as number);
}

/** The passcode slot's key: Argon2id(normalized passcode, salt). */
export function backupPasscodeKek(passcode: string, kdf: PasscodeSlot["kdf"]): Bytes {
  if (!validParams(kdf) || !HEX32.test(kdf.saltHex)) throw new BackupFormatError("the passcode settings are damaged", "malformed");
  return argon2id(enc(normalizeBackupPasscode(passcode)), hexToBytes(kdf.saltHex), { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32 });
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function slotAad(archiveId: string, slot: { kind: string; kdf?: PasscodeSlot["kdf"] }): Bytes {
  const parts = [TAG_SLOT, slot.kind, archiveId];
  if (slot.kind === "passcode" && slot.kdf) {
    parts.push(slot.kdf.algo, `m=${slot.kdf.m}`, `t=${slot.kdf.t}`, `p=${slot.kdf.p}`, slot.kdf.saltHex);
  }
  return enc(parts.join("|"));
}

function check32(b: Bytes, what: string): void {
  if (b.length !== 32) throw new BackupFormatError(`${what} must be 32 bytes`, "malformed");
}
function check12(b: Bytes): void {
  if (b.length !== 12) throw new BackupFormatError("a nonce must be 12 bytes", "malformed");
}

/** Wrap the content key for the owner's account (kek = deriveServerArchiveKey(UMK, archiveId)). */
export function wrapAccountSlot(archiveId: string, contentKey: Bytes, kek: Bytes, nonce: Bytes): AccountSlot {
  if (!HEX32.test(archiveId)) throw new BackupFormatError("bad archive id", "malformed");
  check32(contentKey, "the content key");
  check32(kek, "the account key");
  check12(nonce);
  const slot = { kind: "account" as const };
  return { kind: "account", nonceHex: bytesToHex(nonce), wrappedHex: bytesToHex(gcm(kek, nonce, slotAad(archiveId, slot)).encrypt(contentKey)) };
}

/** Wrap the content key under a passcode (Argon2id with these params and salt). */
export function wrapPasscodeSlot(
  archiveId: string,
  contentKey: Bytes,
  passcode: string,
  salt: Bytes,
  nonce: Bytes,
  params: BackupArgonParams = BACKUP_ARGON_PARAMS,
): PasscodeSlot {
  if (!HEX32.test(archiveId)) throw new BackupFormatError("bad archive id", "malformed");
  check32(contentKey, "the content key");
  check12(nonce);
  if (salt.length !== 16) throw new BackupFormatError("the salt must be 16 bytes", "malformed");
  const kdf = { algo: "argon2id" as const, m: params.m, t: params.t, p: params.p, saltHex: bytesToHex(salt) };
  const kek = backupPasscodeKek(passcode, kdf);
  return {
    kind: "passcode",
    kdf,
    nonceHex: bytesToHex(nonce),
    wrappedHex: bytesToHex(gcm(kek, nonce, slotAad(archiveId, { kind: "passcode", kdf })).encrypt(contentKey)),
  };
}

/** The content key from one slot and its key-encryption key, or null if it doesn't open. */
export function unwrapSlot(archiveId: string, slot: BackupSlot, kek: Bytes): Bytes | null {
  try {
    const key = gcm(kek, hexToBytes(slot.nonceHex), slotAad(archiveId, slot)).decrypt(hexToBytes(slot.wrappedHex));
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The backup file
// ---------------------------------------------------------------------------

export function parseBackupSlot(v: unknown): BackupSlot | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.nonceHex !== "string" || !HEX24.test(s.nonceHex)) return null;
  if (typeof s.wrappedHex !== "string" || !HEX96.test(s.wrappedHex)) return null;
  if (s.kind === "account") return { kind: "account", nonceHex: s.nonceHex, wrappedHex: s.wrappedHex };
  if (s.kind !== "passcode") return null;
  const k = s.kdf as Record<string, unknown> | null;
  if (typeof k !== "object" || k === null || k.algo !== "argon2id" || !validParams(k)) return null;
  if (typeof k.saltHex !== "string" || !HEX32.test(k.saltHex)) return null;
  return {
    kind: "passcode",
    kdf: { algo: "argon2id", m: k.m as number, t: k.t as number, p: k.p as number, saltHex: k.saltHex },
    nonceHex: s.nonceHex,
    wrappedHex: s.wrappedHex,
  };
}

/** Slots as a box accepts them from the owner's app: one of each kind at most, at least one. */
export function parseBackupSlots(v: unknown): BackupSlot[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 2) return null;
  const out: BackupSlot[] = [];
  for (const raw of v) {
    const s = parseBackupSlot(raw);
    if (!s || out.some((o) => o.kind === s.kind)) return null;
    out.push(s);
  }
  return out;
}

/** Read a backup file's outer layer. Throws a readable BackupFormatError. */
export function parseBackupFile(text: string): BackupFile {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BackupFormatError("That isn't a Flagship backup file.", "malformed");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o) || o.magic !== BACKUP_MAGIC) {
    throw new BackupFormatError("That isn't a Flagship backup file.", "malformed");
  }
  if (o.v !== BACKUP_VERSION) {
    throw new BackupFormatError(
      typeof o.v === "number" && o.v > BACKUP_VERSION
        ? "This backup is from a newer version of Flagship. Update the app and try again."
        : "This backup is from an older version of Flagship and can't be restored.",
      "version",
    );
  }
  const damaged = () => new BackupFormatError("This backup file is damaged.", "malformed");
  if (typeof o.archiveId !== "string" || !HEX32.test(o.archiveId)) throw damaged();
  if (typeof o.bodyNonceHex !== "string" || !HEX24.test(o.bodyNonceHex)) throw damaged();
  if (typeof o.bodyHex !== "string" || !HEX.test(o.bodyHex) || o.bodyHex.length < 34) throw damaged();
  const slots = Array.isArray(o.slots) ? o.slots.map(parseBackupSlot) : null;
  if (!slots || slots.length === 0 || slots.some((s) => s === null)) throw damaged();
  return {
    magic: BACKUP_MAGIC,
    v: BACKUP_VERSION,
    archiveId: o.archiveId,
    slots: slots as BackupSlot[],
    bodyNonceHex: o.bodyNonceHex,
    bodyHex: o.bodyHex,
  };
}

/** The file's text: one JSON object, keys in a fixed order, one trailing newline. */
export function serializeBackupFile(f: BackupFile): string {
  return `${JSON.stringify({
    magic: f.magic,
    v: f.v,
    archiveId: f.archiveId,
    slots: f.slots,
    bodyNonceHex: f.bodyNonceHex,
    bodyHex: f.bodyHex,
  })}\n`;
}

/** Seal the body under the content key. */
export function sealBackupFile(archiveId: string, contentKey: Bytes, slots: BackupSlot[], body: BackupBody, nonce: Bytes): BackupFile {
  if (!HEX32.test(archiveId)) throw new BackupFormatError("bad archive id", "malformed");
  check32(contentKey, "the content key");
  check12(nonce);
  const ct = gcm(contentKey, nonce, enc(`${TAG_BODY}|${archiveId}`)).encrypt(enc(JSON.stringify(body)));
  return { magic: BACKUP_MAGIC, v: BACKUP_VERSION, archiveId, slots, bodyNonceHex: bytesToHex(nonce), bodyHex: bytesToHex(ct) };
}

/** Open the body with the content key. Throws `damaged` if it was changed. */
export function openBackupBody(f: BackupFile, contentKey: Bytes): BackupBody {
  let plain: Bytes;
  try {
    plain = gcm(contentKey, hexToBytes(f.bodyNonceHex), enc(`${TAG_BODY}|${f.archiveId}`)).decrypt(hexToBytes(f.bodyHex));
  } catch {
    throw new BackupFormatError("This backup file was changed or is damaged.", "damaged");
  }
  const body = parseBackupBody(new TextDecoder().decode(plain));
  if (!body) throw new BackupFormatError("This backup file is damaged.", "damaged");
  return body;
}

export function parseBackupBody(text: string): BackupBody | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const str = (v: unknown): v is string => typeof v === "string";
  const s = o.server as Record<string, unknown> | null;
  const d = o.data as Record<string, unknown> | null;
  if (typeof o.createdAt !== "number" || !Number.isSafeInteger(o.createdAt)) return null;
  if (!s || typeof s !== "object" || !str(s.name) || !str(s.domain)) return null;
  if (s.bootUnlockMode !== "auto" && s.bootUnlockMode !== "approve") return null;
  if (s.diskEncryption !== "luks" && s.diskEncryption !== "none") return null;
  if (!d || typeof d !== "object" || !str(d.fileName) || !str(d.sha256) || !HEX64.test(d.sha256)) return null;
  if (typeof d.bytes !== "number" || !Number.isSafeInteger(d.bytes) || d.bytes < BACKUP_DATA_MAGIC.length) return null;
  if (typeof d.frameBytes !== "number" || !Number.isSafeInteger(d.frameBytes) || d.frameBytes < 1024 || d.frameBytes > 16 * 1024 * 1024) return null;
  const apps = Array.isArray(o.apps) ? o.apps : null;
  if (!apps || !apps.every((a) => a && str(a.serviceId) && str(a.name))) return null;
  const left = Array.isArray(o.left) ? o.left : [];
  if (!left.every((a) => a && str(a.serviceId) && str(a.name) && str(a.reason))) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter(str) : []);
  return {
    createdAt: o.createdAt,
    server: { name: s.name, domain: s.domain, bootUnlockMode: s.bootUnlockMode, diskEncryption: s.diskEncryption },
    apps: apps.map((a) => ({ serviceId: a.serviceId, name: a.name })),
    left: left.map((a) => ({ serviceId: a.serviceId, name: a.name, reason: a.reason })),
    includes: strings(o.includes),
    excludes: strings(o.excludes),
    data: { fileName: d.fileName, bytes: d.bytes, sha256: d.sha256, frameBytes: d.frameBytes },
  };
}

export interface OpenedBackup {
  file: BackupFile;
  body: BackupBody;
  contentKey: Bytes;
  /** Which slot opened it. */
  via: "account" | "passcode";
}

/** Try the account slot with this account's key; null if the backup isn't this account's. */
export function openBackupWithAccountKey(f: BackupFile, accountKek: Bytes): OpenedBackup | null {
  const slot = f.slots.find((s) => s.kind === "account");
  const key = slot ? unwrapSlot(f.archiveId, slot, accountKek) : null;
  if (!key) return null;
  return { file: f, body: openBackupBody(f, key), contentKey: key, via: "account" };
}

/** Open with the passcode. Throws `locked` for a wrong passcode. */
export function openBackupWithPasscode(f: BackupFile, passcode: string): OpenedBackup {
  const slot = f.slots.find((s): s is PasscodeSlot => s.kind === "passcode");
  if (!slot) throw new BackupFormatError("This backup has no passcode: open it on a device of the account that made it.", "locked");
  const key = unwrapSlot(f.archiveId, slot, backupPasscodeKek(passcode, slot.kdf));
  if (!key) throw new BackupFormatError("That passcode doesn't open this backup.", "locked");
  return { file: f, body: openBackupBody(f, key), contentKey: key, via: "passcode" };
}

// ---------------------------------------------------------------------------
// The data file's frames (the box seals and opens them; the apps only hash the file)
// ---------------------------------------------------------------------------

/** The 12-byte nonce of frame `index`. */
export function backupFrameNonce(index: number): Bytes {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(index));
  return n;
}

/** Frames are bound to the backup and to whether they are the last one. */
export function backupFrameAad(archiveId: string, last: boolean): Bytes {
  return enc(`${TAG_DATA}|${archiveId}|${last ? 1 : 0}`);
}

// ---------------------------------------------------------------------------
// The restore order
// ---------------------------------------------------------------------------

export interface ServerRestoreOrder {
  /** The new server, which waits for this backup and no other. */
  serverDomain: string;
  archiveId: string;
  /** The data file's exact size and SHA-256 (lowercase hex). */
  bytes: number;
  sha256: string;
  issuedAt: number;
}

/** `flagship/server-restore/v1|<serverDomain>|<archiveId>|<bytes>|<sha256>|<issuedAt>` */
export function serverRestoreCanonicalBytes(o: ServerRestoreOrder): Bytes {
  if (o.serverDomain.length === 0) throw new Error("server-restore: empty serverDomain");
  legacyFieldGuard("serverDomain", o.serverDomain);
  if (!HEX32.test(o.archiveId)) throw new Error("server-restore: bad archiveId");
  if (!Number.isSafeInteger(o.bytes) || o.bytes < 1) throw new Error("server-restore: bad bytes");
  if (!HEX64.test(o.sha256)) throw new Error("server-restore: bad sha256");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("server-restore: bad issuedAt");
  return enc([TAG_SERVER_RESTORE, o.serverDomain, o.archiveId, String(o.bytes), o.sha256, String(o.issuedAt)].join("|"));
}

export function signServerRestoreOrder(o: ServerRestoreOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(serverRestoreCanonicalBytes(o));
}

/** Never throws. */
export function verifyServerRestoreOrder(o: ServerRestoreOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, serverRestoreCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted order (no signature check). */
export function parseServerRestoreOrder(v: unknown): ServerRestoreOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.archiveId !== "string" || typeof r.sha256 !== "string") return null;
  if (typeof r.bytes !== "number" || typeof r.issuedAt !== "number") return null;
  const o: ServerRestoreOrder = { serverDomain: r.serverDomain, archiveId: r.archiveId, bytes: r.bytes, sha256: r.sha256, issuedAt: r.issuedAt };
  try {
    serverRestoreCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}

/**
 * The restore order as it rides inside a pairing order's JSON
 * (`{request, signature, restore: {order, signatureHex}}`): pull it out and
 * verify it names this box, under the owner's key. Null when absent or bad.
 */
export function openRestoreFromPairingJson(json: string, ownerPub: Bytes, expectedServerDomain: string): { order: ServerRestoreOrder; signatureHex: string } | null {
  let r: unknown;
  try {
    r = (JSON.parse(json) as { restore?: unknown })?.restore;
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null) return null;
  const { order: raw, signatureHex } = r as { order?: unknown; signatureHex?: unknown };
  const order = parseServerRestoreOrder(raw);
  if (!order || typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return null;
  if (order.serverDomain.toLowerCase() !== expectedServerDomain.toLowerCase()) return null;
  if (!verifyServerRestoreOrder(order, hexToBytes(signatureHex), ownerPub)) return null;
  return { order, signatureHex };
}

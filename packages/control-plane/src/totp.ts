/**
 * v1.2 Plan B Phase 3 — TOTP 2FA enrollment + verification.
 *
 * See docs/v1.2-security-cascade.md §"Phase 3 — TOTP enrollment +
 * verification". Four endpoints:
 *
 *   POST /api/users/:u/totp/enroll-begin    IRK-signed
 *     - Mints a fresh TOTP secret, encrypts at rest with the
 *       Worker-side KEK, stages it on the user row. The account
 *       stays single-device until enroll-confirm.
 *
 *   POST /api/users/:u/totp/enroll-confirm  IRK-signed + sample code
 *     - Verifies the supplied 6-digit code against the staged
 *       secret. On success: flips `account_type = 'multi'`, stamps
 *       `totp_enrolled_at`, generates 10 fresh recovery codes,
 *       writes their argon2id-hashed JSON array atomically, and
 *       returns the plaintext codes ONCE (the only time they leave
 *       the Worker).
 *
 *   POST /api/users/:u/totp/verify          no signature (proof carrier)
 *     - Side-effect-free validator. Returns whether the code is a
 *       valid TOTP or a valid recovery code, WITHOUT consuming the
 *       recovery code. Rate-limited (5 / 15 min / username).
 *
 *   POST /api/users/:u/totp/disable         IRK-signed + sample code
 *     - Drops the TOTP secret + recovery codes; flips account_type
 *       back to 'single'. Only allowed when no sibling paired
 *       sessions exist (single-device state must reflect actual
 *       single-device shape on the .com side too).
 *
 * Recovery codes are 10 codes × 10 base32 chars each, generated via
 * `crypto.getRandomValues`, hashed with argon2id
 * (m=64MiB, t=3, p=1) and stored as a JSON array of hash records.
 * Consumption is atomic via the storage layer's
 * `casRecoveryCodes(username, oldJson, newJson)` CAS update — two
 * parallel re-pairs that race the same recovery code must resolve to
 * exactly one success.
 *
 * The TOTP secret is encrypted at rest with `FLAGSHIP_TOTP_KEK`
 * (a 32-byte hex Worker secret). Format:
 *   stored = base64( iv(12) || ciphertext || tag )
 * `crypto.subtle.encrypt({ name: "AES-GCM", iv }, ...)` already
 * appends the tag, so `iv(12) || encrypt-output` is the on-disk
 * shape. Decrypt-on-read for verification only — the plaintext
 * never escapes a handler frame.
 *
 * When `FLAGSHIP_TOTP_KEK` is unset, every endpoint returns 503
 * `{ error: "TOTP not configured" }` so the system can ship without
 * 2FA fully enabled.
 */

import {
  verifyTotpEnrollBegin,
  verifyTotpEnrollConfirm,
  verifyTotpDisable,
  type TotpEnrollBegin,
  type TotpEnrollConfirm,
  type TotpDisable,
} from "@flagship/protocol";
import type {
  PushTokenStorage,
  UsernameStorage,
} from "@flagship/storage";
import { argon2id } from "@noble/hashes/argon2";
import * as OTPAuth from "otpauth";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

export interface TotpDeps {
  usernames: UsernameStorage;
  /**
   * Required for the "disable only when single-device shape"
   * invariant on /totp/disable AND to consult the quarantine flag
   * on enroll-begin from a freshly-admitted device.
   */
  pushTokens?: PushTokenStorage;
  /** 32-byte hex KEK. Required for any side-effect path; absent ⇒ 503. */
  kekHex?: string;
  /** TOTP issuer label used in the otpauth:// URI. Default "Flagship". */
  issuer?: string;
  maxAgeMs?: number;
  /** Tests inject a deterministic clock for token-window assertions. */
  now?: () => number;
  /** Tests inject deterministic randomness for secret + recovery codes. */
  randomBytes?: (n: number) => Uint8Array;
  /**
   * Test-only — turn off the argon2id round on recovery-code hashing
   * so a 30s test isn't slowed by the 64MiB memory parameter. The
   * default is `false` (real argon2id) so production is unaffected.
   */
  fastHash?: boolean;
}

const DEFAULT_MAX_AGE = 5 * 60_000;
const DEFAULT_ISSUER = "Flagship";

/** TOTP window — RFC 6238 ±1 period (30s either side), so codes
 *  generated up to ~60s ago are still valid. Matches the otpauth
 *  default; restated here so the test that asserts "expired ⇒ 401"
 *  has a deterministic boundary. */
const TOTP_WINDOW = 1;
const TOTP_PERIOD_S = 30;

/** Recovery codes — 10 codes × 10 base32 chars each. */
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_CHARS = 10;
const RECOVERY_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Per-username verify rate-limit: 5 attempts / 15 min. */
const VERIFY_LIMIT = 5;
const VERIFY_WINDOW_MS = 15 * 60_000;

/**
 * Module-scoped rolling-window rate-limiter for /totp/verify + the
 * re-pair TOTP gate. In production .com terms the Worker's
 * RATE_LIMITER binding is the right home, but it's keyed by IP +
 * IRK, not username. For verify, the username is the right axis
 * (you don't want to leak that a different IP is also trying), so
 * we keep a per-username counter here. The Map is bounded by the
 * sweep on every check; entries past the 15 min window are dropped.
 */
interface VerifyAttempts {
  windowStart: number;
  count: number;
}
const verifyAttemptStore = new Map<string, VerifyAttempts>();

/** Test-only — reset the rate-limit store between cases. */
export function _resetTotpVerifyRateLimitForTests(): void {
  verifyAttemptStore.clear();
}

/**
 * Tick the verify counter for `username`. Returns the post-increment
 * state. Callers that want a "would this trip?" probe without
 * consuming a slot should call `peekVerifyAttempts` instead.
 */
export function recordVerifyAttempt(
  username: string,
  now: number,
): { count: number; windowStart: number; remaining: number } {
  const key = username.toLowerCase();
  const existing = verifyAttemptStore.get(key);
  if (!existing || now - existing.windowStart >= VERIFY_WINDOW_MS) {
    const fresh = { windowStart: now, count: 1 };
    verifyAttemptStore.set(key, fresh);
    return { count: 1, windowStart: now, remaining: VERIFY_LIMIT - 1 };
  }
  existing.count += 1;
  return {
    count: existing.count,
    windowStart: existing.windowStart,
    remaining: Math.max(0, VERIFY_LIMIT - existing.count),
  };
}

export function peekVerifyAttempts(
  username: string,
  now: number,
): { count: number; windowStart: number; tripped: boolean } {
  const key = username.toLowerCase();
  const existing = verifyAttemptStore.get(key);
  if (!existing || now - existing.windowStart >= VERIFY_WINDOW_MS) {
    return { count: 0, windowStart: now, tripped: false };
  }
  return {
    count: existing.count,
    windowStart: existing.windowStart,
    tripped: existing.count >= VERIFY_LIMIT,
  };
}

// ───────────────────────────────────────────────────────────────────
// KEK + AES-GCM helpers
// ───────────────────────────────────────────────────────────────────

// Some lib targets in this build don't expose CryptoKey by name —
// matches the pattern used in pushBridge.ts. We let TS infer the
// return type instead.
async function importKek(kekHex: string) {
  const raw = hexToBytes(kekHex);
  if (raw.length !== 32) {
    throw new Error("FLAGSHIP_TOTP_KEK must be 32 bytes (64 hex chars)");
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encrypt the raw TOTP secret bytes under the KEK. Stored shape:
 *   base64( iv(12) || ciphertext-with-gcm-tag )
 * The IV is freshly generated per encrypt — even a re-enrollment
 * of the same secret never re-uses an IV.
 */
export async function encryptTotpSecret(
  secretBytes: Uint8Array,
  kekHex: string,
): Promise<string> {
  const key = await importKek(kekHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, secretBytes),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

/**
 * Decrypt a stored TOTP secret. Throws on a tag-mismatch
 * (re-keyed KEK or corrupted blob); callers should treat that as
 * "user must re-enroll" rather than surfacing the error verbatim.
 */
export async function decryptTotpSecret(
  storedBase64: string,
  kekHex: string,
): Promise<Uint8Array> {
  const blob = base64ToBytes(storedBase64);
  if (blob.length < 12 + 16) {
    throw new Error("totp blob shorter than IV + GCM tag");
  }
  const iv = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  const key = await importKek(kekHex);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
  );
  return pt;
}

// ───────────────────────────────────────────────────────────────────
// Recovery codes
// ───────────────────────────────────────────────────────────────────

/**
 * Generate one recovery code: `RECOVERY_CODE_CHARS` chars of base32
 * (`A-Z2-7`). Drawn from `randomBytes` so tests can inject a known
 * RNG; production calls `crypto.getRandomValues` indirectly via the
 * default factory.
 */
function generateRecoveryCode(rand: (n: number) => Uint8Array): string {
  const raw = rand(RECOVERY_CODE_CHARS);
  let out = "";
  for (let i = 0; i < RECOVERY_CODE_CHARS; i++) {
    const byte = raw[i] as number;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    out += RECOVERY_BASE32_ALPHABET.charAt(byte & 31);
  }
  return out;
}

/**
 * Shape of one entry in the stored recovery-codes JSON array.
 * `saltHex` is unique per code so an attacker that learns the
 * hashes can't precompute a single rainbow table for all 10.
 */
export interface RecoveryCodeHash {
  saltHex: string;
  hashHex: string;
  /** Argon2id parameters baked into each row for forward-compat. */
  params: { m: number; t: number; p: number };
}

const ARGON_PARAMS = { m: 64 * 1024, t: 3, p: 1 } as const;
const ARGON_PARAMS_FAST = { m: 1 * 1024, t: 1, p: 1 } as const;

function hexEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function hashRecoveryCode(
  code: string,
  saltHex: string,
  fastHash: boolean,
): Promise<{ hashHex: string; params: { m: number; t: number; p: number } }> {
  const params = fastHash ? ARGON_PARAMS_FAST : ARGON_PARAMS;
  const salt = hexToBytes(saltHex);
  const out = argon2id(new TextEncoder().encode(code), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: 32,
  });
  return { hashHex: hexEncode(out), params: { ...params } };
}

async function verifyRecoveryCode(
  code: string,
  row: RecoveryCodeHash,
): Promise<boolean> {
  const computed = argon2id(
    new TextEncoder().encode(code),
    hexToBytes(row.saltHex),
    { m: row.params.m, t: row.params.t, p: row.params.p, dkLen: 32 },
  );
  // Constant-time compare.
  const expected = hexToBytes(row.hashHex);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= (computed[i] as number) ^ (expected[i] as number);
  }
  return diff === 0;
}

function parseRecoveryCodesJson(s: string | undefined): RecoveryCodeHash[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s) as RecoveryCodeHash[];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r) =>
        typeof r?.saltHex === "string" &&
        typeof r?.hashHex === "string" &&
        typeof r?.params?.m === "number" &&
        typeof r?.params?.t === "number" &&
        typeof r?.params?.p === "number",
    );
  } catch {
    return [];
  }
}

async function generateRecoveryCodes(
  rand: (n: number) => Uint8Array,
  fastHash: boolean,
): Promise<{ plaintexts: string[]; hashesJson: string }> {
  const plaintexts: string[] = [];
  const rows: RecoveryCodeHash[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = generateRecoveryCode(rand);
    plaintexts.push(code);
    const salt = rand(16);
    const saltHex = hexEncode(salt);
    const { hashHex, params } = await hashRecoveryCode(code, saltHex, fastHash);
    rows.push({ saltHex, hashHex, params });
  }
  return { plaintexts, hashesJson: JSON.stringify(rows) };
}

// ───────────────────────────────────────────────────────────────────
// QR encoding (otpauth URI → PNG base64)
// ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal PNG (greyscale, no compression beyond raw deflate
 * stored-block) from a boolean matrix. Returns base64-encoded PNG
 * bytes ready to drop into an `<img src="data:image/png;base64,…">`
 * tag or to render natively on iOS / Android.
 *
 * Matrix coordinates: matrix[row][col] = true ⇒ black module.
 * The output PNG repeats each module `scale` times in both axes so
 * a typical 41x41 QR with scale=4 lands as a crisp 164x164 PNG that
 * scans on a phone camera. A 1-module quiet-zone border is added.
 */
export function encodeQrPng(
  matrix: boolean[][],
  options: { scale?: number; quietZone?: number } = {},
): string {
  const scale = options.scale ?? 4;
  const quietZone = options.quietZone ?? 4;
  const inner = matrix.length;
  const totalModules = inner + quietZone * 2;
  const w = totalModules * scale;
  const h = totalModules * scale;
  // Build the raster: row-major, 1 byte per pixel, 0 = black, 255 = white.
  // PNG row format: each row is prefixed with a filter byte (0 = none).
  const rowStride = w + 1;
  const raster = new Uint8Array(rowStride * h);
  // Fill white default.
  for (let i = 0; i < raster.length; i++) raster[i] = 255;
  // Zero out filter byte each row (already 0... wait, we set to 255).
  for (let y = 0; y < h; y++) raster[y * rowStride] = 0;
  for (let py = 0; py < h; py++) {
    const moduleRow = Math.floor(py / scale) - quietZone;
    if (moduleRow < 0 || moduleRow >= inner) continue;
    const rowMatrix = matrix[moduleRow] as boolean[];
    for (let px = 0; px < w; px++) {
      const moduleCol = Math.floor(px / scale) - quietZone;
      if (moduleCol < 0 || moduleCol >= inner) continue;
      if (rowMatrix[moduleCol]) {
        raster[py * rowStride + 1 + px] = 0;
      }
    }
  }
  // Deflate as a single stored block. PNG requires zlib wrapping
  // around deflate, hence the 2-byte zlib header + raw block + adler32.
  const zlib = wrapZlibStored(raster);
  // Build PNG: signature + IHDR + IDAT + IEND
  const ihdr = makeIhdr(w, h);
  const idat = makeIdat(zlib);
  const iend = makeIend();
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = new Uint8Array(
    sig.length + ihdr.length + idat.length + iend.length,
  );
  let o = 0;
  total.set(sig, o); o += sig.length;
  total.set(ihdr, o); o += ihdr.length;
  total.set(idat, o); o += idat.length;
  total.set(iend, o); o += iend.length;
  return bytesToBase64(total);
}

function makeIhdr(w: number, h: number): Uint8Array {
  const data = new Uint8Array(13);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, w, false);
  dv.setUint32(4, h, false);
  data[8] = 8;   // bit depth
  data[9] = 0;   // colour type: greyscale
  data[10] = 0;  // compression
  data[11] = 0;  // filter
  data[12] = 0;  // interlace
  return pngChunk("IHDR", data);
}

function makeIdat(deflateData: Uint8Array): Uint8Array {
  return pngChunk("IDAT", deflateData);
}

function makeIend(): Uint8Array {
  return pngChunk("IEND", new Uint8Array(0));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  // CRC over type + data
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc >>> 0, false);
  return out;
}

let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crcTable[((c ^ (buf[i] as number)) & 0xff)] as number) ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

/**
 * Wrap raw bytes in a zlib container with a single uncompressed
 * "stored" deflate block. The Worker doesn't ship a real deflater
 * and we don't need compression for a tiny QR PNG; this keeps the
 * code dependency-free.
 *
 * Layout:
 *   zlib header (2 bytes: 0x78 0x01 — deflate, no compression)
 *   deflate stored block(s):
 *     for each chunk ≤ 65535 bytes:
 *       1 byte:    BFINAL bit | BTYPE=00 (stored)
 *       2 bytes:   LEN  (little-endian)
 *       2 bytes:   NLEN (one's complement of LEN, LE)
 *       LEN bytes: raw data
 *   adler32 of the uncompressed bytes (big-endian)
 */
function wrapZlibStored(data: Uint8Array): Uint8Array {
  const chunkSize = 65535;
  const chunks: Uint8Array[] = [];
  let off = 0;
  while (off < data.length) {
    const remaining = data.length - off;
    const len = Math.min(remaining, chunkSize);
    const final = off + len === data.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = final;
    header[1] = len & 0xff;
    header[2] = (len >> 8) & 0xff;
    const nlen = (~len) & 0xffff;
    header[3] = nlen & 0xff;
    header[4] = (nlen >> 8) & 0xff;
    chunks.push(header);
    chunks.push(data.subarray(off, off + len));
    off += len;
  }
  if (chunks.length === 0) {
    // Empty input — emit a single final stored block of length 0.
    chunks.push(new Uint8Array([1, 0, 0, 0xff, 0xff]));
  }
  let totalLen = 2; // zlib header
  for (const c of chunks) totalLen += c.length;
  totalLen += 4; // adler32
  const out = new Uint8Array(totalLen);
  out[0] = 0x78;
  out[1] = 0x01;
  let p = 2;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  const a = adler32(data);
  out[p++] = (a >>> 24) & 0xff;
  out[p++] = (a >>> 16) & 0xff;
  out[p++] = (a >>> 8) & 0xff;
  out[p] = a & 0xff;
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Build the boolean module matrix for a payload using the
 * qrcode-generator library. Wrapped here so the rest of the file
 * doesn't import the dynamic-typed factory directly.
 */
async function qrMatrixFromText(text: string): Promise<boolean[][]> {
  const factory = (await import("qrcode-generator")).default;
  // Type 0 = auto-pick a small-enough version for the payload.
  // Error correction "M" — medium; balances camera tolerance and
  // payload capacity. Typical otpauth URIs are ~70-150 chars.
  const qr = factory(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const out: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    out.push(row);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────
// TOTP verification (shared by /totp/verify + re-pair gate)
// ───────────────────────────────────────────────────────────────────

/**
 * Validate a code against the user's stored TOTP secret OR
 * recovery-codes JSON. The lookup is side-effect-free — recovery
 * codes are not consumed here. Callers that want consumption (e.g.
 * the re-pair handler) should call `consumeRecoveryCode` after a
 * successful match.
 *
 * The IV-less import path is fine here because `decryptTotpSecret`
 * does the IV split internally.
 */
export async function validateTotpCode(args: {
  code: string;
  totpSecretEncrypted?: string;
  recoveryCodesHashesJson?: string;
  kekHex: string;
  /** Wall-clock ms; defaults to Date.now. */
  now?: number;
  /** Window override (default ±1 period). Tests use this. */
  window?: number;
}): Promise<{ valid: boolean; method: "totp" | "recovery" | null }> {
  const now = args.now ?? Date.now();
  const window = args.window ?? TOTP_WINDOW;
  // Try TOTP first — it's cheap (HMAC-SHA1) and the common case.
  if (args.totpSecretEncrypted) {
    try {
      const secret = await decryptTotpSecret(
        args.totpSecretEncrypted,
        args.kekHex,
      );
      const totp = new OTPAuth.TOTP({
        issuer: DEFAULT_ISSUER,
        algorithm: "SHA1",
        digits: 6,
        period: TOTP_PERIOD_S,
        secret: new OTPAuth.Secret({ buffer: secret.buffer }),
      });
      const delta = totp.validate({
        token: args.code,
        timestamp: now,
        window,
      });
      if (delta !== null) return { valid: true, method: "totp" };
    } catch {
      // Falls through to the recovery-code path.
    }
  }
  if (args.recoveryCodesHashesJson) {
    const rows = parseRecoveryCodesJson(args.recoveryCodesHashesJson);
    for (const row of rows) {
      if (await verifyRecoveryCode(args.code, row)) {
        return { valid: true, method: "recovery" };
      }
    }
  }
  return { valid: false, method: null };
}

/**
 * Atomically consume one recovery code from the user's row. Calls
 * the storage CAS in a small bounded retry loop in case a concurrent
 * verify-with-consume races us. Returns `true` on success; `false`
 * when the candidate code was no longer in the list (consumed by
 * a sibling) or the user vanished. Used by re-pair gate.
 */
export async function consumeRecoveryCode(
  deps: { usernames: UsernameStorage },
  username: string,
  code: string,
): Promise<{ consumed: boolean; reason?: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const userRec = await deps.usernames.get(username);
    if (!userRec) return { consumed: false, reason: "unknown username" };
    const currentJson = userRec.recoveryCodesHashesJson ?? "";
    if (!currentJson) return { consumed: false, reason: "no recovery codes" };
    const rows = parseRecoveryCodesJson(currentJson);
    let matchedIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (await verifyRecoveryCode(code, rows[i] as RecoveryCodeHash)) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex < 0) {
      return { consumed: false, reason: "code did not match" };
    }
    const remaining = rows.slice(0, matchedIndex).concat(rows.slice(matchedIndex + 1));
    const newJson = JSON.stringify(remaining);
    const ok = await deps.usernames.casRecoveryCodes(
      username,
      currentJson,
      newJson,
    );
    if (ok) return { consumed: true };
    // CAS failed — someone else wrote. Re-read and retry; if our
    // code was the one they consumed, the next pass will see it
    // gone and return "did not match".
  }
  return { consumed: false, reason: "concurrent contention" };
}

// ───────────────────────────────────────────────────────────────────
// Handler — /totp/enroll-begin
// ───────────────────────────────────────────────────────────────────

interface EnrollBeginBody {
  request?: { username?: unknown; issuedAt?: unknown };
  signature?: unknown;
}

export async function handleTotpEnrollBegin(
  deps: TotpDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!deps.kekHex) {
    return { status: 503, body: { error: "TOTP not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const rand = deps.randomBytes ?? defaultRandomBytes;
  const issuer = deps.issuer ?? DEFAULT_ISSUER;

  const b = body as EnrollBeginBody;
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: TotpEnrollBegin = {
    username: r.username,
    issuedAt: r.issuedAt,
  };
  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return { status: 500, body: { error: "stored IRK pubkey is malformed" } };
  }
  if (!verifyTotpEnrollBegin(claim, sig, irkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  // Mint a fresh 20-byte (160-bit) secret. RFC 6238 strongly
  // recommends >= 128 bits; 160 is the sweet spot for SHA1-based
  // TOTP and matches the otpauth library's default Secret size.
  const secretBytes = rand(20);
  const secretObj = new OTPAuth.Secret({
    buffer: secretBytes.buffer.slice(
      secretBytes.byteOffset,
      secretBytes.byteOffset + secretBytes.byteLength,
    ),
  });
  const encrypted = await encryptTotpSecret(secretBytes, deps.kekHex);
  const ok = await deps.usernames.setTotpSecretEncrypted(r.username, encrypted);
  if (!ok) return { status: 404, body: { error: "unknown username" } };

  const totp = new OTPAuth.TOTP({
    issuer,
    label: r.username,
    issuerInLabel: true,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_S,
    secret: secretObj,
  });
  const otpauthUrl = totp.toString();

  let qrPngBase64: string;
  try {
    const matrix = await qrMatrixFromText(otpauthUrl);
    qrPngBase64 = encodeQrPng(matrix, { scale: 4, quietZone: 4 });
  } catch {
    // QR rendering must not block enrollment — the otpauth URL
    // alone is enough for users with manual-entry-capable apps.
    qrPngBase64 = "";
  }

  return {
    status: 200,
    body: {
      secret: secretObj.base32,
      otpauthUrl,
      qrPngBase64,
      issuer,
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Handler — /totp/enroll-confirm
// ───────────────────────────────────────────────────────────────────

interface EnrollConfirmBody {
  request?: { username?: unknown; issuedAt?: unknown };
  signature?: unknown;
  code?: unknown;
}

export async function handleTotpEnrollConfirm(
  deps: TotpDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!deps.kekHex) {
    return { status: 503, body: { error: "TOTP not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const rand = deps.randomBytes ?? defaultRandomBytes;
  const fastHash = deps.fastHash ?? false;

  const b = body as EnrollConfirmBody;
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string" ||
    typeof b?.code !== "string" ||
    b.code.length === 0
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };
  if (!userRec.totpSecretEncrypted) {
    return {
      status: 409,
      body: { error: "no staged TOTP secret; call enroll-begin first" },
    };
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: TotpEnrollConfirm = {
    username: r.username,
    issuedAt: r.issuedAt,
  };
  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return { status: 500, body: { error: "stored IRK pubkey is malformed" } };
  }
  if (!verifyTotpEnrollConfirm(claim, sig, irkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  // Verify the sample code against the staged secret.
  let secret: Uint8Array;
  try {
    secret = await decryptTotpSecret(userRec.totpSecretEncrypted, deps.kekHex);
  } catch {
    return { status: 500, body: { error: "stored TOTP secret is corrupted" } };
  }
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_S,
    secret: new OTPAuth.Secret({ buffer: secret.buffer }),
  });
  const delta = totp.validate({
    token: b.code,
    timestamp: now(),
    window: TOTP_WINDOW,
  });
  if (delta === null) {
    return { status: 401, body: { error: "invalid TOTP code" } };
  }

  // Generate 10 recovery codes + their argon2id hashes, write
  // everything in one atomic finalize.
  const { plaintexts, hashesJson } = await generateRecoveryCodes(rand, fastHash);
  const ok = await deps.usernames.finalizeTotpEnrollment(
    r.username,
    now(),
    hashesJson,
  );
  if (!ok) return { status: 404, body: { error: "unknown username" } };

  return {
    status: 200,
    body: {
      ok: true,
      accountType: "multi",
      totpEnrolledAt: now(),
      recoveryCodes: plaintexts,
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Handler — /totp/verify (no signature; rate-limited proof carrier)
// ───────────────────────────────────────────────────────────────────

interface VerifyBody {
  code?: unknown;
}

export async function handleTotpVerify(
  deps: TotpDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!deps.kekHex) {
    return { status: 503, body: { error: "TOTP not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const t = now();
  const peek = peekVerifyAttempts(username, t);
  if (peek.tripped) {
    const retryAfterMs = Math.max(
      0,
      VERIFY_WINDOW_MS - (t - peek.windowStart),
    );
    return {
      status: 429,
      body: {
        error: "too many TOTP verify attempts",
        retryAfterMs,
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
      },
    };
  }
  const b = body as VerifyBody;
  if (typeof b?.code !== "string" || b.code.length === 0) {
    // Don't burn an attempt on a malformed request — those are
    // client bugs, not guessing.
    return { status: 400, body: { error: "malformed body" } };
  }
  const userRec = await deps.usernames.get(username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };

  const verdict = await validateTotpCode({
    code: b.code,
    totpSecretEncrypted: userRec.totpSecretEncrypted,
    recoveryCodesHashesJson: userRec.recoveryCodesHashesJson,
    kekHex: deps.kekHex,
    now: t,
  });
  if (!verdict.valid) {
    const post = recordVerifyAttempt(username, t);
    return {
      status: 401,
      body: {
        valid: false,
        error: "invalid code",
        remainingAttempts: post.remaining,
      },
    };
  }
  // Successful verify does NOT consume a recovery code. The re-pair
  // handler does atomic consumption via consumeRecoveryCode at the
  // moment the proof is committed.
  return {
    status: 200,
    body: { valid: true, method: verdict.method },
  };
}

// ───────────────────────────────────────────────────────────────────
// Handler — /totp/disable
// ───────────────────────────────────────────────────────────────────

interface DisableBody {
  request?: { username?: unknown; issuedAt?: unknown };
  signature?: unknown;
  code?: unknown;
}

export async function handleTotpDisable(
  deps: TotpDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!deps.kekHex) {
    return { status: 503, body: { error: "TOTP not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as DisableBody;
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string" ||
    typeof b?.code !== "string" ||
    b.code.length === 0
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };
  if (!userRec.totpEnrolledAt || !userRec.totpSecretEncrypted) {
    return { status: 409, body: { error: "TOTP not enrolled" } };
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: TotpDisable = { username: r.username, issuedAt: r.issuedAt };
  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return { status: 500, body: { error: "stored IRK pubkey is malformed" } };
  }
  if (!verifyTotpDisable(claim, sig, irkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const verdict = await validateTotpCode({
    code: b.code,
    totpSecretEncrypted: userRec.totpSecretEncrypted,
    recoveryCodesHashesJson: userRec.recoveryCodesHashesJson,
    kekHex: deps.kekHex,
    now: now(),
  });
  if (!verdict.valid) {
    return { status: 401, body: { error: "invalid TOTP code" } };
  }

  // The plan doc spells this out: disabling multi-device TOTP is
  // ONLY allowed when the account isn't currently multi-device in
  // shape. Translate "multiple paired sessions on .com" as
  // "multiple push_tokens rows currently exist". When pushTokens
  // dep is wired (the production path) and the count is > 1, the
  // disable refuses with a clean error the UI can render.
  if (deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(r.username);
    if (rows.length > 1) {
      return {
        status: 409,
        body: {
          error:
            "remove other paired devices before disabling TOTP — single-device account requires single-device state",
          pairedDevices: rows.length,
        },
      };
    }
  }

  const ok = await deps.usernames.clearTotp(r.username);
  if (!ok) return { status: 404, body: { error: "unknown username" } };

  return {
    status: 200,
    body: { ok: true, accountType: "single" },
  };
}

// ───────────────────────────────────────────────────────────────────
// Default RNG
// ───────────────────────────────────────────────────────────────────

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export const _internal = {
  TOTP_WINDOW,
  TOTP_PERIOD_S,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_CHARS,
  VERIFY_LIMIT,
  VERIFY_WINDOW_MS,
  ARGON_PARAMS,
  ARGON_PARAMS_FAST,
  parseRecoveryCodesJson,
  hashRecoveryCode,
  verifyRecoveryCode,
  generateRecoveryCodes,
  qrMatrixFromText,
};

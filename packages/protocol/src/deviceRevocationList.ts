/**
 * `.com`'s signed list of an account's revoked device grants, for keyd's master check
 * (identityAssertion.ts checkMasterEvidence; docs/architecture-v2/REGISTER.md "Gap closure").
 *
 * keyd refuses master evidence the owner took back only from what it was handed, and the daemon
 * hands it over, so a compromised daemon could withhold a revocation. With this list keyd needs
 * freshness instead of trust: `.com` signs, with its CA operational key,
 *
 *   flagship/device-revocation-list/v1|<account IRK hex>|<issuedAt ms>|<revoked grant ids, sorted, comma-joined>
 *
 * The daemon passes the list on (it can't forge one), keyd adds its grant ids to what it holds
 * (removal only), and keyd signs master only while it holds a list issued within
 * REVOCATION_LIST_MAX_AGE_MS. A daemon that withholds lists gets manager for its admins, never a
 * revoked device's master. The CA keys keyd checks against are written by root
 * (`<keyd state>/ca-keys.json`, from the box's baked maintainer pin; server-daemon keydCaKeys.ts),
 * never by the daemon.
 */
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";

export const TAG_DEVICE_REVOCATION_LIST = "flagship/device-revocation-list/v1";
/** The oldest list keyd still signs master on. */
export const REVOCATION_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** A list dated further ahead of keyd's clock than this is refused. */
export const REVOCATION_LIST_SKEW_MS = 5 * 60_000;
export const REVOCATION_LIST_MAX_IDS = 4096;

export interface DeviceRevocationList {
  irkPubHex: string;
  issuedAt: number;
  grantIds: string[];
}

export interface SignedDeviceRevocationList extends DeviceRevocationList {
  /** The CA operational key that signed (lowercase hex). */
  keyHex: string;
  signature: string;
}

/** The CA keys root wrote for keyd, and the window of list times they vouch for. */
export interface KeydCaKeys {
  v: 1;
  keys: string[];
  validFrom: number;
  validUntil: number;
}

export type RevocationListRefusal = "malformed" | "wrong-account" | "key-not-authorized" | "outside-window" | "future" | "signature";

const HEX32 = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const GRANT_ID = /^[0-9a-zA-Z-]{8,64}$/;

function normalizedIds(ids: readonly string[]): string[] | null {
  if (ids.length > REVOCATION_LIST_MAX_IDS || !ids.every((id) => typeof id === "string" && GRANT_ID.test(id))) return null;
  return [...new Set(ids)].sort();
}

export function canonicalDeviceRevocationList(l: DeviceRevocationList): Bytes {
  const ids = normalizedIds(l.grantIds);
  if (!HEX32.test(l.irkPubHex) || !Number.isSafeInteger(l.issuedAt) || l.issuedAt <= 0 || !ids) {
    throw new Error("device-revocation-list: malformed");
  }
  return new TextEncoder().encode([TAG_DEVICE_REVOCATION_LIST, l.irkPubHex, l.issuedAt, ids.join(",")].join("|"));
}

export function signDeviceRevocationList(l: DeviceRevocationList, caPriv: Bytes): SignedDeviceRevocationList {
  const ids = normalizedIds(l.grantIds);
  if (!ids) throw new Error("device-revocation-list: malformed");
  const list = { irkPubHex: l.irkPubHex, issuedAt: l.issuedAt, grantIds: ids };
  const sig = ed.sign(canonicalDeviceRevocationList(list), caPriv);
  return { ...list, keyHex: toHex(ed.getPublicKey(caPriv)), signature: toHex(sig) };
}

/** `ca-keys.json` as root wrote it, or null when it is missing a field or damaged. */
export function parseKeydCaKeys(v: unknown): KeydCaKeys | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<KeydCaKeys>;
  if (o.v !== 1 || !Array.isArray(o.keys) || o.keys.length > 64 || !o.keys.every((k) => typeof k === "string" && HEX32.test(k))) return null;
  if (!Number.isSafeInteger(o.validFrom) || !Number.isSafeInteger(o.validUntil) || o.validFrom! > o.validUntil!) return null;
  return { v: 1, keys: [...o.keys], validFrom: o.validFrom!, validUntil: o.validUntil! };
}

/** The list, when `.com`'s CA signed it for this account inside root's window; else why not. */
export function verifyDeviceRevocationList(
  wire: unknown,
  expect: { irkPubHex: string; caKeys: KeydCaKeys; now: number },
): { ok: true; list: DeviceRevocationList } | { ok: false; code: RevocationListRefusal } {
  if (!wire || typeof wire !== "object") return { ok: false, code: "malformed" };
  const w = wire as Partial<SignedDeviceRevocationList>;
  const keys = Object.keys(w).sort().join(",");
  if (keys !== "grantIds,irkPubHex,issuedAt,keyHex,signature") return { ok: false, code: "malformed" };
  if (typeof w.irkPubHex !== "string" || !HEX32.test(w.irkPubHex) || typeof w.issuedAt !== "number" || !Number.isSafeInteger(w.issuedAt) || w.issuedAt <= 0) {
    return { ok: false, code: "malformed" };
  }
  if (!Array.isArray(w.grantIds) || typeof w.keyHex !== "string" || !HEX32.test(w.keyHex) || typeof w.signature !== "string" || !SIG.test(w.signature)) {
    return { ok: false, code: "malformed" };
  }
  const ids = normalizedIds(w.grantIds);
  if (!ids || ids.join(",") !== w.grantIds.join(",")) return { ok: false, code: "malformed" };
  if (w.irkPubHex !== expect.irkPubHex.toLowerCase()) return { ok: false, code: "wrong-account" };
  if (!expect.caKeys.keys.includes(w.keyHex)) return { ok: false, code: "key-not-authorized" };
  if (w.issuedAt < expect.caKeys.validFrom || w.issuedAt > expect.caKeys.validUntil) return { ok: false, code: "outside-window" };
  if (w.issuedAt > expect.now + REVOCATION_LIST_SKEW_MS) return { ok: false, code: "future" };
  const list = { irkPubHex: w.irkPubHex, issuedAt: w.issuedAt, grantIds: ids };
  let good = false;
  try {
    good = ed.verify(fromHex(w.signature), canonicalDeviceRevocationList(list), fromHex(w.keyHex));
  } catch {
    good = false;
  }
  return good ? { ok: true, list } : { ok: false, code: "signature" };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

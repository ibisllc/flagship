/**
 * The owner's call hours, synced between the owner's own devices and never published (owner decision 2026-11-16,
 * option c: hours in the page index would show the owner's time zone to anyone). Sealed like the Messages state
 * blob, under its own key, so `.com` stores ciphertext and never learns the hours or the time zone. The ringing
 * phone enforces them: outside them it doesn't ring and the call becomes a missed call; the caller hears "No answer".
 * Shared vectors: packages/protocol/test-vectors/voici-call-modes/ section `callSettings`.
 *
 *   key      HKDF-SHA256(ikm UMK seed, salt empty, info "flagship/voici-call-settings/v1", 32)
 *   sealed   {version, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce, aad "flagship/voici-call-settings/v1|
 *            <username>|<version>", canonical JSON plaintext); `version` = stored + 1 (compare-and-set at `.com`)
 *   plain    {v:1, hours, updatedAt}; hours null (calls ring any time) or {days, from, to, zone}:
 *              days  seven "0"/"1" from Monday, not all "0"
 *              from, to  "HHMM" 0000-2359, different; an end before the start runs past midnight (the days name the
 *                    start's day)
 *              zone  IANA ("Europe/Paris") or "UTC"
 *            A conflict merges by the newer updatedAt.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import type { Bytes, UserMasterKey } from "./types.js";
import { b64Decode, b64Encode, canonicalJson, canonicalJsonBytes, hexToBytes, isLowerHex } from "./webEnvelope.js";

export const TAG_VOICI_CALL_SETTINGS = "flagship/voici-call-settings/v1";
export const VOICI_CALL_SETTINGS_MAX_BYTES = 4 * 1024;

export interface VoiciCallHours {
  days: string;
  from: string;
  to: string;
  zone: string;
}
export interface VoiciCallSettings {
  v: 1;
  hours: VoiciCallHours | null;
  updatedAt: number;
}

const te = new TextEncoder();
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DAYS = /^[01]{7}$/;
const HHMM = /^([01][0-9]|2[0-3])[0-5][0-9]$/;
const ZONE = /^(UTC|[A-Za-z]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){1,2})$/;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r: Record<string, unknown>, keys: string[]) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

function knownZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/** Strict shape of the hours (and a time zone this runtime knows). */
export function parseVoiciCallHours(v: unknown): VoiciCallHours | null {
  if (!isObj(v) || !exactKeys(v, ["days", "from", "to", "zone"])) return null;
  if (typeof v.days !== "string" || !DAYS.test(v.days) || v.days === "0000000") return null;
  if (typeof v.from !== "string" || !HHMM.test(v.from) || typeof v.to !== "string" || !HHMM.test(v.to) || v.from === v.to) return null;
  if (typeof v.zone !== "string" || !ZONE.test(v.zone) || !knownZone(v.zone)) return null;
  return { days: v.days, from: v.from, to: v.to, zone: v.zone };
}

export function parseVoiciCallSettings(v: unknown): VoiciCallSettings | null {
  if (!isObj(v) || !exactKeys(v, ["v", "hours", "updatedAt"]) || v.v !== 1 || !isTime(v.updatedAt)) return null;
  if (v.hours === null) return { v: 1, hours: null, updatedAt: v.updatedAt };
  const hours = parseVoiciCallHours(v.hours);
  return hours ? { v: 1, hours, updatedAt: v.updatedAt } : null;
}

/** Whether a call may ring at `now` (no hours: always). Run on the ringing device only. */
export function voiciCallHoursAllow(hours: VoiciCallHours | null, now: number): boolean {
  if (hours === null) return true;
  const h = parseVoiciCallHours(hours);
  if (!h) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: h.zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const day = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  const min = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  if (day < 0 || !Number.isFinite(min)) return true;
  const start = Number(h.from.slice(0, 2)) * 60 + Number(h.from.slice(2));
  const end = Number(h.to.slice(0, 2)) * 60 + Number(h.to.slice(2));
  const on = (d: number) => h.days[(d + 7) % 7] === "1";
  if (start < end) return on(day) && min >= start && min < end;
  return (on(day) && min >= start) || (on(day - 1) && min < end);
}

export function deriveVoiciCallSettingsKey(umk: UserMasterKey): Bytes {
  return hkdf(sha256, umk.seed, new Uint8Array(0), te.encode(TAG_VOICI_CALL_SETTINGS), 32);
}

export function sealVoiciCallSettings(
  key: Bytes,
  username: string,
  version: number,
  s: VoiciCallSettings,
  nonce: Bytes = crypto.getRandomValues(new Uint8Array(12)),
): { version: number; nonce: string; ct: string } {
  if (!USERNAME.test(username) || !isTime(version) || version < 1 || nonce.length !== 12 || !parseVoiciCallSettings(s)) throw new Error(`${TAG_VOICI_CALL_SETTINGS}: bad input`);
  const pt = canonicalJsonBytes(s);
  const ct = gcm(key, nonce, te.encode(`${TAG_VOICI_CALL_SETTINGS}|${username}|${version}`)).encrypt(pt);
  return { version, nonce: hex(nonce), ct: b64Encode(ct) };
}

export function openVoiciCallSettings(key: Bytes, username: string, blob: unknown): VoiciCallSettings | null {
  if (!isObj(blob) || !exactKeys(blob, ["version", "nonce", "ct"]) || !isTime(blob.version) || !isLowerHex(blob.nonce, 12)) return null;
  const ct = b64Decode(blob.ct);
  if (!ct || ct.length > VOICI_CALL_SETTINGS_MAX_BYTES + 16) return null;
  try {
    const pt = gcm(key, hexToBytes(blob.nonce), te.encode(`${TAG_VOICI_CALL_SETTINGS}|${username}|${blob.version}`)).decrypt(ct);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
    const v = JSON.parse(text);
    return canonicalJson(v) === text ? parseVoiciCallSettings(v) : null;
  } catch {
    return null;
  }
}

/** A version conflict: the newer settings win. */
export function mergeVoiciCallSettings(local: VoiciCallSettings, remote: VoiciCallSettings): VoiciCallSettings {
  return remote.updatedAt > local.updatedAt ? remote : local;
}

// The owner's call hours, synced between the owner's own devices and never published (docs/voici-calls.md, owner
// decision 2026-11-16, option c): browser port of packages/protocol/src/voiciCallSettings.ts, byte for byte (vectors
// packages/protocol/test-vectors/voici-call-modes/ section `callSettings`, replayed by apps/web/tests/webappVoiciCallSettings.test.ts).
// `.com` keeps the sealed blob only; the ringing phone enforces the hours. The webapp never rings, it edits them.
//
//   deriveVoiciCallSettingsKey, sealVoiciCallSettings, openVoiciCallSettings, parseVoiciCallHours, voiciCallHoursAllow
//   loadCallSettings(deps) / saveCallHours(hours, deps)     GET / PUT /api/accounts/<u>/voici-call-settings

import { aesGcm, b64Decode, b64Encode, canonicalJson, canonicalJsonBytes, hex, hexToBytes, hkdfSha256, isLowerHex } from "./voiciCore.js";

export const TAG_VOICI_CALL_SETTINGS = "flagship/voici-call-settings/v1";
const te = new TextEncoder();
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HHMM = /^([01][0-9]|2[0-3])[0-5][0-9]$/;
const ZONE = /^(UTC|[A-Za-z]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){1,2})$/;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r, keys) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

function knownZone(z) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

export function parseVoiciCallHours(v) {
  if (!isObj(v) || !exactKeys(v, ["days", "from", "to", "zone"])) return null;
  if (typeof v.days !== "string" || !/^[01]{7}$/.test(v.days) || v.days === "0000000") return null;
  if (typeof v.from !== "string" || !HHMM.test(v.from) || typeof v.to !== "string" || !HHMM.test(v.to) || v.from === v.to) return null;
  if (typeof v.zone !== "string" || !ZONE.test(v.zone) || !knownZone(v.zone)) return null;
  return { days: v.days, from: v.from, to: v.to, zone: v.zone };
}

export function parseVoiciCallSettings(v) {
  if (!isObj(v) || !exactKeys(v, ["v", "hours", "updatedAt"]) || v.v !== 1 || !isTime(v.updatedAt)) return null;
  if (v.hours === null) return { v: 1, hours: null, updatedAt: v.updatedAt };
  const hours = parseVoiciCallHours(v.hours);
  return hours ? { v: 1, hours, updatedAt: v.updatedAt } : null;
}

export function voiciCallHoursAllow(hours, now) {
  if (hours === null) return true;
  const h = parseVoiciCallHours(hours);
  if (!h) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: h.zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const day = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  const min = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  if (day < 0 || !Number.isFinite(min)) return true;
  const start = Number(h.from.slice(0, 2)) * 60 + Number(h.from.slice(2));
  const end = Number(h.to.slice(0, 2)) * 60 + Number(h.to.slice(2));
  const on = (d) => h.days[(d + 7) % 7] === "1";
  if (start < end) return on(day) && min >= start && min < end;
  return (on(day) && min >= start) || (on(day - 1) && min < end);
}

export const deriveVoiciCallSettingsKey = (umk) => hkdfSha256(umk.seed, TAG_VOICI_CALL_SETTINGS, 32);

export function sealVoiciCallSettings(key, username, version, s, nonce = crypto.getRandomValues(new Uint8Array(12))) {
  if (!USERNAME.test(username) || !isTime(version) || version < 1 || nonce.length !== 12 || !parseVoiciCallSettings(s)) throw new Error(`${TAG_VOICI_CALL_SETTINGS}: bad input`);
  const ct = aesGcm(key, nonce, te.encode(`${TAG_VOICI_CALL_SETTINGS}|${username}|${version}`)).encrypt(canonicalJsonBytes(s));
  return { version, nonce: hex(nonce), ct: b64Encode(ct) };
}

export function openVoiciCallSettings(key, username, blob) {
  if (!isObj(blob) || !exactKeys(blob, ["version", "nonce", "ct"]) || !isTime(blob.version) || !isLowerHex(blob.nonce, 12)) return null;
  const ct = b64Decode(blob.ct);
  if (!ct || ct.length > 4096 + 16) return null;
  try {
    const pt = aesGcm(key, hexToBytes(blob.nonce), te.encode(`${TAG_VOICI_CALL_SETTINGS}|${username}|${blob.version}`)).decrypt(ct);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
    const v = JSON.parse(text);
    return canonicalJson(v) === text ? parseVoiciCallSettings(v) : null;
  } catch {
    return null;
  }
}

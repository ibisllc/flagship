// First contact (docs/first-contact.md): this device's pin of each server's own key (STK).
//
// A server makes its key at install. The first blessing pins it here; from then on every request,
// status report or `/pods` entry naming another key is refused, and anything sealed for the server is
// sealed to the pinned key only. `.com`'s word about a key is never a trust input after the pin.
// A pin changes only through an explicit re-trust (a new recipe for that name, or deleting the server).
//
// Also kept here, per server and never synced: the recipe's one-time enrollment secret (with the
// order serial the box's proof binds) and the Studio confirmation key, both wrapped under the account
// key in the keystore database, and deleted once the server is pinned.

import { kvGet, kvPut, kvDel, sealDeviceSecret, openDeviceSecret } from "../keystore.js";

import { tr } from "./i18n.js";
const PINS_KEY = "flagship.serverPins.v1";
const CONFIRMED_KEY = "flagship.serverCodeConfirmed.v1";
const SECRET_WRAP_INFO = "flagship.server-first-contact-wrap.v1";
const HEX64 = /^[0-9a-f]{64}$/;

const norm = (d) => String(d ?? "").trim().toLowerCase();
const hex = (h) => String(h ?? "").trim().toLowerCase();

function readMap(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* storage off: the pin lives for this page only, through memPins */
  }
}

const memPins = new Map();
const changed = new Map();
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a bad listener never breaks the store */ }
  }
}

/** Called whenever a pin or a key-changed note moves. Returns unsubscribe. */
export function onServerPinsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The pinned STK for `domain` (64 lowercase hex), or null when this device has not pinned it. */
export function pinnedStk(domain) {
  const d = norm(domain);
  if (!d) return null;
  const entry = readMap(PINS_KEY)[d];
  const stk = hex(entry?.stk ?? memPins.get(d));
  return HEX64.test(stk) ? stk : null;
}

/**
 * Pin `stkHex` for `domain`. Refuses to replace a different pin: only `retrustServer` clears one.
 * `how` records what made the pin ("proof", "first-sight", "studio").
 */
export function pinServerKey(domain, stkHex, how = "first-sight") {
  const d = norm(domain);
  const stk = hex(stkHex);
  if (!d || !HEX64.test(stk)) throw new Error("not a server key");
  const have = pinnedStk(d);
  if (have && have !== stk) throw keyChangedError(d);
  memPins.set(d, stk);
  const map = readMap(PINS_KEY);
  map[d] = { stk, how, at: Date.now() };
  writeMap(PINS_KEY, map);
  changed.delete(d);
  emit();
  return stk;
}

/**
 * The explicit re-trust: forget the pin (a new recipe for this name, or the server was deleted).
 * Never call this from anything that reads `.com` or a box.
 */
export function retrustServer(domain) {
  const d = norm(domain);
  memPins.delete(d);
  changed.delete(d);
  const map = readMap(PINS_KEY);
  delete map[d];
  writeMap(PINS_KEY, map);
  const conf = readMap(CONFIRMED_KEY);
  delete conf[d];
  writeMap(CONFIRMED_KEY, conf);
  emit();
}

export const KEY_CHANGED_CODE = "server-key-changed";

export function keyChangedError(domain) {
  return Object.assign(new Error(tr("This server's key changed. If you did not rebuild it, do not approve anything for it.")), {
    code: KEY_CHANGED_CODE,
    serverDomain: norm(domain),
  });
}

/** Remember that something named another key for a pinned server, so the screens can say so. */
export function noteKeyChanged(domain, offeredHex) {
  const d = norm(domain);
  const was = changed.get(d);
  changed.set(d, hex(offeredHex));
  if (was !== hex(offeredHex)) emit();
}

/** True when something named a key other than the pin for `domain` since this page loaded. */
export function serverKeyChanged(domain) {
  return changed.has(norm(domain));
}

/**
 * The key to use for a server whose key `offeredHex` came from `.com` or a box.
 *   - pinned: the pin when the offer matches it (or there is no offer); null, noted, when it differs;
 *   - not pinned: the offered key (first sight, nothing sealed on it: see sealingStk).
 */
export function trustedStk(domain, offeredHex) {
  const pin = pinnedStk(domain);
  const offered = hex(offeredHex);
  if (pin) {
    if (offered && offered !== pin) {
      noteKeyChanged(domain, offered);
      return null;
    }
    return pin;
  }
  return HEX64.test(offered) ? offered : null;
}

/** The key to seal anything to: the pin, and only the pin. Null until pinned, or when the offer differs. */
export function sealingStk(domain, offeredHex) {
  const pin = pinnedStk(domain);
  if (!pin) return null;
  return trustedStk(domain, offeredHex);
}

/** `trustedStk` for a `/pods` row (empty string when refused or absent). */
export function podStk(pod) {
  return trustedStk(pod?.serverDomain ?? pod?.fqdn ?? "", pod?.identityPubKey) ?? "";
}

// ── Studio confirmation seam ────────────────────────────────────────────────

/** Mark this server's code as seen and matched by Studio for `stkHex`. */
export function markCodeConfirmed(domain, stkHex) {
  const d = norm(domain);
  const stk = hex(stkHex);
  if (!d || !HEX64.test(stk)) return;
  const map = readMap(CONFIRMED_KEY);
  const seen = Array.isArray(map[d]) ? map[d] : [];
  if (!seen.includes(stk)) map[d] = [...seen, stk].slice(-4);
  writeMap(CONFIRMED_KEY, map);
  emit();
}

/** True when Studio confirmed the code for exactly this key. */
export function codeConfirmed(domain, stkHex) {
  const stk = hex(stkHex);
  const seen = readMap(CONFIRMED_KEY)[norm(domain)];
  return HEX64.test(stk) && Array.isArray(seen) && seen.includes(stk);
}

// ── Per-server secrets, wrapped under the account key ───────────────────────

const recordKey = (kind, domain) => `${kind}.${norm(domain)}`;

async function keepSecret(kind, umk, domain, value, deps = {}) {
  const put = deps.kvPut || kvPut;
  const rk = recordKey(kind, domain);
  await put(rk, await sealDeviceSecret(umk, SECRET_WRAP_INFO, rk, new TextEncoder().encode(JSON.stringify(value))));
}

async function loadSecret(kind, umk, domain, deps = {}) {
  const get = deps.kvGet || kvGet;
  try {
    const rk = recordKey(kind, domain);
    const blob = await get(rk);
    if (!blob || !umk) return null;
    return JSON.parse(new TextDecoder().decode(await openDeviceSecret(umk, SECRET_WRAP_INFO, rk, blob)));
  } catch {
    return null;
  }
}

async function dropSecret(kind, domain, deps = {}) {
  const del = deps.kvDel || kvDel;
  await del(recordKey(kind, domain)).catch(() => {});
}

/** Keep the recipe's enrollment secret and its order serial for `domain` on this device only. */
export async function keepEnrollmentSecret(umk, domain, { secretHex, serial }, deps = {}) {
  if (!HEX64.test(hex(secretHex)) || typeof serial !== "string" || !serial) throw new Error("bad enrollment secret");
  await keepSecret("enrollmentSecret", umk, domain, { secretHex: hex(secretHex), serial }, deps);
}

/** `{ secretHex, serial }` when this device made the recipe and the server is not pinned yet, else null. */
export async function loadEnrollmentSecret(umk, domain, deps = {}) {
  const v = await loadSecret("enrollmentSecret", umk, domain, deps);
  return v && HEX64.test(hex(v.secretHex)) && typeof v.serial === "string" ? { secretHex: hex(v.secretHex), serial: v.serial } : null;
}

export async function forgetEnrollmentSecret(domain, deps = {}) {
  await dropSecret("enrollmentSecret", domain, deps);
}

/** The per-server key Studio uses to say which server key it saw on the console. */
export async function keepStudioConfirmKey(umk, domain, keyHex, deps = {}) {
  if (!HEX64.test(hex(keyHex))) throw new Error("bad confirmation key");
  await keepSecret("studioConfirmKey", umk, domain, { keyHex: hex(keyHex) }, deps);
}

export async function loadStudioConfirmKey(umk, domain, deps = {}) {
  const v = await loadSecret("studioConfirmKey", umk, domain, deps);
  return v && HEX64.test(hex(v.keyHex)) ? hex(v.keyHex) : null;
}

export async function forgetStudioConfirmKey(domain, deps = {}) {
  await dropSecret("studioConfirmKey", domain, deps);
}

/** After a pin, the secrets have done their job. */
export async function forgetFirstContactSecrets(domain, deps = {}) {
  await forgetEnrollmentSecret(domain, deps);
  await forgetStudioConfirmKey(domain, deps);
}

export const _test = {
  reset() {
    memPins.clear();
    changed.clear();
    try {
      localStorage.removeItem(PINS_KEY);
      localStorage.removeItem(CONFIRMED_KEY);
    } catch { /* no storage */ }
  },
};

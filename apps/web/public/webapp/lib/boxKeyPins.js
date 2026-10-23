// Box key pins (packages/protocol/src/boxKeyPin.ts; vectors in
// packages/protocol/test-vectors/box-key-pin/).
//
// Everything this browser seals for a server (the disk-key reply, an
// auto-unlock lease, the SWK / CGK / pairing deposits) goes to the box key
// `.com`'s /pods lists. This browser pins that key per server the first time
// it learns it and refuses to seal to any other afterwards, so a `.com` that
// turns hostile can't swap in its own key and collect the disk key. A key
// changes legitimately only when the server is reinstalled, replaced or
// moved: the device that does it re-pins (`repinBoxKey`), and any other
// device asks its owner first ("Trust its new key").
//
// Pins are public keys, kept in localStorage per account.
//
// Architecture v2: a box's STK also binds an ML-DSA-65 key (lib/pqBinding.js). The browser
// accepts that binding only under the pinned STK, pins the ML-DSA key the first time
// (`mldsa`), refuses a different one later, and from then on requires the boot-key binding's
// hybrid signature too, so stripping it cannot downgrade this server back to classical.

import { verifyBootKeyBindingV2, verifyPqKeyBinding } from "./pqBinding.js";

const TAG_BOOT_KEY_BINDING = "flagship/boot-key-binding/v1";
const HEX32 = /^[0-9a-f]{64}$/;
const memory = new Map();

export const BOX_KEY_CHANGED_MESSAGE =
  "This server's identity key changed since this device first saw it, so Flagship won't send it your disk key. " +
  "If you reinstalled, replaced or moved this server, choose Trust its new key. If you didn't, someone may be impersonating it.";

export class BoxKeyChangedError extends Error {
  constructor(serverDomain, pinnedHex, reportedHex) {
    super(BOX_KEY_CHANGED_MESSAGE);
    this.name = "BoxKeyChangedError";
    this.code = "box-key-changed";
    this.serverDomain = serverDomain;
    this.pinnedHex = pinnedHex;
    this.reportedHex = reportedHex;
  }
}

/** Same verdicts as the TS reference: "first" | "match" | "mismatch" | "invalid". */
export function decideBoxKeyPin(pinnedHex, reportedHex) {
  const reported = String(reportedHex ?? "").toLowerCase();
  if (!HEX32.test(reported)) return "invalid";
  if (!pinnedHex) return "first";
  return String(pinnedHex).toLowerCase() === reported ? "match" : "mismatch";
}

function storageOf(deps) {
  if (deps.pinStorage) return deps.pinStorage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { /* storage blocked */ }
  return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) };
}

const keyFor = (username) => `flagship.boxKeyPins.v1:${String(username).toLowerCase()}`;

function load(username, deps) {
  try {
    const raw = storageOf(deps).getItem(keyFor(username));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(username, pins, deps) {
  try { storageOf(deps).setItem(keyFor(username), JSON.stringify(pins)); } catch { /* best effort */ }
}

export function pinnedBoxKey(username, serverDomain, deps = {}) {
  return load(username, deps)[String(serverDomain).toLowerCase()]?.stk ?? null;
}

/**
 * The key this browser may seal to for `serverDomain`: pins `reportedHex` the
 * first time, returns it while it matches, and throws `BoxKeyChangedError`
 * when it differs from the pin.
 */
export function requirePinnedBoxKey(username, serverDomain, reportedHex, deps = {}) {
  const domain = String(serverDomain).toLowerCase();
  const pins = load(username, deps);
  const reported = String(reportedHex ?? "").toLowerCase();
  const verdict = decideBoxKeyPin(pins[domain]?.stk, reported);
  if (verdict === "invalid") throw new Error(`${domain} has no valid box key on file`);
  if (verdict === "mismatch") throw new BoxKeyChangedError(domain, pins[domain].stk, reported);
  if (verdict === "first") {
    pins[domain] = { stk: reported, pinnedAt: (deps.now || Date.now)() };
    save(username, pins, deps);
  }
  return reported;
}

/** Pin every listed server this browser hasn't pinned yet, so the pin predates any request. */
export function observePods(username, pods, deps = {}) {
  if (!username || !Array.isArray(pods)) return;
  const pins = load(username, deps);
  let changed = false;
  for (const p of pods) {
    const domain = String(p?.serverDomain ?? "").toLowerCase();
    const stk = String(p?.identityPubKey ?? "").toLowerCase();
    if (!domain || p?.revokedAt != null || pins[domain] || !HEX32.test(stk)) continue;
    pins[domain] = { stk, pinnedAt: (deps.now || Date.now)() };
    changed = true;
  }
  if (changed) save(username, pins, deps);
}

/**
 * Replace the pin: only for a change the owner made or confirmed here (this
 * device created or reinstalled the server, moved it, or the owner chose
 * "Trust its new key"). Drops any boot key the old STK had bound.
 */
export function repinBoxKey(username, serverDomain, stkHex, deps = {}) {
  const stk = String(stkHex ?? "").toLowerCase();
  if (!HEX32.test(stk)) throw new Error("not a box key");
  const pins = load(username, deps);
  pins[String(serverDomain).toLowerCase()] = { stk, pinnedAt: (deps.now || Date.now)() };
  save(username, pins, deps);
}

/** This device is about to (re)create `serverDomain`: its next registered key is pinned fresh. */
export function forgetBoxKeyPin(username, serverDomain, deps = {}) {
  const pins = load(username, deps);
  const domain = String(serverDomain).toLowerCase();
  if (!(domain in pins)) return;
  delete pins[domain];
  save(username, pins, deps);
}

export function canonicalBootKeyBinding({ serverDomain, bootPubHex, issuedAt }) {
  if (!HEX32.test(bootPubHex)) throw new Error("bootPubHex must be 32 bytes of lowercase hex");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("issuedAt must be a non-negative integer");
  return new TextEncoder().encode(
    [TAG_BOOT_KEY_BINDING, String(serverDomain).toLowerCase(), bootPubHex, String(issuedAt)].join("|"),
  );
}

export async function verifyBootKeyBinding(binding, signature, pinnedStkPub, serverDomain) {
  try {
    if (String(binding.serverDomain).toLowerCase() !== String(serverDomain).toLowerCase()) return false;
    const key = await crypto.subtle.importKey("raw", pinnedStkPub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, canonicalBootKeyBinding(binding));
  } catch {
    return false;
  }
}

/**
 * Adopt a box's boot-only key: only through a binding the PINNED STK signed,
 * never because `.com` lists it. Returns the boot key, or null when refused.
 */
export async function acceptBootKeyBinding(username, serverDomain, binding, signatureHex, deps = {}, hybridSignatureHex = undefined) {
  const domain = String(serverDomain).toLowerCase();
  const pins = load(username, deps);
  const pin = pins[domain];
  if (!pin) return null;
  const ok = await verifyBootKeyBinding(binding, hexBytes(signatureHex), hexBytes(pin.stk), domain);
  if (!ok || (pin.bootIssuedAt ?? -1) > binding.issuedAt) return null;
  // Once this server's ML-DSA key is pinned, the boot key needs the STK's hybrid signature too.
  if (pin.mldsa && !verifyBootKeyBindingV2(binding, hybridSignatureHex, pin.stk, pin.mldsa)) return null;
  pins[domain] = { ...pin, boot: binding.bootPubHex, bootIssuedAt: binding.issuedAt };
  save(username, pins, deps);
  return binding.bootPubHex;
}

/**
 * Pin the ML-DSA key a box's STK bound, through a binding the PINNED STK and that key both
 * signed. Returns the ML-DSA key, or null when there is no STK pin or the binding is refused.
 * A binding naming another ML-DSA key than the pinned one throws BoxKeyChangedError.
 */
export function acceptStkPqBinding(username, serverDomain, wire, deps = {}) {
  const domain = String(serverDomain).toLowerCase();
  const pins = load(username, deps);
  const pin = pins[domain];
  if (!pin) return null;
  let b;
  try {
    b = verifyPqKeyBinding(wire, {
      role: "box-stk",
      subjectId: domain,
      ed25519PubHex: pin.stk,
      mldsaPubHex: pin.mldsa ?? null,
      now: (deps.now || Date.now)(),
      ...(pin.mldsaIssuedAt !== undefined ? { minIssuedAt: pin.mldsaIssuedAt } : {}),
    });
  } catch (e) {
    if (e?.code === "binding-pq-key-changed") throw new BoxKeyChangedError(domain, pin.mldsa, String(wire?.mldsaPubHex ?? ""));
    return null;
  }
  if (pin.mldsa !== b.mldsaPubHex || pin.mldsaIssuedAt !== b.issuedAt) {
    pins[domain] = { ...pin, mldsa: b.mldsaPubHex, mldsaIssuedAt: b.issuedAt };
    save(username, pins, deps);
  }
  return b.mldsaPubHex;
}

export function pinnedBoxPqKey(username, serverDomain, deps = {}) {
  return load(username, deps)[String(serverDomain).toLowerCase()]?.mldsa ?? null;
}

export function pinnedBootKey(username, serverDomain, deps = {}) {
  return load(username, deps)[String(serverDomain).toLowerCase()]?.boot ?? null;
}

function hexBytes(hex) {
  const clean = String(hex ?? "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(clean)) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

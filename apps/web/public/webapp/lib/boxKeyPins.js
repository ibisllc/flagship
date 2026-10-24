// Box key pins (packages/protocol/src/boxKeyPin.ts; vectors in
// packages/protocol/test-vectors/box-key-pin/).
//
// Everything this browser seals for a server (the disk-key reply, an
// auto-unlock lease, the SWK / CGK / pairing deposits) goes to the key this
// device pinned for it, so a `.com` that turns hostile can't swap in its own
// key and collect the disk key. The pin itself lives in lib/serverPins.js, the
// one pin store, and is made only by first contact (docs/first-contact.md):
// the first blessing, with the code shown above Approve, or an explicit
// re-trust by the owner. Nothing here pins a key because `.com` lists it.
//
// Architecture v2: a box's STK also binds an ML-DSA-65 key (lib/pqBinding.js). The browser
// accepts that binding only under the pinned STK, keeps the ML-DSA key with the pin the first
// time (`mldsa`), refuses a different one later, and from then on requires the boot-key binding's
// hybrid signature too, so stripping it cannot downgrade this server back to classical.

import { verifyBootKeyBindingV2, verifyPqKeyBinding } from "./pqBinding.js";
import { strictInForce } from "./assurancePolicy.js";
import {
  KEY_CHANGED_CODE,
  noteKeyChanged,
  pinServerKey,
  pinnedStk,
  retrustServer,
  serverPinRecord,
  updateServerPin,
} from "./serverPins.js";
import { tr } from "./i18n.js";

const TAG_BOOT_KEY_BINDING = "flagship/boot-key-binding/v1";
const HEX32 = /^[0-9a-f]{64}$/;
const lower = (s) => String(s ?? "").trim().toLowerCase();

export class BoxKeyChangedError extends Error {
  constructor(serverDomain, pinnedHex, reportedHex) {
    super(tr("This server's key changed. If you did not rebuild it, do not approve anything for it."));
    this.name = "BoxKeyChangedError";
    this.code = KEY_CHANGED_CODE;
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

export function pinnedBoxKey(_username, serverDomain) {
  return pinnedStk(serverDomain);
}

/**
 * The key this browser may seal to for `serverDomain`: the pin, while `reportedHex` matches it.
 * Throws `BoxKeyChangedError` when it differs, and a `server-not-pinned` error when this device
 * has not pinned the server yet ("first" never pins here).
 */
export function requirePinnedBoxKey(_username, serverDomain, reportedHex) {
  const domain = lower(serverDomain);
  const pin = pinnedStk(domain);
  const reported = lower(reportedHex);
  const verdict = decideBoxKeyPin(pin, reported);
  if (verdict === "invalid") throw new Error(`${domain} has no valid box key on file`);
  if (verdict === "mismatch") {
    noteKeyChanged(domain, reported);
    throw new BoxKeyChangedError(domain, pin, reported);
  }
  if (verdict === "first") {
    throw Object.assign(new Error(tr("This device hasn't checked this server's key yet.")), {
      code: "server-not-pinned",
      serverDomain: domain,
    });
  }
  return pin;
}

/** Note every listed server whose key differs from this device's pin. Never pins. */
export function observePods(_username, pods) {
  if (!Array.isArray(pods)) return;
  for (const p of pods) {
    const domain = lower(p?.serverDomain);
    const stk = lower(p?.identityPubKey);
    if (!domain || p?.revokedAt != null || !HEX32.test(stk)) continue;
    const pin = pinnedStk(domain);
    if (pin && pin !== stk) noteKeyChanged(domain, stk);
  }
}

/**
 * The owner's explicit re-pin (this device created or reinstalled the server, or the owner
 * chose to trust a new key after a fresh unlock). Drops the old pin and anything its STK bound.
 */
export function repinBoxKey(_username, serverDomain, stkHex) {
  const stk = lower(stkHex);
  if (!HEX32.test(stk)) throw new Error("not a box key");
  retrustServer(serverDomain);
  pinServerKey(serverDomain, stk, "owner");
}

/** This device is about to (re)create `serverDomain`: its next key is pinned by first contact. */
export function forgetBoxKeyPin(_username, serverDomain) {
  if (pinnedStk(serverDomain)) retrustServer(serverDomain);
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
  const domain = lower(serverDomain);
  const pin = serverPinRecord(domain);
  if (!pin) return null;
  const ok = await verifyBootKeyBinding(binding, hexBytes(signatureHex), hexBytes(pin.stk), domain);
  if (!ok || (pin.bootIssuedAt ?? -1) > binding.issuedAt) return null;
  // Once this server's ML-DSA key is pinned, the boot key needs the STK's hybrid signature too.
  if (pin.mldsa && !verifyBootKeyBindingV2(binding, hybridSignatureHex, pin.stk, pin.mldsa)) return null;
  // A server whose owner turned strict on (deps.policy, replayed by lib/assurancePolicy.js) needs
  // it even before this browser has pinned an ML-DSA key.
  if (!pin.mldsa && strictInForce(deps.policy)) return null;
  if (!updateServerPin(domain, pin.stk, { boot: binding.bootPubHex, bootIssuedAt: binding.issuedAt })) return null;
  return binding.bootPubHex;
}

/**
 * Pin the ML-DSA key a box's STK bound, through a binding the PINNED STK and that key both
 * signed. Returns the ML-DSA key, or null when there is no STK pin or the binding is refused.
 * A binding naming another ML-DSA key than the pinned one throws BoxKeyChangedError.
 */
export function acceptStkPqBinding(username, serverDomain, wire, deps = {}) {
  const domain = lower(serverDomain);
  const pin = serverPinRecord(domain);
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
    if (!updateServerPin(domain, pin.stk, { mldsa: b.mldsaPubHex, mldsaIssuedAt: b.issuedAt })) return null;
  }
  return b.mldsaPubHex;
}

export function pinnedBoxPqKey(_username, serverDomain) {
  return serverPinRecord(serverDomain)?.mldsa ?? null;
}

export function pinnedBootKey(_username, serverDomain) {
  return serverPinRecord(serverDomain)?.boot ?? null;
}

function hexBytes(hex) {
  const clean = String(hex ?? "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(clean)) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

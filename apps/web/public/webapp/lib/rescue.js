// Data rescue and basic offline control (docs/data-sovereignty.md): the canonical bytes of the
// box's hello, the owner's session order and the offline-control orders, and the opaque id a box
// announces on its local network. Wire parity with packages/protocol/src/rescue.ts; pinned by
// packages/protocol/test-vectors/rescue/*.json.
//
// A browser cannot do a LAN rescue: it can't connect to an address under another server's name or
// trust a certificate by key, so the webapp has no rescue screen. This port exists so every client
// agrees on the bytes (the four-port rule), and for a future desktop surface that can.
//
//   flagship/rescue-hello/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>
//   flagship/rescue-session/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>
//   flagship/offline-control/v1|<serverDomain>|<sessionNonce>|<action>|<target>|<nonce>|<issuedAt>
//
// MIRRORS: iOS FlagshipCore/Rescue.swift, Android core/Rescue.kt. Verify-only: no key is made,
// imported or held here (the vendored verifier does the Ed25519 check).

import { ed25519, sha256 } from "../vendor/noble-post-quantum/pq-verify.js";

export const TAG_RESCUE_HELLO = "flagship/rescue-hello/v1";
export const TAG_RESCUE_SESSION = "flagship/rescue-session/v1";
export const TAG_OFFLINE_CONTROL = "flagship/offline-control/v1";
export const OFFLINE_CONTROL_ACTIONS = ["app-start", "app-stop", "app-restart", "server-restart", "server-shutdown"];
const TAG_DISCOVERY = "flagship/lan-discovery/v1";

const enc = new TextEncoder();
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

function guard(name, v) {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error(`${name} carries a separator or control character`);
  }
}

function exchange(tag, x) {
  const d = String(x?.serverDomain ?? "");
  if (!d) throw new Error("rescue: empty serverDomain");
  guard("serverDomain", d);
  if (!HEX32.test(x.clientNonce ?? "")) throw new Error("rescue: bad clientNonce");
  if (!HEX32.test(x.boxNonce ?? "")) throw new Error("rescue: bad boxNonce");
  if (!HEX64.test(x.certSha256 ?? "")) throw new Error("rescue: bad certSha256");
  if (!Number.isSafeInteger(x.issuedAt) || x.issuedAt < 0) throw new Error("rescue: bad issuedAt");
  return enc.encode([tag, d, x.clientNonce, x.boxNonce, x.certSha256, String(x.issuedAt)].join("|"));
}

export const rescueHelloCanonical = (x) => exchange(TAG_RESCUE_HELLO, x);
export const rescueSessionCanonical = (x) => exchange(TAG_RESCUE_SESSION, x);

/** `<creator>--<slug>` or a bare `<slug>`, each half a lowercase DNS label. */
export function isOfflineServiceId(id) {
  const parts = String(id).split("--");
  return parts.length <= 2 && parts.every((p) => LABEL.test(p));
}

export function offlineControlCanonical(o) {
  const d = String(o?.serverDomain ?? "");
  if (!d || d !== d.toLowerCase()) throw new Error("offline-control: bad serverDomain");
  guard("serverDomain", d);
  if (!HEX32.test(o.sessionNonce ?? "")) throw new Error("offline-control: bad sessionNonce");
  if (!OFFLINE_CONTROL_ACTIONS.includes(o.action)) throw new Error("offline-control: bad action");
  const target = String(o.target ?? "");
  if (o.action.startsWith("app-") ? !isOfflineServiceId(target) : target !== d) throw new Error("offline-control: bad target");
  if (!HEX32.test(o.nonce ?? "")) throw new Error("offline-control: bad nonce");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("offline-control: bad issuedAt");
  return enc.encode([TAG_OFFLINE_CONTROL, d, o.sessionNonce, o.action, target, o.nonce, String(o.issuedAt)].join("|"));
}

/** Ed25519 check of one of the messages above; never throws. */
export function verifyRescueSignature(canonical, sig, pub) {
  try {
    return sig.length === 64 && pub.length === 32 && ed25519.verify(sig, canonical, pub);
  } catch {
    return false;
  }
}

/** HMAC-SHA256 (RFC 2104) over the vendored SHA-256; the key here is a public key. */
function hmacSha256(key, msg) {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const pad = (b) => block.map((x) => x ^ b);
  const inner = new Uint8Array(64 + msg.length);
  inner.set(pad(0x36));
  inner.set(msg, 64);
  const outer = new Uint8Array(64 + 32);
  outer.set(pad(0x5c));
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** First 8 bytes of HMAC-SHA256(key = the box's STK public key, "flagship/lan-discovery/v1|" + lowercase name), hex. */
export function rescueDiscoveryId(stkPub, serverDomain) {
  guard("serverDomain", serverDomain);
  const mac = hmacSha256(stkPub, enc.encode(`${TAG_DISCOVERY}|${serverDomain.toLowerCase()}`));
  return Array.from(mac.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

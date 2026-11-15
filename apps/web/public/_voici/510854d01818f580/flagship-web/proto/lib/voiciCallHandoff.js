// Calling from the app with the browser's WebRTC (docs/voici-calls.md "Calling from the app"): browser port of the
// handoff section of packages/protocol/src/voiciCalls.ts, byte for byte (vectors test-vectors/voici-calls/ section
// `handoff`). The app (or this webapp) signs a short-lived voi.ci session for the callee's page and hands it to
// `https://voi.ci/<callee>#call=<sid>.<k>` over /qr-pipe, sealed under the pipe key of the sign-in construction. The
// webapp builds and seals; voi.ci (packages/flagship-web, a byte copy of this file) opens and checks.
//
//   VOICI_CALL_HANDOFF_TTL_MS, VOICI_CALL_HANDOFF_SESSION_MS, TAG_VOICI_CALL_HANDOFF
//   checkVoiciCallHandoff(v, {origin, caKeys, now, username?}) -> {ok, handoff, delegatePub} | {ok:false, code}
//   voiciCallHandoffDelegatePub(priv), voiciCallHandoffLink(o), parseVoiciCallHandoffFragment(hash)
//   voiciCallHandoffKey(mySecret, peerPub), sealVoiciCallHandoff(h, appSecret, browserSecret, nonce?),
//   openVoiciCallHandoff(browserSecret, {phonePk, nonce, ciphertext})

import { gcm, hkdf, p256, sha256, x25519 } from "../vendor/noble-post-quantum/pq-seal.js";
import { canonicalJsonBytes, hex, hexToBytes, isLowerHex } from "./voiciCore.js";
import { checkVoiciSignInAnswer, TAG_VOICI_SIGN_IN_REQUEST } from "./voiciMessages.js";

export const TAG_VOICI_CALL_HANDOFF = "flagship/voici-call-handoff/v1";
export const VOICI_CALL_HANDOFF_TTL_MS = 5 * 60_000;
export const VOICI_CALL_HANDOFF_SESSION_MS = 10 * 60_000;
const SKEW_MS = 10 * 60_000;
const MEDIA = ["audio", "audio,video"];
const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const PAGE_ID = /^[0-9a-f]{32}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const KEYS = ["kind", "username", "pageId", "media", "issuedAt", "expiresAt", "delegatePriv", "signIn"];
const te = new TextEncoder();
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const exactKeys = (r, keys) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

export function voiciCallHandoffDelegatePub(delegatePriv) {
  if (!isLowerHex(delegatePriv, 32)) return null;
  try {
    return hex(p256.getPublicKey(hexToBytes(delegatePriv), false));
  } catch {
    return null;
  }
}

export function checkVoiciCallHandoff(v, ctx) {
  const no = (code) => ({ ok: false, code });
  if (!isObj(v) || !exactKeys(v, KEYS) || v.kind !== TAG_VOICI_CALL_HANDOFF) return no("malformed");
  if (typeof v.username !== "string" || !USERNAME.test(v.username) || typeof v.pageId !== "string" || !PAGE_ID.test(v.pageId) || !MEDIA.includes(v.media)) return no("malformed");
  if (!isTime(v.issuedAt) || !isTime(v.expiresAt) || v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > VOICI_CALL_HANDOFF_TTL_MS || !isObj(v.signIn)) return no("malformed");
  if (ctx.now > v.expiresAt || ctx.now < v.issuedAt - SKEW_MS) return no("expired");
  if (ctx.username !== undefined && ctx.username !== v.username) return no("wrong-page");
  const delegatePub = voiciCallHandoffDelegatePub(v.delegatePriv);
  if (!delegatePub) return no("bad-key");
  if (v.signIn.pageId !== v.pageId) return no("wrong-page");
  const d = v.signIn.delegation;
  const nonce = isObj(d) && typeof d.nonce === "string" ? d.nonce : "";
  const r = checkVoiciSignInAnswer(v.signIn, { request: { kind: TAG_VOICI_SIGN_IN_REQUEST, origin: ctx.origin, pageId: v.pageId, username: v.username, delegatePub, nonce }, caKeys: ctx.caKeys, now: ctx.now });
  if (!r.ok) return no(r.code);
  if (r.answer.delegation.expiresAt - r.answer.delegation.issuedAt > VOICI_CALL_HANDOFF_SESSION_MS) return no("bad-delegation");
  return { ok: true, handoff: { ...v, signIn: r.answer }, delegatePub };
}

const b64u = (b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s) => {
  if (typeof s !== "string" || !B64U.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

export function voiciCallHandoffLink(o) {
  if (!USERNAME.test(o.username) || !B64U.test(o.sid) || o.sid.length > 64 || o.browserSecret.length !== 32) throw new Error(`${TAG_VOICI_CALL_HANDOFF}: bad link field`);
  return `https://${o.host}/${o.username}#call=${o.sid}.${b64u(o.browserSecret)}`;
}

export function parseVoiciCallHandoffFragment(hash) {
  const m = /^#?call=([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!m) return null;
  const k = fromB64u(m[2]);
  return k && k.length === 32 ? { sid: m[1], browserSecret: k } : null;
}

export function voiciCallHandoffKey(mySecret, peerPub) {
  return hkdf(sha256, x25519.getSharedSecret(mySecret, peerPub), te.encode("flagship/qr/v1"), te.encode("flagship/qr/enc/v1"), 32);
}

export function sealVoiciCallHandoff(h, appSecret, browserSecret, nonce = crypto.getRandomValues(new Uint8Array(12))) {
  const key = voiciCallHandoffKey(appSecret, x25519.getPublicKey(browserSecret));
  return { phonePk: b64u(x25519.getPublicKey(appSecret)), nonce: b64u(nonce), ciphertext: b64u(gcm(key, nonce).encrypt(canonicalJsonBytes(h))) };
}

export function openVoiciCallHandoff(browserSecret, d) {
  const pk = fromB64u(d?.phonePk);
  const nonce = fromB64u(d?.nonce);
  const ct = fromB64u(d?.ciphertext);
  if (!pk || pk.length !== 32 || !nonce || nonce.length !== 12 || !ct) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(gcm(voiciCallHandoffKey(browserSecret, pk), nonce).decrypt(ct)));
  } catch {
    return null;
  }
}

/** x25519 public key for a secret (the app's side says `hello` with it). */
export const voiciCallHandoffPublicKey = (secret) => x25519.getPublicKey(secret);
export const voiciCallHandoffB64u = b64u;

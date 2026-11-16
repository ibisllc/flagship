// A conversation's delete and the caller's reveal: browser port of packages/protocol/src/voiciConversation.ts, byte
// for byte (vectors packages/protocol/test-vectors/voici-conversation/, replayed by apps/web/tests/webappVoiciReveal.test.ts;
// a byte copy lives in packages/flagship-web/src/proto). docs/voici-calls.md, "Delete = forget" and "Reveal who I am".
//
//   canonicalVoiciConvDelete, signVoiciConvDeleteOwner          the owner's delete (the webapp holds the page key)
//   canonicalVoiciReveal, voiciRevealNameHash, signVoiciReveal   the caller's reveal (by their own page key)
//   parseVoiciRevealControl, checkVoiciReveal                    the owner's check before showing the pill
//   canonicalVoiciAnonBlock, signVoiciAnonBlock                  blocking an anonymous caller

import { ed25519SignHex, ed25519VerifyHex, isLowerHex, sha256Hex } from "./voiciCore.js";
import { checkVoiciText } from "./voiciText.js";

export const TAG_VOICI_CONV_DELETE = "flagship/voici-conv-delete/v1";
export const TAG_VOICI_REVEAL = "flagship/voici-reveal/v1";
export const TAG_VOICI_ANON_BLOCK = "flagship/voici-anon-block/v1";

const te = new TextEncoder();
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r, keys) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

export function canonicalVoiciConvDelete(d) {
  if (!PAGE_ID.test(d.pageId) || !(isLowerHex(d.conv, 32) || isLowerHex(d.conv, 16)) || (d.side !== "owner" && d.side !== "caller") || !isTime(d.issuedAt)) throw new Error(`${TAG_VOICI_CONV_DELETE}: bad field`);
  return te.encode([TAG_VOICI_CONV_DELETE, d.pageId, d.conv, d.side, String(d.issuedAt)].join("|"));
}

export function signVoiciConvDeleteOwner(d, ownerSignSeed) {
  const del = { pageId: d.pageId, conv: d.conv, side: "owner", issuedAt: d.issuedAt };
  return { del, signer: "owner", sig: ed25519SignHex(canonicalVoiciConvDelete(del), ownerSignSeed) };
}

export const voiciRevealNameHash = (displayName) => (displayName === null ? "-" : sha256Hex(te.encode(displayName)));

export function canonicalVoiciReveal(r) {
  if (!isLowerHex(r.conv, 32) || typeof r.username !== "string" || !USERNAME.test(r.username) || !isTime(r.issuedAt)) throw new Error(`${TAG_VOICI_REVEAL}: bad field`);
  if (r.displayName !== null && (typeof r.displayName !== "string" || checkVoiciText("displayName", r.displayName))) throw new Error(`${TAG_VOICI_REVEAL}: bad display name`);
  return te.encode([TAG_VOICI_REVEAL, r.conv, r.username, voiciRevealNameHash(r.displayName), String(r.issuedAt)].join("|"));
}

export function signVoiciReveal(r, pageSignSeed) {
  return { v: 1, kind: "voici-reveal", conv: r.conv, username: r.username, displayName: r.displayName, issuedAt: r.issuedAt, sig: ed25519SignHex(canonicalVoiciReveal(r), pageSignSeed) };
}

export function parseVoiciRevealControl(v) {
  if (!isObj(v) || v.v !== 1) return null;
  if (v.kind === "voici-unreveal") return exactKeys(v, ["v", "kind", "conv", "issuedAt"]) && isLowerHex(v.conv, 32) && isTime(v.issuedAt) ? v : null;
  if (v.kind !== "voici-reveal" || !exactKeys(v, ["v", "kind", "conv", "username", "displayName", "issuedAt", "sig"]) || !isLowerHex(v.sig, 64)) return null;
  try {
    canonicalVoiciReveal(v);
  } catch {
    return null;
  }
  return v;
}

/** {ok:true, reveal} | {ok:false, code: malformed|wrong-conv|bad-signature}: checked under the page key `.com` serves. */
export function checkVoiciReveal(v, ctx) {
  const r = parseVoiciRevealControl(v);
  if (!r || r.kind !== "voici-reveal") return { ok: false, code: "malformed" };
  if (r.conv !== ctx.conv) return { ok: false, code: "wrong-conv" };
  if (!ed25519VerifyHex(r.sig, canonicalVoiciReveal(r), ctx.pageSignPub)) return { ok: false, code: "bad-signature" };
  return { ok: true, reveal: r };
}

/** The pill's text parts: the display name (if any) and the username, so the caller prints "Display Name (username)". */
export const revealLabel = (r) => ({ displayName: r.displayName, username: r.username });

export function canonicalVoiciAnonBlock(b) {
  if (!PAGE_ID.test(b.pageId) || !isLowerHex(b.conv, 16) || (b.op !== "block" && b.op !== "unblock") || !isTime(b.issuedAt)) throw new Error(`${TAG_VOICI_ANON_BLOCK}: bad field`);
  return te.encode([TAG_VOICI_ANON_BLOCK, b.pageId, b.conv, b.op, String(b.issuedAt)].join("|"));
}

export const signVoiciAnonBlock = (b, ownerSignSeed) => ed25519SignHex(canonicalVoiciAnonBlock(b), ownerSignSeed);

/**
 * A conversation's life on `.com` and its one disclosure (docs/voici-calls.md, owner 2026-11-16: "Delete = forget",
 * "No logs", "Reveal who I am", "What the reveal shows"). Shared vectors: packages/protocol/test-vectors/voici-conversation/
 * (tools/voici-conversation-vectors.ts).
 *
 *   delete   flagship/voici-conv-delete/v1|<pageId>|<conv>|<owner|caller>|<issuedAt>
 *            owner: Ed25519 by the page's ownerSignPub. caller: Ed25519 by the pseudonym P (the caller's app), or
 *            P-256 by the browser key B carrying the message cred, as a message is. `.com` drops the conversation's
 *            mailbox rows, ring-back channel, ring, call allow and missed calls at once and keeps nothing (no archive,
 *            no tombstone); each side's device erases its own copy and keys.
 *   reveal   flagship/voici-reveal/v1|<conv>|<username>|<SHA-256 hex of the display name's UTF-8, or "-">|<issuedAt>
 *            Ed25519 by the caller's own page key (that page's ownerSignPub, as `.com` serves it for <username>).
 *            Wire {v:1, kind:"voici-reveal", conv, username, displayName (string or null), issuedAt, sig}; the display
 *            name travels beside the signature and must hash to the signed value. It rides inside the sealed
 *            conversation as a message body {v:1, control:<reveal>}, so `.com` never sees it.
 *   unreveal {v:1, kind:"voici-unreveal", conv, issuedAt}, as a message body {v:1, control:<unreveal>}: no signature
 *            of its own (the message carrying it is the caller's); the owner's app removes the pill.
 * The owner's app shows a checked reveal as "Display Name (username)", or "username" without a display name, with the
 * unchecked-name info beside the display name: the page key proves the username, nothing proves a chosen name.
 */
import { p256 } from "@noble/curves/nist.js";
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { checkMessagesKeyAttestation } from "./messagesAttestation.js";
import type { Bytes } from "./types.js";
import { checkWebDelegation } from "./webDelegation.js";
import { ed25519VerifyHex, isLowerHex, p256VerifyP1363, sha256Hex } from "./webEnvelope.js";
import { canonicalVoiciThreadStatement, parseVoiciThreadStatement, voiciConv } from "./voiciMessages.js";
import { checkVoiciText } from "./voiciText.js";

export const TAG_VOICI_CONV_DELETE = "flagship/voici-conv-delete/v1";
export const TAG_VOICI_REVEAL = "flagship/voici-reveal/v1";
/** Set-up records further than this from the receiver's clock are refused (as the call set-up). */
export const VOICI_CONV_SKEW_MS = 10 * 60_000;

const te = new TextEncoder();
const utf8 = (s: string): Bytes => te.encode(s);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r: Record<string, unknown>, keys: string[]) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));
const join = (parts: (string | number)[]): Bytes => utf8(parts.map(String).join("|"));
type Fail<C> = { ok: false; code: C };

// ── delete = forget ──────────────────────────────────────────────────────

export interface VoiciConvDelete {
  pageId: string;
  conv: string;
  side: "owner" | "caller";
  issuedAt: number;
}

export function canonicalVoiciConvDelete(d: VoiciConvDelete): Bytes {
  if (!PAGE_ID.test(d.pageId) || !isLowerHex(d.conv, 32) || (d.side !== "owner" && d.side !== "caller") || !isTime(d.issuedAt)) throw new Error(`${TAG_VOICI_CONV_DELETE}: bad field`);
  return join([TAG_VOICI_CONV_DELETE, d.pageId, d.conv, d.side, d.issuedAt]);
}

export function parseVoiciConvDelete(v: unknown): VoiciConvDelete | null {
  if (!isObj(v) || !exactKeys(v, ["pageId", "conv", "side", "issuedAt"])) return null;
  try {
    canonicalVoiciConvDelete(v as unknown as VoiciConvDelete);
  } catch {
    return null;
  }
  return v as unknown as VoiciConvDelete;
}

export function signVoiciConvDeleteOwner(d: Omit<VoiciConvDelete, "side">, ownerSignSeed: Bytes) {
  const del: VoiciConvDelete = { ...d, side: "owner" };
  return { del, signer: "owner" as const, sig: hex(ed.sign(canonicalVoiciConvDelete(del), ownerSignSeed)) };
}

export function signVoiciConvDeletePseudonym(d: Omit<VoiciConvDelete, "side">, pseudonymSeed: Bytes) {
  const del: VoiciConvDelete = { ...d, side: "caller" };
  return { del, signer: "pseudonym" as const, from: hex(ed.getPublicKey(pseudonymSeed)), sig: hex(ed.sign(canonicalVoiciConvDelete(del), pseudonymSeed)) };
}

/** Deterministic P-256 for vectors; browsers sign with WebCrypto. */
export function signVoiciConvDeleteBrowserP256(d: Omit<VoiciConvDelete, "side">, from: string, cred: unknown, browserPriv: Bytes) {
  const del: VoiciConvDelete = { ...d, side: "caller" };
  return { del, signer: "browser" as const, from, cred, sig: hex(p256.sign(canonicalVoiciConvDelete(del), browserPriv, { lowS: true })) };
}

export type VoiciConvDeleteRefusal = "malformed" | "wrong-audience" | "wrong-conv" | "wrong-side" | "stale" | "bad-attestation" | "bad-delegation" | "bad-thread" | "revoked" | "bad-signature";

/**
 * Checks a delete: shape, page, freshness, then the signer. The owner's under the page's ownerSignPub; the caller's
 * under P (whose conversation with the page must be `conv`) directly, or under B with the message cred.
 */
export function checkVoiciConvDelete(
  input: unknown,
  ctx: { pageId: string; ownerSignPub: string; origin: string; caKeys: readonly string[]; now: number; revoked?: ReadonlySet<string> },
): { ok: true; del: VoiciConvDelete } | Fail<VoiciConvDeleteRefusal> {
  const no = (code: VoiciConvDeleteRefusal): Fail<VoiciConvDeleteRefusal> => ({ ok: false, code });
  if (!isObj(input) || typeof input.sig !== "string") return no("malformed");
  const signer = input.signer;
  const keys = signer === "owner" ? ["del", "signer", "sig"] : signer === "pseudonym" ? ["del", "signer", "from", "sig"] : signer === "browser" ? ["del", "signer", "from", "cred", "sig"] : null;
  if (!keys || !exactKeys(input, keys)) return no("malformed");
  const d = parseVoiciConvDelete(input.del);
  if (!d) return no("malformed");
  if (d.pageId !== ctx.pageId) return no("wrong-audience");
  if ((signer === "owner") !== (d.side === "owner")) return no("wrong-side");
  if (Math.abs(d.issuedAt - ctx.now) > VOICI_CONV_SKEW_MS) return no("stale");
  const bytes = canonicalVoiciConvDelete(d);
  if (signer === "owner") return isLowerHex(input.sig, 64) && ed25519VerifyHex(input.sig, bytes, ctx.ownerSignPub) ? { ok: true, del: d } : no("bad-signature");
  if (typeof input.from !== "string" || !isLowerHex(input.from, 32)) return no("malformed");
  if (d.conv !== voiciConv(ctx.pageId, input.from)) return no("wrong-conv");
  if (signer === "pseudonym") return isLowerHex(input.sig, 64) && ed25519VerifyHex(input.sig, bytes, input.from) ? { ok: true, del: d } : no("bad-signature");
  const c = input.cred;
  if (!isObj(c) || !exactKeys(c, ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"])) return no("malformed");
  const att = checkMessagesKeyAttestation(c.attestation, { caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: input.from });
  if (!att.ok) return no("bad-attestation");
  const del = checkWebDelegation(c.delegation, c.delegationSig, { scope: "voici-messages", origin: ctx.origin, audience: ctx.pageId, principalPub: input.from, now: ctx.now, notAfter: att.attestation.expiresAt });
  if (!del.ok) return no("bad-delegation");
  if (ctx.revoked?.has(del.delegation.delegatePub)) return no("revoked");
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== input.from || typeof c.threadSig !== "string" || !ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), input.from)) return no("bad-thread");
  if (!isLowerHex(input.sig, 64) || !p256VerifyP1363(input.sig, bytes, del.delegation.delegatePub)) return no("bad-signature");
  return { ok: true, del: d };
}

// ── reveal who I am ──────────────────────────────────────────────────────

export interface VoiciReveal {
  v: 1;
  kind: "voici-reveal";
  conv: string;
  username: string;
  displayName: string | null;
  issuedAt: number;
  sig: string;
}
export interface VoiciUnreveal {
  v: 1;
  kind: "voici-unreveal";
  conv: string;
  issuedAt: number;
}

/** The signed value for a display name: the SHA-256 hex of its UTF-8, or "-" for none. */
export const voiciRevealNameHash = (displayName: string | null): string => (displayName === null ? "-" : sha256Hex(utf8(displayName)));

export function canonicalVoiciReveal(r: Pick<VoiciReveal, "conv" | "username" | "displayName" | "issuedAt">): Bytes {
  if (!isLowerHex(r.conv, 32) || typeof r.username !== "string" || !USERNAME.test(r.username) || !isTime(r.issuedAt)) throw new Error(`${TAG_VOICI_REVEAL}: bad field`);
  if (r.displayName !== null && (typeof r.displayName !== "string" || checkVoiciText("displayName", r.displayName))) throw new Error(`${TAG_VOICI_REVEAL}: bad display name`);
  return join([TAG_VOICI_REVEAL, r.conv, r.username, voiciRevealNameHash(r.displayName), r.issuedAt]);
}

/** The caller's app signs with its own page's key (deriveVoiciOwnerSignKey of its account). */
export function signVoiciReveal(r: Pick<VoiciReveal, "conv" | "username" | "displayName" | "issuedAt">, pageSignSeed: Bytes): VoiciReveal {
  return { v: 1, kind: "voici-reveal", conv: r.conv, username: r.username, displayName: r.displayName, issuedAt: r.issuedAt, sig: hex(ed.sign(canonicalVoiciReveal(r), pageSignSeed)) };
}

/** Strict shape of a reveal or an unreveal; null otherwise. */
export function parseVoiciRevealControl(v: unknown): VoiciReveal | VoiciUnreveal | null {
  if (!isObj(v) || v.v !== 1) return null;
  if (v.kind === "voici-unreveal") return exactKeys(v, ["v", "kind", "conv", "issuedAt"]) && isLowerHex(v.conv, 32) && isTime(v.issuedAt) ? (v as unknown as VoiciUnreveal) : null;
  if (v.kind !== "voici-reveal" || !exactKeys(v, ["v", "kind", "conv", "username", "displayName", "issuedAt", "sig"]) || !isLowerHex(v.sig, 64)) return null;
  try {
    canonicalVoiciReveal(v as unknown as VoiciReveal);
  } catch {
    return null;
  }
  return v as unknown as VoiciReveal;
}

export type VoiciRevealRefusal = "malformed" | "wrong-conv" | "bad-signature";

/**
 * The owner's app: a reveal for this conversation, signed by the page key `.com` serves for its username
 * (`pageSignPub`, from that page's verified index). Anything that fails shows nothing.
 */
export function checkVoiciReveal(v: unknown, ctx: { conv: string; pageSignPub: string }): { ok: true; reveal: VoiciReveal } | Fail<VoiciRevealRefusal> {
  const r = parseVoiciRevealControl(v);
  if (!r || r.kind !== "voici-reveal") return { ok: false, code: "malformed" };
  if (r.conv !== ctx.conv) return { ok: false, code: "wrong-conv" };
  if (!ed25519VerifyHex(r.sig, canonicalVoiciReveal(r), ctx.pageSignPub)) return { ok: false, code: "bad-signature" };
  return { ok: true, reveal: r };
}

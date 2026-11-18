/**
 * The "Load into Flagship" voucher link (docs/anonymous-vouchers.md "Voucher links"). After a card purchase on the
 * web shop, signed out, the browser holds the unblinded vouchers and offers them as one or more app links. The
 * vouchers ride only in the URL fragment, which a browser never sends to a server, so `.com` never sees which
 * account they end up in. Every app (iOS, Android, the webapp) parses the link, checks each voucher's signature
 * against the voucher keys it already holds (no network call), and adds the new ones to the account's sealed wallet.
 * Shared vectors: packages/protocol/test-vectors/voucher-link/.
 *
 *   link      https://<control apex>/app/vouchers#v=<payload, base64url without padding>
 *   payload   version (1 byte, 1) | part (1 byte, 1-based) | parts (1 byte) | keyId (8 bytes) | count (1 byte)
 *             | sigLen (2 bytes, big-endian) | count × (prefix 32 | nonce 32 | signature sigLen) | check (4 bytes)
 *   check     the first 4 bytes of SHA-256("flagship/voucher-link/v1|" followed by every payload byte before it)
 *
 * One link holds at most VOUCHER_LINK_MAX_PER_LINK vouchers under one key; a bigger purchase is several links,
 * "part i of n", each complete on its own. Opening a link twice adds nothing the second time (the wallet already
 * holds those vouchers), so a link needs no server-side memory of being used.
 */
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";
import { parseVoucher, verifyVoucher, voucherNullifier, type Voucher, type VoucherPublicKey } from "./voucher.js";
import { VOUCHER_WALLET_MAX_VOUCHERS, type VoucherWallet } from "./voucherWallet.js";
import { b64Decode, b64Encode, hexToBytes } from "./webEnvelope.js";

export const TAG_VOUCHER_LINK = "flagship/voucher-link/v1";
export const VOUCHER_LINK_PATH = "/app/vouchers";
export const VOUCHER_LINK_VERSION = 1;
/** Most vouchers in one link: 30 keep a 2048-bit key's link near 13,000 characters (4096-bit: about 23,000). */
export const VOUCHER_LINK_MAX_PER_LINK = 30;
/** Most links one purchase is split into. */
export const VOUCHER_LINK_MAX_PARTS = 255;
/** A longer fragment is refused before decoding. */
export const VOUCHER_LINK_MAX_CHARS = 32_768;
const MIN_SIG = 256;
const MAX_SIG = 1024;
const HEADER = 14;
const CHECK = 4;

const te = new TextEncoder();
const KEY_ID = /^[0-9a-f]{16}$/;

export type VoucherLinkError = "not-a-link" | "damaged" | "newer";

export type VoucherLinkParse =
  | { ok: true; part: number; parts: number; keyId: string; vouchers: Voucher[] }
  | { ok: false; code: VoucherLinkError };

function b64url(b: Bytes): string {
  return b64Encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64Decode(std + "=".repeat((4 - (std.length % 4)) % 4));
}

function check(body: Bytes): Bytes {
  const tag = te.encode(`${TAG_VOUCHER_LINK}|`);
  const m = new Uint8Array(tag.length + body.length);
  m.set(tag);
  m.set(body, tag.length);
  return sha256(m).subarray(0, CHECK);
}

/** One link's payload: `vouchers` share one key and one signature length. */
export function encodeVoucherLinkPayload(vouchers: readonly Voucher[], part: number, parts: number): string {
  const first = vouchers[0];
  if (!first || vouchers.length > VOUCHER_LINK_MAX_PER_LINK) throw new Error(`${TAG_VOUCHER_LINK}: bad count`);
  if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || parts < part || parts > VOUCHER_LINK_MAX_PARTS) {
    throw new Error(`${TAG_VOUCHER_LINK}: bad part`);
  }
  const sigs = vouchers.map((v) => {
    const p = parseVoucher(v);
    const s = p ? b64Decode(p.s) : null;
    if (!p || !s || p.k !== first.k) throw new Error(`${TAG_VOUCHER_LINK}: bad voucher`);
    return s;
  });
  const sigLen = sigs[0]!.length;
  if (sigLen < MIN_SIG || sigLen > MAX_SIG || sigs.some((s) => s.length !== sigLen)) throw new Error(`${TAG_VOUCHER_LINK}: bad signature length`);
  const body = new Uint8Array(HEADER + vouchers.length * (64 + sigLen));
  body[0] = VOUCHER_LINK_VERSION;
  body[1] = part;
  body[2] = parts;
  body.set(hexToBytes(first.k), 3);
  body[11] = vouchers.length;
  body[12] = sigLen >> 8;
  body[13] = sigLen & 0xff;
  let o = HEADER;
  vouchers.forEach((v, i) => {
    body.set(hexToBytes(v.p), o);
    body.set(hexToBytes(v.n), o + 32);
    body.set(sigs[i]!, o + 64);
    o += 64 + sigLen;
  });
  const out = new Uint8Array(body.length + CHECK);
  out.set(body);
  out.set(check(body), body.length);
  return b64url(out);
}

/**
 * Every link for `vouchers`, in their order: grouped by key (first seen first), at most VOUCHER_LINK_MAX_PER_LINK
 * a link, numbered across the whole set. `apex` is the control apex ("flagshipserver.com").
 */
export function encodeVoucherLinks(vouchers: readonly Voucher[], apex: string): string[] {
  const groups = new Map<string, Voucher[]>();
  for (const v of vouchers) groups.set(v.k, [...(groups.get(v.k) ?? []), v]);
  const chunks: Voucher[][] = [];
  for (const g of groups.values()) for (let i = 0; i < g.length; i += VOUCHER_LINK_MAX_PER_LINK) chunks.push(g.slice(i, i + VOUCHER_LINK_MAX_PER_LINK));
  if (chunks.length === 0 || chunks.length > VOUCHER_LINK_MAX_PARTS) throw new Error(`${TAG_VOUCHER_LINK}: bad count`);
  return chunks.map((c, i) => `https://${apex}${VOUCHER_LINK_PATH}#v=${encodeVoucherLinkPayload(c, i + 1, chunks.length)}`);
}

/** The payload of a link (a whole URL, or a bare fragment such as "#v=…" or "v=…"), or null. */
export function voucherLinkPayloadOf(link: string): string | null | "not-a-link" {
  if (typeof link !== "string") return "not-a-link";
  const s = link.trim();
  const hashAt = s.indexOf("#");
  let frag: string;
  if (/^https?:\/\//i.test(s)) {
    const pathEnd = s.search(/[?#]/);
    const beforeFrag = pathEnd < 0 ? s : s.slice(0, pathEnd);
    const path = beforeFrag.replace(/^https?:\/\/[^/]*/i, "").replace(/\/+$/, "");
    if (path !== VOUCHER_LINK_PATH) return "not-a-link";
    if (hashAt < 0) return null;
    frag = s.slice(hashAt + 1);
  } else {
    frag = hashAt >= 0 ? s.slice(hashAt + 1) : s;
  }
  for (const pair of frag.split("&")) if (pair.startsWith("v=")) return pair.slice(2);
  return null;
}

/** Parse a voucher link. Checks its shape and checksum only: signatures are checked by planVoucherLinkImport. */
export function parseVoucherLink(link: string): VoucherLinkParse {
  const payload = voucherLinkPayloadOf(link);
  if (payload === "not-a-link") return { ok: false, code: "not-a-link" };
  if (payload === null || payload.length === 0 || payload.length > VOUCHER_LINK_MAX_CHARS) return { ok: false, code: "damaged" };
  const b = fromB64url(payload);
  if (!b || b.length === 0) return { ok: false, code: "damaged" };
  if (b[0] !== VOUCHER_LINK_VERSION) return { ok: false, code: b[0]! > VOUCHER_LINK_VERSION ? "newer" : "damaged" };
  if (b.length < HEADER + CHECK) return { ok: false, code: "damaged" };
  const body = b.subarray(0, b.length - CHECK);
  const want = check(body);
  const got = b.subarray(b.length - CHECK);
  if (want.some((x, i) => x !== got[i])) return { ok: false, code: "damaged" };
  const part = b[1]!;
  const parts = b[2]!;
  const keyId = hex(b.subarray(3, 11));
  const count = b[11]!;
  const sigLen = (b[12]! << 8) | b[13]!;
  if (part < 1 || parts < part || count < 1 || count > VOUCHER_LINK_MAX_PER_LINK || sigLen < MIN_SIG || sigLen > MAX_SIG) {
    return { ok: false, code: "damaged" };
  }
  if (body.length !== HEADER + count * (64 + sigLen) || !KEY_ID.test(keyId)) return { ok: false, code: "damaged" };
  const vouchers: Voucher[] = [];
  for (let i = 0, o = HEADER; i < count; i++, o += 64 + sigLen) {
    vouchers.push({ k: keyId, p: hex(body.subarray(o, o + 32)), n: hex(body.subarray(o + 32, o + 64)), s: b64Encode(body.subarray(o + 64, o + 64 + sigLen)) });
  }
  return { ok: true, part, parts, keyId, vouchers };
}

/**
 * What adding a link's vouchers to `wallet` would do, decided on the device alone:
 *   add         new vouchers whose signature verifies under a key in `keys`
 *   duplicate   already in the wallet (or twice in the link): opening a link twice adds nothing
 *   spent       this wallet already spent them (their nullifier is in `spent`)
 *   invalid     the signature doesn't verify under the named key (forged or damaged)
 *   unknownKey  signed under a key this device doesn't hold (it has never loaded Plan while that key was served)
 *   full        adding them would pass VOUCHER_WALLET_MAX_VOUCHERS; nothing is added then
 * `outcome` is the one thing the screen says: "add" (ask, then add `add`), or why nothing can be added.
 */
export interface VoucherLinkImportPlan {
  add: Voucher[];
  duplicate: number;
  spent: number;
  invalid: number;
  unknownKey: number;
  full: boolean;
  outcome: "add" | "full" | "invalid" | "unknown-key" | "spent" | "already";
}

export function planVoucherLinkImport(wallet: VoucherWallet, vouchers: readonly Voucher[], keys: readonly VoucherPublicKey[]): VoucherLinkImportPlan {
  const have = new Set(wallet.vouchers.map((v) => `${v.k}|${v.n}`));
  const spentSet = new Set(wallet.spent);
  const out = { add: [] as Voucher[], duplicate: 0, spent: 0, invalid: 0, unknownKey: 0 };
  for (const v of vouchers) {
    const key = keys.find((k) => k.keyId === v.k);
    if (!key) out.unknownKey++;
    else if (!verifyVoucher(key, v)) out.invalid++;
    else if (spentSet.has(voucherNullifier(v))) out.spent++;
    else if (have.has(`${v.k}|${v.n}`)) out.duplicate++;
    else {
      have.add(`${v.k}|${v.n}`);
      out.add.push({ k: v.k, p: v.p, n: v.n, s: v.s });
    }
  }
  const full = out.add.length > 0 && wallet.vouchers.length + out.add.length > VOUCHER_WALLET_MAX_VOUCHERS;
  const outcome: VoucherLinkImportPlan["outcome"] = full
    ? "full"
    : out.add.length > 0
      ? "add"
      : out.invalid > 0
        ? "invalid"
        : out.unknownKey > 0
          ? "unknown-key"
          : out.spent > 0
            ? "spent"
            : "already";
  return { ...out, full, outcome };
}

/**
 * Approving a server's start-up from the watch while the phone is locked (docs/watch-boot-approval-
 * without-unlock.md, option (a)). The watch-delegate SIGNING key already lets a boot response be signed
 * without Face ID, but the response carries the disk key, and only the account key could open the copy
 * `.com` holds. So an admin device, once, deposits a SECOND copy of the disk key for one server, sealed to
 * a boot-only X25519 DECRYPTION key that lives next to the signing delegate in the Secure Enclave or
 * Keystore (user presence per use, this device only).
 *
 * That deposit is attested by the account key, per server (an owner opt-in per server, off by default):
 *
 *   flagship/watch-boot-delegate/v1|<serverDomain>|<delegatePubHex>|<decryptPubHex>|<keySha256Hex>|<issuedAt>|<expiresAt>
 *
 * It names the signing delegate, the decryption key, the server, the SHA-256 of the disk key it holds
 * (so the watch can check what it opened) and a window no longer than {@link WATCH_BOOT_MAX_MS} and no
 * later than the delegate's own expiry. Nothing else becomes readable: the key opens only this one
 * server's disk key, and the boot service refuses to hand it out, or to take a delegate's approval, while
 * the server is suspended (SEC-LOCK-001): a locked server is started from the phone with the account key.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import { openSealed, sealForRecipient } from "./encryption.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_WATCH_BOOT_DELEGATE = "flagship/watch-boot-delegate/v1";

/** Longest a deposit may last: the watch delegate's own 7-day TTL. */
export const WATCH_BOOT_MAX_MS = 7 * 24 * 3600_000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function unhex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface WatchBootDelegate {
  serverDomain: string;
  /** The watch-delegate Ed25519 key whose signature answers the request. */
  delegatePubHex: string;
  /** The boot-only X25519 key the disk key copy is sealed to. */
  decryptPubHex: string;
  /** SHA-256 of the disk key the copy holds. */
  keySha256Hex: string;
  issuedAt: number;
  expiresAt: number;
}

export interface WatchBootDeposit extends WatchBootDelegate {
  /** The disk key, sealed to `decryptPubHex`, hex. */
  sealedKeyHex: string;
  /** The account key's signature over the canonical bytes, hex. */
  signatureHex: string;
}

export function canonicalWatchBootDelegate(d: WatchBootDelegate): Bytes {
  legacyFieldGuard("serverDomain", d.serverDomain);
  for (const [k, v] of [["delegatePubHex", d.delegatePubHex], ["decryptPubHex", d.decryptPubHex], ["keySha256Hex", d.keySha256Hex]] as const) {
    if (!HEX64.test(v)) throw new Error(`${k} must be 64 lowercase hex`);
  }
  if (!Number.isSafeInteger(d.issuedAt) || d.issuedAt < 0) throw new Error("bad issuedAt");
  if (!Number.isSafeInteger(d.expiresAt) || d.expiresAt <= d.issuedAt) throw new Error("bad expiresAt");
  if (d.expiresAt - d.issuedAt > WATCH_BOOT_MAX_MS) throw new Error("a watch boot key lasts at most 7 days");
  return new TextEncoder().encode(
    [TAG_WATCH_BOOT_DELEGATE, d.serverDomain.toLowerCase(), d.delegatePubHex, d.decryptPubHex, d.keySha256Hex, d.issuedAt, d.expiresAt].join("|"),
  );
}

export function signWatchBootDelegate(d: WatchBootDelegate, accountKey: Keypair): Bytes {
  return ed.sign(canonicalWatchBootDelegate(d), accountKey.privateKey);
}

export function verifyWatchBootDelegate(d: WatchBootDelegate, sig: Bytes, accountPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalWatchBootDelegate(d), accountPub);
  } catch {
    return false;
  }
}

/** Admin device side: seal the unsealed disk key for the watch's decryption key and attest the deposit. */
export function buildWatchBootDeposit(
  args: { serverDomain: string; diskKey: Bytes; delegatePub: Bytes; decryptPub: Bytes; issuedAt: number; expiresAt: number },
  accountKey: Keypair,
): WatchBootDeposit {
  const d: WatchBootDelegate = {
    serverDomain: args.serverDomain.toLowerCase(),
    delegatePubHex: hex(args.delegatePub),
    decryptPubHex: hex(args.decryptPub),
    keySha256Hex: hex(sha256(args.diskKey)),
    issuedAt: args.issuedAt,
    expiresAt: args.expiresAt,
  };
  return { ...d, sealedKeyHex: hex(sealForRecipient(args.diskKey, args.decryptPub)), signatureHex: hex(signWatchBootDelegate(d, accountKey)) };
}

/**
 * Watch side: open the copy with the boot-only decryption key and check it is the key the account key
 * attested. Throws when it is not, so a swapped or corrupted copy is never sent on.
 */
export function openWatchBootKey(deposit: Pick<WatchBootDeposit, "sealedKeyHex" | "keySha256Hex">, decryptPriv: Bytes): Bytes {
  const key = openSealed(unhex(deposit.sealedKeyHex), decryptPriv);
  if (hex(sha256(key)) !== deposit.keySha256Hex.toLowerCase()) throw new Error("the opened key is not the one the account attested");
  return key;
}

/** Shape-check an untrusted deposit body (no signature check). */
export function parseWatchBootDeposit(v: unknown): WatchBootDeposit | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.sealedKeyHex !== "string" || typeof r.signatureHex !== "string") return null;
  if (typeof r.issuedAt !== "number" || typeof r.expiresAt !== "number") return null;
  const d: WatchBootDeposit = {
    serverDomain: r.serverDomain,
    delegatePubHex: String(r.delegatePubHex).toLowerCase(),
    decryptPubHex: String(r.decryptPubHex).toLowerCase(),
    keySha256Hex: String(r.keySha256Hex).toLowerCase(),
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    sealedKeyHex: r.sealedKeyHex.toLowerCase(),
    signatureHex: r.signatureHex.toLowerCase(),
  };
  if (!HEX128.test(d.signatureHex) || !/^[0-9a-f]{1,131072}$/.test(d.sealedKeyHex) || d.sealedKeyHex.length % 2 !== 0) return null;
  try {
    canonicalWatchBootDelegate(d);
  } catch {
    return null;
  }
  return d;
}

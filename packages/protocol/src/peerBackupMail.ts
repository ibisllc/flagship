/**
 * The sealed envelope an owner sends to a holder's mailbox through the relay
 * (docs/peer-backup.md §5.3). The relay sees the mailbox id, sizes and
 * timing; nothing else.
 *
 *   request  = 0x01 ‖ ephX25519Pub(32) ‖ nonce(12) ‖ AES-256-GCM(kReq, nonce, plaintext, aad = mailboxId)
 *   response = 0x01 ‖ nonce(12) ‖ AES-256-GCM(kResp, nonce, plaintext, aad = mailboxId)
 *   kReq/kResp = HKDF(X25519(eph, holderXPub), salt = mailboxId, info "flagship/pb-mail/v1|req" / "|resp")
 *   plaintext  = u32 BE headerLen ‖ header JSON (UTF-8) ‖ raw body
 */
import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import type { Bytes } from "./types.js";

const te = new TextEncoder();
const td = new TextDecoder();
const VERSION = 0x01;
const MAX_HEADER = 256 * 1024;

/**
 * AES-256-GCM. The default is pure JS (runs anywhere); a box passes
 * node:crypto's, which is far faster on multi-megabyte bricks.
 */
export interface PbAead {
  seal(key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes): Bytes;
  /** Throws when the tag doesn't verify. */
  open(key: Bytes, nonce: Bytes, aad: Bytes, ciphertext: Bytes): Bytes;
}

export const nobleAead: PbAead = {
  seal: (key, nonce, aad, pt) => gcm(key, nonce, aad).encrypt(pt),
  open: (key, nonce, aad, ct) => gcm(key, nonce, aad).decrypt(ct),
};

export interface PbMailMessage {
  header: Record<string, unknown>;
  body: Bytes;
}

export interface PbMailKeys {
  req: Bytes;
  resp: Bytes;
}

function keysFrom(shared: Bytes, mailboxId: string): PbMailKeys {
  const salt = te.encode(mailboxId);
  return {
    req: hkdf(sha256, shared, salt, te.encode("flagship/pb-mail/v1|req"), 32),
    resp: hkdf(sha256, shared, salt, te.encode("flagship/pb-mail/v1|resp"), 32),
  };
}

export function pbGenerateXKeypair(): { secretKey: Bytes; publicKey: Bytes } {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function pbXPublicKey(secretKey: Bytes): Bytes {
  return x25519.getPublicKey(secretKey);
}

export function encodePbMailPlaintext(m: PbMailMessage): Bytes {
  const h = te.encode(JSON.stringify(m.header));
  if (h.length > MAX_HEADER) throw new Error("mail header too large");
  const out = new Uint8Array(4 + h.length + m.body.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(m.body, 4 + h.length);
  return out;
}

/** Decode a plaintext; also returns the exact header string (signatures cover it). */
export function decodePbMailPlaintext(p: Bytes): PbMailMessage & { headerJson: string } {
  if (p.length < 4) throw new Error("mail too short");
  const len = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
  if (len > MAX_HEADER || 4 + len > p.length) throw new Error("bad mail header length");
  const headerJson = td.decode(p.subarray(4, 4 + len));
  const header = JSON.parse(headerJson) as unknown;
  if (typeof header !== "object" || header === null || Array.isArray(header)) throw new Error("bad mail header");
  return { header: header as Record<string, unknown>, headerJson, body: p.subarray(4 + len) };
}

/** Owner side: seal a request. Keep `keys.resp` to open the reply. */
export function sealPbMailRequest(
  holderXPub: Bytes,
  mailboxId: string,
  plaintext: Bytes,
  opts: { ephSecret?: Bytes; nonce?: Bytes; aead?: PbAead } = {},
): { envelope: Bytes; keys: PbMailKeys } {
  const eph = opts.ephSecret ?? x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const keys = keysFrom(x25519.getSharedSecret(eph, holderXPub), mailboxId);
  const nonce = opts.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ct = (opts.aead ?? nobleAead).seal(keys.req, nonce, te.encode(mailboxId), plaintext);
  const envelope = new Uint8Array(1 + 32 + 12 + ct.length);
  envelope[0] = VERSION;
  envelope.set(ephPub, 1);
  envelope.set(nonce, 33);
  envelope.set(ct, 45);
  return { envelope, keys };
}

/** Holder side: open a request. Throws on anything that isn't sealed to this key. */
export function openPbMailRequest(
  holderXSecret: Bytes,
  mailboxId: string,
  envelope: Bytes,
  aead: PbAead = nobleAead,
): { plaintext: Bytes; keys: PbMailKeys } {
  if (envelope.length < 45 + 16 || envelope[0] !== VERSION) throw new Error("not a peer-backup envelope");
  const ephPub = envelope.subarray(1, 33);
  const keys = keysFrom(x25519.getSharedSecret(holderXSecret, ephPub), mailboxId);
  const plaintext = aead.open(keys.req, envelope.subarray(33, 45), te.encode(mailboxId), envelope.subarray(45));
  return { plaintext, keys };
}

export function sealPbMailResponse(keys: PbMailKeys, mailboxId: string, plaintext: Bytes, nonce?: Bytes, aead: PbAead = nobleAead): Bytes {
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ct = aead.seal(keys.resp, n, te.encode(mailboxId), plaintext);
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = VERSION;
  out.set(n, 1);
  out.set(ct, 13);
  return out;
}

export function openPbMailResponse(keys: PbMailKeys, mailboxId: string, envelope: Bytes, aead: PbAead = nobleAead): Bytes {
  if (envelope.length < 13 + 16 || envelope[0] !== VERSION) throw new Error("not a peer-backup reply");
  return aead.open(keys.resp, envelope.subarray(1, 13), te.encode(mailboxId), envelope.subarray(13));
}

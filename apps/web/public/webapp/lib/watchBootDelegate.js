// `flagship/watch-boot-delegate/v1`: the account key's attestation of a copy of one server's disk key
// sealed to a watch's boot-only X25519 key (docs/watch-boot-approval-without-unlock.md, option (a)).
// Wire parity with packages/protocol/src/watchBootDelegate.ts; pinned by
// packages/protocol/test-vectors/watch-boot-delegate/vectors.json.
//
//   flagship/watch-boot-delegate/v1|<serverDomain lowercase>|<delegatePubHex>|<decryptPubHex>|<keySha256Hex>|<issuedAt>|<expiresAt>

import { sealForBrowserKey } from "./buildDraft.js";
import { importX25519Private } from "./x25519.js";

export const WATCH_BOOT_TAG = "flagship/watch-boot-delegate/v1";
export const WATCH_BOOT_MAX_MS = 7 * 24 * 3_600_000;

const HEX64 = /^[0-9a-f]{64}$/;

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function fromHex(h) {
  if (typeof h !== "string" || h.length % 2 || !/^[0-9a-f]*$/.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const sha256Hex = async (b) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));

export function canonicalWatchBootDelegate(d) {
  if (!d.serverDomain || /[|\x00-\x1f\x7f]/.test(d.serverDomain)) throw new Error("serverDomain");
  for (const k of ["delegatePubHex", "decryptPubHex", "keySha256Hex"]) {
    if (!HEX64.test(d[k])) throw new Error(k);
  }
  if (!Number.isSafeInteger(d.issuedAt) || d.issuedAt < 0) throw new Error("issuedAt");
  if (!Number.isSafeInteger(d.expiresAt) || d.expiresAt <= d.issuedAt) throw new Error("expiresAt");
  if (d.expiresAt - d.issuedAt > WATCH_BOOT_MAX_MS) throw new Error("a watch boot key lasts at most 7 days");
  return new TextEncoder().encode([
    WATCH_BOOT_TAG, d.serverDomain.toLowerCase(), d.delegatePubHex, d.decryptPubHex,
    d.keySha256Hex, String(d.issuedAt), String(d.expiresAt),
  ].join("|"));
}

/** Admin device: seal the unsealed disk key for the watch and sign the attestation with `sign(bytes)`. */
export async function buildWatchBootDeposit({ serverDomain, diskKey, delegatePub, decryptPub, issuedAt, expiresAt }, sign) {
  const attestation = {
    serverDomain: serverDomain.toLowerCase(),
    delegatePubHex: toHex(delegatePub),
    decryptPubHex: toHex(decryptPub),
    keySha256Hex: await sha256Hex(diskKey),
    issuedAt,
    expiresAt,
  };
  const signature = await sign(canonicalWatchBootDelegate(attestation));
  const sealed = await sealForBrowserKey(diskKey, attestation.decryptPubHex);
  return { ...attestation, sealedKeyHex: toHex(sealed), signatureHex: toHex(signature) };
}

/** Watch side: open the copy with the boot-only key; null unless it is the key the account attested. */
export async function openWatchBootKey(deposit, decryptPriv) {
  const blob = fromHex(deposit.sealedKeyHex);
  if (!blob || blob.length < 44 + 16) return null;
  try {
    const ephPub = blob.slice(0, 32);
    const priv = await importX25519Private(decryptPriv);
    const pub = await crypto.subtle.importKey("raw", ephPub, "X25519", false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
    const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const sym = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: ephPub, info: new TextEncoder().encode("flagship.seal.v1") },
      hk,
      256,
    );
    const aes = await crypto.subtle.importKey("raw", sym, { name: "AES-GCM" }, false, ["decrypt"]);
    const key = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(32, 44) }, aes, blob.slice(44)));
    return (await sha256Hex(key)) === String(deposit.keySha256Hex).toLowerCase() ? key : null;
  } catch {
    return null;
  }
}

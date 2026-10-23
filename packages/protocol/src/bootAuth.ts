/**
 * The boot worker's request authorization envelope (flagship/boot-auth/v1).
 *
 * The worker verifies it (boot-core/gate.ts); the box and the phones produce
 * it. It lives here so a client that signs through a key custodian (it holds
 * no raw key) can build the exact same bytes. `role` and `method`/`path` are
 * inside the signature, so a captured header cannot be retargeted.
 */
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";

export const TAG_BOOT_AUTH = "flagship/boot-auth/v1";
export const BOOT_AUTH_SCHEME = "Flagship-Boot-v1";

export type BootAuthRole = "box" | "owner" | "delegate" | "share";

export interface BootAuthEnvelope {
  role: BootAuthRole;
  serverDomain: string;
  method: string;
  path: string;
  pubKeyHex: string;
  nonceHex: string;
  issuedAt: number;
  signatureHex: string;
}

export function canonicalBootAuth(e: Omit<BootAuthEnvelope, "signatureHex">): Bytes {
  return new TextEncoder().encode(
    [TAG_BOOT_AUTH, e.role, e.serverDomain, e.method.toUpperCase(), e.path, e.pubKeyHex.toLowerCase(), e.nonceHex.toLowerCase(), e.issuedAt].join("|"),
  );
}

export function bootAuthB64urlEncode(bytes: Bytes): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeBootAuthHeader(e: BootAuthEnvelope): string {
  return `${BOOT_AUTH_SCHEME} ${bootAuthB64urlEncode(new TextEncoder().encode(JSON.stringify(e)))}`;
}

const toHex = (b: Bytes) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Sign with a closure (a key custodian) instead of a raw seed. */
export function signBootAuthWith(
  args: Omit<BootAuthEnvelope, "signatureHex">,
  sign: (message: Bytes) => Bytes,
): string {
  return encodeBootAuthHeader({ ...args, signatureHex: toHex(sign(canonicalBootAuth(args))) });
}

/** Sign with a raw seed (tests and tools). */
export function signBootAuth(args: Omit<BootAuthEnvelope, "signatureHex">, privSeed: Bytes): string {
  return signBootAuthWith(args, (m) => ed.sign(m, privSeed));
}

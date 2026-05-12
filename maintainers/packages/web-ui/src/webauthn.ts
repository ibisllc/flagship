/**
 * WebAuthn glue for the maintainers protocol.
 *
 * Design note (why this looks the way it does):
 *
 * The maintainers protocol uses Ed25519 for every signature; the
 * verifier and canonical-bytes layer accept nothing else. WebAuthn
 * authenticators, by contrast, generally bind a credential to ES256
 * (P-256 ECDSA) — and even when they support Ed25519 (alg=-8) directly,
 * the signature they produce is over `authenticatorData || sha256
 * (clientDataJSON)`, NOT over our canonical bytes. Verifying that
 * shape would require the protocol library to learn a second message
 * format, which is exactly what we want to avoid.
 *
 * The clean way out: use the WebAuthn PRF extension. PRF returns a
 * deterministic 32-byte secret bound to the credential and surfaced
 * only when the user verifies (touches the YubiKey + entered PIN). We
 * treat that secret as the Ed25519 seed; the keypair lives only in
 * page memory for the duration of the signing operation; canonical
 * bytes are signed using the protocol's normal `sign()`. The YubiKey
 * never sees our canonical bytes and we never persist the derived
 * private key.
 *
 * This means:
 *   - Enrollment = create a discoverable credential with PRF enabled.
 *     The credential id, COSE pubkey, and PRF-derived Ed25519 pubkey
 *     are all surfaced; the protocol pubkey is the PRF-derived one.
 *   - Signing = `navigator.credentials.get` with userVerification
 *     'required' and PRF eval requested; the returned secret seeds
 *     Ed25519 and signs the canonical bytes.
 *
 * The YubiKey serves as a tamper-resistant key-derivation oracle.
 * Lose the YubiKey and you lose the seed; no extracted-key risk.
 *
 * If a platform/authenticator does not support PRF, this module surfaces
 * a clear error so the caller can fall back to a soft-key flow (see
 * `softKeyFallback` in src/soft-key.ts) for testing / no-YubiKey
 * scenarios.
 */

import { generateKeypair } from "@maintainers/protocol";
import { decodeCbor, expectBytes, expectMap } from "./cbor.js";

/** A YubiKey-backed identity, sourced from a single PRF derivation. */
export interface MaintainerIdentity {
  /** WebAuthn credential id, base64url-encoded. */
  credentialId: string;
  /** Ed25519 pubkey hex; this is the protocol-level pubkey. */
  pubKey: string;
  /**
   * Ed25519 private key hex, derived from PRF. Lives only as long as
   * the caller holds it; UI code should drop it immediately after
   * signing.
   */
  privKey: string;
  /** RP id used for the credential (e.g. the page's hostname). */
  rpId: string;
}

export interface EnrollOptions {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  userDisplayName: string;
  /** Required: a 32-byte challenge from a server or a local random nonce. */
  challenge: Uint8Array;
  /**
   * Optional override for the PRF salt. The salt is application-scoped:
   * different salts on the same credential derive different secrets,
   * letting one credential power multiple independent Ed25519 keys
   * (e.g. one for `release`, one for `ca`). Defaults to a maintainers-
   * protocol-specific salt.
   */
  prfSalt?: Uint8Array;
}

export interface AssertOptions {
  rpId: string;
  credentialId: string;
  challenge: Uint8Array;
  prfSalt?: Uint8Array;
}

export const DEFAULT_PRF_SALT = utf8("maintainers/v1/ed25519-seed");

/**
 * Enroll a new credential and immediately derive the Ed25519 identity
 * via PRF. Returns the full identity (pub + priv); caller must hold the
 * priv only as long as needed, then drop it.
 */
export async function enrollMaintainerIdentity(opts: EnrollOptions): Promise<MaintainerIdentity> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new WebAuthnUnavailableError("navigator.credentials is not available in this environment");
  }
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: opts.challenge.buffer.slice(opts.challenge.byteOffset, opts.challenge.byteOffset + opts.challenge.byteLength) as ArrayBuffer,
      rp: { id: opts.rpId, name: opts.rpName },
      user: {
        id: opts.userId.buffer.slice(opts.userId.byteOffset, opts.userId.byteOffset + opts.userId.byteLength) as ArrayBuffer,
        name: opts.userName,
        displayName: opts.userDisplayName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },   // Ed25519, if supported
        { type: "public-key", alg: -7 },   // ES256 fallback (covers all YubiKey 5 series)
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      extensions: { prf: { eval: { first: (opts.prfSalt ?? DEFAULT_PRF_SALT).buffer as ArrayBuffer } } } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new WebAuthnError("credential creation returned null");

  const ext = (cred.getClientExtensionResults?.() ?? {}) as Record<string, unknown>;
  const prfFirst = extractPrfFirst(ext);
  if (!prfFirst) {
    // PRF wasn't enabled at creation — try one round-trip assertion to "first-bind" it.
    // Some platforms (e.g. macOS Safari) only surface PRF on the second invocation.
    return await assertAndDerive({
      rpId: opts.rpId,
      credentialId: base64urlFromBytes(new Uint8Array(cred.rawId)),
      challenge: opts.challenge,
      prfSalt: opts.prfSalt,
    });
  }
  const seed = sliceToSeed(prfFirst);
  const kp = generateKeypair(seed);
  return {
    credentialId: base64urlFromBytes(new Uint8Array(cred.rawId)),
    pubKey: kp.pubKey,
    privKey: kp.privKey,
    rpId: opts.rpId,
  };
}

/**
 * Assert against an existing credential and derive the same Ed25519
 * identity (PRF is deterministic for the same credential+salt).
 */
export async function assertAndDerive(opts: AssertOptions): Promise<MaintainerIdentity> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new WebAuthnUnavailableError("navigator.credentials is not available in this environment");
  }
  const idBytes = bytesFromBase64url(opts.credentialId);
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: opts.challenge.buffer.slice(opts.challenge.byteOffset, opts.challenge.byteOffset + opts.challenge.byteLength) as ArrayBuffer,
      rpId: opts.rpId,
      allowCredentials: [
        {
          id: idBytes.buffer.slice(idBytes.byteOffset, idBytes.byteOffset + idBytes.byteLength) as ArrayBuffer,
          type: "public-key",
        },
      ],
      userVerification: "required",
      extensions: { prf: { eval: { first: (opts.prfSalt ?? DEFAULT_PRF_SALT).buffer as ArrayBuffer } } } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new WebAuthnError("assertion returned null");

  const ext = (assertion.getClientExtensionResults?.() ?? {}) as Record<string, unknown>;
  const prfFirst = extractPrfFirst(ext);
  if (!prfFirst) {
    throw new PrfUnsupportedError(
      "the authenticator did not return a PRF result; either PRF is unsupported or it was disabled at credential creation",
    );
  }
  const seed = sliceToSeed(prfFirst);
  const kp = generateKeypair(seed);
  return {
    credentialId: opts.credentialId,
    pubKey: kp.pubKey,
    privKey: kp.privKey,
    rpId: opts.rpId,
  };
}

/**
 * Pull `prf.results.first` out of getClientExtensionResults() in a
 * way that tolerates both the spec wire form and platform-specific
 * shapes (some browsers return `prf.results.first` as ArrayBuffer,
 * some as Uint8Array).
 */
function extractPrfFirst(ext: Record<string, unknown>): Uint8Array | null {
  const prf = ext["prf"];
  if (!prf || typeof prf !== "object") return null;
  const results = (prf as Record<string, unknown>)["results"];
  if (!results || typeof results !== "object") return null;
  const first = (results as Record<string, unknown>)["first"];
  if (first instanceof Uint8Array) return first;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  if (first && typeof first === "object" && "byteLength" in first) {
    // DataView or similar
    const view = first as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function sliceToSeed(secret: Uint8Array): Uint8Array {
  if (secret.length < 32) {
    throw new WebAuthnError(`prf secret is ${secret.length} bytes; need at least 32`);
  }
  return secret.slice(0, 32);
}

// ---- attestation-object parsing (kept for completeness; not required
// when using PRF, but useful for debugging or for adopters who want to
// also persist the raw COSE pubkey alongside their derived Ed25519 key).

export interface AttestationParse {
  fmt: string;
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  aaguid: Uint8Array | null;
  credentialId: Uint8Array | null;
  cosePubkey: Map<number | string, unknown> | null;
}

export function parseAttestationObject(bytes: Uint8Array): AttestationParse {
  const decoded = decodeCbor(bytes);
  if (!(decoded instanceof Map)) {
    throw new Error("attestationObject: top-level must be a CBOR map");
  }
  const fmt = decoded.get("fmt");
  const authData = decoded.get("authData");
  if (typeof fmt !== "string") throw new Error("attestationObject: 'fmt' missing");
  if (!(authData instanceof Uint8Array)) throw new Error("attestationObject: 'authData' missing");
  return { fmt, ...parseAuthData(authData) };
}

function parseAuthData(authData: Uint8Array): Omit<AttestationParse, "fmt"> {
  if (authData.length < 37) throw new Error("authData too short");
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32]!;
  const signCount =
    ((authData[33]! << 24) | (authData[34]! << 16) | (authData[35]! << 8) | authData[36]!) >>> 0;
  let offset = 37;
  let aaguid: Uint8Array | null = null;
  let credentialId: Uint8Array | null = null;
  let cosePubkey: Map<number | string, unknown> | null = null;
  if (flags & 0x40) {
    if (authData.length < offset + 18) throw new Error("authData: attestedCredData truncated");
    aaguid = authData.slice(offset, offset + 16);
    const credIdLen = (authData[offset + 16]! << 8) | authData[offset + 17]!;
    offset += 18;
    credentialId = authData.slice(offset, offset + credIdLen);
    offset += credIdLen;
    // The COSE pubkey is the remainder of authData (up to extensions, if present).
    const rest = authData.slice(offset);
    const reader = decodeCbor(rest);
    if (!(reader instanceof Map)) throw new Error("authData: COSE_Key not a map");
    cosePubkey = reader;
  }
  return { rpIdHash, flags, signCount, aaguid, credentialId, cosePubkey };
}

/**
 * Best-effort extraction of an Ed25519 pubkey from a COSE_Key map.
 * Returns the hex-encoded 32-byte key, or null if the COSE_Key is not
 * Ed25519 / not in OKP form. Used for the "fancy badge" UI element
 * that shows what algorithm the YubiKey provided.
 */
export function ed25519PubkeyFromCose(
  cose: Map<number | string, unknown>,
): string | null {
  // COSE_Key labels: 1=kty, 3=alg; for OKP: -1=crv, -2=x
  const kty = cose.get(1);
  const alg = cose.get(3);
  const crv = cose.get(-1);
  const x = cose.get(-2);
  // kty=1 (OKP), alg=-8 (EdDSA), crv=6 (Ed25519)
  if (kty !== 1 || alg !== -8 || crv !== 6) return null;
  if (!(x instanceof Uint8Array) || x.length !== 32) return null;
  return bytesToHex(x);
}

// ---- helpers

export class WebAuthnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnError";
  }
}

export class WebAuthnUnavailableError extends WebAuthnError {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnUnavailableError";
  }
}

export class PrfUnsupportedError extends WebAuthnError {
  constructor(message: string) {
    super(message);
    this.name = "PrfUnsupportedError";
  }
}

export function base64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  const b64 = typeof btoa !== "undefined" ? btoa(s) : Buffer.from(s, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesFromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = typeof atob !== "undefined" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

/**
 * Generate a 32-byte challenge using the platform CSPRNG. Used when a
 * server-side challenge isn't available (purely-static deployment).
 */
export function randomChallenge(): Uint8Array {
  const b = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(b);
    return b;
  }
  throw new Error("no secure random source available");
}

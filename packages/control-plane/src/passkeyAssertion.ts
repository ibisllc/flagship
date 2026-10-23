import { ed } from "@flagship/protocol";

/**
 * The recovery passkey, checked by `.com` (SEC-REPAIR-001, owner decision 2026-10-24).
 *
 * Enrolment keeps the passkey's public key, read from the attestation object the platform hands
 * back at creation (no extra prompt). Recovery asks `.com` for a challenge, and the single passkey
 * sheet that already yields the PRF output also signs it; `.com` checks that assertion before it
 * releases the wrapped key or mints a recovery proof. Everything here runs in the Worker: a small
 * CBOR reader for the attestation object and the COSE key, and WebCrypto (ES256, RS256) or the
 * protocol's Ed25519 (EdDSA) for the signature.
 *
 * Challenge: base64url of `[expiresAt: 8 bytes big-endian][nonce: 16][HMAC: 32]`, the HMAC under
 * the Worker's recovery secret over `flagship/recovery-challenge/v1|<username>|<expiresAt>|<nonceHex>`.
 * Stateless: valid for one username until it expires; nothing is stored.
 */

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;
export const COSE_ALG_RS256 = -257;
export const RECOVERY_CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_TAG = "flagship/recovery-challenge/v1";

/**
 * SHA-256 fingerprints of the Android app's signing certificates, as published in
 * apps/web/public/.well-known/assetlinks.json (a test keeps the two equal). A native Android
 * assertion names its origin as `android:apk-key-hash:<base64url of one of these>`.
 */
export const ANDROID_CERT_SHA256 = [
  "3C:BF:B3:A6:75:A9:E0:73:91:D6:1C:25:58:D9:91:0C:E0:1D:A9:7C:2D:F3:55:9E:58:02:A2:94:ED:8F:7C:DD",
  "AC:A5:B6:B8:82:16:7C:01:1A:96:C4:46:33:03:65:EB:11:94:80:5C:2D:97:0A:7C:6D:CA:31:0F:C6:69:43:96",
  "65:3B:54:4E:1A:70:23:F3:63:64:0D:CF:9E:C3:C4:94:A1:0B:18:6B:E6:6A:FB:18:8F:B7:D1:2C:49:CB:A4:19",
  "22:F0:1C:82:1C:5C:F4:F4:F1:7C:9B:FD:90:FE:3D:3A:C3:48:0C:82:96:68:45:ED:C3:9A:23:F4:7E:8A:6C:6E",
  "A2:89:02:75:F6:BB:6B:EE:71:2B:CA:37:6C:AA:B4:31:DB:13:AA:64:2A:CF:33:A0:5A:0B:CA:92:A3:F6:19:84",
] as const;

export interface PasskeyPolicy {
  /** Relying-party ids a recovery passkey may be scoped to. */
  rpIds: string[];
  /** `clientDataJSON.origin` values accepted. */
  origins: string[];
}

/**
 * Where recovery passkeys live: the webapp's dedicated sub-origin (`recovery.<apex>`, its own rpId
 * so an XSS elsewhere cannot use it) and the native apps, whose rpId is the control apex (iOS
 * reports `https://<apex>` as the origin, Android its signing-certificate hash).
 */
export function recoveryPasskeyPolicy(controlApex = "flagshipserver.com"): PasskeyPolicy {
  const apex = controlApex.toLowerCase();
  const android = ANDROID_CERT_SHA256.map((fp) => `android:apk-key-hash:${b64url(hexBytes(fp.replace(/:/g, "")))}`);
  return { rpIds: [apex, `recovery.${apex}`], origins: [`https://${apex}`, `https://recovery.${apex}`, ...android] };
}

// ── encoding ─────────────────────────────────────────────────────────────

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Standard or URL-safe base64, padded or not. Null on anything else. */
export function unb64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  try {
    const std = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const enc = (s: string) => new TextEncoder().encode(s);

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// ── CBOR (just what attestation objects and COSE keys use) ─────────────

type Cbor = number | bigint | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | boolean | null | undefined;

/** Decode one CBOR item at `at`; returns it and the offset after it. Throws on anything malformed. */
export function cborDecode(b: Uint8Array, at = 0, depth = 0): { value: Cbor; next: number } {
  if (depth > 16) throw new Error("cbor too deep");
  if (at >= b.length) throw new Error("cbor truncated");
  const head = b[at]!;
  const major = head >> 5;
  const info = head & 0x1f;
  let p = at + 1;
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) n = b[p++]!;
  else if (info === 25) { n = (b[p]! << 8) | b[p + 1]!; p += 2; }
  else if (info === 26) { n = ((b[p]! << 24) >>> 0) + (b[p + 1]! << 16) + (b[p + 2]! << 8) + b[p + 3]!; p += 4; }
  else if (info === 27) {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[p + i]!);
    p += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor length too large");
    n = Number(v);
  } else throw new Error("cbor indefinite lengths are not used here");
  if (p > b.length) throw new Error("cbor truncated");
  switch (major) {
    case 0: return { value: n, next: p };
    case 1: return { value: -1 - n, next: p };
    case 2:
      if (p + n > b.length) throw new Error("cbor truncated");
      return { value: b.slice(p, p + n), next: p + n };
    case 3:
      if (p + n > b.length) throw new Error("cbor truncated");
      return { value: new TextDecoder().decode(b.slice(p, p + n)), next: p + n };
    case 4: {
      const arr: Cbor[] = [];
      for (let i = 0; i < n; i++) { const r = cborDecode(b, p, depth + 1); arr.push(r.value); p = r.next; }
      return { value: arr, next: p };
    }
    case 5: {
      const m = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = cborDecode(b, p, depth + 1);
        const v = cborDecode(b, k.next, depth + 1);
        m.set(k.value, v.value);
        p = v.next;
      }
      return { value: m, next: p };
    }
    case 7:
      if (info === 20) return { value: false, next: p };
      if (info === 21) return { value: true, next: p };
      if (info === 22) return { value: null, next: p };
      throw new Error("cbor simple value not used here");
    default:
      throw new Error("cbor tags are not used here");
  }
}

// ── keys ─────────────────────────────────────────────────────────────────

export type PasskeyPublicKey =
  | { alg: typeof COSE_ALG_ES256; x: Uint8Array; y: Uint8Array }
  | { alg: typeof COSE_ALG_EDDSA; pub: Uint8Array }
  | { alg: typeof COSE_ALG_RS256; n: Uint8Array; e: Uint8Array };

/** Read a COSE_Key. Only the three algorithms platform passkeys use. */
export function parseCoseKey(cose: Uint8Array): PasskeyPublicKey {
  const { value } = cborDecode(cose);
  if (!(value instanceof Map)) throw new Error("COSE key is not a map");
  const kty = value.get(1);
  const alg = value.get(3);
  const bytes = (k: number) => {
    const v = value.get(k);
    if (!(v instanceof Uint8Array)) throw new Error(`COSE key field ${k} missing`);
    return v;
  };
  if (kty === 2 && alg === COSE_ALG_ES256 && value.get(-1) === 1) {
    const x = bytes(-2), y = bytes(-3);
    if (x.length !== 32 || y.length !== 32) throw new Error("P-256 coordinates are 32 bytes");
    return { alg, x, y };
  }
  if (kty === 1 && alg === COSE_ALG_EDDSA && value.get(-1) === 6) {
    const pub = bytes(-2);
    if (pub.length !== 32) throw new Error("Ed25519 keys are 32 bytes");
    return { alg, pub };
  }
  if (kty === 3 && alg === COSE_ALG_RS256) {
    const n = bytes(-1), e = bytes(-2);
    if (n.length < 256) throw new Error("RSA keys under 2048 bits are refused");
    return { alg, n, e };
  }
  throw new Error("unsupported passkey key type or algorithm");
}

/**
 * From a registration's attestation object: the credential id and its COSE public key. The
 * attestation statement itself is not checked (platform passkeys send `none`); the IRK-signed
 * record names the credential id, which must match.
 */
export function readAttestationObject(att: Uint8Array): { credentialId: Uint8Array; cose: Uint8Array; rpIdHash: Uint8Array } {
  const { value } = cborDecode(att);
  if (!(value instanceof Map)) throw new Error("attestation object is not a map");
  const authData = value.get("authData");
  if (!(authData instanceof Uint8Array)) throw new Error("attestation object has no authData");
  if (authData.length < 37 + 18) throw new Error("authData too short");
  const flags = authData[32]!;
  if (!(flags & 0x40)) throw new Error("authData carries no credential");
  let p = 37 + 16;
  const idLen = (authData[p]! << 8) | authData[p + 1]!;
  p += 2;
  if (p + idLen > authData.length) throw new Error("credential id truncated");
  const credentialId = authData.slice(p, p + idLen);
  p += idLen;
  const key = cborDecode(authData, p);
  const cose = authData.slice(p, key.next);
  parseCoseKey(cose);
  return { credentialId, cose, rpIdHash: authData.slice(0, 32) };
}

// ── challenge ────────────────────────────────────────────────────────────

async function challengeMac(secret: string, username: string, expiresAt: number, nonce: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${CHALLENGE_TAG}|${username.toLowerCase()}|${expiresAt}|${toHex(nonce)}`)));
}

export async function issueRecoveryChallenge(secret: string, username: string, now: number, nonce?: Uint8Array): Promise<{ challenge: string; expiresAt: number }> {
  const expiresAt = now + RECOVERY_CHALLENGE_TTL_MS;
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(16));
  const out = new Uint8Array(56);
  new DataView(out.buffer).setBigUint64(0, BigInt(expiresAt));
  out.set(n, 8);
  out.set(await challengeMac(secret, username, expiresAt, n), 24);
  return { challenge: b64url(out), expiresAt };
}

/** The challenge's nonce and expiry (after `checkRecoveryChallenge` accepted it), for spending it once. */
export function challengeNonce(challenge: string): { nonceHex: string; expiresAt: number } | null {
  const raw = unb64(challenge);
  if (!raw || raw.length !== 56) return null;
  return { nonceHex: toHex(raw.slice(8, 24)), expiresAt: Number(new DataView(raw.buffer, raw.byteOffset).getBigUint64(0)) };
}

/** True when `challenge` was issued for `username` with `secret` and has not expired. */
export async function checkRecoveryChallenge(secret: string, username: string, challenge: string, now: number): Promise<boolean> {
  const raw = unb64(challenge);
  if (!raw || raw.length !== 56) return false;
  const expiresAt = Number(new DataView(raw.buffer, raw.byteOffset).getBigUint64(0));
  if (!(expiresAt > now) || expiresAt - now > RECOVERY_CHALLENGE_TTL_MS) return false;
  return equal(raw.slice(24), await challengeMac(secret, username, expiresAt, raw.slice(8, 24)));
}

// ── assertion ────────────────────────────────────────────────────────────

export interface PasskeyAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export type AssertionVerdict = { ok: true } | { ok: false; reason: string };

/** WebAuthn's ECDSA signatures are DER; WebCrypto wants r||s. */
function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30) return null;
  let p = 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 2; i++) {
    if (der[p] !== 0x02) return null;
    const len = der[p + 1]!;
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    out.set(v, i * 32 + (32 - v.length));
  }
  return out;
}

async function verifySignature(key: PasskeyPublicKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    if (key.alg === COSE_ALG_EDDSA) return ed.verify(sig, data, key.pub);
    if (key.alg === COSE_ALG_ES256) {
      const raw = derToRaw(sig);
      if (!raw) return false;
      const pt = new Uint8Array(65);
      pt[0] = 4;
      pt.set(key.x, 1);
      pt.set(key.y, 33);
      const k = await crypto.subtle.importKey("raw", pt, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, raw, data);
    }
    const k = await crypto.subtle.importKey("jwk", { kty: "RSA", n: b64url(key.n), e: b64url(key.e), alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, sig, data);
  } catch {
    return false;
  }
}

/**
 * Check a recovery assertion against the stored public key: the credential named at enrolment, a
 * `webauthn.get` for exactly `challenge`, from an allowed origin and rpId, with the user present
 * and verified, and a signature over `authenticatorData || SHA-256(clientDataJSON)`.
 */
export async function verifyPasskeyAssertion(args: {
  coseHex: string;
  credentialIdHex: string;
  assertion: unknown;
  challenge: string;
  policy: PasskeyPolicy;
}): Promise<AssertionVerdict> {
  const a = args.assertion as Partial<PasskeyAssertion> | null;
  if (!a || typeof a !== "object") return { ok: false, reason: "a passkey assertion is required" };
  const credentialId = unb64(a.credentialId);
  const authData = unb64(a.authenticatorData);
  const clientData = unb64(a.clientDataJSON);
  const sig = unb64(a.signature);
  if (!credentialId || !authData || !clientData || !sig || authData.length < 37) return { ok: false, reason: "malformed passkey assertion" };
  if (toHex(credentialId) !== args.credentialIdHex.toLowerCase()) return { ok: false, reason: "not the enrolled passkey" };
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    cd = JSON.parse(new TextDecoder().decode(clientData)) as typeof cd;
  } catch {
    return { ok: false, reason: "malformed passkey assertion" };
  }
  if (cd.type !== "webauthn.get") return { ok: false, reason: "not a passkey sign-in" };
  if (typeof cd.challenge !== "string" || cd.challenge.replace(/=+$/, "") !== args.challenge.replace(/=+$/, "")) return { ok: false, reason: "the passkey signed another challenge" };
  if (typeof cd.origin !== "string" || !args.policy.origins.includes(cd.origin)) return { ok: false, reason: "the passkey was used from an unknown origin" };
  let rpOk = false;
  for (const rp of args.policy.rpIds) if (equal(authData.slice(0, 32), await sha256(enc(rp)))) rpOk = true;
  if (!rpOk) return { ok: false, reason: "the passkey belongs to another site" };
  const flags = authData[32]!;
  if (!(flags & 0x01) || !(flags & 0x04)) return { ok: false, reason: "the passkey did not verify the user" };
  let key: PasskeyPublicKey;
  try {
    key = parseCoseKey(hexBytes(args.coseHex));
  } catch {
    return { ok: false, reason: "the stored passkey key is unreadable" };
  }
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(await sha256(clientData), authData.length);
  if (!(await verifySignature(key, signed, sig))) return { ok: false, reason: "the passkey signature does not verify" };
  return { ok: true };
}

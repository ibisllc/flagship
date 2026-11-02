/**
 * Per-device caps for Messages (docs/voici-and-messages.md §9.5): Apple App Attest + DeviceCheck on iOS, Google Play
 * Integrity (standard request) with device recall on Android. A device's two bits live with Apple or Google, never
 * here: bit 0 "enrolled a Messages account this month", bit 1 "banned". `.com` keeps only what §9.5 lists.
 *
 * The evidence rides beside a messages-key-attestation request and is bound to it: the App Attest clientData and the
 * Play Integrity requestHash are both the request's canonical bytes (SHA-256 hex for Play). An iOS install sends its
 * attestation object once (clientDataHash = SHA-256 of the request bytes, so no separate challenge round trip) and
 * an assertion on every later request. Anything that fails or is not configured makes the request unattested, which
 * the caller serves on the slow tier; it is never an error of its own.
 *
 * Behind `DeviceIntegrity`, so tests use `FakeDeviceIntegrity`.
 */
import { b64url, certificateExtension, cborDecode, firstOctetString, parseCertificate, pemBlocks, sameBytes, unb64, verifyX509Signature, ANDROID_CERT_SHA256 } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";

export type IntegrityPlatform = "ios" | "android";

export interface IosEvidence {
  platform: "ios";
  /** App Attest key id (base64, as DCAppAttestService returns it). */
  keyId: string;
  /** CBOR attestation object (base64), the first time this key is used. */
  attestation?: string;
  /** CBOR assertion (base64) over the request bytes, every other time. */
  assertion?: string;
  /** DeviceCheck token (base64). */
  deviceToken: string;
}
export interface AndroidEvidence {
  platform: "android";
  /** Play Integrity standard-request token, requestHash = SHA-256 hex of the request bytes. */
  token: string;
}
export type IntegrityEvidence = IosEvidence | AndroidEvidence;

export type IntegrityResult =
  | {
      attested: true;
      platform: IntegrityPlatform;
      /** Bit 0 is set and was written this calendar month (UTC). */
      enrolledThisMonth: boolean;
      /** Bit 1. */
      banned: boolean;
      /** HMAC(VOICI_DEVICE_SECRET, keyId), iOS only. */
      attestKeyHmac: string | null;
      /** What a later bit write needs: the DeviceCheck token or the integrity token. */
      deviceToken: string;
    }
  | { attested: false; reason: string };

export interface DeviceIntegrity {
  check(evidence: IntegrityEvidence, requestBytes: Uint8Array, now: number): Promise<IntegrityResult>;
  /** Sets bit 0 (`enrolled`) and/or bit 1 (`banned`) on the device behind `deviceToken`. False when it couldn't. */
  setBits(platform: IntegrityPlatform, deviceToken: string, bits: { enrolled?: true; banned?: boolean }, now: number): Promise<boolean>;
}

const MAX_B64 = 16 * 1024;

/** Strict shape of the `integrity` field for the request's deviceCheckRef; null when it doesn't match. */
export function parseIntegrityEvidence(v: unknown, ref: "ios" | "android"): IntegrityEvidence | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= MAX_B64;
  if (ref === "ios") {
    const keys = Object.keys(r).sort().join(",");
    if (r.platform !== "ios" || !str(r.keyId) || !str(r.deviceToken) || !/^[A-Za-z0-9+/=]+$/.test(r.deviceToken as string)) return null;
    if (keys === "attestation,deviceToken,keyId,platform" && str(r.attestation)) {
      return { platform: "ios", keyId: r.keyId as string, attestation: r.attestation as string, deviceToken: r.deviceToken as string };
    }
    if (keys === "assertion,deviceToken,keyId,platform" && str(r.assertion)) {
      return { platform: "ios", keyId: r.keyId as string, assertion: r.assertion as string, deviceToken: r.deviceToken as string };
    }
    return null;
  }
  if (Object.keys(r).sort().join(",") !== "platform,token" || r.platform !== "android" || !str(r.token)) return null;
  if (!/^[A-Za-z0-9_.=+/-]+$/.test(r.token as string)) return null;
  return { platform: "android", token: r.token as string };
}

// ── App Attest ─────────────────────────────────────────────────────────────

/**
 * Apple App Attestation Root CA (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem),
 * P-384, valid 2020-03-18 to 2045-03-15, SHA-256 fingerprint
 * 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32.
 */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const OID_APP_ATTEST_NONCE = "1.2.840.113635.100.8.2";
const AAGUID_PRODUCTION = new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0]);
const AAGUID_DEVELOPMENT = new TextEncoder().encode("appattestdevelop");
/** apple_validation_category_01: TestFlight, development signing, App Store (development signing only in development). */
const CATEGORIES_PRODUCTION = new Set([2, 4]);
const CATEGORIES_DEVELOPMENT = new Set([2, 3, 4]);

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  aaguid: Uint8Array | null;
  credentialId: Uint8Array | null;
  category: number | null;
}

/** WebAuthn authenticator data (rpIdHash 32, flags 1, counter 4, [aaguid 16, credIdLen 2, credId, COSE key], [extensions]). */
function parseAuthData(a: Uint8Array): AuthData {
  if (a.length < 37) throw new Error("authData too short");
  const flags = a[32]!;
  const counter = ((a[33]! << 24) >>> 0) + (a[34]! << 16) + (a[35]! << 8) + a[36]!;
  let p = 37;
  let aaguid: Uint8Array | null = null;
  let credentialId: Uint8Array | null = null;
  if (flags & 0x40) {
    if (a.length < p + 18) throw new Error("attested data truncated");
    aaguid = a.slice(p, p + 16);
    const len = (a[p + 16]! << 8) | a[p + 17]!;
    p += 18;
    if (a.length < p + len) throw new Error("credential id truncated");
    credentialId = a.slice(p, p + len);
    p += len;
    p = cborDecode(a, p).next;
  }
  let category: number | null = null;
  if (flags & 0x80) {
    const ext = cborDecode(a, p);
    p = ext.next;
    if (ext.value instanceof Map) {
      const c = ext.value.get("apple_validation_category_01") ?? ext.value.get("validationCategory");
      if (c !== undefined) {
        if (typeof c !== "number") throw new Error("bad validation category");
        category = c;
      }
    }
  }
  if (p !== a.length) throw new Error("trailing authData");
  return { rpIdHash: a.slice(0, 32), flags, counter, aaguid, credentialId, category };
}

export interface AppAttestPolicy {
  /** `<TeamID>.<bundle id>`. */
  appId: string;
  environment: "production" | "development";
  /** DER of the trusted root (Apple's, or a test root). */
  rootDer: Uint8Array;
}

function categoryOk(category: number | null, env: AppAttestPolicy["environment"]): boolean {
  if (category === null) return true;
  return (env === "production" ? CATEGORIES_PRODUCTION : CATEGORIES_DEVELOPMENT).has(category);
}

/**
 * The attestation object checks of "Validating apps that connect to your server"
 * (https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server).
 * Returns the attested P-256 key, X9.62 uncompressed.
 */
export async function verifyAppAttestAttestation(
  attestation: Uint8Array,
  keyId: Uint8Array,
  clientDataHash: Uint8Array,
  policy: AppAttestPolicy,
  now: number,
): Promise<{ ok: true; publicKey: Uint8Array } | { ok: false; why: string }> {
  try {
    const top = cborDecode(attestation);
    if (top.next !== attestation.length || !(top.value instanceof Map)) return { ok: false, why: "attestation not a CBOR map" };
    const m = top.value;
    if (m.get("fmt") !== "apple-appattest") return { ok: false, why: "fmt" };
    const stmt = m.get("attStmt");
    const authData = m.get("authData");
    if (!(stmt instanceof Map) || !(authData instanceof Uint8Array)) return { ok: false, why: "attestation shape" };
    const x5c = stmt.get("x5c");
    if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every((c) => c instanceof Uint8Array)) return { ok: false, why: "x5c" };
    const leafDer = x5c[0] as Uint8Array;
    const intDer = x5c[1] as Uint8Array;
    const root = parseCertificate(policy.rootDer);
    const inter = parseCertificate(intDer);
    const leaf = parseCertificate(leafDer);
    for (const c of [root, inter, leaf]) if (now < c.notBefore || now >= c.notAfter) return { ok: false, why: "certificate outside its validity" };
    if (!sameBytes(inter.issuer, root.subject) || !sameBytes(leaf.issuer, inter.subject)) return { ok: false, why: "chain names" };
    if (!(await verifyX509Signature(root.publicKey, inter.signatureAlgorithm, inter.tbs, inter.signature))) return { ok: false, why: "intermediate signature" };
    if (!(await verifyX509Signature(inter.publicKey, leaf.signatureAlgorithm, leaf.tbs, leaf.signature))) return { ok: false, why: "leaf signature" };
    const nonce = await sha256(authData, clientDataHash);
    const ext = certificateExtension(leafDer, OID_APP_ATTEST_NONCE);
    const inExt = ext ? firstOctetString(ext) : null;
    if (!inExt || !sameBytes(inExt, nonce)) return { ok: false, why: "nonce" };
    if (leaf.publicKey.key.kind !== "ec" || leaf.publicKey.key.curve !== "P-256") return { ok: false, why: "leaf key" };
    const publicKey = leaf.publicKey.spki.slice(leaf.publicKey.spki.length - 65);
    if (!sameBytes(await sha256(publicKey), keyId)) return { ok: false, why: "key id" };
    const ad = parseAuthData(authData);
    if (!sameBytes(ad.rpIdHash, await sha256(new TextEncoder().encode(policy.appId)))) return { ok: false, why: "rp id" };
    if (ad.counter !== 0) return { ok: false, why: "counter" };
    const aaguid = policy.environment === "production" ? AAGUID_PRODUCTION : AAGUID_DEVELOPMENT;
    if (!ad.aaguid || !sameBytes(ad.aaguid, aaguid)) return { ok: false, why: "aaguid" };
    if (!ad.credentialId || !sameBytes(ad.credentialId, keyId)) return { ok: false, why: "credential id" };
    if (!categoryOk(ad.category, policy.environment)) return { ok: false, why: "validation category" };
    return { ok: true, publicKey };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

function derSigToRaw(sig: Uint8Array): Uint8Array | null {
  if (sig.length < 8 || sig[0] !== 0x30 || sig[1] !== sig.length - 2) return null;
  const out = new Uint8Array(64);
  let p = 2;
  for (let i = 0; i < 2; i++) {
    if (sig[p] !== 0x02) return null;
    const len = sig[p + 1]!;
    let v = sig.subarray(p + 2, p + 2 + len);
    if (v.length !== len) return null;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    out.set(v, i * 32 + (32 - v.length));
    p += 2 + len;
  }
  return p === sig.length ? out : null;
}

/** An assertion over `clientData` (here: the request's canonical bytes) under a key attested before. */
export async function verifyAppAttestAssertion(
  assertion: Uint8Array,
  clientData: Uint8Array,
  publicKey: Uint8Array,
  previousCounter: number,
  policy: Pick<AppAttestPolicy, "appId" | "environment">,
): Promise<{ ok: true; counter: number } | { ok: false; why: string }> {
  try {
    const top = cborDecode(assertion);
    if (top.next !== assertion.length || !(top.value instanceof Map)) return { ok: false, why: "assertion not a CBOR map" };
    const sig = top.value.get("signature");
    const authData = top.value.get("authenticatorData");
    if (!(sig instanceof Uint8Array) || !(authData instanceof Uint8Array)) return { ok: false, why: "assertion shape" };
    const nonce = await sha256(authData, await sha256(clientData));
    const raw = derSigToRaw(sig);
    if (!raw) return { ok: false, why: "signature encoding" };
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, nonce))) return { ok: false, why: "signature" };
    const ad = parseAuthData(authData);
    if (!sameBytes(ad.rpIdHash, await sha256(new TextEncoder().encode(policy.appId)))) return { ok: false, why: "rp id" };
    if (ad.counter <= previousCounter) return { ok: false, why: "counter" };
    if (!categoryOk(ad.category, policy.environment)) return { ok: false, why: "validation category" };
    return { ok: true, counter: ad.counter };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

// ── Play Integrity ─────────────────────────────────────────────────────────

export interface PlayIntegrityPolicy {
  packageName: string;
  /** Signing certificate SHA-256 digests, base64url (as the verdict carries them). */
  certDigests: readonly string[];
}

/** Colon hex fingerprints (assetlinks.json form) to the base64url form of `certificateSha256Digest`. */
export function certDigestsB64url(fingerprints: readonly string[]): string[] {
  return fingerprints.map((fp) => {
    const h = fp.replace(/:/g, "");
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return b64url(b);
  });
}

const yyyymm = (now: number) => {
  const d = new Date(now);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
};

/**
 * The decoded verdict (https://developer.android.com/google/play/integrity/verdicts): requestDetails match this
 * request and are fresh, the app is Play-recognized with our package and signing certificate, the device meets
 * MEETS_DEVICE_INTEGRITY; device recall (https://developer.android.com/google/play/integrity/device-recall, beta)
 * gives the two bits: bitFirst enrolled (with writeDates.yyyymmFirst), bitSecond banned.
 */
export function checkPlayIntegrityVerdict(
  payload: unknown,
  want: { requestHash: string; now: number; maxAgeMs?: number },
  policy: PlayIntegrityPolicy,
): { ok: true; enrolledThisMonth: boolean; banned: boolean } | { ok: false; why: string } {
  if (!payload || typeof payload !== "object") return { ok: false, why: "no payload" };
  const p = payload as Record<string, any>;
  const rd = p.requestDetails ?? {};
  if (rd.requestPackageName !== policy.packageName) return { ok: false, why: "package" };
  if (rd.requestHash !== want.requestHash) return { ok: false, why: "request hash" };
  const ts = Number(rd.timestampMillis);
  if (!Number.isFinite(ts) || Math.abs(want.now - ts) > (want.maxAgeMs ?? 10 * 60_000)) return { ok: false, why: "stale" };
  const ai = p.appIntegrity ?? {};
  if (ai.appRecognitionVerdict !== "PLAY_RECOGNIZED" || ai.packageName !== policy.packageName) return { ok: false, why: "app" };
  const digests: unknown = ai.certificateSha256Digest;
  if (!Array.isArray(digests) || !digests.some((d) => typeof d === "string" && policy.certDigests.includes(d.replace(/=+$/, "")))) return { ok: false, why: "certificate" };
  const di = p.deviceIntegrity ?? {};
  const verdicts: unknown = di.deviceRecognitionVerdict;
  if (!Array.isArray(verdicts) || !verdicts.includes("MEETS_DEVICE_INTEGRITY")) return { ok: false, why: "device" };
  const values = di.deviceRecall?.values ?? {};
  const dates = di.deviceRecall?.writeDates ?? {};
  return {
    ok: true,
    enrolledThisMonth: values.bitFirst === true && Number(dates.yyyymmFirst) === yyyymm(want.now),
    banned: values.bitSecond === true,
  };
}

// ── live clients ───────────────────────────────────────────────────────────

export interface DeviceIntegrityEnv {
  DB?: D1Database;
  /** HMAC key for App Attest key ids (§9.5). */
  VOICI_DEVICE_SECRET?: string;
  APPLE_TEAM_ID?: string;
  APPLE_DEVICECHECK_KEY_ID?: string;
  /** The DeviceCheck .p8 (PKCS#8 PEM, ES256). */
  APPLE_DEVICECHECK_KEY?: string;
  /** Default com.flagshipserver.app. */
  APPLE_BUNDLE_ID?: string;
  /** "development" for development-signed builds (gym); default production. */
  APPLE_APP_ATTEST_ENV?: string;
  /** Service account JSON with access to the Play Integrity API. */
  PLAY_INTEGRITY_SA_JSON?: string;
  /** Default com.flagshipserver.app. */
  PLAY_INTEGRITY_PACKAGE?: string;
  /** Comma-separated colon-hex fingerprints; default the assetlinks.json set. */
  PLAY_INTEGRITY_CERT_SHA256?: string;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return unb64(body) ?? new Uint8Array();
}

function b64urlJson(v: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(v)));
}

async function signJwt(alg: "ES256" | "RS256", header: Record<string, unknown>, claims: Record<string, unknown>, pkcs8Pem: string): Promise<string> {
  const input = `${b64urlJson({ ...header, alg })}.${b64urlJson(claims)}`;
  const algo = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pkcs8Pem), algo, false, ["sign"]);
  const sig = await crypto.subtle.sign(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const tokenCache = new Map<string, { value: string; until: number }>();

async function cached(key: string, now: number, ttlMs: number, make: () => Promise<{ value: string; ttlMs?: number }>): Promise<string> {
  const hit = tokenCache.get(key);
  if (hit && hit.until > now) return hit.value;
  const made = await make();
  tokenCache.set(key, { value: made.value, until: now + (made.ttlMs ?? ttlMs) });
  return made.value;
}

export async function hmacHex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

/** DeviceCheck's two bits (https://developer.apple.com/documentation/devicecheck/accessing-and-modifying-per-device-data). */
class DeviceCheckClient {
  constructor(
    private readonly env: DeviceIntegrityEnv,
    private readonly fetchFn: typeof fetch,
  ) {}

  private base(): string {
    return this.env.APPLE_APP_ATTEST_ENV === "development" ? "https://api.development.devicecheck.apple.com" : "https://api.devicecheck.apple.com";
  }

  private async jwt(now: number): Promise<string> {
    const { APPLE_TEAM_ID: team, APPLE_DEVICECHECK_KEY_ID: kid, APPLE_DEVICECHECK_KEY: key } = this.env;
    return cached(`devicecheck|${kid}`, now, 30 * 60_000, async () => ({
      value: await signJwt("ES256", { kid }, { iss: team, iat: Math.floor(now / 1000) }, key!),
    }));
  }

  private async call(path: string, body: Record<string, unknown>, now: number): Promise<Response> {
    return this.fetchFn(`${this.base()}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.jwt(now)}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, transaction_id: crypto.randomUUID(), timestamp: now }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async query(deviceToken: string, now: number): Promise<{ bit0: boolean; bit1: boolean; month: string | null } | null> {
    const res = await this.call("/v1/query_two_bits", { device_token: deviceToken }, now);
    if (res.status !== 200) return null;
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { bit0?: unknown; bit1?: unknown; last_update_time?: unknown };
      return { bit0: j.bit0 === true, bit1: j.bit1 === true, month: typeof j.last_update_time === "string" ? j.last_update_time : null };
    } catch {
      return { bit0: false, bit1: false, month: null };
    }
  }

  async update(deviceToken: string, bits: { bit0?: boolean; bit1?: boolean }, now: number): Promise<boolean> {
    const res = await this.call("/v1/update_two_bits", { device_token: deviceToken, ...bits }, now);
    return res.status === 200;
  }
}

class PlayIntegrityClient {
  constructor(
    private readonly sa: { client_email: string; private_key: string; token_uri?: string },
    private readonly packageName: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  private async accessToken(now: number): Promise<string> {
    const aud = this.sa.token_uri ?? "https://oauth2.googleapis.com/token";
    return cached(`play|${this.sa.client_email}`, now, 50 * 60_000, async () => {
      const iat = Math.floor(now / 1000);
      const assertion = await signJwt(
        "RS256",
        { typ: "JWT" },
        { iss: this.sa.client_email, scope: "https://www.googleapis.com/auth/playintegrity", aud, iat, exp: iat + 3600 },
        this.sa.private_key,
      );
      const res = await this.fetchFn(aud, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
        signal: AbortSignal.timeout(5_000),
      });
      const j = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!res.ok || !j.access_token) throw new Error(`google token: HTTP ${res.status}`);
      return { value: j.access_token, ttlMs: Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 };
    });
  }

  async decode(token: string, now: number): Promise<unknown> {
    const res = await this.fetchFn(`https://playintegrity.googleapis.com/v1/${this.packageName}:decodeIntegrityToken`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken(now)}`, "content-type": "application/json" },
      body: JSON.stringify({ integrityToken: token }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { tokenPayloadExternal?: unknown }).tokenPayloadExternal ?? null;
  }

  async writeRecall(token: string, values: { bitFirst?: boolean; bitSecond?: boolean }, now: number): Promise<boolean> {
    const res = await this.fetchFn(`https://playintegrity.googleapis.com/v1/${this.packageName}/deviceRecall:write`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken(now)}`, "content-type": "application/json" },
      body: JSON.stringify({ integrityToken: token, newValues: values }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  }
}

const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Apple and Google behind the interface, with App Attest keys in D1 (`messages_app_attest_keys`). */
export class LiveDeviceIntegrity implements DeviceIntegrity {
  private readonly deviceCheck: DeviceCheckClient | null;
  private readonly play: PlayIntegrityClient | null;
  private readonly playPolicy: PlayIntegrityPolicy;
  private readonly attestPolicy: AppAttestPolicy;

  constructor(
    private readonly env: DeviceIntegrityEnv,
    fetchFn: typeof fetch = (i, init) => fetch(i, init),
    rootPem: string = APPLE_APP_ATTEST_ROOT_PEM,
  ) {
    const iosReady = !!(env.APPLE_TEAM_ID && env.APPLE_DEVICECHECK_KEY_ID && env.APPLE_DEVICECHECK_KEY && env.VOICI_DEVICE_SECRET && env.DB);
    this.deviceCheck = iosReady ? new DeviceCheckClient(env, fetchFn) : null;
    const pkg = env.PLAY_INTEGRITY_PACKAGE ?? "com.flagshipserver.app";
    let sa: { client_email: string; private_key: string; token_uri?: string } | null = null;
    try {
      const j = env.PLAY_INTEGRITY_SA_JSON ? (JSON.parse(env.PLAY_INTEGRITY_SA_JSON) as Record<string, unknown>) : null;
      if (j && typeof j.client_email === "string" && typeof j.private_key === "string") {
        sa = { client_email: j.client_email, private_key: j.private_key, ...(typeof j.token_uri === "string" ? { token_uri: j.token_uri } : {}) };
      }
    } catch {
      sa = null;
    }
    this.play = sa ? new PlayIntegrityClient(sa, pkg, fetchFn) : null;
    const fps = env.PLAY_INTEGRITY_CERT_SHA256 ? env.PLAY_INTEGRITY_CERT_SHA256.split(",").map((s) => s.trim()).filter(Boolean) : [...ANDROID_CERT_SHA256];
    this.playPolicy = { packageName: pkg, certDigests: certDigestsB64url(fps) };
    this.attestPolicy = {
      appId: `${env.APPLE_TEAM_ID ?? ""}.${env.APPLE_BUNDLE_ID ?? "com.flagshipserver.app"}`,
      environment: env.APPLE_APP_ATTEST_ENV === "development" ? "development" : "production",
      rootDer: pemBlocks(rootPem)[0]!,
    };
  }

  async check(e: IntegrityEvidence, requestBytes: Uint8Array, now: number): Promise<IntegrityResult> {
    try {
      return e.platform === "ios" ? await this.checkIos(e, requestBytes, now) : await this.checkAndroid(e, requestBytes, now);
    } catch (err) {
      return { attested: false, reason: `unavailable: ${(err as Error).message}` };
    }
  }

  private async checkIos(e: IosEvidence, requestBytes: Uint8Array, now: number): Promise<IntegrityResult> {
    if (!this.deviceCheck) return { attested: false, reason: "not-configured" };
    const db = this.env.DB!;
    const keyId = unb64(e.keyId);
    if (!keyId || keyId.length !== 32) return { attested: false, reason: "key id" };
    const keyHmac = await hmacHex(this.env.VOICI_DEVICE_SECRET!, keyId);
    if (e.attestation) {
      const att = unb64(e.attestation);
      if (!att) return { attested: false, reason: "attestation encoding" };
      const v = await verifyAppAttestAttestation(att, keyId, await sha256(requestBytes), this.attestPolicy, now);
      if (!v.ok) return { attested: false, reason: `attestation: ${v.why}` };
      const ins = await db
        .prepare("INSERT OR IGNORE INTO messages_app_attest_keys (key_hmac, public_key_hex, counter, created_at) VALUES (?1, ?2, 0, ?3)")
        .bind(keyHmac, toHex(v.publicKey), now)
        .run();
      if (!ins.meta?.changes) return { attested: false, reason: "key attested before" };
    } else {
      const row = await db.prepare("SELECT public_key_hex, counter FROM messages_app_attest_keys WHERE key_hmac = ?1").bind(keyHmac).first<{ public_key_hex: string; counter: number }>();
      const asr = unb64(e.assertion);
      if (!row || !asr) return { attested: false, reason: "unknown key" };
      const pub = new Uint8Array(row.public_key_hex.match(/../g)!.map((h) => parseInt(h, 16)));
      const v = await verifyAppAttestAssertion(asr, requestBytes, pub, row.counter, this.attestPolicy);
      if (!v.ok) return { attested: false, reason: `assertion: ${v.why}` };
      const up = await db
        .prepare("UPDATE messages_app_attest_keys SET counter = ?2 WHERE key_hmac = ?1 AND counter < ?2")
        .bind(keyHmac, v.counter)
        .run();
      if (!up.meta?.changes) return { attested: false, reason: "assertion replayed" };
    }
    const bits = await this.deviceCheck.query(e.deviceToken, now);
    if (!bits) return { attested: false, reason: "devicecheck unavailable" };
    return {
      attested: true,
      platform: "ios",
      enrolledThisMonth: bits.bit0 && bits.month === monthOf(now),
      banned: bits.bit1,
      attestKeyHmac: keyHmac,
      deviceToken: e.deviceToken,
    };
  }

  private async checkAndroid(e: AndroidEvidence, requestBytes: Uint8Array, now: number): Promise<IntegrityResult> {
    if (!this.play) return { attested: false, reason: "not-configured" };
    const payload = await this.play.decode(e.token, now);
    const v = checkPlayIntegrityVerdict(payload, { requestHash: toHex(await sha256(requestBytes)), now }, this.playPolicy);
    if (!v.ok) return { attested: false, reason: `verdict: ${v.why}` };
    return { attested: true, platform: "android", enrolledThisMonth: v.enrolledThisMonth, banned: v.banned, attestKeyHmac: null, deviceToken: e.token };
  }

  async setBits(platform: IntegrityPlatform, deviceToken: string, bits: { enrolled?: true; banned?: boolean }, now: number): Promise<boolean> {
    try {
      if (platform === "ios") {
        if (!this.deviceCheck) return false;
        return await this.deviceCheck.update(deviceToken, { ...(bits.enrolled ? { bit0: true } : {}), ...(bits.banned !== undefined ? { bit1: bits.banned } : {}) }, now);
      }
      if (!this.play) return false;
      return await this.play.writeRecall(deviceToken, { ...(bits.enrolled ? { bitFirst: true } : {}), ...(bits.banned !== undefined ? { bitSecond: bits.banned } : {}) }, now);
    } catch {
      return false;
    }
  }
}

/**
 * For tests: a device is its token (DeviceCheck token or integrity token). Tokens in `failing` don't verify;
 * `devices` holds the bits Apple or Google would keep.
 */
export class FakeDeviceIntegrity implements DeviceIntegrity {
  readonly devices = new Map<string, { enrolledMonth: string | null; banned: boolean }>();
  readonly failing = new Set<string>();
  readonly writes: { platform: IntegrityPlatform; token: string; bits: { enrolled?: true; banned?: boolean } }[] = [];

  async check(e: IntegrityEvidence, _requestBytes: Uint8Array, now: number): Promise<IntegrityResult> {
    const token = e.platform === "ios" ? e.deviceToken : e.token;
    if (this.failing.has(token)) return { attested: false, reason: "fake failure" };
    const d = this.devices.get(token) ?? { enrolledMonth: null, banned: false };
    return {
      attested: true,
      platform: e.platform,
      enrolledThisMonth: d.enrolledMonth === monthOf(now),
      banned: d.banned,
      attestKeyHmac: e.platform === "ios" ? `fake-${e.keyId}` : null,
      deviceToken: token,
    };
  }

  async setBits(platform: IntegrityPlatform, token: string, bits: { enrolled?: true; banned?: boolean }, now: number): Promise<boolean> {
    this.writes.push({ platform, token, bits });
    const d = this.devices.get(token) ?? { enrolledMonth: null, banned: false };
    if (bits.enrolled) d.enrolledMonth = monthOf(now);
    if (bits.banned !== undefined) d.banned = bits.banned;
    this.devices.set(token, d);
    return true;
  }
}

/**
 * Scoped inference tokens — the `.com`-issued bearer the box presents to
 * the Flagship inference endpoint (the metering shim in front of RunPod)
 * for the free-credits `flagship` provider.
 *
 * The token is a compact, self-describing, HMAC-SHA256-signed string:
 *
 *     v1.<base64url(payload)>.<base64url(mac)>
 *
 * `payload` is the JSON claims below; `mac = HMAC-SHA256(secret, "v1." +
 * payloadB64)`. The shim verifies the MAC + `exp` with the SAME secret
 * (`FLAGSHIP_INFERENCE_TOKEN_SECRET`), enforces the per-token caps, and
 * reports true usage back to POST /api/llm-promo/usage.
 *
 * Why HMAC, not a public-key JWT: both minter (.com) and verifier (our
 * shim) are first-party and share the secret, so a symmetric MAC is the
 * smallest thing that closes the trust gap. Nothing else needs to verify
 * the token. Runtime-agnostic (WebCrypto `crypto.subtle`) so it runs
 * unchanged on the Cloudflare Worker, on Node (the apps/web issuer), and
 * in the shim.
 *
 * The token carries NO secret material — it is a capability, scoped to
 * one user + short-lived. A leaked token is limited by its `exp`, its
 * caps, and (on the box side) the host-pinned SSRF guard.
 */

export interface InferenceTokenClaims {
  /** Account the token was minted for. */
  username: string;
  /** Opaque key id (also the promo-ledger revocation handle). */
  keyId: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Issued-at, epoch ms. */
  iat: number;
  /** Per-token daily token caps the shim enforces. */
  dailyInputTokenCap: number;
  dailyOutputTokenCap: number;
  /** The box FQDN the token was scoped to (audit / optional pin). */
  serverFqdn?: string;
}

const PREFIX = "v1";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Mint a signed scoped token from the given claims. */
export async function mintScopedInferenceToken(
  claims: InferenceTokenClaims,
  secret: string,
): Promise<string> {
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${PREFIX}.${payloadB64}`;
  const mac = await hmac(secret, signingInput);
  return `${signingInput}.${b64urlEncode(mac)}`;
}

export type VerifyResult =
  | { ok: true; claims: InferenceTokenClaims }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verify a token's MAC and expiry. `now` defaults to `Date.now()`. Used by
 * the metering shim; exported here so it is contract-tested alongside the
 * minter (one source of truth for the wire format).
 */
export async function verifyScopedInferenceToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const [, payloadB64, macB64] = parts;
  let expectedMac: Uint8Array;
  let givenMac: Uint8Array;
  try {
    expectedMac = await hmac(secret, `${PREFIX}.${payloadB64}`);
    givenMac = b64urlDecode(macB64!);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!timingSafeEqual(expectedMac, givenMac)) return { ok: false, reason: "bad-signature" };
  let claims: InferenceTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64!))) as InferenceTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || now >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

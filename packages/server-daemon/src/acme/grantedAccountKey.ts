import { openSealedFromEd25519Recipient } from "@flagship/protocol";
import type { FetchLike } from "@flagship/llm-providers";

/**
 * #28 — seal-to-box: a box that an admin has granted indefinite cert-minting
 * autonomy receives the user's shared ACME ACCOUNT key sealed to its STK
 * (Station/identity key). The admin device produces an `AcmeAccountKeyGrant`
 * whose `sealedAccountKey` is `sealForEd25519Recipient(utf8(pkcs8Pem), stkPub)`
 * — i.e. the account key in PKCS#8 PEM form, sealed to the box's Ed25519 STK.
 * The box opens it with its STK seed; the result is fed straight into the ACME
 * client as `accountKeyPem`, so every box under the user mints certs under ONE
 * Let's Encrypt account.
 *
 * `.com` only ever holds the opaque ciphertext — it never sees the account key
 * (the seal primitive is end-to-end, recipient = the box STK).
 *
 * Throws if the blob doesn't decrypt under this STK (wrong recipient / tamper)
 * or if the plaintext isn't a PEM private key — the caller treats a throw as
 * "no usable grant" and falls back to disk / self-generation.
 */
export function unsealGrantedAccountKeyPem(
  sealedAccountKey: Uint8Array,
  stkSeed: Uint8Array,
): string {
  if (stkSeed.length !== 32) {
    throw new Error("STK seed must be 32 bytes");
  }
  const plain = openSealedFromEd25519Recipient(sealedAccountKey, stkSeed);
  const pem = new TextDecoder().decode(plain);
  // A PKCS#8 (or SEC1) PEM the ACME client (`acme-client`) can load. We only
  // sanity-check the framing here; the ACME client does the real parse.
  if (!/-----BEGIN (EC )?PRIVATE KEY-----/.test(pem) || !pem.includes("-----END")) {
    throw new Error("unsealed ACME account key is not a PEM private key");
  }
  return pem;
}

/** Shape of `.com`'s `GET /api/server/<fqdn>/acme-account-key` 200 body. */
interface GrantedAccountKeyResponse {
  /** Hex of `sealForEd25519Recipient(utf8(pkcs8Pem), boxStkPub)`. */
  sealedAccountKeyHex: string;
  /** Opaque grant id, for logging / future revocation correlation. */
  accountKeyId?: string;
  /** Box STK pubkey the grant was sealed to, hex. Advisory only. */
  recipientPubKeyHex?: string;
  /** Epoch-ms the grant stops being served. Advisory only. */
  expiresAt?: number;
}

export interface FetchGrantedAccountKeyDeps {
  /** Control-plane base URL, e.g. `https://flagshipserver.com` (no trailing slash needed). */
  baseUrl: string;
  /** This box's server FQDN — the grant is keyed by it server-side. */
  serverFqdn: string;
  /**
   * The box STK seed: the 32-byte raw Ed25519 SEED of the daemon's identity
   * keypair (`DaemonRuntimeOptions.identityPrivKey` / `identity.privateKey`).
   * The grant is sealed to this key's pubkey; opening needs the seed.
   */
  stkSeed: Uint8Array;
  /** Injected fetch (the daemon's). Defaults to the global. */
  fetch?: FetchLike;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("sealedAccountKeyHex is not valid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * #28 seal-to-box (box half): fetch this box's GRANTED shared ACME account key
 * from `.com` and open it under the box STK. Used as the `resolveGrantedPem`
 * resolver `resolveAccountKey` tries before the on-disk / self-generated key,
 * so a box an admin has granted cert-minting autonomy adopts the user's ONE
 * shared Let's Encrypt account.
 *
 * `GET <baseUrl>/api/server/<fqdn>/acme-account-key`. On 200 the body is
 * `{ sealedAccountKeyHex, accountKeyId, recipientPubKeyHex, expiresAt }`; we
 * hex-decode the sealed blob and `unsealGrantedAccountKeyPem` it under the box
 * STK seed, returning the PKCS#8 PEM.
 *
 * Returns null on 404 (no active grant) AND on any error (network failure,
 * malformed body, hex decode failure, or — critically — a blob that doesn't
 * decrypt under THIS box's STK, i.e. it was sealed to a different box). A null
 * makes `resolveAccountKey` fall back to disk / self-generation, so a wrong-
 * recipient or transient `.com` outage never wedges boot. `.com` only ever
 * holds the opaque ciphertext; the seal is end-to-end to the box STK.
 */
export async function fetchGrantedAccountKeyPem(
  deps: FetchGrantedAccountKeyDeps,
): Promise<string | null> {
  const f = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = deps.baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(deps.serverFqdn)}/acme-account-key`;
  try {
    const res = await f(url, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = (await res.json()) as GrantedAccountKeyResponse;
    if (!body || typeof body.sealedAccountKeyHex !== "string") return null;
    const sealed = hexToBytes(body.sealedAccountKeyHex);
    return unsealGrantedAccountKeyPem(sealed, deps.stkSeed);
  } catch {
    // Network failure, non-JSON body, bad hex, or — importantly — a blob
    // sealed to a DIFFERENT box (open throws). All collapse to "no usable
    // grant" so the caller falls back to disk / self-gen. Never throws.
    return null;
  }
}

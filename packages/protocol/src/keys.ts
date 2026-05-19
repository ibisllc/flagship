import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import type { Bytes, Keypair, ServerId, UserMasterKey } from "./types.js";

const INFO_BAK = "flagship.bak.v1";
const INFO_IRK = "flagship.irk.v1";
const INFO_SWK = "flagship.swk.v1";
const INFO_STK = "flagship.stk.v1";
const INFO_APP_SECRET = "flagship.app-secret.v1";
const INFO_APP_MEMBER = "flagship.app-member.v1";

export function generateUMK(rng: () => Bytes = randomBytes): UserMasterKey {
  const seed = rng();
  if (seed.length !== 32) throw new Error("UMK seed must be 32 bytes");
  return { seed };
}

function randomBytes(): Bytes {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

function derive(umk: UserMasterKey, info: string): Bytes {
  return hkdf(sha256, umk.seed, new Uint8Array(0), new TextEncoder().encode(info), 32);
}

function seedToKeypair(seed: Bytes): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

export function deriveIRK(umk: UserMasterKey): Keypair {
  return seedToKeypair(derive(umk, INFO_IRK));
}

export function deriveBAK(umk: UserMasterKey, serverId: ServerId): Keypair {
  return seedToKeypair(derive(umk, `${INFO_BAK}|${serverId}`));
}

export function deriveSWK(umk: UserMasterKey, serverId: ServerId): Bytes {
  return derive(umk, `${INFO_SWK}|${serverId}`);
}

/**
 * Server Tunnel Key — Ed25519 keypair derived from SWK. Lives on the server
 * (since SWK lives on the server post-provisioning) and signs the tunnel HELLO
 * so a stolen serverId cannot impersonate without also possessing SWK.
 *
 * The pubkey is registered with the control plane at image-build time (the
 * phone derives the same value from UMK and signs a registration with IRK).
 */
export function deriveSTK(swk: Bytes): Keypair {
  const seed = hkdf(
    sha256,
    swk,
    new Uint8Array(0),
    new TextEncoder().encode(INFO_STK),
    32,
  );
  return seedToKeypair(seed);
}

/**
 * Per-service secret used by the runtime on a Flagship server. Different
 * services on the same server have independent secrets, so a stable-id
 * derived for service A cannot be linked to a stable-id derived for service
 * B (privacy by construction — services cannot cross-link the same person
 * without explicit handshake).
 */
export function deriveServiceSecret(swk: Bytes, serviceId: string): Bytes {
  return hkdf(
    sha256,
    swk,
    new TextEncoder().encode(serviceId),
    new TextEncoder().encode(INFO_APP_SECRET),
    32,
  );
}

/**
 * Per-service stable member identifier derived from the service's secret
 * and the member's IRK pubkey. Used by Caddy as the value of
 * `X-Flagship-Member` injected on inbound requests. Returns 32 hex chars
 * (16 bytes) for compactness.
 */
export function deriveServiceMemberStableId(
  serviceSecret: Bytes,
  accepterIrkPub: Bytes,
): string {
  const out = hkdf(
    sha256,
    serviceSecret,
    accepterIrkPub,
    new TextEncoder().encode(INFO_APP_MEMBER),
    16,
  );
  let s = "";
  for (const x of out) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Test-user identity helper. Mints a UMK seed → derives IRK + STK
 * the same way the real protocol does, so test users look identical
 * to real ones from the canonical-bytes layer.
 *
 * Re-uses @flagship/protocol directly — if any derivation drifts
 * between the protocol and the e2e tests, both fail loudly.
 */

import { deriveIRK, deriveSTK, deriveSWK, ed, type Keypair } from "@flagship/protocol";

export interface TestIdentity {
  username: string;
  serverFqdn: string;
  /** Raw 32-byte UMK seed. Treat as secret. */
  umkSeed: Uint8Array;
  irk: Keypair;
  /** Server identity keypair (acts as the daemon's identity). */
  identity: Keypair;
  /** STK derived from SWK(umk, serverId). */
  stk: Keypair;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

export function newTestIdentity(usernameStem = "alice"): TestIdentity {
  // Random suffix so concurrent test runs don't collide on .com.
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36).padStart(4, "0");
  const username = `e2e${Date.now().toString(36).slice(-5)}${suffix}`;
  const serverFqdn = `home.${username}.flagship.services`;
  const umkSeed = new Uint8Array(32);
  crypto.getRandomValues(umkSeed);
  const umk = { seed: umkSeed };
  return {
    username,
    serverFqdn,
    umkSeed,
    irk: deriveIRK(umk),
    identity: makeKey(),
    stk: deriveSTK(deriveSWK(umk, serverFqdn)),
  };
}

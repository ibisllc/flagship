/**
 * Identity helper — mints an IRK + phone-delegated + RCK keypair the
 * SAME way the real protocol does (via `@flagship/protocol`'s `ed`),
 * so the test user looks identical to a real one from the
 * canonical-bytes/signature layer. Injected into the core so the test
 * suite can pin a deterministic key.
 */

import { ed, type Keypair } from "@flagship/protocol";
import type { IdentityHelper } from "./ports.js";

function makeKey(seed?: Uint8Array): Keypair {
  const priv = seed ?? (() => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b;
  })();
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

/**
 * @param seeds Optional fixed 32-byte seeds for deterministic tests.
 */
export function makeIdentity(seeds?: {
  irk: Uint8Array;
  delegated: Uint8Array;
  rck: Uint8Array;
}): IdentityHelper {
  const irk = makeKey(seeds?.irk);
  const delegated = makeKey(seeds?.delegated);
  const rck = makeKey(seeds?.rck);
  return {
    irk,
    delegated,
    rck,
    signWithIrk: (msg) => ed.sign(msg, irk.privateKey),
  };
}

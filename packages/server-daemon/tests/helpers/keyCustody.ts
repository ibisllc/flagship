/**
 * Test helpers for the KeyCustodian migration. Production wires a single
 * custodian at boot; tests that used to pass a raw SWK / identity keypair now
 * pass the equivalent custodian slice via these thin wrappers.
 */
import { KeyCustodian, type SwkOps, type BoxSigner } from "../../src/keyCustodian.js";

/** A BoxSigner backed by an existing Ed25519 keypair's seed (its privateKey). */
export function boxSigner(kp: { privateKey: Uint8Array }): BoxSigner {
  return new KeyCustodian({ identityPriv: kp.privateKey });
}

const DEFAULT_SEED = new Uint8Array(32).fill(1);

export function testCustodian(opts: {
  identityPriv?: Uint8Array;
  swk?: Uint8Array;
  cgk?: Uint8Array;
} = {}): KeyCustodian {
  return new KeyCustodian({
    identityPriv: opts.identityPriv ?? DEFAULT_SEED,
    swk: opts.swk,
    cgk: opts.cgk,
  });
}

/** Wrap raw SWK bytes into the custodian's SwkOps slice (byte-identical ops). */
export function swkOps(swk: Uint8Array): SwkOps {
  return testCustodian({ swk }).asSwkOps();
}

/** A custodian-backed unseal closure for a given box identity seed. */
export function unsealerFor(identityPriv: Uint8Array): (blob: Uint8Array) => Uint8Array {
  const c = testCustodian({ identityPriv });
  return (blob) => c.unsealToBox(blob);
}

/**
 * Test seams for "only an admin device of the joining account accepts"
 * (src/shares/acceptAdmin.ts): a stand-in maintainer CA, the joining
 * account's admin root, and the proof its admin device seals into an
 * acceptance.
 */
import {
  ACCOUNT_KEY_ATTESTATION_TTL_MS,
  ed,
  signAccountKeyAttestation,
  signServerShareAcceptAdmin,
  type AccountKeyKind,
  type CaTrustChain,
  type Keypair,
  type ServerShareAccept,
  type ShareAcceptAdminProof,
} from "@flagship/protocol";
import { checkShareAcceptAdmin } from "../../src/shares/acceptAdmin.js";
import type { ShareStoreOptions } from "../../src/shares/shareStore.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (fill: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};

/** The maintainer-endorsed CA these tests trust. */
export const TEST_CA = kp(0xc4);
/** The joining account's admin root. */
export const JOIN_ADMIN = kp(0x3c);

export const testCaChain: CaTrustChain = { authorizedCaKeys: () => [hex(TEST_CA.publicKey)] };

export interface ProofOptions {
  signer?: Keypair;
  keyKind?: AccountKeyKind;
  /** The key the attestation names (defaults to the signer's). */
  attested?: Keypair;
  attestedKind?: AccountKeyKind;
  ca?: Keypair;
  issuedAt?: number;
  admit?: Partial<ShareAcceptAdminProof["admit"]>;
}

/** The proof an admin device of the joining account seals with its acceptance. */
export function adminProof(accept: ServerShareAccept, o: ProofOptions = {}): ShareAcceptAdminProof {
  const signer = o.signer ?? JOIN_ADMIN;
  const keyKind = o.keyKind ?? "admin-root";
  const attested = o.attested ?? signer;
  const issuedAt = o.issuedAt ?? accept.acceptedAt - 1000;
  const admit = { ...accept, keyKind, keyPubHex: hex(signer.publicKey), ...o.admit };
  return {
    admit,
    signature: hex(signServerShareAcceptAdmin(admit, signer)),
    attestation: signAccountKeyAttestation(
      { keyKind: o.attestedKind ?? keyKind, keyPubHex: hex(attested.publicKey), issuedAt, expiresAt: issuedAt + ACCOUNT_KEY_ATTESTATION_TTL_MS },
      o.ca ?? TEST_CA,
    ),
  };
}

/** The box's check, against the stand-in CA and the given clock. */
export function testVerifyAcceptAdmin(now: () => number = () => Date.now()): ShareStoreOptions["verifyAcceptAdmin"] {
  return (accept, proof) => checkShareAcceptAdmin({ accept, proof, chain: testCaChain, now: now() });
}

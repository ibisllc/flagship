/**
 * Helpers for producing signed envelopes from unsigned object shapes.
 *
 * Each `sign*` function takes the envelope's pre-signature fields,
 * derives canonical bytes, signs with the provided private key, and
 * returns the fully-formed envelope.
 *
 * Each `signWith*Keys` variant accepts multiple private keys (one per
 * required signer) and is used for M-of-N tracks.
 */

import {
  canonicalMandate,
  canonicalKeyFile,
  canonicalKeyRedirect,
  canonicalEmailRotation,
  canonicalKeyIntroductionRequest,
  canonicalReleaseEndorsement,
} from "./canonical.js";
import { sign, pubKeyFromPriv } from "./crypto.js";
import type {
  Mandate,
  KeyFile,
  KeyRedirect,
  EmailRotation,
  KeyIntroductionRequest,
  ReleaseEndorsement,
} from "./types.js";

export function signMandate(
  unsigned: Omit<Mandate, "signatures">,
  signers: { privKey: string }[],
): Mandate {
  const bytes = canonicalMandate(unsigned);
  const signatures = signers.map(({ privKey }) => ({
    pubkey: pubKeyFromPriv(privKey),
    sig: sign(bytes, privKey),
  }));
  return { ...unsigned, signatures };
}

export function signKeyFile(
  unsigned: Omit<KeyFile, "signature">,
  privKey: string,
): KeyFile {
  const bytes = canonicalKeyFile(unsigned);
  const signature = sign(bytes, privKey);
  if (pubKeyFromPriv(privKey) !== unsigned.pubkey) {
    throw new Error(
      "signKeyFile: private key does not correspond to the KeyFile's pubkey field",
    );
  }
  return { ...unsigned, signature };
}

export function signKeyRedirect(
  unsigned: Omit<KeyRedirect, "signature">,
  privKey: string,
): KeyRedirect {
  const bytes = canonicalKeyRedirect(unsigned);
  const signature = sign(bytes, privKey);
  if (pubKeyFromPriv(privKey) !== unsigned.pubkey) {
    throw new Error(
      "signKeyRedirect: private key does not correspond to the redirect's pubkey field",
    );
  }
  return { ...unsigned, signature };
}

export function signEmailRotation(
  unsigned: Omit<EmailRotation, "signature">,
  privKey: string,
): EmailRotation {
  const bytes = canonicalEmailRotation(unsigned);
  const signature = sign(bytes, privKey);
  if (pubKeyFromPriv(privKey) !== unsigned.pubkey) {
    throw new Error(
      "signEmailRotation: private key does not correspond to the rotation's pubkey field",
    );
  }
  return { ...unsigned, signature };
}

export function signKeyIntroductionRequest(
  unsigned: Omit<KeyIntroductionRequest, "signature">,
  privKey: string,
): KeyIntroductionRequest {
  const bytes = canonicalKeyIntroductionRequest(unsigned);
  const signature = sign(bytes, privKey);
  if (pubKeyFromPriv(privKey) !== unsigned.pubkey) {
    throw new Error(
      "signKeyIntroductionRequest: private key does not correspond to the request's pubkey field",
    );
  }
  return { ...unsigned, signature };
}

export function signReleaseEndorsement(
  unsigned: Omit<ReleaseEndorsement, "signatures">,
  signers: { privKey: string }[],
): ReleaseEndorsement {
  const bytes = canonicalReleaseEndorsement(unsigned);
  const signatures = signers.map(({ privKey }) => ({
    pubkey: pubKeyFromPriv(privKey),
    sig: sign(bytes, privKey),
  }));
  return { ...unsigned, signatures };
}

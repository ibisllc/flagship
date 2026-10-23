// What `.com` needs to check the recovery passkey itself (SEC-REPAIR-001). Wire parity with
// packages/control-plane/src/passkeyAssertion.ts; pinned by
// packages/protocol/test-vectors/recovery-passkey/vectors.json.
//
// Enrolment: send the platform's attestation object as `passkeyAttestationObject` beside the
// signed record (same passkey sheet; .com reads the public key from it).
// Recovery: POST /api/recovery/by-username/<u>/challenge, pass `challengeBytes(challenge)` as the
// WebAuthn challenge in the same get() that evaluates the PRF, then send
// `passkey: fetchPasskeyField(challenge, credential)` with the /fetch body.

const toB64url = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The enrolment field: the attestation object (ArrayBuffer or bytes) as base64url. */
export function attestationField(attestationObject) {
  return toB64url(attestationObject);
}

/** The challenge `.com` issued, as the bytes WebAuthn signs. */
export function challengeBytes(challenge) {
  const std = challenge.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The /fetch body's `passkey` field from the PublicKeyCredential get() returned. */
export function fetchPasskeyField(challenge, credential) {
  const r = credential.response;
  return {
    challenge,
    assertion: {
      credentialId: toB64url(credential.rawId),
      authenticatorData: toB64url(r.authenticatorData),
      clientDataJSON: toB64url(r.clientDataJSON),
      signature: toB64url(r.signature),
    },
  };
}

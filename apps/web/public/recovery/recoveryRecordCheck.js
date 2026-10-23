// Before anything is unwrapped: is every ciphertext `.com` handed back the one the owner's signed
// recovery record names (SECURITY-HARDENING-PLAN.md 18.3, N03)? Same rule as `ciphertextMismatch`
// in webapp/lib/recoveryRecord.js (this origin cannot import from the webapp's). The signature
// itself is checked by the webapp once the recovered key exists.

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function digestOfB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Returns null when every ciphertext matches the claim, else the name of the one that does not. */
export async function ciphertextMismatch(claim, { wrappedUmkB64, wrappedAdminRootB64, wrappedAcmeAccountKeyB64 }) {
  if (!wrappedUmkB64 || (await digestOfB64(wrappedUmkB64)) !== claim.wrappedUmkDigestHex) return "wrappedUmk";
  const check = async (b64, e, name) => {
    const want = e && (e.change === "keep" || e.change === "replace") ? e.digestHex : undefined;
    if (!want) return b64 ? name : null;
    if (!b64) return name;
    return (await digestOfB64(b64)) === want ? null : name;
  };
  return (await check(wrappedAdminRootB64, claim.adminRoot, "wrappedAdminRoot"))
    ?? (await check(wrappedAcmeAccountKeyB64, claim.acmeKey, "wrappedAcmeAccountKey"));
}

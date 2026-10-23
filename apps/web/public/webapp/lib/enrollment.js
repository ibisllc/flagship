// First contact between a new server and the device that created it. Wire parity with
// packages/protocol/src/enrollment.ts; pinned by packages/protocol/test-vectors/enrollment/vectors.json.
//
// - The recipe carries a one-time 32-byte `enrollmentKeyHex` this device keeps; the box's first request
//   carries `deviceInfo.enrollmentProof` = HMAC-SHA256(secret,
//   `flagship/enrollment-proof/v1|<serverDomain lowercase>|<stkPubHex>|<authCodeSerial>`).
//   A proof that fails means the key was not built from this device's recipe: refuse to pin it.
// - The server code: first 4 bytes of SHA-256(`flagship/server-code/v1|<stkPubHex>`), big-endian,
//   mod 1,000,000, six digits. The box shows it on its own screen.

export const ENROLLMENT_PROOF_TAG = "flagship/enrollment-proof/v1";
export const SERVER_CODE_TAG = "flagship/server-code/v1";

const HEX64 = /^[0-9a-f]{64}$/;
const toHex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** A fresh one-time secret for a new recipe, as hex. */
export function newEnrollmentSecretHex() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function enrollmentProofHex(secretHex, { serverDomain, stkPubHex, authCodeSerial }) {
  if (!HEX64.test(secretHex) || !HEX64.test(stkPubHex) || serverDomain.includes("|") || authCodeSerial.includes("|")) return null;
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(secretHex.match(/../g), (h) => parseInt(h, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = new TextEncoder().encode([ENROLLMENT_PROOF_TAG, serverDomain.toLowerCase(), stkPubHex, authCodeSerial].join("|"));
  return toHex(await crypto.subtle.sign("HMAC", key, msg));
}

/** Constant-time check of the box's proof. */
export async function verifyEnrollmentProof(secretHex, statement, proofHex) {
  const want = await enrollmentProofHex(secretHex, statement);
  if (!want || typeof proofHex !== "string" || proofHex.length !== want.length) return false;
  const got = proofHex.toLowerCase();
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export const SERVER_CODE_SEEN_TAG = "flagship/server-code-seen/v1";

/** Studio's report that the VM it hosts showed `stkPubHex` (order status `serverSeen`): HMAC under the
 *  per-server studioConfirmKey this device sent Studio beside the recipe, never inside it. */
export async function serverSeenMacHex(studioConfirmKeyHex, serverDomain, stkPubHex) {
  if (!HEX64.test(studioConfirmKeyHex) || !HEX64.test(stkPubHex) || serverDomain.includes("|")) return null;
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(studioConfirmKeyHex.match(/../g), (h) => parseInt(h, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${SERVER_CODE_SEEN_TAG}|${serverDomain.toLowerCase()}|${stkPubHex}`)));
}

export async function verifyServerSeen(studioConfirmKeyHex, serverDomain, stkPubHex, macHex) {
  const want = await serverSeenMacHex(studioConfirmKeyHex, serverDomain, stkPubHex);
  if (!want || typeof macHex !== "string" || macHex.length !== want.length) return false;
  const got = macHex.toLowerCase();
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export async function serverCode(stkPubHex) {
  if (!HEX64.test(stkPubHex)) return null;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SERVER_CODE_TAG}|${stkPubHex}`)));
  const n = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
  return String(n % 1_000_000).padStart(6, "0");
}

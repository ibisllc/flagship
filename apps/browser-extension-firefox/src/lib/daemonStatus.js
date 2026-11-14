// The box's STK-signed daemon-status report (packages/protocol/src/daemonStatus.ts), verify only.
// Canonical bytes, byte for byte the protocol's:
//   flagship/daemon-status/v1|<serverDomain>|<certSha256 or "">|<certValidUntil or "">|<certIssuer or "">|
//   <appsServed sorted, ","-joined>|<nonce>|<issuedAt>
// tests/daemonStatus.test.ts checks these bytes against @flagship/protocol.

const TAG = "flagship/daemon-status/v1";
const HEX = /^[0-9a-f]*$/;

/** The protocol's legacyFieldGuard: no separator, no control characters. */
function guard(value) {
  if (typeof value !== "string" || value.includes("|") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("malformed report field");
  }
  return value;
}

export function canonicalDaemonStatus(r) {
  guard(r.serverDomain);
  if (r.certSha256 !== null) guard(r.certSha256);
  if (r.certIssuer !== null) guard(r.certIssuer);
  if (!Array.isArray(r.appsServed)) throw new Error("malformed report field");
  for (const app of r.appsServed) guard(app);
  guard(r.nonce);
  if (!Number.isSafeInteger(r.issuedAt)) throw new Error("malformed report field");
  if (r.certValidUntil !== null && !Number.isFinite(r.certValidUntil)) throw new Error("malformed report field");
  const apps = r.appsServed.slice().sort().join(",");
  return new TextEncoder().encode(
    [TAG, r.serverDomain, r.certSha256 ?? "", String(r.certValidUntil ?? ""), r.certIssuer ?? "", apps, r.nonce, String(r.issuedAt)].join("|"),
  );
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True when `signatureHex` is the server key's Ed25519 signature over the report. Never throws. */
export async function verifyDaemonStatus(report, signatureHex, stkPubHex, subtle = globalThis.crypto.subtle) {
  try {
    if (!/^[0-9a-f]{128}$/.test(String(signatureHex).toLowerCase())) return false;
    if (!/^[0-9a-f]{64}$/.test(String(stkPubHex))) return false;
    const msg = canonicalDaemonStatus(report);
    const key = await subtle.importKey("raw", hexToBytes(stkPubHex), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, hexToBytes(signatureHex.toLowerCase()), msg);
  } catch {
    return false;
  }
}

/** A report as it arrives over the wire, or null when its shape is wrong. */
export function parseReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  if (typeof r.serverDomain !== "string" || typeof r.nonce !== "string" || !Number.isSafeInteger(r.issuedAt)) return null;
  if (r.certSha256 !== null && typeof r.certSha256 !== "string") return null;
  if (r.certIssuer !== null && typeof r.certIssuer !== "string") return null;
  if (r.certValidUntil !== null && typeof r.certValidUntil !== "number") return null;
  if (!Array.isArray(r.appsServed) || r.appsServed.some((a) => typeof a !== "string")) return null;
  return {
    serverDomain: r.serverDomain,
    certSha256: r.certSha256,
    certValidUntil: r.certValidUntil,
    certIssuer: r.certIssuer,
    appsServed: r.appsServed.slice(),
    nonce: r.nonce,
    issuedAt: r.issuedAt,
  };
}

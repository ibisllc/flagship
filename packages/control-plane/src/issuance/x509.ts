/**
 * Just enough DER to check a PKCS#10 request and the chain a CA returns, verified with WebCrypto (the Worker has no
 * X.509 library, and a general one costs bundle and CPU). Strict: definite lengths only, no trailing bytes, one-byte
 * tags; anything else is refused rather than guessed at.
 */

interface Tlv {
  tag: number;
  /** Offset of the first byte of the whole TLV. */
  start: number;
  /** Offset of the value. */
  valueStart: number;
  /** Offset just past the value. */
  end: number;
}

export class DerError extends Error {}

function readTlv(b: Uint8Array, at: number, limit = b.length): Tlv {
  if (at + 2 > limit) throw new DerError("truncated");
  const tag = b[at]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tag");
  let len = b[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError("unsupported length");
    if (p + n > limit) throw new DerError("truncated");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i]!;
    if (n > 1 && b[p] === 0) throw new DerError("non-minimal length");
    if (len < 0x80) throw new DerError("non-minimal length");
    p += n;
  }
  if (p + len > limit) throw new DerError("truncated");
  return { tag, start: at, valueStart: p, end: p + len };
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.valueStart;
  while (p < t.end) {
    const c = readTlv(b, p, t.end);
    out.push(c);
    p = c.end;
  }
  return out;
}

function expect(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) throw new DerError(`${what}: unexpected tag`);
  return t;
}

function oidOf(b: Uint8Array, t: Tlv): string {
  expect(t, 0x06, "oid");
  const v = b.subarray(t.valueStart, t.end);
  if (v.length === 0) throw new DerError("empty oid");
  const parts: number[] = [];
  let acc = 0;
  for (let i = 0; i < v.length; i++) {
    acc = acc * 128 + (v[i]! & 0x7f);
    if (acc > Number.MAX_SAFE_INTEGER / 128) throw new DerError("oid too long");
    if (!(v[i]! & 0x80)) {
      if (parts.length === 0) {
        const first = acc < 80 ? Math.floor(acc / 40) : 2;
        parts.push(first, acc - first * 40);
      } else parts.push(acc);
      acc = 0;
    } else if (i === v.length - 1) throw new DerError("oid truncated");
  }
  return parts.join(".");
}

function bitString(b: Uint8Array, t: Tlv): Uint8Array {
  expect(t, 0x03, "bit string");
  if (b[t.valueStart] !== 0) throw new DerError("bit string with unused bits");
  return b.subarray(t.valueStart + 1, t.end);
}

const ascii = (b: Uint8Array, t: Tlv): string => {
  const v = b.subarray(t.valueStart, t.end);
  for (const c of v) if (c < 0x20 || c > 0x7e) throw new DerError("non-ascii name");
  return String.fromCharCode(...v);
};

export const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  rsaSha256: "1.2.840.113549.1.1.11",
  rsaSha384: "1.2.840.113549.1.1.12",
  commonName: "2.5.4.3",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
} as const;

export type KeyKind = { kind: "ec"; curve: "P-256" | "P-384" } | { kind: "rsa"; bits: number };

export interface PublicKeyInfo {
  /** The whole SubjectPublicKeyInfo TLV, as WebCrypto's `spki` import takes it. */
  spki: Uint8Array;
  key: KeyKind;
}

function publicKeyInfo(b: Uint8Array, t: Tlv): PublicKeyInfo {
  const [alg, bits] = children(b, expect(t, 0x30, "spki"));
  const algParts = children(b, expect(alg, 0x30, "spki algorithm"));
  const algOid = oidOf(b, algParts[0]!);
  const raw = bitString(b, bits!);
  const spki = b.slice(t.start, t.end);
  if (algOid === OID.ecPublicKey) {
    const curve = algParts[1] ? oidOf(b, algParts[1]) : "";
    if (curve === OID.p256 && raw.length === 65 && raw[0] === 4) return { spki, key: { kind: "ec", curve: "P-256" } };
    if (curve === OID.p384 && raw.length === 97 && raw[0] === 4) return { spki, key: { kind: "ec", curve: "P-384" } };
    throw new DerError("unsupported curve");
  }
  if (algOid === OID.rsaEncryption) {
    const rsa = readTlv(raw, 0);
    if (rsa.end !== raw.length) throw new DerError("trailing bytes in RSA key");
    const [mod] = children(raw, expect(rsa, 0x30, "rsa key"));
    const m = expect(mod, 0x02, "rsa modulus");
    let len = m.end - m.valueStart;
    if (raw[m.valueStart] === 0) len -= 1;
    return { spki, key: { kind: "rsa", bits: len * 8 } };
  }
  throw new DerError("unsupported key algorithm");
}

/** A SAN entry: DNS names as written; anything else (IP, email, URI…) by kind only. */
export type SanEntry = { type: "dns"; value: string } | { type: "other"; tag: number };

function sanEntries(b: Uint8Array, extnValue: Tlv): SanEntry[] {
  const inner = readTlv(b, extnValue.valueStart, extnValue.end);
  if (inner.end !== extnValue.end) throw new DerError("trailing bytes in SAN");
  return children(b, expect(inner, 0x30, "general names")).map((g) =>
    g.tag === 0x82 ? { type: "dns" as const, value: ascii(b, g) } : { type: "other" as const, tag: g.tag },
  );
}

function extensionsSans(b: Uint8Array, exts: Tlv): SanEntry[] | null {
  let sans: SanEntry[] | null = null;
  for (const e of children(b, expect(exts, 0x30, "extensions"))) {
    const parts = children(b, expect(e, 0x30, "extension"));
    if (oidOf(b, parts[0]!) !== OID.subjectAltName) continue;
    if (sans) throw new DerError("two SAN extensions");
    sans = sanEntries(b, expect(parts[parts.length - 1], 0x04, "extension value"));
  }
  return sans;
}

function commonNames(b: Uint8Array, name: Tlv): string[] {
  const out: string[] = [];
  for (const rdn of children(b, expect(name, 0x30, "name"))) {
    for (const atv of children(b, expect(rdn, 0x31, "rdn"))) {
      const [type, value] = children(b, expect(atv, 0x30, "attribute"));
      if (oidOf(b, type!) === OID.commonName && value) out.push(ascii(b, value));
    }
  }
  return out;
}

function signatureAlgorithm(b: Uint8Array, t: Tlv): string {
  return oidOf(b, children(b, expect(t, 0x30, "signature algorithm"))[0]!);
}

export interface ParsedCsr {
  /** The signed part, for verification. */
  info: Uint8Array;
  publicKey: PublicKeyInfo;
  commonNames: string[];
  sans: SanEntry[];
  signatureAlgorithm: string;
  signature: Uint8Array;
}

export function parseCsr(der: Uint8Array): ParsedCsr {
  const top = readTlv(der, 0);
  if (top.end !== der.length) throw new DerError("trailing bytes");
  const [info, alg, sig] = children(der, expect(top, 0x30, "csr"));
  const parts = children(der, expect(info, 0x30, "csr info"));
  const version = expect(parts[0], 0x02, "csr version");
  if (version.end - version.valueStart !== 1 || der[version.valueStart] !== 0) throw new DerError("csr version");
  const subject = parts[1]!;
  const spki = publicKeyInfo(der, parts[2]!);
  let sans: SanEntry[] = [];
  const attrs = parts[3];
  if (attrs) {
    expect(attrs, 0xa0, "csr attributes");
    for (const a of children(der, attrs)) {
      const [type, values] = children(der, expect(a, 0x30, "attribute"));
      if (oidOf(der, type!) !== OID.extensionRequest) continue;
      const vs = children(der, expect(values, 0x31, "attribute values"));
      if (vs.length !== 1) throw new DerError("extension request");
      sans = extensionsSans(der, vs[0]!) ?? [];
    }
  }
  return {
    info: der.slice(info!.start, info!.end),
    publicKey: spki,
    commonNames: commonNames(der, subject),
    sans,
    signatureAlgorithm: signatureAlgorithm(der, alg!),
    signature: bitString(der, sig!),
  };
}

export interface ParsedCertificate {
  tbs: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  publicKey: PublicKeyInfo;
  notBefore: number;
  notAfter: number;
  sans: SanEntry[];
  signatureAlgorithm: string;
  signature: Uint8Array;
}

function timeOf(b: Uint8Array, t: Tlv): number {
  const s = ascii(b, t);
  let m: RegExpMatchArray | null;
  if (t.tag === 0x17 && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const yy = Number(m[1]);
    return Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (t.tag === 0x18 && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw new DerError("time");
}

export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const top = readTlv(der, 0);
  if (top.end !== der.length) throw new DerError("trailing bytes");
  const [tbs, alg, sig] = children(der, expect(top, 0x30, "certificate"));
  const parts = children(der, expect(tbs, 0x30, "tbs"));
  let i = 0;
  if (parts[0]?.tag === 0xa0) i++;
  i++; // serial
  i++; // signature algorithm (inner)
  const issuer = expect(parts[i++], 0x30, "issuer");
  const validity = children(der, expect(parts[i++], 0x30, "validity"));
  const subject = expect(parts[i++], 0x30, "subject");
  const spki = publicKeyInfo(der, parts[i++]!);
  let sans: SanEntry[] = [];
  for (; i < parts.length; i++) {
    if (parts[i]!.tag !== 0xa3) continue;
    const exts = readTlv(der, parts[i]!.valueStart, parts[i]!.end);
    sans = extensionsSans(der, exts) ?? [];
  }
  return {
    tbs: der.slice(tbs!.start, tbs!.end),
    issuer: der.slice(issuer.start, issuer.end),
    subject: der.slice(subject.start, subject.end),
    publicKey: spki,
    notBefore: timeOf(der, validity[0]!),
    notAfter: timeOf(der, validity[1]!),
    sans,
    signatureAlgorithm: signatureAlgorithm(der, alg!),
    signature: bitString(der, sig!),
  };
}

/** DER ECDSA-Sig-Value → the fixed-width r‖s WebCrypto verifies. */
function ecdsaRaw(sig: Uint8Array, size: number): Uint8Array | null {
  try {
    const top = readTlv(sig, 0);
    if (top.end !== sig.length) return null;
    const [r, s] = children(sig, expect(top, 0x30, "ecdsa sig"));
    const out = new Uint8Array(size * 2);
    for (const [idx, t] of [r, s].entries()) {
      const v = sig.subarray(expect(t, 0x02, "ecdsa int").valueStart, t!.end);
      const trimmed = v[0] === 0 ? v.subarray(1) : v;
      if (trimmed.length > size) return null;
      out.set(trimmed, idx * size + (size - trimmed.length));
    }
    return out;
  } catch {
    return null;
  }
}

/** Verify `signature` over `data` under `key` with the named X.509 signature algorithm. False for anything unsupported. */
export async function verifyX509Signature(key: PublicKeyInfo, algorithm: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  try {
    if (key.key.kind === "ec") {
      const hash = algorithm === OID.ecdsaSha256 ? "SHA-256" : algorithm === OID.ecdsaSha384 ? "SHA-384" : null;
      if (!hash) return false;
      const raw = ecdsaRaw(signature, key.key.curve === "P-256" ? 32 : 48);
      if (!raw) return false;
      const k = await subtle.importKey("spki", key.spki, { name: "ECDSA", namedCurve: key.key.curve }, false, ["verify"]);
      return await subtle.verify({ name: "ECDSA", hash }, k, raw, data);
    }
    const hash = algorithm === OID.rsaSha256 ? "SHA-256" : algorithm === OID.rsaSha384 ? "SHA-384" : null;
    if (!hash) return false;
    const k = await subtle.importKey("spki", key.spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return await subtle.verify("RSASSA-PKCS1-v1_5", k, signature, data);
  } catch {
    return false;
  }
}

export function pemBlocks(pem: string, label = "CERTIFICATE"): Uint8Array[] {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, "g");
  const out: Uint8Array[] = [];
  for (const m of pem.matchAll(re)) out.push(base64ToBytes(m[1]!.replace(/\s+/g, "")));
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** The extnValue contents (inside its OCTET STRING) of the extension `oid` in a certificate, or null when absent. */
export function certificateExtension(der: Uint8Array, oid: string): Uint8Array | null {
  const top = readTlv(der, 0);
  if (top.end !== der.length) throw new DerError("trailing bytes");
  const [tbs] = children(der, expect(top, 0x30, "certificate"));
  let found: Uint8Array | null = null;
  for (const part of children(der, expect(tbs, 0x30, "tbs"))) {
    if (part.tag !== 0xa3) continue;
    const exts = readTlv(der, part.valueStart, part.end);
    for (const e of children(der, expect(exts, 0x30, "extensions"))) {
      const parts = children(der, expect(e, 0x30, "extension"));
      if (oidOf(der, parts[0]!) !== oid) continue;
      if (found) throw new DerError("duplicate extension");
      const v = expect(parts[parts.length - 1], 0x04, "extension value");
      found = der.slice(v.valueStart, v.end);
    }
  }
  return found;
}

/** The first OCTET STRING in a DER value, depth first through constructed values. */
export function firstOctetString(der: Uint8Array): Uint8Array | null {
  const walk = (start: number, end: number, depth: number): Uint8Array | null => {
    if (depth > 8) throw new DerError("too deep");
    let p = start;
    while (p < end) {
      const t = readTlv(der, p, end);
      if (t.tag === 0x04) return der.slice(t.valueStart, t.end);
      if (t.tag & 0x20) {
        const inner = walk(t.valueStart, t.end, depth + 1);
        if (inner) return inner;
      }
      p = t.end;
    }
    return null;
  };
  return walk(0, der.length, 0);
}

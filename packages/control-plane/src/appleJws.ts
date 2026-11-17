// Apple's signed App Store data (StoreKit 2 transactions, App Store Server Notifications V2): a compact JWS, ES256,
// whose `x5c` header carries leaf, intermediate and root. We check it ourselves (no Apple SDK in a Worker):
// the root is Apple Root CA - G3 by SHA-256 of its DER, each certificate is signed by the next and inside its dates,
// the intermediate carries Apple's WWDR marker and the leaf the App Store receipt-signing marker, and the JWS
// verifies under the leaf's P-256 key. docs/payments-privacy-and-rails.md §11.

/** SHA-256 of Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer). */
export const APPLE_ROOT_CA_G3_SHA256 = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";
/** Marker extension on Apple's WWDR intermediate. */
export const APPLE_WWDR_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
/** Marker extension on the App Store's signing leaf. */
export const APPLE_APPSTORE_LEAF_OID = "1.2.840.113635.100.6.11.1";

interface Tlv {
  tag: number;
  start: number; // first byte of the value
  end: number; // one past the value
  hdr: number; // first byte of the tag
}

function tlv(b: Uint8Array, off: number): Tlv {
  if (off + 2 > b.length) throw new Error("der: short");
  const tag = b[off]!;
  let len = b[off + 1]!;
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > b.length) throw new Error("der: length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++]!;
  }
  if (p + len > b.length) throw new Error("der: overrun");
  return { tag, start: p, end: p + len, hdr: off };
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.start; p < t.end; ) {
    const c = tlv(b, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function oid(b: Uint8Array, t: Tlv): string {
  const v = b.subarray(t.start, t.end);
  if (v.length === 0) return "";
  const parts = [Math.floor(v[0]! / 40), v[0]! % 40];
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i]! & 0x7f);
    if (!(v[i]! & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join(".");
}

function derTime(b: Uint8Array, t: Tlv): number {
  const s = new TextDecoder().decode(b.subarray(t.start, t.end));
  const m = t.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error("der: time");
  let y = Number(m[1]);
  if (t.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface ParsedCert {
  der: Uint8Array;
  tbs: Uint8Array;
  sigAlg: string;
  sig: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array;
  curve: "P-256" | "P-384" | null;
  extensions: string[];
}

const EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Record<string, "P-256" | "P-384"> = { "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384" };
const SIG_HASH: Record<string, "SHA-256" | "SHA-384"> = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384" };

export function parseCert(der: Uint8Array): ParsedCert {
  const cert = tlv(der, 0);
  if (cert.tag !== 0x30 || cert.end !== der.length) throw new Error("cert: outer");
  const [tbsT, algT, sigT] = children(der, cert);
  if (!tbsT || !algT || !sigT || sigT.tag !== 0x03) throw new Error("cert: parts");
  const algOid = children(der, algT)[0];
  if (!algOid) throw new Error("cert: alg");
  const f = children(der, tbsT);
  let i = 0;
  if (f[0]?.tag === 0xa0) i++; // version
  const issuerT = f[i + 2];
  const validityT = f[i + 3];
  const subjectT = f[i + 4];
  const spkiT = f[i + 5];
  if (!issuerT || !validityT || !subjectT || !spkiT) throw new Error("cert: tbs");
  const [nb, na] = children(der, validityT);
  if (!nb || !na) throw new Error("cert: validity");
  const spkiAlg = children(der, children(der, spkiT)[0]!);
  const isEc = spkiAlg[0] ? oid(der, spkiAlg[0]) === EC_PUBLIC_KEY : false;
  const curve = isEc && spkiAlg[1] ? (CURVES[oid(der, spkiAlg[1])] ?? null) : null;
  const extensions: string[] = [];
  const extWrap = f.slice(i + 6).find((c) => c.tag === 0xa3);
  if (extWrap) {
    const seq = children(der, extWrap)[0];
    for (const e of seq ? children(der, seq) : []) {
      const id = children(der, e)[0];
      if (id?.tag === 0x06) extensions.push(oid(der, id));
    }
  }
  return {
    der,
    tbs: der.subarray(tbsT.hdr, tbsT.end),
    sigAlg: oid(der, algOid),
    sig: der.subarray(sigT.start + 1, sigT.end), // skip the unused-bits byte
    issuer: der.subarray(issuerT.hdr, issuerT.end),
    subject: der.subarray(subjectT.hdr, subjectT.end),
    notBefore: derTime(der, nb),
    notAfter: derTime(der, na),
    spki: der.subarray(spkiT.hdr, spkiT.end),
    curve,
    extensions,
  };
}

/** DER ECDSA-Sig-Value → the raw r‖s WebCrypto wants. */
function ecdsaDerToRaw(sig: Uint8Array, size: number): Uint8Array {
  const seq = tlv(sig, 0);
  const [r, s] = children(sig, seq);
  if (seq.tag !== 0x30 || !r || !s || r.tag !== 0x02 || s.tag !== 0x02) throw new Error("ecdsa: sig");
  const out = new Uint8Array(size * 2);
  const put = (t: Tlv, at: number) => {
    let v = sig.subarray(t.start, t.end);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("ecdsa: int");
    out.set(v, at + size - v.length);
  };
  put(r, 0);
  put(s, size);
  return out;
}

const CURVE_SIZE = { "P-256": 32, "P-384": 48 } as const;

async function importKey(c: ParsedCert): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  if (!c.curve) throw new Error("cert: not an EC P-256/P-384 key");
  return crypto.subtle.importKey("spki", c.spki, { name: "ECDSA", namedCurve: c.curve }, false, ["verify"]);
}

async function signedBy(child: ParsedCert, parent: ParsedCert): Promise<boolean> {
  const hash = SIG_HASH[child.sigAlg];
  if (!hash || !parent.curve) return false;
  if (!bytesEqual(child.issuer, parent.subject)) return false;
  try {
    const raw = ecdsaDerToRaw(child.sig, CURVE_SIZE[parent.curve]);
    return await crypto.subtle.verify({ name: "ECDSA", hash }, await importKey(parent), raw, child.tbs);
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(std + "=".repeat((4 - (std.length % 4)) % 4));
}

function b64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface AppleJwsOptions {
  /** SHA-256 hex of the accepted root(s); defaults to Apple Root CA - G3. Tests pass their own. */
  rootFingerprints?: readonly string[];
  now: number;
}

/**
 * Verify an Apple-signed JWS and return its payload object, or null on any failure (bad shape, chain, marker, dates
 * or signature). Never throws.
 */
export async function verifyAppleSignedJws(jws: unknown, opts: AppleJwsOptions): Promise<Record<string, unknown> | null> {
  try {
    if (typeof jws !== "string" || jws.length > 64 * 1024) return null;
    const parts = jws.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    const hb = b64urlToBytes(h);
    const pb = b64urlToBytes(p);
    const sb = b64urlToBytes(s);
    if (!hb || !pb || !sb || sb.length !== 64) return null;
    const header = JSON.parse(new TextDecoder().decode(hb)) as { alg?: unknown; x5c?: unknown };
    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) return null;
    const ders = header.x5c.map((c) => (typeof c === "string" ? b64ToBytes(c) : null));
    if (ders.some((d) => !d)) return null;
    const [leaf, mid, root] = (ders as Uint8Array[]).map(parseCert) as [ParsedCert, ParsedCert, ParsedCert];
    const roots = opts.rootFingerprints ?? [APPLE_ROOT_CA_G3_SHA256];
    if (!roots.includes(await sha256Hex(root.der))) return null;
    for (const c of [leaf, mid, root]) if (opts.now < c.notBefore || opts.now > c.notAfter) return null;
    if (!mid.extensions.includes(APPLE_WWDR_INTERMEDIATE_OID) || !leaf.extensions.includes(APPLE_APPSTORE_LEAF_OID)) return null;
    if (!(await signedBy(mid, root)) || !(await signedBy(leaf, mid))) return null;
    if (leaf.curve !== "P-256") return null;
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(leaf), sb, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(pb)) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

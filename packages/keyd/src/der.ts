/** The few ASN.1 DER encodings a certificate request needs. */

export function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, body: Uint8Array): Uint8Array {
  const l = len(body.length);
  const out = new Uint8Array(1 + l.length + body.length);
  out[0] = tag;
  out.set(l, 1);
  out.set(body, 1 + l.length);
  return out;
}

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const seq = (...p: Uint8Array[]): Uint8Array => tlv(0x30, cat(...p));
export const set = (...p: Uint8Array[]): Uint8Array => tlv(0x31, cat(...p));
export const octets = (b: Uint8Array): Uint8Array => tlv(0x04, b);
export const utf8 = (s: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(s));
export const int0 = (): Uint8Array => tlv(0x02, Uint8Array.of(0));
export const bitString = (b: Uint8Array): Uint8Array => tlv(0x03, cat(Uint8Array.of(0), b));

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    for (let v = p >>> 7; v > 0; v >>>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** Parse the ASN.1 DER signature (r, s) of an ECDSA signature into 64 raw bytes. Used by tests. */
export function pemBody(pem: string): Uint8Array {
  return Uint8Array.from(Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));
}

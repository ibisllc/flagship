/**
 * Minimal CBOR decoder — just enough to parse the WebAuthn
 * attestationObject (a CBOR map) and the COSE_Key inside authData.
 *
 * Why custom: avoiding a dependency on `cbor`/`cbor-web` (each ~50 KB);
 * we only need integer keys, byte strings, text strings, arrays, and
 * maps. The full CBOR spec includes tags, big-numbers, indefinite-
 * length items, and half-precision floats that WebAuthn does not use.
 *
 * Scope:
 *   - Major types 0 (unsigned int), 1 (negative int), 2 (byte string),
 *     3 (text string), 4 (array), 5 (map), 7 (simple values true/false/null).
 *   - Definite-length items only.
 *   - Returns plain JS values: Map<key, value> for CBOR maps (preserves
 *     key order and supports both string and number keys, which COSE_Key
 *     requires).
 *
 * Throws on anything outside that scope so we fail loudly on input that
 * doesn't match what an authenticator should emit.
 */

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | Map<number | string, CborValue>;

export function decodeCbor(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const out = r.read();
  if (r.offset !== bytes.length) {
    throw new Error(`cbor: trailing bytes (offset=${r.offset}, length=${bytes.length})`);
  }
  return out;
}

class Reader {
  offset = 0;
  constructor(readonly buf: Uint8Array) {}

  read(): CborValue {
    if (this.offset >= this.buf.length) throw new Error("cbor: unexpected EOF");
    const ib = this.buf[this.offset++]!;
    const major = ib >> 5;
    const minor = ib & 0x1f;
    const len = this.readLen(minor);
    switch (major) {
      case 0:
        return Number(len);
      case 1:
        return -1 - Number(len);
      case 2: {
        const n = Number(len);
        const slice = this.buf.slice(this.offset, this.offset + n);
        if (slice.length !== n) throw new Error("cbor: truncated byte string");
        this.offset += n;
        return slice;
      }
      case 3: {
        const n = Number(len);
        const slice = this.buf.slice(this.offset, this.offset + n);
        if (slice.length !== n) throw new Error("cbor: truncated text string");
        this.offset += n;
        return new TextDecoder("utf-8", { fatal: true }).decode(slice);
      }
      case 4: {
        const n = Number(len);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.read());
        return out;
      }
      case 5: {
        const n = Number(len);
        const out = new Map<number | string, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = this.read();
          const v = this.read();
          if (typeof k !== "number" && typeof k !== "string") {
            throw new Error(`cbor: unsupported map key type (${typeof k})`);
          }
          out.set(k, v);
        }
        return out;
      }
      case 7:
        if (minor === 20) return false;
        if (minor === 21) return true;
        if (minor === 22) return null;
        if (minor === 23) return null;
        throw new Error(`cbor: unsupported simple/float (minor=${minor})`);
      default:
        throw new Error(`cbor: unsupported major type ${major}`);
    }
  }

  private readLen(minor: number): number | bigint {
    if (minor < 24) return minor;
    if (minor === 24) return this.readUint(1);
    if (minor === 25) return this.readUint(2);
    if (minor === 26) return this.readUint(4);
    if (minor === 27) return this.readUint(8);
    throw new Error(`cbor: unsupported length-form (minor=${minor})`);
  }

  private readUint(n: number): number | bigint {
    if (this.offset + n > this.buf.length) throw new Error("cbor: truncated length");
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(this.buf[this.offset++]!);
    return n <= 6 ? Number(v) : v;
  }
}

/**
 * Helper: pull a Uint8Array entry out of a CBOR map, or throw.
 */
export function expectBytes(m: Map<number | string, CborValue>, key: number | string): Uint8Array {
  const v = m.get(key);
  if (!(v instanceof Uint8Array)) {
    throw new Error(`cbor: expected byte string at key ${String(key)}; got ${typeof v}`);
  }
  return v;
}

export function expectString(m: Map<number | string, CborValue>, key: number | string): string {
  const v = m.get(key);
  if (typeof v !== "string") {
    throw new Error(`cbor: expected text string at key ${String(key)}; got ${typeof v}`);
  }
  return v;
}

export function expectNumber(m: Map<number | string, CborValue>, key: number | string): number {
  const v = m.get(key);
  if (typeof v !== "number") {
    throw new Error(`cbor: expected number at key ${String(key)}; got ${typeof v}`);
  }
  return v;
}

export function expectMap(
  m: Map<number | string, CborValue>,
  key: number | string,
): Map<number | string, CborValue> {
  const v = m.get(key);
  if (!(v instanceof Map)) {
    throw new Error(`cbor: expected map at key ${String(key)}; got ${typeof v}`);
  }
  return v;
}

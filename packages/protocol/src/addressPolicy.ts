/**
 * One destination classifier for every dialer (SEC N02). Addresses are parsed
 * to bytes before they are judged, so spelling (expanded IPv6, upper case,
 * IPv4-mapped in dotted or hex form, zone ids) cannot change the answer.
 *
 * This only classifies. A caller must still resolve, classify, then connect to
 * the numeric address it classified, and repeat for every redirect.
 */

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "multicast"
  | "reserved"
  | "invalid";

/** A strict dotted quad: four decimal octets, no leading zeros, no octal or hex. */
export function parseStrictIpv4(s: string): [number, number, number, number] | null {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return [o[0]!, o[1]!, o[2]!, o[3]!];
}

/** Sixteen bytes of an IPv6 address; null if it is not one. A zone id is refused. */
export function parseIpv6Bytes(input: string): Uint8Array | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%") || !s.includes(":")) return null;
  s = s.toLowerCase();
  let tail: number[] = [];
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    const v4 = parseStrictIpv4(s.slice(colon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, colon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !rest) return null;
  let all: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    all = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    all = head;
  }
  if (all.length !== 8) return null;
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 255;
  });
  tail.forEach((b, i) => (out[12 + i] = b));
  return out;
}

function inV4(o: ArrayLike<number>, base: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const mask = 0x80 >> (i & 7);
    if (((o[i >> 3]! ^ base[i >> 3]!) & mask) !== 0) return false;
  }
  return true;
}

const V4_RANGES: Array<[number[], number, AddressClass]> = [
  [[0, 0, 0, 0], 8, "reserved"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "private"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 169, 254], 32, "metadata"],
  [[169, 254, 0, 0], 16, "link-local"],
  [[172, 16, 0, 0], 12, "private"],
  [[192, 0, 0, 0], 24, "reserved"],
  [[192, 0, 2, 0], 24, "reserved"],
  [[192, 88, 99, 0], 24, "reserved"],
  [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "private"],
  [[198, 51, 100, 0], 24, "reserved"],
  [[203, 0, 113, 0], 24, "reserved"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"],
];

export function classifyIpv4(o: readonly number[]): AddressClass {
  for (const [base, bits, cls] of V4_RANGES) if (inV4(o, base, bits)) return cls;
  return "public";
}

// Within 2000::/3 these still are not the public internet.
const V6_CARVE_OUTS: Array<[number[], number, AddressClass]> = [
  [[0x20, 0x01, 0x00, 0x00], 23, "reserved"], // IETF assignments, Teredo, benchmarking
  [[0x20, 0x01, 0x0d, 0xb8], 32, "reserved"], // documentation
  [[0x20, 0x02], 16, "reserved"], // 6to4 embeds an IPv4 address nobody vouched for
  [[0x3f, 0xff], 20, "reserved"], // documentation
];

export function classifyIpv6(b: Uint8Array): AddressClass {
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(16)) return "reserved"; // ::
  if (zeros(15) && b[15] === 1) return "loopback"; // ::1
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return classifyIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
  if (zeros(12)) return "reserved"; // ::/96 IPv4-compatible
  if ((b[0]! & 0xfe) === 0xfc) {
    // fd00:ec2::254 is the AWS IPv6 metadata address.
    const aws = b[0] === 0xfd && b[1] === 0 && b[2] === 0x0e && b[3] === 0xc2 && b[14] === 0x02 && b[15] === 0x54 && b.slice(4, 14).every((x) => x === 0);
    return aws ? "metadata" : "private";
  }
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link-local";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return "private"; // fec0::/10 site-local
  if (b[0] === 0xff) return "multicast";
  if ((b[0]! & 0xe0) !== 0x20) return "reserved"; // outside 2000::/3
  for (const [prefix, bits, cls] of V6_CARVE_OUTS) if (inV4(b, prefix, bits)) return cls;
  return "public";
}

/** Classify a textual IPv4 or IPv6 address. Anything that is not one is "invalid". */
export function classifyAddress(ip: string): AddressClass {
  const v4 = parseStrictIpv4(ip);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6Bytes(ip);
  return v6 ? classifyIpv6(v6) : "invalid";
}

/** True only for an address on the public internet. Fails closed. */
export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === "public";
}

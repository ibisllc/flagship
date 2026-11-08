// Minimal TLS ClientHello reader: SNI and ALPN (enough for the spike relay's routing + logging).
export function readHello(buf) {
  if (buf.length < 5 || buf[0] !== 0x16) return null;
  const recLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recLen) return undefined; // need more
  let p = 5;
  if (buf[p] !== 0x01) return null;
  p += 4 + 2 + 32;
  p += 1 + buf[p];
  p += 2 + buf.readUInt16BE(p);
  p += 1 + buf[p];
  const extEnd = p + 2 + buf.readUInt16BE(p);
  p += 2;
  const out = { sni: null, alpn: [], groups: [] };
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2), d = p + 4;
    if (type === 0 && len > 5) out.sni = buf.subarray(d + 5, d + 5 + buf.readUInt16BE(d + 3)).toString();
    if (type === 16) { let q = d + 2; while (q < d + len) { const l = buf[q]; out.alpn.push(buf.subarray(q + 1, q + 1 + l).toString()); q += 1 + l; } }
    if (type === 10) { for (let q = d + 2; q < d + len; q += 2) out.groups.push(buf.readUInt16BE(q)); }
    p = d + len;
  }
  return out;
}
export const GROUP_NAMES = { 0x001d: "x25519", 0x0017: "secp256r1", 0x0018: "secp384r1", 0x11ec: "X25519MLKEM768", 0x6399: "X25519Kyber768Draft00" };

/**
 * An in-process fake LDAP server for the LDAP-pull tests: just enough BER (RFC 4511) to answer a
 * simple bind, a search (every entry it holds; the filter is not evaluated) and an unbind. The real
 * `ldapts` client talks to it over TCP, so the tests exercise the client's own encoding and parsing.
 */
import { createServer, type AddressInfo, type Socket } from "node:net";

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const octets = (s: string | Buffer) => tlv(0x04, Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8"));
const int = (tag: number, n: number) => tlv(tag, Buffer.from([n]));
const result = (tag: number, code: number) => tlv(tag, Buffer.concat([int(0x0a, code), octets(""), octets("")]));
const message = (id: number, op: Buffer) => tlv(0x30, Buffer.concat([int(0x02, id), op]));

/** Reads one TLV at `at`: tag, the body's start and end. */
function read(b: Buffer, at: number): { tag: number; start: number; end: number } | null {
  if (at + 2 > b.length) return null;
  const tag = b[at]!;
  let l = b[at + 1]!;
  let start = at + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    if (start + n > b.length) return null;
    l = 0;
    for (let i = 0; i < n; i++) l = (l << 8) | b[start + i]!;
    start += n;
  }
  return start + l > b.length ? null : { tag, start, end: start + l };
}

export interface FakeLdapEntry {
  dn: string;
  attrs: Record<string, Array<string | Buffer>>;
}

export async function fakeLdapServer(entries: FakeLdapEntry[], creds: { dn: string; password: string }) {
  const seen = { binds: [] as string[], searches: [] as string[], unbinds: 0 };
  const server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let bound = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const msg = read(buf, 0);
        if (!msg) return;
        const idT = read(buf, msg.start)!;
        const id = buf.readUIntBE(idT.start, idT.end - idT.start);
        const op = read(buf, idT.end)!;
        if (op.tag === 0x60) {
          const ver = read(buf, op.start)!;
          const name = read(buf, ver.end)!;
          const pw = read(buf, name.end)!;
          const dn = buf.subarray(name.start, name.end).toString();
          seen.binds.push(dn);
          bound = dn === creds.dn && buf.subarray(pw.start, pw.end).toString() === creds.password;
          sock.write(message(id, result(0x61, bound ? 0 : 49)));
        } else if (op.tag === 0x63) {
          const base = read(buf, op.start)!;
          seen.searches.push(buf.subarray(base.start, base.end).toString());
          if (bound) {
            for (const e of entries) {
              const attrs = Object.entries(e.attrs).map(([k, vs]) => tlv(0x30, Buffer.concat([octets(k), tlv(0x31, Buffer.concat(vs.map((v) => octets(v))))])));
              sock.write(message(id, tlv(0x64, Buffer.concat([octets(e.dn), tlv(0x30, Buffer.concat(attrs))]))));
            }
          }
          sock.write(message(id, result(0x65, bound ? 0 : 50)));
        } else if (op.tag === 0x42) {
          seen.unbinds++;
          sock.end();
        }
        buf = buf.subarray(msg.end);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `ldap://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

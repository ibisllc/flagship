import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import {
  QTYPE_A,
  QTYPE_AAAA,
  RCODE_FORMERR,
  RCODE_NXDOMAIN,
  RCODE_REFUSED,
  RCODE_SERVFAIL,
  answerDnsQuery,
  parseDnsQuery,
  startDnsServer,
  type DnsFilterDeps,
} from "../../src/egress/dnsFilter.js";

function query(name: string, qtype = QTYPE_A, id = 0x1234, flags = 0x0100): Buffer {
  const labels = name.split(".").filter(Boolean);
  const q = Buffer.concat([
    ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")])),
    Buffer.from([0]),
    Buffer.from([qtype >> 8, qtype & 0xff, 0, 1]),
  ]);
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(1, 4);
  return Buffer.concat([h, q]);
}

const rcode = (b: Buffer) => b[3]! & 0xf;
const answers = (b: Buffer) => b.readUInt16BE(6);

/** A canned upstream answer: one A record 93.184.215.14 for the question. */
function upstreamAnswer(q: Buffer): Buffer {
  const out = Buffer.from(q);
  out.writeUInt16BE(0x8180, 2);
  out.writeUInt16BE(1, 6);
  return Buffer.concat([out, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 215, 14])]);
}

const deps = (allowed: string[], seen: string[] = []): DnsFilterDeps => ({
  allow: (_src, name) => allowed.includes(name),
  upstream: async (q) => {
    seen.push(parseDnsQuery(q)!.name);
    return upstreamAnswer(q);
  },
});

describe("DNS query parsing", () => {
  it("reads one standard question, lowercased", () => {
    expect(parseDnsQuery(query("Registry.NPMJS.org"))).toMatchObject({ id: 0x1234, name: "registry.npmjs.org", qtype: 1, qclass: 1 });
  });

  it("rejects responses, other opcodes, several questions, compression and junk", () => {
    expect(parseDnsQuery(query("a.com", 1, 1, 0x8100))).toBeNull();
    expect(parseDnsQuery(query("a.com", 1, 1, 0x2900))).toBeNull();
    const two = query("a.com");
    two.writeUInt16BE(2, 4);
    expect(parseDnsQuery(two)).toBeNull();
    const ptr = Buffer.concat([query("a.com").subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
    expect(parseDnsQuery(ptr)).toBeNull();
    expect(parseDnsQuery(Buffer.alloc(5))).toBeNull();
    expect(parseDnsQuery(query("a\u0000b.com"))).toBeNull();
  });
});

describe("filtering", () => {
  it("forwards an allowed name unchanged and returns the upstream answer", async () => {
    const seen: string[] = [];
    const res = await answerDnsQuery(deps(["registry.npmjs.org"], seen), "172.20.0.2", query("registry.npmjs.org"), "udp");
    expect(seen).toEqual(["registry.npmjs.org"]);
    expect(rcode(res)).toBe(0);
    expect(answers(res)).toBe(1);
  });

  it("answers NXDOMAIN for anything else without asking upstream", async () => {
    const seen: string[] = [];
    const denied: string[] = [];
    const d = { ...deps(["registry.npmjs.org"], seen), onDenied: (_s: string, n: string) => denied.push(n) };
    const q = query("c2VjcmV0LWRhdGE.attacker.example");
    const res = await answerDnsQuery(d, "172.20.0.2", q, "udp");
    expect(rcode(res)).toBe(RCODE_NXDOMAIN);
    expect(res.readUInt16BE(0)).toBe(0x1234);
    expect(res[2]! & 0x80).toBe(0x80);
    expect(res.subarray(12)).toEqual(q.subarray(12));
    expect(seen).toEqual([]);
    expect(denied).toEqual(["c2vjcmv0lwrhdge.attacker.example"]);
  });

  it("gives allowed names an empty AAAA answer (the bridges are IPv4-only)", async () => {
    const seen: string[] = [];
    const res = await answerDnsQuery(deps(["github.com"], seen), "172.22.0.2", query("github.com", QTYPE_AAAA), "udp");
    expect(rcode(res)).toBe(0);
    expect(answers(res)).toBe(0);
    expect(seen).toEqual([]);
  });

  it("FORMERR for garbage, REFUSED for non-IN classes, SERVFAIL when upstream fails", async () => {
    expect(rcode(await answerDnsQuery(deps([]), "x", Buffer.from("garbage!!garbage"), "udp"))).toBe(RCODE_FORMERR);
    const chaos = query("github.com");
    chaos.writeUInt16BE(3, chaos.length - 2);
    expect(rcode(await answerDnsQuery(deps(["github.com"]), "x", chaos, "udp"))).toBe(RCODE_REFUSED);
    const failing: DnsFilterDeps = { allow: () => true, upstream: async () => { throw new Error("down"); } };
    expect(rcode(await answerDnsQuery(failing, "x", query("github.com"), "udp"))).toBe(RCODE_SERVFAIL);
    const wrongId: DnsFilterDeps = { allow: () => true, upstream: async (q) => upstreamAnswer(Buffer.concat([Buffer.from([9, 9]), q.subarray(2)])) };
    expect(rcode(await answerDnsQuery(wrongId, "x", query("github.com"), "udp"))).toBe(RCODE_SERVFAIL);
  });

  it("an allow callback that throws is a denial", async () => {
    const d: DnsFilterDeps = { allow: () => Promise.reject(new Error("boom")), upstream: async (q) => upstreamAnswer(q) };
    expect(rcode(await answerDnsQuery(d, "x", query("github.com"), "udp"))).toBe(RCODE_NXDOMAIN);
  });
});

describe("the DNS server", () => {
  it("serves UDP and TCP and filters by source address", async () => {
    const d: DnsFilterDeps = { allow: (src, name) => src === "127.0.0.1" && name === "github.com", upstream: async (q) => upstreamAnswer(q) };
    const port = 20000 + Math.floor(Math.random() * 20000);
    const srv = await startDnsServer(d, "127.0.0.1", port);
    try {
      const udp = createSocket("udp4");
      const udpAsk = (q: Buffer) =>
        new Promise<Buffer>((resolve) => {
          udp.once("message", (m) => resolve(m));
          udp.send(q, port, "127.0.0.1");
        });
      expect(rcode(await udpAsk(query("github.com")))).toBe(0);
      expect(rcode(await udpAsk(query("example.com")))).toBe(RCODE_NXDOMAIN);
      udp.close();

      const tcpRes = await new Promise<Buffer>((resolve, reject) => {
        const s = connect({ host: "127.0.0.1", port });
        let buf = Buffer.alloc(0);
        s.on("error", reject);
        s.on("connect", () => {
          const q = query("github.com");
          const l = Buffer.alloc(2);
          l.writeUInt16BE(q.length);
          s.write(Buffer.concat([l, q]));
        });
        s.on("data", (c) => {
          buf = Buffer.concat([buf, c]);
          if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
            s.destroy();
            resolve(buf.subarray(2));
          }
        });
      });
      expect(rcode(tcpRes)).toBe(0);
      expect(answers(tcpRes)).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

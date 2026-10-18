import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { answerFor, describeResponse, parseQuestions, startLanDiscovery, DISCOVERY_SERVICE_TYPE, type LanDiscovery } from "../src/lanDiscovery.js";

const ID = "0123456789abcdef";
const ann = { id: ID, endpoints: [{ address: "192.168.1.20", port: 443 }, { address: "fd12:3456::7", port: 443 }] };

function query(name: string, type: number, qu = false): Buffer {
  const labels = name.split(".").flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1 | (qu ? 0x8000 : 0), 2);
  return Buffer.concat([head, ...labels, Buffer.from([0]), tail]);
}

/** Pull every name and type out of a response (answers + additional), following compression pointers. */
function records(msg: Buffer): Array<{ name: string; type: number; rdata: Buffer }> {
  const name = (start: number): { s: string; next: number } => {
    const labels: string[] = [];
    let off = start;
    let next = -1;
    for (;;) {
      const len = msg[off]!;
      if (len === 0) return { s: labels.join("."), next: next === -1 ? off + 1 : next };
      if ((len & 0xc0) === 0xc0) {
        if (next === -1) next = off + 2;
        off = ((len & 0x3f) << 8) | msg[off + 1]!;
        continue;
      }
      labels.push(msg.subarray(off + 1, off + 1 + len).toString());
      off += 1 + len;
    }
  };
  const out: Array<{ name: string; type: number; rdata: Buffer }> = [];
  let off = 12;
  const n = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  for (let i = 0; i < n; i++) {
    const nm = name(off);
    const type = msg.readUInt16BE(nm.next);
    const rdlen = msg.readUInt16BE(nm.next + 8);
    out.push({ name: nm.s, type, rdata: msg.subarray(nm.next + 10, nm.next + 10 + rdlen) });
    off = nm.next + 10 + rdlen;
  }
  return out;
}

describe("parseQuestions", () => {
  it("reads a query and its QU bit", () => {
    expect(parseQuestions(query(DISCOVERY_SERVICE_TYPE, 12, true))).toEqual([{ name: DISCOVERY_SERVICE_TYPE, type: 12, unicast: true }]);
  });
  it("ignores responses, other opcodes, garbage and pointer loops", () => {
    const resp = query("a.local", 1);
    resp.writeUInt16BE(0x8400, 2);
    expect(parseQuestions(resp)).toBeNull();
    const op = query("a.local", 1);
    op.writeUInt16BE(0x2800, 2);
    expect(parseQuestions(op)).toBeNull();
    expect(parseQuestions(Buffer.from("nope"))).toBeNull();
    const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
    loop.writeUInt16BE(1, 4);
    expect(parseQuestions(loop)).toBeNull();
  });
});

describe("answerFor", () => {
  it("answers the service browse with the instance, its port, its id and its addresses", () => {
    const res = answerFor(ann, [{ name: DISCOVERY_SERVICE_TYPE, type: 12, unicast: false }])!;
    expect(describeResponse(res).answers).toBe(1);
    const rr = records(res);
    expect(rr.map((r) => r.type).sort((a, b) => a - b)).toEqual([1, 12, 16, 28, 33]);
    const srv = rr.find((r) => r.type === 33)!;
    expect(srv.name).toBe(`${ID}.${DISCOVERY_SERVICE_TYPE}`);
    expect(srv.rdata.readUInt16BE(4)).toBe(443);
    expect(rr.find((r) => r.type === 1)!.rdata).toEqual(Buffer.from([192, 168, 1, 20]));
    expect(rr.find((r) => r.type === 16)!.rdata.toString("latin1")).toContain(`id=${ID}`);
  });
  it("names nothing about the server: no domain, account or owner appears in the bytes", () => {
    const res = answerFor(ann, [{ name: DISCOVERY_SERVICE_TYPE, type: 12, unicast: false }])!;
    const text = res.toString("latin1");
    for (const word of ["flagship.services", "harry", "home", "alice"]) expect(text).not.toContain(word);
  });
  it("answers an address question for the box's own host name, and nothing for other names", () => {
    const a = answerFor(ann, [{ name: `${ID}.local`, type: 1, unicast: false }])!;
    expect(records(a).map((r) => r.type)).toContain(1);
    expect(answerFor(ann, [{ name: "printer.local", type: 1, unicast: false }])).toBeNull();
    expect(answerFor(ann, [{ name: "_http._tcp.local", type: 12, unicast: false }])).toBeNull();
  });
  it("never announces an address that is not on a local network", () => {
    const res = answerFor({ id: ID, endpoints: [{ address: "203.0.113.5", port: 443 }, { address: "10.0.0.2", port: 443 }] }, [{ name: DISCOVERY_SERVICE_TYPE, type: 12, unicast: false }])!;
    const addrs = records(res).filter((r) => r.type === 1).map((r) => [...r.rdata].join("."));
    expect(addrs).toEqual(["10.0.0.2"]);
  });
});

describe("startLanDiscovery over a real socket", () => {
  let d: LanDiscovery | null = null;
  afterEach(() => d?.close());

  it("answers a legacy unicast query from a non-5353 port, and stays quiet for other questions", async () => {
    const logs: string[] = [];
    d = startLanDiscovery({ id: ID, endpoints: () => ann.endpoints, port: 0, anySource: true, log: (m) => logs.push(m) });
    const port = await d.listening;
    const asker = dgram.createSocket("udp4");
    await new Promise<void>((r) => asker.bind(0, "127.0.0.1", () => r()));
    const next = () => new Promise<Buffer | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 200);
      asker.once("message", (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    let wait = next();
    asker.send(query(DISCOVERY_SERVICE_TYPE, 12), port, "127.0.0.1");
    const got = await wait;
    expect(got).not.toBeNull();
    expect(records(got!).find((r) => r.type === 33)!.name).toBe(`${ID}.${DISCOVERY_SERVICE_TYPE}`);
    wait = next();
    asker.send(query("_ipp._tcp.local", 12), port, "127.0.0.1");
    expect(await wait).toBeNull();
    asker.close();
    expect(logs.filter((l) => /error|dropped/.test(l))).toEqual([]);
  });

  it("ignores queries from outside the local network", async () => {
    d = startLanDiscovery({ id: ID, endpoints: () => ann.endpoints, port: 0, log: () => {} });
    const port = await d.listening;
    const asker = dgram.createSocket("udp4");
    await new Promise<void>((r) => asker.bind(0, "127.0.0.1", () => r()));
    const got = new Promise<Buffer | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 200);
      asker.once("message", (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    asker.send(query(DISCOVERY_SERVICE_TYPE, 12), port, "127.0.0.1");
    expect(await got).toBeNull(); // loopback is not a LAN address
    asker.close();
  });

  it("does not throw when the port is taken: it logs and carries on", async () => {
    const hog = dgram.createSocket({ type: "udp4", reuseAddr: false });
    await new Promise<void>((r) => hog.bind(0, "0.0.0.0", () => r()));
    const port = (hog.address() as AddressInfo).port;
    const logs: string[] = [];
    d = startLanDiscovery({ id: ID, endpoints: () => ann.endpoints, port, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.some((l) => /not announcing|cannot/.test(l))).toBe(true);
    hog.close();
  });
});

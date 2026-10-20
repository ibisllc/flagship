import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { echoBody, parseProxyHeader, startRelayEcho } from "../src/tunnel/relayEcho.js";

function ask(port: number, prefix: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(Buffer.concat([prefix, Buffer.from("GET /echo HTTP/1.1\r\nhost: x\r\n\r\n")])));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("close", () => resolve(out));
    s.on("error", reject);
  });
}

const v2Sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
function v2Ipv4(dst: number[], dport: number): Buffer {
  const body = Buffer.alloc(12);
  Buffer.from([1, 2, 3, 4]).copy(body, 0);
  Buffer.from(dst).copy(body, 4);
  body.writeUInt16BE(5555, 8);
  body.writeUInt16BE(dport, 10);
  const head = Buffer.alloc(4);
  head[0] = 0x21;
  head[1] = 0x11;
  head.writeUInt16BE(12, 2);
  return Buffer.concat([v2Sig, head, body]);
}

describe("relay echo", () => {
  it("parses a v1 header and leaves the rest", () => {
    const r = parseProxyHeader(Buffer.from("PROXY TCP4 1.2.3.4 149.248.216.86 5555 8444\r\nGET"))!;
    expect(r.header).toEqual({ src: "1.2.3.4", dst: "149.248.216.86", srcPort: 5555, dstPort: 8444 });
    expect(r.length).toBe("PROXY TCP4 1.2.3.4 149.248.216.86 5555 8444\r\n".length);
  });

  it("parses a v2 IPv4 header", () => {
    const r = parseProxyHeader(v2Ipv4([149, 248, 216, 86], 8444))!;
    expect(r.header?.dst).toBe("149.248.216.86");
    expect(r.header?.dstPort).toBe(8444);
  });

  it("waits for more bytes and refuses garbage", () => {
    expect(parseProxyHeader(Buffer.from("PROXY TCP4 1.2"))).toBeNull();
    expect(() => parseProxyHeader(Buffer.from("GET / HTTP/1.1\r\nhost: x\r\n"))).toThrow();
  });

  it("answers the address the PROXY header names", async () => {
    const echo = await startRelayEcho({ port: 0, host: "127.0.0.1" });
    try {
      const out = await ask(echo.port, Buffer.from("PROXY TCP4 1.2.3.4 149.248.216.86 5555 8444\r\n"));
      expect(out).toContain("200 OK");
      expect(JSON.parse(out.split("\r\n\r\n")[1]!)).toEqual({ relay: "flagship.services", reachedAt: "149.248.216.86", reachedPort: 8444 });
      const v2 = await ask(echo.port, v2Ipv4([10, 0, 0, 9], 8444));
      expect(JSON.parse(v2.split("\r\n\r\n")[1]!).reachedAt).toBe("10.0.0.9");
    } finally {
      await echo.close();
    }
  });

  it("says nothing it does not know, and drops a connection with no header", async () => {
    expect(JSON.parse(echoBody(null)).reachedAt).toBeNull();
    const echo = await startRelayEcho({ port: 0, host: "127.0.0.1" });
    try {
      expect(await ask(echo.port, Buffer.alloc(0))).toBe("");
    } finally {
      await echo.close();
    }
  });
});

import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PinningProxy } from "../src/browser/pinningProxy.js";

let origin: Server;
let originPort = 0;
let proxy: PinningProxy;
let proxyPort = 0;
const seen: string[] = [];

beforeAll(async () => {
  origin = createServer((req, res) => {
    seen.push(`${req.headers.host}${req.url}`);
    res.end("hello");
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as { port: number }).port;
  // 127.0.0.1 is where the test origin lives, so the proxy's own refusal list is a different address.
  proxy = new PinningProxy({ forbidden: (a) => a === "169.254.169.254" });
  proxyPort = await proxy.listen();
});
afterAll(async () => {
  await proxy.close();
  origin.close();
});

function connectThrough(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s: Socket = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nhost: ${host}:${port}\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        s.destroy();
        resolve(buf.split("\r\n")[0]!);
      }
    });
    s.on("close", () => resolve(buf.split("\r\n")[0] ?? "closed"));
    s.on("error", () => resolve("error"));
  });
}

function getThrough(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: u.host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

describe("pinning proxy", () => {
  it("connects a host only to the addresses approved for it, whatever DNS would say now", async () => {
    proxy.allow("shop.test", ["127.0.0.1"]);
    const r = await getThrough(`http://shop.test:${originPort}/x`);
    expect(r).toEqual({ status: 200, body: "hello" });
    expect(seen).toContain(`shop.test:${originPort}/x`);
  });

  it("refuses a host nobody approved, and an approval that has lapsed", async () => {
    expect((await getThrough(`http://nobody.test:${originPort}/x`)).status).toBe(403);
    expect(await connectThrough("nobody.test", 443)).toMatch(/403/);
    let t = 0;
    const p2 = new PinningProxy({ forbidden: () => false, now: () => t, ttlMs: 1000 });
    const port2 = await p2.listen();
    p2.allow("late.test", ["127.0.0.1"]);
    t = 5000;
    const status = await new Promise<number>((res) => {
      const r = request({ host: "127.0.0.1", port: port2, path: `http://late.test:${originPort}/`, headers: { host: "late.test" } }, (x) => res(x.statusCode ?? 0));
      r.end();
    });
    expect(status).toBe(403);
    await p2.close();
  });

  it("never connects to an address on its refusal list, even if approved", async () => {
    proxy.allow("meta.test", ["169.254.169.254"]);
    expect(await connectThrough("meta.test", 80)).toMatch(/403/);
    expect((await getThrough("http://meta.test/")).status).toBe(403);
  });

  it("tunnels a CONNECT to the approved address", async () => {
    proxy.allow("secure.test", ["127.0.0.1"]);
    expect(await connectThrough("secure.test", originPort)).toMatch(/200 Connection Established/);
  });
});

import "reflect-metadata";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeLanFetch } from "../src/appCopy/lanFetch.js";
import { selfSigned } from "./helpers/selfSignedTls.js";

const SRC = "home.harry.flagship.services";
const servers: Array<https.Server | net.Server> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      (s as https.Server).closeAllConnections?.();
      return new Promise((r) => s.close(r));
    }),
  );
});

type Answer = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
const fullAnswer: Answer = (_req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(Buffer.from("chunk-bytes"));
};

async function serve(name: string, answer: Answer = fullAnswer) {
  const tls = await selfSigned(name);
  const seen: Array<{ host?: string; sni?: string; body: string }> = [];
  const srv = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ host: req.headers.host, sni: (req.socket as { servername?: string }).servername, body });
      answer(req, res);
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { port: (srv.address() as AddressInfo).port, ca: tls.cert, seen };
}

const init = { method: "POST", headers: { "content-type": "application/json" }, body: '{"part":"image"}' };
const url = `https://${SRC}/api/app-copy/export`;

describe("fetching from the source over the LAN", () => {
  it("connects to the LAN address but speaks TLS and HTTP as the source's own name", async () => {
    const s = await serve(SRC);
    const f = makeLanFetch({ ca: s.ca });
    const res = await f({ address: "127.0.0.1", port: s.port }, url, init);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("chunk-bytes");
    expect(s.seen).toEqual([{ host: SRC, sni: SRC, body: '{"part":"image"}' }]);
    // A second request reuses the kept-alive connection without tripping the connect timer.
    const again = await f({ address: "127.0.0.1", port: s.port }, url, init);
    expect(again.status).toBe(200);
  });

  it("refuses whatever holds that address when it can't prove it is the source", async () => {
    const s = await serve("printer.local");
    const f = makeLanFetch({ ca: s.ca });
    await expect(f({ address: "127.0.0.1", port: s.port }, url, init)).rejects.toThrow(/altnames|hostname|match/i);
    expect(s.seen).toEqual([]);
  });

  it("refuses a server with the right name but a cert nobody vouches for", async () => {
    const s = await serve(SRC);
    const f = makeLanFetch();
    await expect(f({ address: "127.0.0.1", port: s.port }, url, init)).rejects.toThrow(/self[- ]signed|certificate/i);
    expect(s.seen).toEqual([]);
  });

  it("gives up quickly on an address that doesn't answer", async () => {
    const f = makeLanFetch({ connectTimeoutMs: 200 });
    const t0 = Date.now();
    // TEST-NET-1 is never routed, so the connect hangs until the timer.
    await expect(f({ address: "192.0.2.1", port: 443 }, url, init)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("gives up quickly on a listener that accepts but never finishes the handshake", async () => {
    const held: net.Socket[] = [];
    const mute = net.createServer((sock) => held.push(sock));
    servers.push(mute);
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", () => r()));
    const f = makeLanFetch({ connectTimeoutMs: 200 });
    const t0 = Date.now();
    await expect(f({ address: "127.0.0.1", port: (mute.address() as AddressInfo).port }, url, init)).rejects.toThrow(/no answer/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    held.forEach((sock) => sock.destroy());
  });

  it("gives up when the source goes quiet after the handshake (a Wi-Fi drop leaves no reset)", async () => {
    const s = await serve(SRC, () => {});
    const f = makeLanFetch({ ca: s.ca, idleTimeoutMs: 200 });
    const t0 = Date.now();
    await expect(f({ address: "127.0.0.1", port: s.port }, url, init)).rejects.toThrow(/went quiet/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("fails, rather than returning a short chunk, when the connection drops mid-answer", async () => {
    const s = await serve(SRC, (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write(Buffer.alloc(10));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const f = makeLanFetch({ ca: s.ca });
    await expect(f({ address: "127.0.0.1", port: s.port }, url, init)).rejects.toThrow();
  });
});

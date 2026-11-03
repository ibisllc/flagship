/**
 * `/api/rescue/*` answers only through LAN-direct (docs/data-sovereignty.md, "LAN only"): the relay tunnel feeds the
 * same loopback TLS server, so the box tells the two apart by the loopback port the LAN listener connected from,
 * never by anything the client sends.
 */
import https from "node:https";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLanListener, type LanListener } from "../src/lanDirect.js";
import { cameViaLan, ingressPeerPort, LanIngressPorts, refuseRescueOffLan } from "../src/lanIngress.js";
import { _handleHttpConnectionForTest, type HttpRequest } from "../src/runtime.js";
import { listenForFrontend } from "../src/tlsUpstream.js";
import { selfSigned } from "./helpers/selfSignedTls.js";

const ZONE = "home.alice.flagship.services";
const req = (path: string): HttpRequest => ({ method: "POST", path, headers: {}, body: Buffer.alloc(0) });

describe("LanIngressPorts and the rescue gate", () => {
  it("knows a port only while the LAN connection holds it", () => {
    const ports = new LanIngressPorts();
    const forget = ports.add(40_001);
    expect(ports.has(40_001)).toBe(true);
    forget();
    forget();
    expect(ports.has(40_001)).toBe(false);
  });

  it("reads the frontend's peer port first, the socket's own peer only when it is loopback, else nothing", () => {
    expect(ingressPeerPort({ frontendPeerPort: 5, remoteAddress: "127.0.0.1", remotePort: 6 })).toBe(5);
    expect(ingressPeerPort({ remoteAddress: "127.0.0.1", remotePort: 6 })).toBe(6);
    expect(ingressPeerPort({ remoteAddress: "::1", remotePort: 7 })).toBe(7);
    expect(ingressPeerPort({ remoteAddress: "192.168.1.9", remotePort: 6 })).toBeNull();
    expect(ingressPeerPort({})).toBeNull();
    const ports = new LanIngressPorts();
    ports.add(6);
    expect(cameViaLan({ remoteAddress: "127.0.0.1", remotePort: 6 }, ports)).toBe(true);
    expect(cameViaLan({ remoteAddress: "10.0.0.2", remotePort: 6 }, ports)).toBe(false);
  });

  it("answers every rescue path off the LAN with the box's plain 404 and leaves other paths alone", () => {
    for (const p of ["/api/rescue", "/api/rescue/hello", "/api/rescue/archive/x?y=1"]) {
      expect(refuseRescueOffLan(req(p), false), p).toEqual({ status: 404, headers: { "content-type": "text/plain" }, body: "not found" });
      expect(refuseRescueOffLan(req(p), true), p).toBeNull();
    }
    expect(refuseRescueOffLan(req("/api/rescuex"), false)).toBeNull();
    expect(refuseRescueOffLan(req("/api/health"), false)).toBeNull();
  });
});

describe("rescue over real TLS: the relay path is refused, the LAN path works", () => {
  let server: tls.Server;
  let lan: LanListener | null = null;
  let tlsPort = 0;

  beforeEach(async () => {
    const material = await selfSigned(ZONE);
    const ports = new LanIngressPorts();
    // The runtime's composition: decided once per connection, before any request is read.
    server = tls.createServer({ cert: material.cert, key: material.key }, (socket) => {
      const viaLan = cameViaLan(socket, ports);
      _handleHttpConnectionForTest(socket, async (r) => refuseRescueOffLan(r, viaLan) ?? { status: 200, headers: { "content-type": "text/plain" }, body: `rescue:${r.path}` });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    tlsPort = (server.address() as net.AddressInfo).port;
    lan = await startLanListener({ port: 0, backendPort: tlsPort, zone: ZONE, listAddresses: () => ["127.0.0.1"], log: () => {}, lanPorts: ports });
  });
  afterEach(async () => {
    await lan?.close();
    lan = null;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (port: number, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = https.request(
        { host: "127.0.0.1", port, path, method: "POST", servername: ZONE, rejectUnauthorized: false, agent: false, headers: { host: ZONE, ...headers } },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      r.on("error", reject);
      r.end();
    });

  it("a rescue request straight into the TLS server (as the relay tunnel delivers it) is a 404, whatever it claims", async () => {
    expect(await post(tlsPort, "/api/rescue/hello")).toEqual({ status: 404, body: "not found" });
    expect(await post(tlsPort, "/api/rescue/hello", { "x-flagship-ingress": "lan", "x-forwarded-for": "192.168.1.5" })).toEqual({ status: 404, body: "not found" });
    expect(await post(tlsPort, "/api/health")).toEqual({ status: 200, body: "rescue:/api/health" });
  });

  it("the same request through the LAN listener reaches rescue", async () => {
    const lanPort = lan!.endpoints()[0]!.port;
    expect(await post(lanPort, "/api/rescue/hello")).toEqual({ status: 200, body: "rescue:/api/rescue/hello" });
  });
});

describe("rescue behind flagship-ingress: the header's peer port decides", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "lani-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("only a peer port the LAN listener holds counts as LAN; a header without one does not", async () => {
    const ports = new LanIngressPorts();
    ports.add(41_234);
    const seen: boolean[] = [];
    const path = join(dir, "u.sock");
    const server = await listenForFrontend(path, (s) => {
      seen.push(cameViaLan(s as unknown as Parameters<typeof cameViaLan>[0], ports));
      s.destroy();
    });
    const send = (line: string) =>
      new Promise<void>((resolve) => {
        const c = net.connect(path, () => c.write(`${line}\n`));
        c.on("close", () => resolve());
      });
    await send(`{"sni":"${ZONE}","alpn":"http/1.1","tls":"1.3","peer":41234}`);
    await send(`{"sni":"${ZONE}","alpn":"http/1.1","tls":"1.3","peer":41235}`);
    await send(`{"sni":"${ZONE}","alpn":"http/1.1","tls":"1.3"}`);
    await new Promise<void>((r) => server.close(() => r()));
    expect(seen).toEqual([true, false, false]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer, type AddressInfo, type Server } from "node:net";
import { connect as netConnect } from "node:net";
import { startTunnelClient, type TunnelClient } from "@flagship/server-daemon";
import { deriveSTK, deriveSWK } from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startSniRouter, type RunningSniRouter } from "../src/tunnel/sniRouter.js";
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";

/** Build a minimal valid TLS 1.2 ClientHello with the given SNI. */
function buildClientHello(sni: string): Uint8Array {
  const hostBytes = new TextEncoder().encode(sni);
  const nameEntry = concat(new Uint8Array([0]), u16(hostBytes.length), hostBytes);
  const list = concat(u16(nameEntry.length), nameEntry);
  const sniExt = concat(u16(0), u16(list.length), list);
  const extensions = concat(u16(sniExt.length), sniExt);
  const body = concat(
    new Uint8Array([0x03, 0x03]), // TLS 1.2
    new Uint8Array(32),           // random
    new Uint8Array([0]),          // session_id len = 0
    u16(2),
    new Uint8Array([0x00, 0x9c]), // 1 cipher suite
    new Uint8Array([1, 0]),        // 1 compression method = null
    extensions,
  );
  const handshake = concat(new Uint8Array([0x01]), u24(body.length), body);
  return concat(
    new Uint8Array([0x16]),
    new Uint8Array([0x03, 0x01]),
    u16(handshake.length),
    handshake,
  );
}

function u16(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}
function u24(v: number): Uint8Array {
  return new Uint8Array([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

function startEchoBackend(): Promise<{ port: number; received: () => Buffer; close: () => Promise<void>; server: Server }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const server = createServer((sock) => {
      sock.on("data", (chunk) => {
        chunks.push(chunk);
        // Echo upper-cased bytes back.
        const upper = Buffer.from(chunk.toString("binary").toUpperCase(), "binary");
        sock.write(upper);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        received: () => Buffer.concat(chunks),
        close: () => new Promise((r) => server.close(() => r())),
        server,
      });
    });
  });
}

describe("end-to-end tunnel: TCP → SNI router → WS hub → TunnelClient → backend", () => {
  let app: FastifyInstance;
  let registry: TunnelRegistry;
  let stopHub: () => Promise<void>;
  let router: RunningSniRouter;
  let backendPort: number;
  let backendReceived: () => Buffer;
  let backendClose: () => Promise<void>;
  let tunnel: TunnelClient;

  beforeEach(async () => {
    const swk = deriveSWK({ seed: new Uint8Array(32).fill(101) }, "srv-test");
    const stk = deriveSTK(swk);

    registry = new TunnelRegistry();
    app = Fastify({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    stopHub = startTunnelHub(app.server, registry, {
      authLookup: (serverId) => (serverId === "srv-test" ? stk.publicKey : null),
    });
    const hubPort = (app.server.address() as AddressInfo).port;

    router = await startSniRouter(registry, { port: 0, host: "127.0.0.1" });

    const backend = await startEchoBackend();
    backendPort = backend.port;
    backendReceived = backend.received;
    backendClose = backend.close;

    tunnel = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      serverId: "srv-test",
      subdomains: ["*.harry.flagship.services"],
      signingKey: stk,
      resolveBackend: (sni) => {
        if (sni.endsWith(".harry.flagship.services")) {
          return { host: "127.0.0.1", port: backendPort };
        }
        return null;
      },
    });
    await tunnel.ready();
  });

  afterEach(async () => {
    await tunnel.close();
    await router.close();
    await stopHub();
    await app.close();
    await backendClose();
  });

  it("routes a TLS-shaped TCP connection to the registered Flagship server backend", async () => {
    const hello = buildClientHello("photos.harry.flagship.services");
    const trailing = Buffer.from("hello-flagship", "utf8");
    const payload = Buffer.concat([Buffer.from(hello), trailing]);

    const responseChunks: Buffer[] = [];
    const responsePromise = new Promise<Buffer>((resolve) => {
      const client = netConnect(router.port, "127.0.0.1");
      client.on("data", (chunk) => {
        responseChunks.push(chunk);
        const total = Buffer.concat(responseChunks);
        // The backend uppercases everything; once we've seen the uppercased
        // trailing bytes echo back, the round-trip is complete.
        if (total.includes(Buffer.from("HELLO-FLAGSHIP", "utf8"))) {
          client.end();
          resolve(total);
        }
      });
      client.on("error", () => {});
      client.write(payload);
    });

    const response = await responsePromise;
    expect(response.length).toBeGreaterThanOrEqual(payload.length);

    // Backend should have received the original ClientHello prefix and the trailing bytes.
    const received = backendReceived();
    expect(received.length).toBeGreaterThanOrEqual(payload.length);
    expect(received[0]).toBe(0x16); // TLS handshake byte
    expect(received.includes(Buffer.from("hello-flagship", "utf8"))).toBe(true);
  });

  it("rejects an SNI that has no registered tunnel", async () => {
    const hello = buildClientHello("unknown.flagship.services");

    await new Promise<void>((resolve) => {
      const client = netConnect(router.port, "127.0.0.1");
      client.on("error", () => {
        resolve();
      });
      client.on("close", () => {
        resolve();
      });
      client.write(Buffer.from(hello));
    });
    expect(true).toBe(true); // reaching here = connection closed cleanly
  });

  it("rejects a tunnel client whose HELLO signature is from the wrong STK", async () => {
    // Spin up a second hub instance with a STRICT authLookup that only accepts
    // a different STK pubkey, then try to connect with the original STK.
    const otherSwk = deriveSWK({ seed: new Uint8Array(32).fill(202) }, "srv-other");
    const otherStk = deriveSTK(otherSwk);

    const altApp = Fastify({ logger: false });
    const altRegistry = new TunnelRegistry();
    await altApp.listen({ port: 0, host: "127.0.0.1" });
    const altStop = startTunnelHub(altApp.server, altRegistry, {
      authLookup: (sid) => (sid === "srv-test" ? otherStk.publicKey : null),
    });
    const altPort = (altApp.server.address() as AddressInfo).port;

    const wrongSwk = deriveSWK({ seed: new Uint8Array(32).fill(101) }, "srv-test");
    const wrongStk = deriveSTK(wrongSwk);

    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${altPort}/tunnel`,
      serverId: "srv-test",
      subdomains: ["*.harry.flagship.services"],
      signingKey: wrongStk, // does NOT match what authLookup returns
      resolveBackend: () => null,
    });

    await expect(t.ready()).rejects.toThrow();
    await t.close();
    await altStop();
    await altApp.close();
  });

  it("rejects a connection whose ClientHello has no SNI", async () => {
    // ClientHello with empty extensions block.
    const noSni = (() => {
      const body = concat(
        new Uint8Array([0x03, 0x03]),
        new Uint8Array(32),
        new Uint8Array([0]),
        u16(2),
        new Uint8Array([0x00, 0x9c]),
        new Uint8Array([1, 0]),
      );
      const handshake = concat(new Uint8Array([0x01]), u24(body.length), body);
      return concat(
        new Uint8Array([0x16]),
        new Uint8Array([0x03, 0x01]),
        u16(handshake.length),
        handshake,
      );
    })();

    await new Promise<void>((resolve) => {
      const client = netConnect(router.port, "127.0.0.1");
      client.on("error", () => resolve());
      client.on("close", () => resolve());
      client.write(Buffer.from(noSni));
    });
    expect(true).toBe(true);
  });
});

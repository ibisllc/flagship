import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ed, type Keypair } from "@flagship/protocol";
import { acceptSiblingUpgrade } from "../../src/sibling/wsServer.js";
import { openSiblingConnection } from "../../src/sibling/wsClient.js";
import { InMemorySiblingRouter } from "../../src/sibling/router.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const ALICE = "home.alice.flagship.services";
const BOB = "office.alice.flagship.services";

interface SimpleServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Spin up a tiny HTTP server that accepts WS upgrades for
 * /.flagship/sibling-handshake and routes them into the runtime's
 * acceptSiblingUpgrade helper. Used to exercise the full handshake
 * over a real socket pair (plain TCP — no TLS in the test).
 */
async function startResponderHttp(args: {
  myServerId: string;
  myStk: Keypair;
  lookupPeerStk: (id: string) => Promise<Uint8Array | null>;
  router: InMemorySiblingRouter;
}): Promise<SimpleServer> {
  const server: Server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let parsed = false;
    const onData = (chunk: Buffer) => {
      if (parsed) return;
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      parsed = true;
      sock.off("data", onData);
      const headerBlock = buf.subarray(0, sep).toString("utf8");
      const headBuffer = buf.subarray(sep + 4);
      const lines = headerBlock.split(/\r\n/);
      const reqLine = lines[0]?.split(" ") ?? [];
      const method = reqLine[0] ?? "";
      const path = reqLine[1] ?? "/";
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      void method;
      if (path === "/.flagship/sibling-handshake") {
        acceptSiblingUpgrade({
          socket: sock,
          headBuffer,
          headers,
          myServerId: args.myServerId,
          myStk: args.myStk,
          lookupPeerStk: args.lookupPeerStk,
          router: args.router,
          onReady: ({ peerServerId }) => {
            args.router.setSibling({
              siblingId: peerServerId,
              fqdns: [],
              online: true,
              transport: null,
            });
          },
          onClose: ({ peerServerId }) => {
            if (peerServerId) args.router.removeSibling(peerServerId);
          },
        });
        return;
      }
      // Anything else: 404 + close.
      sock.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      sock.end();
    };
    sock.on("data", onData);
    sock.on("error", () => { /* swallow */ });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

describe("sibling WS endpoint + outbound client (end-to-end over real sockets)", () => {
  let responder: SimpleServer | null = null;
  afterEach(async () => {
    if (responder) {
      await responder.close();
      responder = null;
    }
  });

  it("two pods complete a handshake over real sockets and exchange app-messages", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const lookup = async (sid: string) => {
      if (sid === ALICE) return aliceKey.publicKey;
      if (sid === BOB) return bobKey.publicKey;
      return null;
    };
    const aliceRouter = new InMemorySiblingRouter();
    const bobRouter = new InMemorySiblingRouter();

    // Bob is the responder.
    responder = await startResponderHttp({
      myServerId: BOB,
      myStk: bobKey,
      lookupPeerStk: lookup,
      router: bobRouter,
    });

    // Alice initiates.
    const { connection } = await openSiblingConnection({
      peerFqdn: `127.0.0.1:${responder.port}`,
      peerServerId: BOB,
      myServerId: ALICE,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      router: aliceRouter,
      scheme: "ws",
    });

    // Both routers should now know about the other side.
    expect(connection.getPeerServerId()).toBe(BOB);
    // Bob's router learns about Alice on its onReady hook.
    await new Promise((r) => setTimeout(r, 30));
    const bobsView = bobRouter.list().map((s) => s.siblingId);
    expect(bobsView).toContain(ALICE);

    // Send an app-message from Alice → Bob and verify Bob's router routes it.
    const received: Array<{ fromSiblingId: string; payloadHex: string }> = [];
    bobRouter.subscribe("notes", (e) => {
      if (e.kind === "app-message") {
        received.push({ fromSiblingId: e.fromSiblingId, payloadHex: e.payloadHex });
      }
    });
    connection.sendAppMessage({
      appId: "notes",
      fromSiblingId: ALICE,
      toSiblingId: BOB,
      payloadHex: "deadbeef",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([{ fromSiblingId: ALICE, payloadHex: "deadbeef" }]);
    connection.close();
  });
});

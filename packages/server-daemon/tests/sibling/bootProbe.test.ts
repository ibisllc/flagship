import { afterEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import {
  ed,
  signClaimUrlCapability,
  type ClaimUrlCapability,
  type Keypair,
} from "@flagship/protocol";
import { runBootProbe, type ProbeOutcome } from "../../src/sibling/bootProbe.js";
import { acceptSiblingUpgrade } from "../../src/sibling/wsServer.js";
import {
  admitCapability,
  InMemoryCapabilityStore,
} from "../../src/capabilityStore.js";
import { InMemorySiblingRouter } from "../../src/sibling/router.js";
import type { UrlController } from "../../src/runtime.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const ALICE = "home.alice.flagship.services";
const BOB = "office.alice.flagship.services";

interface SimpleServer { port: number; close(): Promise<void>; }

async function startResponder(args: {
  myServerId: string;
  myStk: Keypair;
  lookupPeerStk: (id: string) => Promise<Uint8Array | null>;
  router: InMemorySiblingRouter;
}): Promise<SimpleServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
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
      const path = reqLine[1] ?? "/";
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
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
        });
        return;
      }
      sock.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      sock.end();
    };
    sock.on("data", onData);
    sock.on("error", () => { /* swallow */ });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: () => new Promise<void>((res) => {
      for (const s of sockets) s.destroy();
      server.close(() => res());
    }),
  };
}

function inMemoryUrlController(): UrlController & { _list: Set<string> } {
  const set = new Set<string>();
  return {
    _list: set,
    async claim(f: string) { set.add(f.toLowerCase()); },
    async release(f: string) { set.delete(f.toLowerCase()); },
    list(): string[] { return [...set]; },
  };
}

async function depositCap(
  store: InMemoryCapabilityStore,
  irk: Keypair,
  cap: ClaimUrlCapability,
) {
  const sig = signClaimUrlCapability(cap, irk);
  await admitCapability({
    capability: cap,
    signatureHex: hex(sig),
    irkPubLookup: async () => irk.publicKey,
    store,
    now: () => 1_500,
  });
}

describe("bootProbe", () => {
  let responders: SimpleServer[] = [];
  afterEach(async () => {
    for (const r of responders) await r.close();
    responders = [];
  });

  it("claims a vacant FQDN (nobody answers)", async () => {
    const aliceKey = makeKey();
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await depositCap(store, irk, {
      username: "alice",
      appId: "notes",
      siblingId: ALICE,
      fqdn: "ghost.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const ctrl = inMemoryUrlController();
    const router = new InMemorySiblingRouter();
    const outcomes = await runBootProbe({
      myServerId: ALICE,
      myStk: aliceKey,
      lookupPeerStk: async () => null,
      router,
      urlController: ctrl,
      capabilityStore: store,
      scheme: "ws",
      connectTimeoutMs: 1_500,
    });
    expect(outcomes).toEqual([{ fqdn: "ghost.alice.flagship.services", result: "claimed" }]);
    expect(ctrl._list.has("ghost.alice.flagship.services")).toBe(true);
  });

  it("does NOT claim an FQDN held by an answering sibling — keeps a WS open instead", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const irk = makeKey();
    const lookup = async (sid: string) => {
      if (sid === ALICE) return aliceKey.publicKey;
      if (sid === BOB) return bobKey.publicKey;
      return null;
    };
    const bobRouter = new InMemorySiblingRouter();
    const responder = await startResponder({
      myServerId: BOB,
      myStk: bobKey,
      lookupPeerStk: lookup,
      router: bobRouter,
    });
    responders.push(responder);

    const store = new InMemoryCapabilityStore();
    // Alice has a cap for the FQDN that Bob is currently serving.
    await depositCap(store, irk, {
      username: "alice",
      appId: "notes",
      siblingId: ALICE,
      fqdn: `127.0.0.1:${responder.port}`,
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const ctrl = inMemoryUrlController();
    const aliceRouter = new InMemorySiblingRouter();
    const outcomes = await runBootProbe({
      myServerId: ALICE,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      router: aliceRouter,
      urlController: ctrl,
      capabilityStore: store,
      scheme: "ws",
      connectTimeoutMs: 2_000,
    });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]).toMatchObject({ result: "incumbent", peerServerId: BOB });
    expect(ctrl._list.size).toBe(0); // didn't claim
    // Alice's router records Bob as a live sibling.
    expect(aliceRouter.list().some((s) => s.siblingId === BOB)).toBe(true);
  });

  it("only probes caps that name THIS pod's siblingId", async () => {
    const aliceKey = makeKey();
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    // Cap for some other pod — should be ignored.
    await depositCap(store, irk, {
      username: "alice",
      appId: "notes",
      siblingId: BOB,
      fqdn: "shouldnt-touch.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const ctrl = inMemoryUrlController();
    const outcomes = await runBootProbe({
      myServerId: ALICE,
      myStk: aliceKey,
      lookupPeerStk: async () => null,
      router: new InMemorySiblingRouter(),
      urlController: ctrl,
      capabilityStore: store,
      scheme: "ws",
      connectTimeoutMs: 1_500,
    });
    expect(outcomes).toEqual([]);
    expect(ctrl._list.size).toBe(0);
  });

  it("dedupes when multiple caps cover the same fqdn", async () => {
    const aliceKey = makeKey();
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    const fqdn = "shared.alice.flagship.services";
    for (const appId of ["app-a", "app-b"]) {
      await depositCap(store, irk, {
        username: "alice", appId, siblingId: ALICE, fqdn,
        issuedAt: 1_000, expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
      });
    }
    const ctrl = inMemoryUrlController();
    const outcomes = await runBootProbe({
      myServerId: ALICE,
      myStk: aliceKey,
      lookupPeerStk: async () => null,
      router: new InMemorySiblingRouter(),
      urlController: ctrl,
      capabilityStore: store,
      scheme: "ws",
      connectTimeoutMs: 1_500,
    });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.fqdn).toBe(fqdn);
  });
});

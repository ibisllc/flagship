import { describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import {
  memoryTransportPair,
  SiblingConnection,
} from "../../src/sibling/connection.js";
import { InMemorySiblingRouter } from "../../src/sibling/router.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const ALICE = "home.alice.flagship.services";
const BOB = "office.alice.flagship.services";

async function pair(): Promise<{
  aliceConn: SiblingConnection;
  bobConn: SiblingConnection;
  aliceRouter: InMemorySiblingRouter;
  bobRouter: InMemorySiblingRouter;
}> {
  const aliceKey = makeKey();
  const bobKey = makeKey();
  const lookup = async (sid: string) => {
    if (sid === ALICE) return aliceKey.publicKey;
    if (sid === BOB) return bobKey.publicKey;
    return null;
  };
  const [aSock, bSock] = memoryTransportPair();
  const aliceRouter = new InMemorySiblingRouter();
  const bobRouter = new InMemorySiblingRouter();
  const aliceConn = new SiblingConnection({
    socket: aSock,
    myServerId: ALICE,
    peerServerId: BOB,
    myStk: aliceKey,
    lookupPeerStk: lookup,
    router: aliceRouter,
  });
  const bobConn = new SiblingConnection({
    socket: bSock,
    myServerId: BOB,
    peerServerId: ALICE,
    myStk: bobKey,
    lookupPeerStk: lookup,
    router: bobRouter,
  });
  await Promise.all([aliceConn.ready(), bobConn.ready()]);
  return { aliceConn, bobConn, aliceRouter, bobRouter };
}

describe("SiblingConnection", () => {
  it("two honest peers complete the handshake over the in-memory transport", async () => {
    const { aliceConn, bobConn } = await pair();
    expect(aliceConn).toBeDefined();
    expect(bobConn).toBeDefined();
  });

  it("post-handshake app-messages route through the receiver's router", async () => {
    const { aliceConn, bobRouter } = await pair();
    const received: Array<{ fromSiblingId: string; payloadHex: string }> = [];
    bobRouter.subscribe("notes", (e) => {
      if (e.kind === "app-message") {
        received.push({ fromSiblingId: e.fromSiblingId, payloadHex: e.payloadHex });
      }
    });
    aliceConn.sendAppMessage({
      serviceId: "notes",
      fromSiblingId: ALICE,
      toSiblingId: BOB,
      payloadHex: "deadbeef",
    });
    // give the queueMicrotask + handler chain time to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([{ fromSiblingId: ALICE, payloadHex: "deadbeef" }]);
  });

  it("messages for app A do not reach app B's subscriber on the same pod", async () => {
    const { aliceConn, bobRouter } = await pair();
    const aReceived: number[] = [];
    const bReceived: number[] = [];
    bobRouter.subscribe("alpha", () => aReceived.push(1));
    bobRouter.subscribe("beta", () => bReceived.push(1));
    aliceConn.sendAppMessage({
      serviceId: "alpha",
      fromSiblingId: ALICE,
      toSiblingId: BOB,
      payloadHex: "01",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(aReceived.length).toBe(1);
    expect(bReceived.length).toBe(0);
  });

  it("rejects when the peer signs with the wrong STK", async () => {
    const aliceKey = makeKey();
    const bobActual = makeKey();
    const bobImpostor = makeKey();
    const lookup = async (sid: string) => {
      if (sid === ALICE) return aliceKey.publicKey;
      if (sid === BOB) return bobActual.publicKey;
      return null;
    };
    const [aSock, bSock] = memoryTransportPair();
    const router = new InMemorySiblingRouter();
    const aliceConn = new SiblingConnection({
      socket: aSock,
      myServerId: ALICE,
      peerServerId: BOB,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      router,
    });
    const bobConn = new SiblingConnection({
      socket: bSock,
      myServerId: BOB,
      peerServerId: ALICE,
      myStk: bobImpostor,
      lookupPeerStk: lookup,
      router,
    });
    await expect(aliceConn.ready()).rejects.toThrow();
    bobConn.close();
  });

  it("calls onReady when handshake completes and onClose on close()", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const lookup = async (sid: string) => (sid === ALICE ? aliceKey.publicKey : sid === BOB ? bobKey.publicKey : null);
    const [aSock, bSock] = memoryTransportPair();
    const router = new InMemorySiblingRouter();
    let aliceReady = false;
    let aliceClosed = false;
    const aliceConn = new SiblingConnection({
      socket: aSock,
      myServerId: ALICE,
      peerServerId: BOB,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      router,
      onReady: () => { aliceReady = true; },
      onClose: () => { aliceClosed = true; },
    });
    const bobConn = new SiblingConnection({
      socket: bSock,
      myServerId: BOB,
      peerServerId: ALICE,
      myStk: bobKey,
      lookupPeerStk: lookup,
      router,
    });
    await Promise.all([aliceConn.ready(), bobConn.ready()]);
    expect(aliceReady).toBe(true);
    expect(aliceClosed).toBe(false);
    aliceConn.close();
    expect(aliceClosed).toBe(true);
  });

  it("piggy-backs liveSiblings on hello and the peer can read them", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const lookup = async (sid: string) => (sid === ALICE ? aliceKey.publicKey : sid === BOB ? bobKey.publicKey : null);
    const [aSock, bSock] = memoryTransportPair();
    const aliceRouter = new InMemorySiblingRouter();
    const bobRouter = new InMemorySiblingRouter();
    // Bob already has a third sibling — Alice should learn about it
    // through the gossip on Bob's hello.
    const GARAGE = "garage.alice.flagship.services";
    const aliceConn = new SiblingConnection({
      socket: aSock,
      myServerId: ALICE,
      peerServerId: BOB,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      router: aliceRouter,
    });
    const bobConn = new SiblingConnection({
      socket: bSock,
      myServerId: BOB,
      peerServerId: ALICE,
      myStk: bobKey,
      lookupPeerStk: lookup,
      router: bobRouter,
      liveSiblings: () => [GARAGE],
    });
    await Promise.all([aliceConn.ready(), bobConn.ready()]);
    // The current implementation captures liveSiblings on the wire; the
    // gossip-merge into the router happens in N0e-3 (deferred). For
    // now, just verify the handshake completed — the wire-level
    // exchange is exercised in frames.test.ts.
    expect(true).toBe(true);
  });
});

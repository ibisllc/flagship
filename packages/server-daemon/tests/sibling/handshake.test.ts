import { describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import {
  runHandshakePair,
  SiblingHandshake,
  type SiblingHandshakeOptions,
  type SiblingPeerLookup,
} from "../../src/sibling/handshake.js";
import { encodeSiblingFrame, type SiblingFrame } from "../../src/sibling/frames.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const ALICE = "home.alice.flagship.services";
const BOB = "office.alice.flagship.services";

describe("SiblingHandshake — happy path", () => {
  it("two honest peers reach 'ready' after exchanging signed hellos", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const lookup: SiblingPeerLookup = async (sid) => {
      if (sid === ALICE) return aliceKey.publicKey;
      if (sid === BOB) return bobKey.publicKey;
      return null;
    };
    const { alice, bob } = await runHandshakePair(
      {
        myServerId: ALICE,
        peerServerId: BOB,
        myStk: aliceKey,
        lookupPeerStk: lookup,
        send: () => {},
      },
      {
        myServerId: BOB,
        peerServerId: ALICE,
        myStk: bobKey,
        lookupPeerStk: lookup,
        send: () => {},
      },
    );
    expect(alice.getStatus().state).toBe("ready");
    expect(bob.getStatus().state).toBe("ready");
  });
});

describe("SiblingHandshake — adversarial rejections", () => {
  it("rejects when the peer signs with the WRONG STK", async () => {
    const aliceKey = makeKey();
    const bobActual = makeKey();
    const bobImpostor = makeKey();
    const lookup: SiblingPeerLookup = async (sid) => {
      if (sid === ALICE) return aliceKey.publicKey;
      // Lookup returns Bob's REGISTERED key, but the impostor signs with theirs.
      if (sid === BOB) return bobActual.publicKey;
      return null;
    };
    let aliceSend!: (f: SiblingFrame) => void;
    let bobSend!: (f: SiblingFrame) => void;
    const aliceOpts: SiblingHandshakeOptions = {
      myServerId: ALICE,
      peerServerId: BOB,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      send: (f) => bobSend(f),
    };
    const bobOpts: SiblingHandshakeOptions = {
      myServerId: BOB,
      peerServerId: ALICE,
      myStk: bobImpostor, // wrong key
      lookupPeerStk: lookup,
      send: (f) => aliceSend(f),
    };
    const aliceHs = new SiblingHandshake(aliceOpts);
    const bobHs = new SiblingHandshake(bobOpts);
    aliceSend = (f) => void aliceHs.ingest(encodeSiblingFrame(f));
    bobSend = (f) => void bobHs.ingest(encodeSiblingFrame(f));
    aliceHs.start();
    bobHs.start();
    await expect(aliceHs.ready()).rejects.toThrow(/peer signature/);
  });

  it("rejects when the peer is not registered with .com", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const lookup: SiblingPeerLookup = async (sid) => {
      if (sid === ALICE) return aliceKey.publicKey;
      // Bob is unknown to .com — registry lookup returns null.
      return null;
    };
    let aliceSend!: (f: SiblingFrame) => void;
    let bobSend!: (f: SiblingFrame) => void;
    const aliceOpts: SiblingHandshakeOptions = {
      myServerId: ALICE,
      peerServerId: BOB,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      send: (f) => bobSend(f),
    };
    const bobOpts: SiblingHandshakeOptions = {
      myServerId: BOB,
      peerServerId: ALICE,
      myStk: bobKey,
      lookupPeerStk: lookup,
      send: (f) => aliceSend(f),
    };
    const aliceHs = new SiblingHandshake(aliceOpts);
    const bobHs = new SiblingHandshake(bobOpts);
    aliceSend = (f) => void aliceHs.ingest(encodeSiblingFrame(f));
    bobSend = (f) => void bobHs.ingest(encodeSiblingFrame(f));
    aliceHs.start();
    bobHs.start();
    await expect(aliceHs.ready()).rejects.toThrow(/not registered/);
  });

  it("rejects when the peer claims a different serverId than expected", async () => {
    const aliceKey = makeKey();
    const bobKey = makeKey();
    const carolKey = makeKey();
    const CAROL = "garage.alice.flagship.services";
    const lookup: SiblingPeerLookup = async (sid) => {
      if (sid === ALICE) return aliceKey.publicKey;
      if (sid === BOB) return bobKey.publicKey;
      if (sid === CAROL) return carolKey.publicKey;
      return null;
    };
    // Alice expects to talk to BOB; the connection actually wires up to CAROL.
    let aliceSend!: (f: SiblingFrame) => void;
    let carolSend!: (f: SiblingFrame) => void;
    const aliceOpts: SiblingHandshakeOptions = {
      myServerId: ALICE,
      peerServerId: BOB,
      myStk: aliceKey,
      lookupPeerStk: lookup,
      send: (f) => carolSend(f),
    };
    const carolOpts: SiblingHandshakeOptions = {
      myServerId: CAROL,
      peerServerId: ALICE,
      myStk: carolKey,
      lookupPeerStk: lookup,
      send: (f) => aliceSend(f),
    };
    const aliceHs = new SiblingHandshake(aliceOpts);
    const carolHs = new SiblingHandshake(carolOpts);
    aliceSend = (f) => void aliceHs.ingest(encodeSiblingFrame(f));
    carolSend = (f) => void carolHs.ingest(encodeSiblingFrame(f));
    aliceHs.start();
    carolHs.start();
    await expect(aliceHs.ready()).rejects.toThrow(/serverId mismatch/);
  });
});

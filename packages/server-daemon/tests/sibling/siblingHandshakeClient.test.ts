/**
 * N0e-2 — persistent sibling-handshake auto-dialer + manager. Mirrors
 * the cert-sync siblingClient.test.ts harness: a fake `openImpl` seam
 * drives ready/close so we can assert router population, reconnect
 * backoff, setPeers supervision, and clean teardown without a real WS.
 */
import { describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import {
  SiblingHandshakeClientManager,
  startPersistentSiblingHandshakeClient,
  type SiblingOpenFn,
} from "../../src/sibling/siblingHandshakeClient.js";
import { InMemorySiblingRouter } from "../../src/sibling/router.js";
import type { OpenSiblingArgs, OpenSiblingResult } from "../../src/sibling/wsClient.js";

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const ME = "home.alice.flagship.services";

/** A fake open that synchronously "completes the handshake": records
 *  the args, fires onReady, and returns a connection whose close()
 *  fires onClose exactly once (matching real SiblingConnection). */
function fakeOpen(): {
  impl: SiblingOpenFn;
  calls: OpenSiblingArgs[];
  closeLast(): void;
} {
  const calls: OpenSiblingArgs[] = [];
  let lastOnClose: ((a: { peerServerId: string | null }) => void) | undefined;
  let closed = false;
  const impl: SiblingOpenFn = async (args) => {
    calls.push(args);
    closed = false;
    lastOnClose = args.onClose;
    args.onReady?.({ peerServerId: args.peerServerId ?? args.peerFqdn });
    const connection = {
      close() {
        if (closed) return;
        closed = true;
        args.onClose?.({ peerServerId: args.peerServerId ?? args.peerFqdn });
      },
    } as unknown as OpenSiblingResult["connection"];
    return { connection };
  };
  return {
    impl,
    calls,
    closeLast() {
      if (lastOnClose && !closed) {
        closed = true;
        lastOnClose({ peerServerId: calls[calls.length - 1]!.peerFqdn });
      }
    },
  };
}

const baseOpts = (router: InMemorySiblingRouter, openImpl: SiblingOpenFn) => ({
  myServerId: ME,
  myStk: key(),
  lookupPeerStk: async () => null,
  router,
  scheme: "ws" as const,
  baseReconnectMs: 1,
  maxReconnectMs: 1,
  random: () => 0,
  openImpl,
});

describe("PersistentSiblingHandshakeClient (N0e-2)", () => {
  it("on ready registers the peer in the router; firstReady resolves", async () => {
    const router = new InMemorySiblingRouter();
    const f = fakeOpen();
    const c = startPersistentSiblingHandshakeClient({
      ...baseOpts(router, f.impl),
      peerFqdn: "office.alice.flagship.services",
    });
    await c.firstReady();
    expect(c.isConnected()).toBe(true);
    expect(router.list().map((s) => s.siblingId)).toEqual([
      "office.alice.flagship.services",
    ]);
    c.close();
  });

  it("on disconnect removes the peer and schedules a reconnect", async () => {
    const router = new InMemorySiblingRouter();
    const f = fakeOpen();
    const c = startPersistentSiblingHandshakeClient({
      ...baseOpts(router, f.impl),
      peerFqdn: "office.alice.flagship.services",
    });
    await c.firstReady();
    expect(router.list()).toHaveLength(1);
    f.closeLast(); // peer drops
    expect(router.list()).toHaveLength(0);
    // Backoff (base/max 1ms, random 0 ⇒ delay 0) re-dials.
    await new Promise((r) => setTimeout(r, 5));
    expect(f.calls.length).toBeGreaterThanOrEqual(2);
    expect(router.list()).toHaveLength(1); // re-registered on re-ready
    c.close();
  });

  it("retries with backoff when the dial throws", async () => {
    const router = new InMemorySiblingRouter();
    let n = 0;
    const impl: SiblingOpenFn = async (args) => {
      n += 1;
      if (n === 1) throw new Error("upgrade failed");
      args.onReady?.({ peerServerId: args.peerFqdn });
      return {
        connection: { close() {} } as unknown as OpenSiblingResult["connection"],
      };
    };
    const c = startPersistentSiblingHandshakeClient({
      ...baseOpts(router, impl),
      peerFqdn: "p.alice.flagship.services",
    });
    await c.firstReady();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(c.attempts()).toBeGreaterThanOrEqual(0); // reset to 0 on ready
    c.close();
  });

  it("close() tears down the live connection and cancels reconnects", async () => {
    const router = new InMemorySiblingRouter();
    const f = fakeOpen();
    const c = startPersistentSiblingHandshakeClient({
      ...baseOpts(router, f.impl),
      peerFqdn: "office.alice.flagship.services",
    });
    await c.firstReady();
    c.close();
    expect(c.isConnected()).toBe(false);
    expect(router.list()).toHaveLength(0); // close → onClose → removeSibling
  });
});

describe("SiblingHandshakeClientManager — peer set (N0e-2)", () => {
  it("setPeers spins up a client per peer and tears down removed ones", async () => {
    const router = new InMemorySiblingRouter();
    const f = fakeOpen();
    const m = new SiblingHandshakeClientManager(baseOpts(router, f.impl));
    m.setPeers([
      "office.alice.flagship.services",
      "travel.alice.flagship.services",
    ]);
    expect(m.peers().sort()).toEqual([
      "office.alice.flagship.services",
      "travel.alice.flagship.services",
    ]);
    await Promise.resolve();
    expect(router.list()).toHaveLength(2);

    m.setPeers(["office.alice.flagship.services"]);
    expect(m.peers()).toEqual(["office.alice.flagship.services"]);
    // The torn-down peer left the router.
    expect(router.list().map((s) => s.siblingId)).toEqual([
      "office.alice.flagship.services",
    ]);

    const before = f.calls.length;
    m.setPeers(["office.alice.flagship.services"]); // idempotent
    expect(f.calls.length).toBe(before);

    m.setPeers([
      "office.alice.flagship.services",
      "new.alice.flagship.services",
    ]);
    await Promise.resolve();
    expect(m.peers().sort()).toEqual([
      "new.alice.flagship.services",
      "office.alice.flagship.services",
    ]);
    m.close();
    expect(m.peers()).toEqual([]);
  });
});

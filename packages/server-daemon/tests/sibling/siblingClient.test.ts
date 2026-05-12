import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { ed, type Bytes, type Keypair, type PodIdentityBinding } from "@flagship/protocol";
import {
  SiblingClientManager,
  startPersistentSiblingClient,
  type WsLike,
} from "../../src/sibling/siblingClient.js";
import {
  InMemoryAppGrantStore,
  mintTestBinding,
} from "../../src/sibling/syncConnection.js";

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const USER = "alice";
const ME = "home.alice.flagship.services";

class FakeWs extends EventEmitter implements WsLike {
  static OPEN_STATE = 1 as const;
  static CLOSED_STATE = 3 as const;
  readyState: number = FakeWs.OPEN_STATE;
  binaryType = "arraybuffer";
  closed = false;
  sent: Uint8Array[] = [];
  pingCount = 0;
  readonly OPEN = FakeWs.OPEN_STATE;
  constructor(public url: string) {
    super();
  }
  send(data: Uint8Array): void {
    if (!this.closed) this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWs.CLOSED_STATE;
    queueMicrotask(() => this.emit("close"));
  }
  ping(): void {
    this.pingCount += 1;
  }
}

describe("SiblingClientManager — peer set tracking (#86)", () => {
  it("setPeers spins up a client per peer and tears it down when removed", () => {
    const irk = key();
    const myId = key();
    const binding = mintTestBinding({
      irk,
      username: USER,
      podIdentityPubKey: myId.publicKey,
      serverDomain: ME,
    });
    const created: FakeWs[] = [];
    const m = new SiblingClientManager({
      myServerDomain: ME,
      myIdentity: myId,
      username: USER,
      myBinding: binding.binding as PodIdentityBinding,
      myBindingSignature: binding.signature as Bytes,
      lookupIrk: async () => irk.publicKey,
      revocations: async () => new Set<string>(),
      store: new InMemoryAppGrantStore(),
      scheme: "ws",
      // Disable backoff jitter for determinism.
      baseReconnectMs: 1,
      maxReconnectMs: 1,
      random: () => 0,
      wsFactory: (url) => {
        const ws = new FakeWs(url);
        created.push(ws);
        return ws;
      },
    });
    m.setPeers([
      "office.alice.flagship.services",
      "travel.alice.flagship.services",
    ]);
    expect(m.peers().sort()).toEqual([
      "office.alice.flagship.services",
      "travel.alice.flagship.services",
    ]);
    expect(created).toHaveLength(2);

    // Remove one peer — no re-issuance, no remint; just stop syncing.
    m.setPeers(["office.alice.flagship.services"]);
    expect(m.peers()).toEqual(["office.alice.flagship.services"]);
    // The torn-down WS is closed.
    const torn = created.find(
      (ws) => ws.url.includes("travel.alice.flagship.services"),
    );
    expect(torn?.closed).toBe(true);

    // Adding a fresh peer creates a NEW client.
    m.setPeers([
      "office.alice.flagship.services",
      "new.alice.flagship.services",
    ]);
    expect(created.length).toBe(3);
    m.close();
  });

  it("setPeers is idempotent — re-asserting the same set is a no-op", () => {
    const irk = key();
    const myId = key();
    const binding = mintTestBinding({
      irk,
      username: USER,
      podIdentityPubKey: myId.publicKey,
      serverDomain: ME,
    });
    const created: FakeWs[] = [];
    const m = new SiblingClientManager({
      myServerDomain: ME,
      myIdentity: myId,
      username: USER,
      myBinding: binding.binding as PodIdentityBinding,
      myBindingSignature: binding.signature as Bytes,
      lookupIrk: async () => irk.publicKey,
      revocations: async () => new Set<string>(),
      store: new InMemoryAppGrantStore(),
      scheme: "ws",
      baseReconnectMs: 1,
      maxReconnectMs: 1,
      random: () => 0,
      wsFactory: (url) => {
        const ws = new FakeWs(url);
        created.push(ws);
        return ws;
      },
    });
    m.setPeers(["office.alice.flagship.services"]);
    m.setPeers(["office.alice.flagship.services"]); // no churn
    m.setPeers(["office.alice.flagship.services"]);
    expect(created).toHaveLength(1);
    m.close();
  });

  it("dial failures schedule a reconnect — supervisor never gives up", async () => {
    const irk = key();
    const myId = key();
    const binding = mintTestBinding({
      irk,
      username: USER,
      podIdentityPubKey: myId.publicKey,
      serverDomain: ME,
    });
    const dialed: string[] = [];
    const client = startPersistentSiblingClient({
      myServerDomain: ME,
      myIdentity: myId,
      username: USER,
      myBinding: binding.binding as PodIdentityBinding,
      myBindingSignature: binding.signature as Bytes,
      lookupIrk: async () => irk.publicKey,
      revocations: async () => new Set<string>(),
      store: new InMemoryAppGrantStore(),
      peerDomain: "office.alice.flagship.services",
      scheme: "ws",
      baseReconnectMs: 1,
      maxReconnectMs: 1,
      random: () => 0,
      wsFactory: (url) => {
        dialed.push(url);
        throw new Error("connection refused");
      },
    });
    // The factory throws synchronously → schedules a reconnect.
    await new Promise((r) => setTimeout(r, 10));
    expect(dialed.length).toBeGreaterThan(1);
    expect(client.attempts()).toBeGreaterThan(1);
    client.close();
  });
});

/**
 * startTunnelClient must surface the hub's relay-trust attachment on an
 * accepting HELLO_ACK (task #5): it invokes onHelloAckTrust with the
 * presented blessing + hubSig + the box's HELLO nonce, and ALWAYS resolves
 * ready() (OBSERVE — the trust hook never gates the tunnel). A throwing
 * hook must not wedge the tunnel.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  encodeFrame,
  helloAckFrame,
  type Frame,
} from "@flagship/tunnel-protocol";
import {
  startTunnelClient,
  type TunnelClientOptions,
  type TunnelWebSocketLike,
  type WebSocketFactory,
} from "../src/tunnel/tunnelClient.js";

class FakeWS extends EventEmitter implements TunnelWebSocketLike {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWS.OPEN;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  close(): void {
    this.readyState = FakeWS.CLOSED;
    this.emit("close");
  }
  send(data: Uint8Array | string): void {
    if (typeof data !== "string") this.sent.push(data);
  }
  ping(): void {}
}

function factoryFor(ws: FakeWS): WebSocketFactory {
  return Object.assign(((_url: string) => ws) as (url: string) => TunnelWebSocketLike, {
    OPEN: FakeWS.OPEN,
    CLOSED: FakeWS.CLOSED,
  });
}

function commonOpts(): TunnelClientOptions {
  return {
    hubUrl: "wss://hub.example/tunnel",
    signingKey: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) },
    getEntitlements: async () => ({
      rootEntitlement: {
        username: "alice",
        podPubKey: new Uint8Array(32),
        podCanonical: "home.alice.flagship.services",
        issuedAt: 0,
      },
      rootEntitlementSig: new Uint8Array(64),
    }),
    resolveBackend: () => ({ host: "127.0.0.1", port: 8443 }),
  };
}

function ackWithTrust(): Frame {
  return helloAckFrame(true, undefined, {
    serviceBlessing: { kind: "ServiceBlessing", hubKeyPub: "ab".repeat(32) },
    hubSig: "cd".repeat(64),
  });
}

describe("startTunnelClient — relay-trust on HELLO_ACK", () => {
  it("delivers blessing + hubSig + nonce, and still resolves ready (OBSERVE)", async () => {
    const ws = new FakeWS();
    const seen: { serviceBlessing: unknown; hubSig?: string; nonce: Uint8Array }[] = [];
    const client = startTunnelClient({
      ...commonOpts(),
      wsFactory: factoryFor(ws),
      onHelloAckTrust: (e) => seen.push(e),
    });
    ws.emit("open");
    await new Promise((r) => setTimeout(r, 0)); // let sendHello() run + set nonce
    ws.emit("message", encodeFrame(ackWithTrust()).buffer);
    await client.ready();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.hubSig).toBe("cd".repeat(64));
    expect((seen[0]!.serviceBlessing as { hubKeyPub: string }).hubKeyPub).toBe("ab".repeat(32));
    // The nonce is the 32-byte HELLO nonce the client generated.
    expect(seen[0]!.nonce.length).toBe(32);
    await client.close();
  });

  it("an old hub (no trust fields) still resolves ready; hook sees undefined fields", async () => {
    const ws = new FakeWS();
    const seen: { serviceBlessing: unknown; hubSig?: string }[] = [];
    const client = startTunnelClient({
      ...commonOpts(),
      wsFactory: factoryFor(ws),
      onHelloAckTrust: (e) => seen.push(e),
    });
    ws.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    ws.emit("message", encodeFrame(helloAckFrame(true)).buffer);
    await client.ready();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.serviceBlessing).toBeUndefined();
    expect(seen[0]!.hubSig).toBeUndefined();
    await client.close();
  });

  it("a throwing trust hook does not wedge the tunnel (still ready)", async () => {
    const ws = new FakeWS();
    const client = startTunnelClient({
      ...commonOpts(),
      wsFactory: factoryFor(ws),
      onHelloAckTrust: () => {
        throw new Error("boom");
      },
    });
    ws.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    ws.emit("message", encodeFrame(ackWithTrust()).buffer);
    await expect(client.ready()).resolves.toBeUndefined();
    await client.close();
  });

  it("does not fire the hook on a REJECTING ack (only on accept)", async () => {
    const ws = new FakeWS();
    const seen: unknown[] = [];
    const client = startTunnelClient({
      ...commonOpts(),
      wsFactory: factoryFor(ws),
      onHelloAckTrust: (e) => seen.push(e),
    });
    ws.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    ws.emit("message", encodeFrame(helloAckFrame(false, "nope")).buffer);
    await expect(client.ready()).rejects.toThrow(/nope/);
    expect(seen).toHaveLength(0);
    await client.close();
  });
});

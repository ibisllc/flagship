import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { ServingGate } from "../src/tunnel/servingGate.js";
import { ServingFeedClient } from "../src/tunnel/servingFeedClient.js";
import { comRecord, edKey, revocation } from "./support/serving.js";

const SECRET = "control-secret";

/** A stand-in for `.com`'s ServingFeed: records what relays send and lets the test push frames. */
async function fakeFeed() {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets: WebSocket[] = [];
  const received: Array<Record<string, unknown>> = [];
  const upgrades: Array<{ url: string; auth: string | undefined }> = [];
  http.on("upgrade", (req, socket, head) => {
    upgrades.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (m) => received.push(JSON.parse(m.toString())));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    sockets,
    received,
    upgrades,
    push(frame: unknown) {
      for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify(frame));
    },
    async close() {
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ServingFeedClient", () => {
  let feed: Awaited<ReturnType<typeof fakeFeed>> | undefined;
  let client: ServingFeedClient | undefined;
  afterEach(async () => {
    client?.stop();
    await feed?.close();
    client = undefined;
    feed = undefined;
  });

  it("says hello from 0, applies revocations in order, acks, and ends a revoked box's tunnel", async () => {
    feed = await fakeFeed();
    const rk = edKey();
    const admin = edKey();
    const box = edKey().pub;
    const gate = new ServingGate({ fetchRecord: async () => comRecord({ adminKey: admin.pub }) });
    const closed: string[] = [];
    await gate.attach(
      { username: "alice", boxPub: box, podCanonical: "home.alice.flagship.services", adminKey: admin.pub, policy: null },
      { closeTunnel: (_c, r) => closed.push(r), closeAppStreams: () => undefined, onAppsChanged: () => undefined },
    );
    client = new ServingFeedClient({ comBaseUrl: feed.base, secret: SECRET, relayId: "iad-1", revocationKey: rk.pub, gate });
    client.start();
    await waitFor(() => feed!.received.length >= 1);
    expect(feed.upgrades[0]!.url).toBe("/api/internal/serving-feed?relay=iad-1");
    expect(feed.received[0]).toEqual({ type: "hello", since: 0 });

    feed.push({ type: "revocation", ...revocation(1, "alice", edKey().pub, rk) });
    feed.push({ type: "revocation", ...revocation(2, "alice", box, rk) });
    await waitFor(() => feed!.received.some((f) => f.type === "ack" && f.sequence === 2));
    expect(gate.revocations.sequence).toBe(2);
    expect(closed).toEqual(["revoked"]);
  });

  it("fills a gap from serving-revocations?since and refuses an entry the pinned key did not sign", async () => {
    feed = await fakeFeed();
    const rk = edKey();
    const gate = new ServingGate({ fetchRecord: async () => null });
    const asked: number[] = [];
    const log = [1, 2, 3].map((n) => revocation(n, "alice", edKey().pub, rk));
    client = new ServingFeedClient({
      comBaseUrl: feed.base,
      secret: SECRET,
      relayId: "r",
      revocationKey: rk.pub,
      gate,
      revocationsSince: async (since) => {
        asked.push(since);
        return { entries: log.filter((e) => e.entry.sequence > since), sequence: 3 };
      },
    });
    client.start();
    await waitFor(() => feed!.sockets.length === 1 && feed!.received.length >= 1);
    feed.push({ type: "revocation", ...log[2]! });
    await waitFor(() => gate.revocations.sequence === 3);
    expect(asked).toEqual([0]);
    expect(gate.stats().feed).toEqual({ sequence: 3, latest: 3, lag: 0 });

    const forged = revocation(4, "alice", edKey().pub, edKey());
    feed.push({ type: "revocation", ...forged });
    await waitFor(() => client!.stats().badEntries === 1);
    expect(gate.revocations.sequence).toBe(3);
  });

  it("a beat ahead of what it holds reads the missing entries", async () => {
    feed = await fakeFeed();
    const rk = edKey();
    const gate = new ServingGate({ fetchRecord: async () => null });
    const log = [revocation(1, "alice", edKey().pub, rk)];
    client = new ServingFeedClient({
      comBaseUrl: feed.base,
      secret: SECRET,
      relayId: "r",
      revocationKey: rk.pub,
      gate,
      revocationsSince: async () => ({ entries: log, sequence: 1 }),
    });
    client.start();
    await waitFor(() => feed!.received.length >= 1);
    feed.push({ type: "beat", sequence: 1 });
    await waitFor(() => gate.revocations.sequence === 1);
  });

  it("every frame is contact; it reconnects after the feed drops and says hello from where it is", async () => {
    feed = await fakeFeed();
    const rk = edKey();
    let now = 0;
    const gate = new ServingGate({ fetchRecord: async () => null, now: () => now });
    client = new ServingFeedClient({
      comBaseUrl: feed.base,
      secret: SECRET,
      relayId: "r",
      revocationKey: rk.pub,
      gate,
      initialBackoffMs: 20,
    });
    client.start();
    await waitFor(() => feed!.received.length >= 1);
    now = 59_000;
    feed.push({ type: "revocation", ...revocation(1, "alice", edKey().pub, rk) });
    await waitFor(() => gate.revocations.sequence === 1);
    now = 100_000;
    expect(gate.acceptingNewTunnels()).toBe(true); // 41 s since the last frame

    for (const s of feed.sockets) s.close();
    await waitFor(() => feed!.sockets.length === 2 && feed!.received.filter((f) => f.type === "hello").length === 2);
    expect(feed.received.filter((f) => f.type === "hello")[1]).toEqual({ type: "hello", since: 1 });
    now = 200_000;
    expect(gate.acceptingNewTunnels()).toBe(false);
    feed.push({ type: "beat", sequence: 1 });
    await waitFor(() => gate.acceptingNewTunnels());
  });

  it("a changed frame re-reads that box from .com", async () => {
    feed = await fakeFeed();
    const admin = edKey();
    const box = edKey().pub;
    let reads = 0;
    const gate = new ServingGate({
      fetchRecord: async () => {
        reads += 1;
        return comRecord({ adminKey: admin.pub });
      },
    });
    await gate.attach(
      { username: "alice", boxPub: box, podCanonical: "home.alice.flagship.services", adminKey: admin.pub, policy: null },
      { closeTunnel: () => undefined, closeAppStreams: () => undefined, onAppsChanged: () => undefined },
    );
    client = new ServingFeedClient({ comBaseUrl: feed.base, secret: SECRET, relayId: "r", revocationKey: edKey().pub, gate });
    client.start();
    await waitFor(() => feed!.received.length >= 1);
    feed.push({ type: "changed", username: "alice", boxPub: box });
    await waitFor(() => reads === 2);
  });
});

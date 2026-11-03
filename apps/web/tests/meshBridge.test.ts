/**
 * Bridges (relay-mesh.md §6): the handshake (both sides check the blessing, the directory, the log and the signature
 * over both nonces and both ids, with the §6.2 close codes), the null-blessing restart path, and the stream mux:
 * 70 KB each way verbatim under stream credit, closes both ways, and the `hop` refusal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { ed, openBridgeText, type RelayBlessing } from "@flagship/protocol";
import { encodeFrame, FRAME_OPEN } from "@flagship/tunnel-protocol";
import { acceptorHandshake, BridgeManager, type BridgePeer, type BridgeStream, type HandshakeContext } from "../src/tunnel/mesh/bridge.js";
import { MeshDirectory } from "../src/tunnel/mesh/directory.js";
import { MeshFeed } from "../src/tunnel/mesh/feed.js";
import { APEX, MeshFixture, type FixtureRelay } from "./support/meshFixture.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function ctxFor(fx: MeshFixture, r: FixtureRelay, o: { blessing?: RelayBlessing | null; dir?: MeshDirectory } = {}): Promise<HandshakeContext & { dir: MeshDirectory; feed: MeshFeed }> {
  const dir = o.dir ?? new MeshDirectory({ servicesApex: APEX, caKeys: () => [fx.caPub] });
  dir.offerFile({ directory: fx.directory, blessings: [] });
  const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
  await feed.poll();
  const blessing = o.blessing === undefined ? fx.blessings.get(r.relayId)! : o.blessing;
  return {
    selfRelayId: r.relayId,
    sign: (m) => ed.sign(m, r.key.privateKey),
    blessing: () => blessing,
    heldBlessing: (id) => dir.heldBlessing(id),
    caKeys: () => [fx.caPub],
    checkContext: () => ({ servicesApex: APEX, log: feed.state, directory: dir.current, now: Date.now() }),
    now: () => Date.now(),
    dir,
    feed,
  };
}

interface Side {
  mgr: BridgeManager;
  port: number;
  opened: BridgeStream[];
  ups: BridgePeer[];
}

async function side(fx: MeshFixture, r: FixtureRelay, ports: Map<string, number>, ctx: HandshakeContext, peers: string[]): Promise<Side> {
  const http: Server = createServer();
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", () => res()));
  const port = (http.address() as AddressInfo).port;
  ports.set(r.relayId, port);
  const s: Side = { mgr: null as unknown as BridgeManager, port, opened: [], ups: [] };
  s.mgr = new BridgeManager({
    ...ctx,
    peers: () => peers.map((id) => ({ relayId: id, tunnelHost: `${id}.tunnel.${APEX}` })),
    peerUrl: (p) => `ws://127.0.0.1:${ports.get(p.relayId)}/mesh`,
    handler: {
      onControl: () => undefined,
      onOpen: (_p, st) => {
        s.opened.push(st);
        // Echo the stream back, uppercase-free: the bytes verbatim.
        st.on("data", (c: Buffer) => st.write(c));
        st.on("end", () => st.end());
      },
      onUp: (p) => s.ups.push(p),
      onDown: () => undefined,
    },
  });
  const detach = s.mgr.attach(http);
  cleanup.push(async () => {
    detach();
    await s.mgr.stop();
    http.closeAllConnections?.();
    await new Promise<void>((res) => http.close(() => res()));
  });
  return s;
}

function fixture() {
  const fx = new MeshFixture();
  const ra = fx.addRelay("ra");
  const rb = fx.addRelay("rb");
  fx.mintDirectory();
  return { fx, ra, rb };
}

describe("bridges", () => {
  it("the smaller id dials, both sides authenticate, and a stream carries 70 KB each way verbatim under credit", async () => {
    const { fx, ra, rb } = fixture();
    const ports = new Map<string, number>();
    const a = await side(fx, ra, ports, await ctxFor(fx, ra), ["rb"]);
    const b = await side(fx, rb, ports, await ctxFor(fx, rb), ["ra"]);
    a.mgr.start(100);
    b.mgr.start(100);
    await expect.poll(() => a.mgr.peer("rb") !== null && b.mgr.peer("ra") !== null, { timeout: 5_000 }).toBe(true);
    expect(a.mgr.peer("rb")!.role).toBe("client");
    expect(b.mgr.peer("ra")!.role).toBe("server");
    const s = a.mgr.peer("rb")!.open(`home.alice.${APEX}`, "tls")!;
    expect(s.id % 2).toBe(1);
    const payload = Buffer.alloc(70 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const got: Buffer[] = [];
    s.on("data", (c: Buffer) => got.push(c));
    s.write(payload);
    await expect.poll(() => Buffer.concat(got).length, { timeout: 5_000 }).toBe(payload.length);
    expect(Buffer.concat(got).equals(payload)).toBe(true);
    expect(b.opened[0]!.sni).toBe(`home.alice.${APEX}`);
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    s.end();
    await closed;
    await expect.poll(() => b.mgr.peer("ra")!.streamCount(), { timeout: 2_000 }).toBe(0);
  });

  it("refuses with 4401 and the reason: a key not in the directory, an unblessed relay, the wrong peer", async () => {
    const { fx, ra, rb } = fixture();
    const ports = new Map<string, number>();
    const rogue = fx.addRelay("rz");
    // rz is blessed but not in the directory.
    fx.blessings.set("rz", fx.bless(rogue));
    const bCtx = await ctxFor(fx, rb);
    await side(fx, rb, ports, bCtx, []);
    const zCtx = await ctxFor(fx, rogue);
    const closeOf = async (ctx: HandshakeContext, expectPeer: string): Promise<{ code: number; reason: string }> => {
      const { dialerHandshake, HandshakeQueue } = await import("../src/tunnel/mesh/bridge.js");
      const ws = new WebSocket(`ws://127.0.0.1:${ports.get("rb")}/mesh`);
      const q = new HandshakeQueue(ws);
      const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
      ws.on("error", () => undefined);
      await new Promise<void>((r) => ws.on("open", () => r()));
      void dialerHandshake(ws, expectPeer, ctx, 5_000, q);
      return closed;
    };
    expect(await closeOf(zCtx, "rb")).toEqual({ code: 4401, reason: "not-in-directory" });
    // ra with no blessing, and nothing held for it on rb: bad-blessing.
    const unblessed = await ctxFor(fx, ra, { blessing: null });
    expect(await closeOf(unblessed, "rb")).toEqual({ code: 4401, reason: "bad-blessing" });
    // The dialer expected another relay at that address.
    expect((await closeOf(await ctxFor(fx, ra), "rc")).code).toBe(4401);
  });

  it("a relay that restarted without a blessing is admitted on the copy its peer holds, and gets it back", async () => {
    const { fx, ra, rb } = fixture();
    const ports = new Map<string, number>();
    const bCtx = await ctxFor(fx, rb);
    bCtx.dir.offerBlessing(fx.blessings.get("ra"));
    await side(fx, rb, ports, bCtx, []);
    const aCtx = await ctxFor(fx, ra, { blessing: null });
    const a = await side(fx, ra, ports, aCtx, ["rb"]);
    const returned: unknown[] = [];
    (a.mgr as unknown as { opts: { handler: { onControl: (p: BridgePeer, m: Record<string, unknown>) => void } } }).opts.handler.onControl = (_p, m) => {
      if (m.type === "blessing") returned.push(m.blessing);
    };
    a.mgr.start(100);
    await expect.poll(() => a.mgr.peer("rb") !== null, { timeout: 5_000 }).toBe(true);
    await expect.poll(() => returned.length, { timeout: 2_000 }).toBe(1);
    expect((returned[0] as RelayBlessing).relayId).toBe("ra");
  });

  it("a bridged OPEN without hop:1 is refused `hop`", async () => {
    const { fx, ra, rb } = fixture();
    const ports = new Map<string, number>();
    const b = await side(fx, rb, ports, await ctxFor(fx, rb), []);
    const { dialerHandshake, HandshakeQueue } = await import("../src/tunnel/mesh/bridge.js");
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/mesh`);
    const q = new HandshakeQueue(ws);
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.on("open", () => r()));
    const hs = await dialerHandshake(ws, "rb", await ctxFor(fx, ra), 5_000, q);
    if (!hs.ok) throw new Error(hs.reason);
    q.detach();
    const msgs: Record<string, unknown>[] = [];
    let seq = 0;
    ws.on("message", (raw: Buffer, bin: boolean) => {
      if (!bin) msgs.push(JSON.parse(openBridgeText(hs.keys.s2c, seq++, raw.toString())!) as Record<string, unknown>);
    });
    ws.send(encodeFrame({ streamId: 1, type: FRAME_OPEN, payload: new TextEncoder().encode(JSON.stringify({ sni: `x.${APEX}`, kind: "tls", hop: 2 })) }));
    await expect.poll(() => msgs.find((m) => m.type === "refuse"), { timeout: 2_000 }).toMatchObject({ type: "refuse", stream: 1, code: "hop" });
    expect(b.opened.length).toBe(0);
    ws.terminate();
    void acceptorHandshake;
  });
});

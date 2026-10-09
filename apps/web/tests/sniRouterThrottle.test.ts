import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect, type Socket } from "node:net";
import { FRAME_DATA, FRAME_OPEN, type Frame } from "@flagship/tunnel-protocol";
import {
  TunnelRegistry,
  type RegisteredTunnel,
  type StreamCallbacks,
} from "../src/tunnel/registry.js";
import { startSniRouter, type RunningSniRouter } from "../src/tunnel/sniRouter.js";
import { UsageMeter } from "../src/tunnel/usageMeter.js";

// ClientHello builder (as in sniRouterNudge.test.ts).
function buildClientHello(sni: string): Uint8Array {
  const hostBytes = new TextEncoder().encode(sni);
  const nameEntry = concat(new Uint8Array([0]), u16(hostBytes.length), hostBytes);
  const list = concat(u16(nameEntry.length), nameEntry);
  const sniExt = concat(u16(0), u16(list.length), list);
  const extensions = concat(u16(sniExt.length), sniExt);
  const body = concat(
    new Uint8Array([0x03, 0x03]),
    new Uint8Array(32),
    new Uint8Array([0]),
    u16(2),
    new Uint8Array([0x00, 0x9c]),
    new Uint8Array([1, 0]),
    extensions,
  );
  const handshake = concat(new Uint8Array([0x01]), u24(body.length), body);
  return concat(new Uint8Array([0x16]), new Uint8Array([0x03, 0x01]), u16(handshake.length), handshake);
}
const u16 = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
const u24 = (v: number) => new Uint8Array([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

const BOX = "home.harry.flagship.services";

function mockTunnel(): RegisteredTunnel & {
  sent: Frame[];
  streams: Map<number, StreamCallbacks>;
  holds: number[];
} {
  let next = 1;
  const streams = new Map<number, StreamCallbacks>();
  const sent: Frame[] = [];
  const holds: number[] = [];
  return {
    podCanonical: BOX,
    sent,
    streams,
    holds,
    send: (f) => void sent.push(f),
    attachStream: (id, cb) => void streams.set(id, cb),
    detachStream: (id) => void streams.delete(id),
    nextStreamId: () => next++,
    holdInbound: (ms) => void holds.push(ms),
  };
}

async function meterFor(admit: boolean): Promise<UsageMeter> {
  const fetchImpl = (async () =>
    ({ ok: true, json: async () => ({ ok: true, results: [{ username: "harry", admit }] }) }) as unknown as Response) as unknown as typeof fetch;
  const m = new UsageMeter({ reportUrl: "https://x/api/usage/report", secret: "s", fetchImpl, throttleBytesPerSec: 1_000 });
  m.add("harry", 1);
  await m.flush();
  return m;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

describe("SNI router — an over-quota account is slowed, never refused", () => {
  let router: RunningSniRouter | undefined;
  const socks: Socket[] = [];
  afterEach(async () => {
    for (const s of socks.splice(0)) s.destroy();
    if (router) await router.close();
    router = undefined;
  });

  async function open(admit: boolean) {
    const reg = new TunnelRegistry();
    const box = mockTunnel();
    reg.register({ tunnel: box, canonicals: [BOX] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1" }, await meterFor(admit));
    const sock = netConnect(router.port, "127.0.0.1");
    socks.push(sock);
    let closed = false;
    const received: Buffer[] = [];
    sock.on("close", () => (closed = true));
    sock.on("error", () => {});
    sock.on("data", (b: Buffer) => received.push(b));
    sock.write(Buffer.from(buildClientHello(BOX)));
    await waitFor(() => box.sent.some((f) => f.type === FRAME_OPEN));
    return { box, isClosed: () => closed, received };
  }

  it("pipes an over-quota visitor instead of dropping the connection", async () => {
    const { box, isClosed } = await open(false);
    expect(box.sent.filter((f) => f.type === FRAME_OPEN)).toHaveLength(1);
    await sleep(50);
    expect(isClosed()).toBe(false);
  });

  it("box → visitor data still arrives, and overdrawing the bucket holds the box's tunnel", async () => {
    const { box, received } = await open(false);
    const [cb] = [...box.streams.values()];
    cb!.onData(new Uint8Array(4_000)); // 4× the 1 kB/s rate
    await waitFor(() => received.reduce((n, b) => n + b.length, 0) >= 4_000);
    expect(box.holds.length).toBeGreaterThan(0);
    expect(box.holds.at(-1)!).toBeGreaterThan(0);
  });

  it("a within-quota account is never held", async () => {
    const { box, received } = await open(true);
    const [cb] = [...box.streams.values()];
    for (let i = 0; i < 20; i++) cb!.onData(new Uint8Array(4_000));
    await waitFor(() => received.reduce((n, b) => n + b.length, 0) >= 80_000);
    expect(box.holds).toEqual([]);
  });

  it("an over-quota upload stops being read from the visitor (backpressure), and closing cleans up", async () => {
    const { box, isClosed } = await open(false);
    const uploaded = () =>
      box.sent.filter((f) => f.type === FRAME_DATA).reduce((n, f) => n + f.payload.length, 0);
    const afterHello = uploaded();
    socks[0]!.write(Buffer.alloc(4_000)); // overdraws a 1 kB/s bucket by ~3 s
    await waitFor(() => uploaded() >= afterHello + 4_000);
    socks[0]!.write(Buffer.alloc(4_000));
    await sleep(300);
    expect(uploaded()).toBe(afterHello + 4_000); // second write held at the socket
    // A paused socket can't see the visitor hang up until it reads again, so
    // teardown waits out the current hold (~3 s of debt at this test's 1 kB/s;
    // at most one chunk's worth — ~2 s — at the real 256 kbit/s).
    socks[0]!.destroy();
    await waitFor(() => isClosed() && box.streams.size === 0, 6_000);
  }, 10_000);
});

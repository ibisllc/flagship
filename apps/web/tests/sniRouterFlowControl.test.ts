import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect, type Socket } from "node:net";
import { FRAME_CLOSE, FRAME_DATA, FRAME_OPEN, type Frame } from "@flagship/tunnel-protocol";
import {
  TunnelRegistry,
  type RegisteredTunnel,
  type StreamCallbacks,
} from "../src/tunnel/registry.js";
import { MAX_PARKED_BYTES, startSniRouter, type RunningSniRouter } from "../src/tunnel/sniRouter.js";

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
/** The same hello re-framed into TLS records of `size` handshake bytes each. */
function inRecords(single: Uint8Array, size: number): Uint8Array {
  const hs = single.subarray(5);
  const parts: Uint8Array[] = [];
  for (let off = 0; off < hs.length; off += size) {
    const frag = hs.subarray(off, Math.min(hs.length, off + size));
    parts.push(concat(new Uint8Array([0x16, 3, 1]), u16(frag.length), frag));
  }
  return concat(...parts);
}

const BOX = "home.harry.flagship.services";

interface MockTunnel extends RegisteredTunnel {
  sent: Frame[];
  streams: Map<number, StreamCallbacks>;
  paused: Set<string>;
  writable: boolean;
  writableWaiters: Array<() => void>;
}

function mockTunnel(pod = BOX): MockTunnel {
  let next = 1;
  const t: MockTunnel = {
    podCanonical: pod,
    sent: [],
    streams: new Map(),
    paused: new Set(),
    writable: true,
    writableWaiters: [],
    send: (f) => void t.sent.push(f),
    attachStream: (id, cb) => void t.streams.set(id, cb),
    detachStream: (id) => void t.streams.delete(id),
    nextStreamId: () => next++,
    pauseInbound: (k) => void t.paused.add(k),
    resumeInbound: (k) => void t.paused.delete(k),
    whenBoxWritable: (cb) => {
      if (t.writable) return true;
      t.writableWaiters.push(cb);
      return false;
    },
  };
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}
const dataBytes = (t: MockTunnel) =>
  t.sent.filter((f) => f.type === FRAME_DATA).reduce((n, f) => n + f.payload.length, 0);

let router: RunningSniRouter | undefined;
const socks: Socket[] = [];
afterEach(async () => {
  for (const s of socks.splice(0)) s.destroy();
  if (router) await router.close();
  router = undefined;
});

function visitor(port: number) {
  const sock = netConnect(port, "127.0.0.1");
  socks.push(sock);
  const state = { closed: false };
  sock.on("close", () => (state.closed = true));
  sock.on("error", () => {});
  return { sock, state };
}

describe("SNI router flow control", () => {
  it("pauses the tunnel for a visitor that stops reading, then cuts it", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel();
    reg.register({ tunnel: box, canonicals: [BOX] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", slowVisitorGraceMs: 300 });
    const { sock, state } = visitor(router.port);
    sock.pause(); // never reads
    sock.write(Buffer.from(buildClientHello(BOX)));
    await waitFor(() => box.streams.size === 1);
    const [id, cb] = [...box.streams][0]!;
    const chunk = new Uint8Array(256 * 1024);
    // Push box data until the router asks the tunnel to stop, the way a paused WS would.
    let pushed = 0;
    while (box.paused.size === 0 && pushed < 256 * 1024 * 1024) {
      cb.onData(chunk);
      pushed += chunk.length;
      await sleep(1);
    }
    expect(box.paused.size).toBe(1);
    // The paused test socket never reads the FIN, so watch the router's side of the cut.
    await waitFor(() => box.streams.size === 0);
    expect(box.paused.size).toBe(0);
    sock.resume();
    await waitFor(() => state.closed);
    expect(box.sent.some((f) => f.type === FRAME_CLOSE && f.streamId === id)).toBe(true);
    expect(box.streams.size).toBe(0);
  });

  it("resumes the tunnel once a slow visitor catches up, without cutting it", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel();
    reg.register({ tunnel: box, canonicals: [BOX] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", slowVisitorGraceMs: 2_000 });
    const { sock, state } = visitor(router.port);
    sock.pause();
    sock.write(Buffer.from(buildClientHello(BOX)));
    await waitFor(() => box.streams.size === 1);
    const cb = [...box.streams.values()][0]!;
    const chunk = new Uint8Array(256 * 1024);
    let pushed = 0;
    while (box.paused.size === 0) {
      cb.onData(chunk);
      pushed += chunk.length;
      await sleep(1);
    }
    let received = 0;
    sock.on("data", (b: Buffer) => (received += b.length));
    sock.resume();
    await waitFor(() => box.paused.size === 0);
    await waitFor(() => received === pushed);
    expect(state.closed).toBe(false);
  });

  it("stops reading a visitor's upload while the box is backed up", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel();
    reg.register({ tunnel: box, canonicals: [BOX] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1" });
    const { sock } = visitor(router.port);
    const hello = buildClientHello(BOX);
    box.writable = false;
    sock.write(Buffer.from(hello));
    await waitFor(() => box.writableWaiters.length === 1);
    const upload = Buffer.alloc(4 * 1024 * 1024, 1);
    sock.write(upload);
    await sleep(100);
    expect(dataBytes(box)).toBe(hello.length);
    box.writable = true;
    for (const w of box.writableWaiters.splice(0)) w();
    await waitFor(() => dataBytes(box) === hello.length + upload.length);
  });

  it("stops reading a parked visitor past the cap and replays every byte in order once routed", async () => {
    const reg = new TunnelRegistry();
    const other = mockTunnel("attic.harry.flagship.services");
    reg.register({ tunnel: other, canonicals: [other.podCanonical] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", holdTimeoutMs: 3_000, holdPollIntervalMs: 20 });
    const name = "chess.harry.flagship.services";
    const { sock } = visitor(router.port);
    const hello = buildClientHello(name);
    const early = Buffer.alloc(MAX_PARKED_BYTES * 8);
    for (let i = 0; i < early.length; i++) early[i] = i % 251;
    sock.write(Buffer.from(hello));
    sock.write(early);
    await sleep(200);
    const box = mockTunnel();
    reg.register({ tunnel: box, canonicals: [box.podCanonical, name] });
    await waitFor(() => dataBytes(box) === hello.length + early.length);
    const got = Buffer.concat(box.sent.filter((f) => f.type === FRAME_DATA).map((f) => Buffer.from(f.payload)));
    expect(got.equals(Buffer.concat([Buffer.from(hello), early]))).toBe(true);
  });

  it("routes a hello sent one byte at a time in 16-byte records", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel();
    reg.register({ tunnel: box, canonicals: [BOX] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1" });
    const { sock } = visitor(router.port);
    sock.setNoDelay(true);
    const raw = inRecords(buildClientHello(BOX), 16);
    for (const b of raw) {
      sock.write(Buffer.from([b]));
      await sleep(0);
    }
    await waitFor(() => box.sent.some((f) => f.type === FRAME_OPEN));
    expect(dataBytes(box)).toBe(raw.length);
  });

  it("drops connections past the pending-hello cap at once", async () => {
    const reg = new TunnelRegistry();
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", maxPendingHellos: 2 });
    const a = visitor(router.port);
    const b = visitor(router.port);
    await sleep(100);
    const c = visitor(router.port);
    await waitFor(() => c.state.closed, 1_000);
    expect(a.state.closed).toBe(false);
    expect(b.state.closed).toBe(false);
    a.sock.destroy();
    await sleep(100);
    const d = visitor(router.port);
    await sleep(200);
    expect(d.state.closed).toBe(false);
  });
});

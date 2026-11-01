#!/usr/bin/env -S npx tsx
/**
 * Relay benchmark, TypeScript hub vs Rust flagship-relay (release plan G10). Both run as their own process against
 * the same mock `.com` of tools/relay-conformance; one box connects over the tunnel WebSocket with a real signed
 * HELLO, and visitors connect to the SNI passthrough port with a TLS ClientHello, as on flagship.services.
 *
 *   npx tsx scripts/bench/relay.ts [--quick] [--out results.jsonl] [--impl ts,rust] [--relay-bin <path>]
 *
 * Measures, per relay: startup to listening, idle CPU and RSS, stream-open latency (ClientHello in, first byte of
 * the box's answer back), echo round trips on an open stream (p50/p95/p99), download and upload throughput through
 * one stream, and the relay's CPU seconds and peak RSS over the run. The load generator is one Node process: on a
 * fast relay it, not the relay, may be the limit, so throughput is a lower bound for both.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { closeFrame, dataFrame, decodeFrame, encodeFrame, FRAME_CLOSE, FRAME_DATA, FRAME_HELLO, FRAME_HELLO_ACK, FRAME_OPEN, parseHelloAck, type Frame } from "@flagship/tunnel-protocol";
import { APEX, boxIdentity, clientHello, CONTROL_SECRET, freePort, helloPayload, MockCom, REPO, type BoxIdentity } from "../../tools/relay-conformance/harness.js";
import { arg, flag, nowMs, procUsage, Recorder, sleep } from "./common.js";

const QUICK = flag("quick");
const IMPLS = (arg("impl") ?? "ts,rust").split(",");
const RUST_BIN = arg("relay-bin") ?? process.env.FLAGSHIP_RELAY_BIN ?? resolve(REPO, "rust/target/release/flagship-relay");
const rec = new Recorder("relay");

interface Relay { child: ChildProcess; hub: number; sni: number; startupMs: number }

async function startRelay(impl: string, com: MockCom): Promise<Relay> {
  const p = { hub: await freePort(), sni: await freePort(), echo: await freePort() };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp",
    PORT: String(p.hub), TUNNEL_TCP_PORT: String(p.sni), RELAY_ECHO_PORT: String(p.echo), HOST: "127.0.0.1",
    FLAGSHIP_SURFACE: "services", FLAGSHIP_SERVICES_APEX: APEX, FLAGSHIP_COM_BASE_URL: com.url,
    SERVICES_CONTROL_SECRET: CONTROL_SECRET, FLAGSHIP_HUB_HOST: APEX, FLAGSHIP_DRAIN_GRACE_MS: "1000",
    FLAGSHIP_OUTBOUND_RELAY: "off", FLAGSHIP_RELAY_ID: "bench", FLAGSHIP_PHONE_ROUTE: "off", NODE_ENV: "production",
  };
  const t0 = nowMs();
  const child = impl === "rust"
    ? spawn(RUST_BIN, [], { env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [resolve(import.meta.dirname, "relay-ts-child.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], cwd: REPO });
  const logs: string[] = [];
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${impl} relay did not start: ${logs.slice(-5).join(" | ")}`)), 30_000);
    const onData = (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (!line) continue;
        logs.push(line);
        if (line.startsWith("tunnel hub:")) { clearTimeout(timer); ok(); }
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); fail(new Error(`${impl} relay exited ${c}: ${logs.slice(-5).join(" | ")}`)); });
  });
  const startupMs = nowMs() - t0;
  // The hub's blessing is fetched once at start; HELLO_ACKs carry it once held.
  for (let i = 0; i < 100 && com.blessed === null; i++) await sleep(50);
  return { child, hub: p.hub, sni: p.sni, startupMs };
}

/** A box that keeps no frame history: it answers OPENs by the handler and counts bytes. */
class BenchBox {
  private buf: Uint8Array = new Uint8Array(0);
  private ackWait: ((ok: boolean, reason?: string) => void) | null = null;
  onOpen: (id: number, sni: string) => void = () => undefined;
  onData: (id: number, data: Uint8Array) => void = () => undefined;
  onClose: (id: number) => void = () => undefined;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer) => {
      const j = new Uint8Array(this.buf.length + raw.length);
      j.set(this.buf);
      j.set(raw, this.buf.length);
      this.buf = j;
      for (;;) {
        const d = decodeFrame(this.buf, { drainNotice: true });
        if (d.kind !== "ok") break;
        this.buf = this.buf.subarray(d.consumed);
        this.frame(d.frame);
      }
    });
    ws.on("error", () => undefined);
  }
  private frame(f: Frame): void {
    if (f.type === FRAME_HELLO_ACK) {
      const a = parseHelloAck(f.payload) as { ok: boolean; reason?: string };
      this.ackWait?.(a.ok, a.reason);
    } else if (f.type === FRAME_OPEN) this.onOpen(f.streamId, new TextDecoder().decode(f.payload));
    else if (f.type === FRAME_DATA) this.onData(f.streamId, f.payload);
    else if (f.type === FRAME_CLOSE) this.onClose(f.streamId);
  }
  static async connect(hub: number, b: BoxIdentity): Promise<BenchBox> {
    const ws = new WebSocket(`ws://127.0.0.1:${hub}/tunnel`);
    await new Promise<void>((ok, fail) => { ws.once("open", () => ok()); ws.once("error", fail); });
    const box = new BenchBox(ws);
    const acked = new Promise<void>((ok, fail) => (box.ackWait = (o, r) => (o ? ok() : fail(new Error(`HELLO refused: ${r}`)))));
    const h = await helloPayload(b);
    box.send({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(JSON.stringify(h.payload)) });
    await acked;
    return box;
  }
  send(f: Frame): void { this.ws.send(encodeFrame(f)); }
  /** Send with backpressure on the WebSocket's own buffer. */
  async sendPaced(f: Frame): Promise<void> {
    this.send(f);
    while (this.ws.bufferedAmount > 8 << 20) await sleep(1);
  }
  close(): void { this.ws.terminate(); }
}

async function openVisitor(port: number, first: Uint8Array): Promise<Socket> {
  const s = netConnect(port, "127.0.0.1");
  s.setNoDelay(true);
  await new Promise<void>((ok, fail) => { s.once("connect", () => ok()); s.once("error", fail); });
  s.write(first);
  return s;
}

async function run(impl: string): Promise<void> {
  const com = new MockCom();
  await com.start();
  const relay = await startRelay(impl, com);
  const pid = relay.child.pid!;
  rec.add(impl, "startup_to_listening", relay.startupMs, "ms", 1);
  try {
    const a = com.account("alice");
    const b = boxIdentity(com, a, "home", ["notes"]);
    const box = await BenchBox.connect(relay.hub, b);

    // Idle: one box attached, nothing flowing.
    await sleep(1000);
    const idle0 = procUsage(pid)!;
    const idleSec = QUICK ? 3 : 15;
    await sleep(idleSec * 1000);
    const idle1 = procUsage(pid)!;
    rec.add(impl, "idle_cpu_percent", (100 * (idle1.cpuSec - idle0.cpuSec)) / idleSec, "%", idleSec);
    rec.add(impl, "idle_rss", idle1.rssKiB / 1024, "MiB");
    const load0 = procUsage(pid)!;

    // Stream open: ClientHello to the box's first answer byte at the visitor.
    const pending = new Map<string, (id: number) => void>();
    box.onOpen = (id, sni) => { box.send(dataFrame(id, new Uint8Array([0x16]))); pending.get(sni)?.(id); };
    box.onData = () => undefined;
    const opens: number[] = [];
    const nOpen = QUICK ? 50 : 500;
    for (let i = 0; i < nOpen + 20; i++) {
      const t = nowMs();
      const v = await openVisitor(relay.sni, clientHello(b.pod));
      await new Promise<void>((ok) => v.once("data", () => ok()));
      if (i >= 20) opens.push(nowMs() - t);
      v.destroy();
    }
    rec.latency(impl, "stream_open", opens);

    // Echo round trips: 64-byte messages the box sends straight back.
    const echoId = new Promise<number>((ok) => pending.set(b.pod, ok));
    box.onOpen = (id, sni) => pending.get(sni)?.(id);
    box.onData = (id, d) => { if (d[0] !== 0x16) box.send(dataFrame(id, d)); };
    const v = await openVisitor(relay.sni, clientHello(b.pod));
    await echoId;
    const msg = Buffer.alloc(64, 7);
    const rtts: number[] = [];
    const nEcho = QUICK ? 500 : 5000;
    for (let i = 0; i < nEcho + 100; i++) {
      const t = nowMs();
      let got = 0;
      await new Promise<void>((ok) => {
        const on = (d: Buffer) => { got += d.length; if (got >= 64) { v.off("data", on); ok(); } };
        v.on("data", on);
        v.write(msg);
      });
      if (i >= 100) rtts.push(nowMs() - t);
    }
    rec.latency(impl, "echo_rtt_64B", rtts);
    v.destroy();

    // Download: the box streams N MiB in 64 KiB DATA frames to one visitor.
    const mib = QUICK ? 64 : 512;
    const chunk = new Uint8Array(64 * 1024).fill(1);
    let dlId: (id: number) => void = () => undefined;
    box.onOpen = (id) => dlId(id);
    box.onData = () => undefined;
    const dlOpened = new Promise<number>((ok) => (dlId = ok));
    const dv = await openVisitor(relay.sni, clientHello(b.pod));
    const id = await dlOpened;
    let rx = 0;
    const want = mib * 1024 * 1024;
    const t0 = nowMs();
    const done = new Promise<void>((ok) => dv.on("data", (d: Buffer) => { rx += d.length; if (rx >= want) ok(); }));
    for (let sent = 0; sent < want; sent += chunk.length) await box.sendPaced(dataFrame(id, chunk));
    await done;
    rec.add(impl, "download_throughput", (mib / (nowMs() - t0)) * 1000, "MiB/s", mib);
    box.send(closeFrame(id));
    dv.destroy();

    // Upload: a visitor streams N MiB to the box.
    let upRx = 0;
    let upOpen: (id: number) => void = () => undefined;
    const upOpened = new Promise<number>((ok) => (upOpen = ok));
    box.onOpen = (i) => upOpen(i);
    let upDone: () => void = () => undefined;
    const upFinished = new Promise<void>((ok) => (upDone = ok));
    const first = clientHello(b.pod);
    box.onData = (_i, d) => { upRx += d.length; if (upRx >= want + first.length) upDone(); };
    const uv = await openVisitor(relay.sni, first);
    await upOpened;
    const buf = Buffer.alloc(64 * 1024, 2);
    const t1 = nowMs();
    for (let sent = 0; sent < want; sent += buf.length) {
      if (!uv.write(buf)) await new Promise<void>((ok) => uv.once("drain", () => ok()));
    }
    await upFinished;
    rec.add(impl, "upload_throughput", (mib / (nowMs() - t1)) * 1000, "MiB/s", mib);
    uv.destroy();

    const load1 = procUsage(pid)!;
    rec.add(impl, "cpu_seconds_under_load", load1.cpuSec - load0.cpuSec, "s");
    rec.add(impl, "peak_rss", load1.peakKiB / 1024, "MiB");
    box.close();
  } finally {
    relay.child.kill("SIGKILL");
    await com.stop();
  }
}

for (const impl of IMPLS) {
  if (impl === "rust" && !existsSync(RUST_BIN)) {
    console.log(`skipping rust: no relay binary at ${RUST_BIN} (cargo build --release -p flagship-relay)`);
    continue;
  }
  await run(impl);
}
rec.print();
process.exit(0);

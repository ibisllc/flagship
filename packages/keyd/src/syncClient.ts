import { Worker } from "node:worker_threads";
import { KEYD_PROTOCOL_VERSION, KeydError, type KeydErrorCode, type Op } from "./wire.js";

/**
 * A synchronous keyd client for code that signs inline (`ed.sign` returns bytes, not a
 * promise). A worker thread owns the socket; the calling thread blocks on an Atomics wait
 * until the worker has the answer. Calls are serialized. keyd answers in well under a
 * millisecond, so the block is short, but it is a real block: do not call this from a
 * latency-critical loop that could be asynchronous.
 */

const WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const net = require("node:net");
const { control, data, socketPath } = workerData;
const ctl = new Int32Array(control);
const buf = new Uint8Array(data);
let socket = null;
let chunks = Buffer.alloc(0);
let current = null;
const MAX = 4 * 1024 * 1024;

function finish(kind, bytes) {
  // kind: 1 = frame ready, 2 = connection error
  buf.set(bytes.subarray(0, buf.length), 0);
  Atomics.store(ctl, 1, Math.min(bytes.length, buf.length));
  Atomics.store(ctl, 0, kind);
  Atomics.notify(ctl, 0);
}

function connect() {
  socket = net.connect(socketPath);
  socket.on("data", (d) => {
    chunks = Buffer.concat([chunks, d]);
    while (chunks.length >= 4) {
      const len = chunks.readUInt32BE(0);
      if (len === 0 || len > MAX) { finish(2, Buffer.from("bad frame")); socket.destroy(); return; }
      if (chunks.length < 4 + len) return;
      const body = chunks.subarray(4, 4 + len);
      chunks = chunks.subarray(4 + len);
      if (current) { current = null; finish(1, body); }
    }
  });
  socket.on("error", (e) => { if (current) { current = null; finish(2, Buffer.from(String(e.message))); } });
  socket.on("close", () => { if (current) { current = null; finish(2, Buffer.from("closed")); } });
  return new Promise((resolve) => socket.once("connect", resolve));
}

parentPort.on("message", async (m) => {
  if (m.kind === "connect") {
    try { await connect(); } catch (e) { finish(2, Buffer.from(String(e && e.message))); return; }
    current = true;
    socket.write(m.frame);
    return;
  }
  if (m.kind === "call") { current = true; if (!socket || socket.destroyed) { current = null; finish(2, Buffer.from("not connected")); return; } socket.write(m.frame); return; }
  if (m.kind === "close") { if (socket) socket.destroy(); process.exit(0); }
});
`;

export interface KeydSyncClientOptions {
  socketPath: string;
  component: string;
  timeoutMs?: number;
}

export class KeydSyncClient {
  private readonly ctl = new Int32Array(new SharedArrayBuffer(8));
  private readonly data = new Uint8Array(new SharedArrayBuffer(4 * 1024 * 1024 + 16));
  private worker: Worker | null = null;
  private nextId = 1;
  publicKeyHex = "";

  constructor(private readonly opts: KeydSyncClientOptions) {}

  connect(): { publicKey: string; hasSwk: boolean; hasCgk: boolean } {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { control: this.ctl.buffer, data: this.data.buffer, socketPath: this.opts.socketPath },
    });
    this.worker.unref();
    const id = this.nextId++;
    const frame = this.frame({ id, op: "hello", args: { v: KEYD_PROTOCOL_VERSION, component: this.opts.component } });
    const res = this.roundTrip({ kind: "connect", frame }, id) as { publicKey: string; hasSwk: boolean; hasCgk: boolean };
    this.publicKeyHex = res.publicKey;
    return res;
  }

  call(op: Op, args: Record<string, unknown> = {}): Record<string, unknown> {
    if (!this.worker) throw new KeydError("failed", "not connected to keyd");
    const id = this.nextId++;
    return this.roundTrip({ kind: "call", frame: this.frame({ id, op, args }) }, id);
  }

  close(): void {
    this.worker?.postMessage({ kind: "close" });
    this.worker = null;
  }

  private frame(v: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(v), "utf8");
    const out = Buffer.allocUnsafe(4 + body.length);
    out.writeUInt32BE(body.length, 0);
    body.copy(out, 4);
    return out;
  }

  private roundTrip(msg: { kind: string; frame: Buffer }, id: number): Record<string, unknown> {
    Atomics.store(this.ctl, 0, 0);
    this.worker!.postMessage(msg);
    const waited = Atomics.wait(this.ctl, 0, 0, this.opts.timeoutMs ?? 10_000);
    if (waited === "timed-out") throw new KeydError("failed", "keyd did not answer in time");
    const kind = Atomics.load(this.ctl, 0);
    const len = Atomics.load(this.ctl, 1);
    const text = Buffer.from(this.data.subarray(0, len)).toString("utf8");
    if (kind === 2) throw new KeydError("failed", `keyd connection: ${text.slice(0, 120)}`);
    const r = JSON.parse(text) as { id: number; ok: boolean; result?: Record<string, unknown>; code?: KeydErrorCode; message?: string };
    if (r.id !== id) throw new KeydError("failed", "keyd answered a different request");
    if (!r.ok) throw new KeydError(r.code ?? "failed", r.message ?? "keyd refused");
    return r.result ?? {};
  }
}

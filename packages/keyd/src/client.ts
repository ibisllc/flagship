import { connect, type Socket } from "node:net";
import { KEYD_PROTOCOL_VERSION, FrameReader, KeydError, encodeFrame, type KeydErrorCode, type KeydResponse, type Op } from "./wire.js";

export interface KeydClientOptions {
  socketPath: string;
  /** Names this caller in keyd's audit log. */
  component: string;
  timeoutMs?: number;
}

/** Asynchronous client. Calls are answered in order on one connection. */
export class KeydClient {
  private socket: Socket | null = null;
  private reader = new FrameReader();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  publicKeyHex = "";

  constructor(private readonly opts: KeydClientOptions) {}

  async connect(): Promise<{ publicKey: string; hasSwk: boolean; hasCgk: boolean }> {
    const socket = connect(this.opts.socketPath);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = this.reader.push(chunk);
      } catch (e) {
        this.failAll(e as Error);
        socket.destroy();
        return;
      }
      for (const f of frames) {
        const r = f as KeydResponse;
        const p = this.pending.get(r.id);
        if (!p) continue;
        this.pending.delete(r.id);
        clearTimeout(p.timer);
        if (r.ok) p.resolve(r.result);
        else p.reject(new KeydError(r.code as KeydErrorCode, r.message));
      }
    });
    socket.on("close", () => this.failAll(new KeydError("failed", "keyd connection closed")));
    socket.on("error", (e) => this.failAll(e));
    const hello = (await this.call("hello", { v: KEYD_PROTOCOL_VERSION, component: this.opts.component })) as { publicKey: string; hasSwk: boolean; hasCgk: boolean };
    this.publicKeyHex = hello.publicKey;
    return hello;
  }

  call(op: Op, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new KeydError("failed", "not connected to keyd"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KeydError("failed", "keyd did not answer in time"));
      }, this.opts.timeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeFrame({ id, op, args }));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private failAll(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }
}

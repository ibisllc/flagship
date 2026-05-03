import { connect as netConnect, type Socket } from "node:net";
import { WebSocket } from "ws";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_OPEN,
  type Frame,
} from "@flagship/tunnel-protocol";
import { signTunnelHello, type Keypair } from "@flagship/protocol";

export interface BackendTarget {
  host: string;
  port: number;
}

export type BackendResolver = (sni: string) => BackendTarget | null;

export interface TunnelClientOptions {
  /** ws:// or wss:// URL of the control-plane tunnel hub. */
  hubUrl: string;
  serverId: string;
  subdomains: string[];
  /** STK (Server Tunnel Key) used to sign the HELLO. Derived from SWK. */
  signingKey: Keypair;
  /** Given an SNI hostname, return the local backend to forward to. */
  resolveBackend: BackendResolver;
}

export interface TunnelClient {
  /** Resolves once HELLO_ACK is received and registration is confirmed. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function startTunnelClient(opts: TunnelClientOptions): TunnelClient {
  const ws = new WebSocket(opts.hubUrl);
  ws.binaryType = "arraybuffer";

  const streams = new Map<number, Socket>();
  let buffered: Uint8Array = new Uint8Array(0);
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  function send(frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame), { binary: true });
  }

  ws.on("open", () => {
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const issuedAt = Date.now();
    const helloRecord = {
      serverId: opts.serverId,
      subdomains: opts.subdomains,
      nonce,
      issuedAt,
    };
    const signature = signTunnelHello(helloRecord, opts.signingKey);
    const payload = JSON.stringify({
      serverId: opts.serverId,
      subdomains: opts.subdomains,
      nonce: bytesToHex(nonce),
      issuedAt,
      signature: bytesToHex(signature),
    });
    send({
      streamId: 0,
      type: FRAME_HELLO,
      payload: new TextEncoder().encode(payload),
    });
  });

  ws.on("message", (raw: ArrayBuffer | Buffer | Buffer[]) => {
    const incoming = toUint8(raw);
    buffered = concat(buffered, incoming);
    while (true) {
      const r = decodeFrame(buffered);
      if (r.kind === "incomplete") return;
      if (r.kind === "error") {
        rejectReady(new Error(r.reason));
        ws.close();
        return;
      }
      buffered = buffered.subarray(r.consumed);
      handleFrame(r.frame);
    }
  });

  ws.on("close", () => {
    for (const sock of streams.values()) sock.destroy();
    streams.clear();
  });

  ws.on("error", (e) => {
    rejectReady(e instanceof Error ? e : new Error(String(e)));
  });

  function handleFrame(f: Frame): void {
    if (f.type === FRAME_HELLO_ACK) {
      let body: { ok?: boolean; reason?: string };
      try {
        body = JSON.parse(new TextDecoder().decode(f.payload));
      } catch {
        rejectReady(new Error("HELLO_ACK payload not JSON"));
        return;
      }
      if (body.ok) resolveReady();
      else rejectReady(new Error(body.reason ?? "HELLO_ACK rejected"));
      return;
    }
    if (f.type === FRAME_OPEN) {
      const sni = new TextDecoder().decode(f.payload);
      const target = opts.resolveBackend(sni);
      if (!target) {
        send(closeFrame(f.streamId, true));
        return;
      }
      const sock = netConnect(target.port, target.host);
      streams.set(f.streamId, sock);
      sock.on("data", (chunk: Buffer) => {
        send(
          dataFrame(
            f.streamId,
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          ),
        );
      });
      sock.on("end", () => {
        send(closeFrame(f.streamId, true));
      });
      sock.on("close", () => {
        streams.delete(f.streamId);
      });
      sock.on("error", () => {
        send(closeFrame(f.streamId, true));
        sock.destroy();
        streams.delete(f.streamId);
      });
      return;
    }
    if (f.type === FRAME_DATA) {
      const sock = streams.get(f.streamId);
      if (sock) sock.write(Buffer.from(f.payload));
      return;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      const sock = streams.get(f.streamId);
      if (sock) sock.end();
      streams.delete(f.streamId);
      return;
    }
  }

  return {
    ready: () => ready,
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

function toUint8(raw: ArrayBuffer | Buffer | Buffer[]): Uint8Array {
  if (Array.isArray(raw)) {
    let total = 0;
    for (const b of raw) total += b.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const b of raw) {
      out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), p);
      p += b.length;
    }
    return out;
  }
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * `/phone-tunnel`: the WebSocket a phone holds while Flagship is in the foreground on it (plan H3; wire protocol in
 * docs/architecture-v2/phone-route.md). Text messages are JSON control (begin, claim, release, beat); binary messages
 * are tunnel-protocol v1 frames, one per message: the relay opens a stream per visitor of the phone's bare name
 * (OPEN with the SNI, then the visitor's TLS bytes as DATA) and the phone answers with DATA and CLOSE. TLS ends on the
 * phone; the relay only splices. Routing decisions live in phoneRoute.ts.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  closeFrame,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  MAX_FRAME_PAYLOAD,
  type Frame,
} from "@flagship/tunnel-protocol";
import { PHONE_TUNNEL_PING_MS, PHONE_TUNNEL_SILENCE_MS } from "@flagship/protocol";
import type { PhoneRoutes, PhoneSession, PhoneSessionHandle } from "./phoneRoute.js";
import type { RegisteredTunnel, StreamCallbacks } from "./registry.js";

export const PHONE_TUNNEL_PATH = "/phone-tunnel";
const MAX_CONTROL_BYTES = 16 * 1024;
/** Control messages a phone may send per minute (a claim needs two; beats are one per 15 s). */
const MAX_CONTROL_PER_MINUTE = 30;
const QUEUE_HIGH_BYTES = MAX_FRAME_PAYLOAD;
const QUEUE_LOW_BYTES = 256 * 1024;

export interface PhoneTunnelOptions {
  pingMs?: number;
  silenceMs?: number;
}

export interface PhoneTunnelHandle {
  (): Promise<void>;
  connectionCount(): number;
}

export function startPhoneTunnel(httpServer: HttpServer, routes: PhoneRoutes, opts: PhoneTunnelOptions = {}): PhoneTunnelHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MAX_FRAME_PAYLOAD });
  const sockets = new Set<WsSocket>();
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (req.url !== PHONE_TUNNEL_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      attachPhone(ws, routes, opts);
    });
  };
  httpServer.on("upgrade", onUpgrade);
  const stop = async () => {
    httpServer.off("upgrade", onUpgrade);
    for (const ws of sockets) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
  return Object.assign(stop, { connectionCount: () => sockets.size });
}

function attachPhone(ws: WsSocket, routes: PhoneRoutes, opts: PhoneTunnelOptions): void {
  const streams = new Map<number, StreamCallbacks>();
  let nextStream = 1;
  let queued = 0;
  let waiters: Array<() => void> = [];
  let lastHeard = Date.now();
  let controlWindowStart = Date.now();
  let controlCount = 0;
  let session: PhoneSession;

  const sendFrame = (frame: Frame) => {
    if (ws.readyState !== ws.OPEN) return;
    const bytes = encodeFrame(frame);
    queued += bytes.byteLength;
    ws.send(bytes, { binary: true }, () => {
      queued -= bytes.byteLength;
      if (queued <= QUEUE_LOW_BYTES && waiters.length > 0) {
        const w = waiters;
        waiters = [];
        for (const fn of w) fn();
      }
    });
  };

  const tunnel: RegisteredTunnel = {
    get podCanonical() {
      return session?.held?.hostname ?? "";
    },
    send: sendFrame,
    attachStream: (id, cb) => {
      streams.set(id, cb);
    },
    detachStream: (id) => {
      streams.delete(id);
    },
    nextStreamId: () => {
      for (;;) {
        const id = nextStream;
        nextStream = nextStream >= 0x7fffffff ? 1 : nextStream + 1;
        if (!streams.has(id)) return id;
      }
    },
    whenBoxWritable: (onWritable) => {
      if (queued <= QUEUE_HIGH_BYTES) return true;
      waiters.push(onWritable);
      return false;
    },
  };

  const handle: PhoneSessionHandle = {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    tunnel,
    streamCount: () => streams.size,
    closeStreams: () => {
      for (const [id, cb] of [...streams]) {
        streams.delete(id);
        sendFrame(closeFrame(id, false));
        cb.onRemoteClose();
      }
    },
    close: (code, reason) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    },
  };
  session = routes.attach(handle);

  const pingMs = opts.pingMs ?? PHONE_TUNNEL_PING_MS;
  const silenceMs = opts.silenceMs ?? PHONE_TUNNEL_SILENCE_MS;
  const ping = setInterval(() => {
    if (Date.now() - lastHeard >= silenceMs) {
      ws.terminate();
      return;
    }
    if (ws.readyState === ws.OPEN) ws.ping();
  }, Math.min(pingMs, silenceMs / 3));
  ping.unref?.();

  ws.on("pong", () => (lastHeard = Date.now()));
  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    lastHeard = Date.now();
    if (isBinary) return onFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    if (raw.byteLength > MAX_CONTROL_BYTES) return ws.close(1009, "control message too large");
    const now = Date.now();
    if (now - controlWindowStart >= 60_000) {
      controlWindowStart = now;
      controlCount = 0;
    }
    if (++controlCount > MAX_CONTROL_PER_MINUTE) {
      handle.send({ type: "refused", code: "busy" });
      return ws.close(1008, "too many control messages");
    }
    let msg: Record<string, unknown>;
    try {
      const v = JSON.parse(raw.toString("utf8")) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return;
      msg = v as Record<string, unknown>;
    } catch {
      return;
    }
    void onControl(msg).catch((e) => {
      console.warn(`[phone-tunnel] control handler failed: ${e instanceof Error ? e.message : String(e)}`);
      ws.close(1011, "internal error");
    });
  });
  ws.on("close", () => {
    clearInterval(ping);
    routes.detach(session);
    for (const cb of [...streams.values()]) cb.onRemoteClose();
    streams.clear();
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  });
  ws.on("error", () => undefined);

  async function onControl(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "begin":
        return routes.begin(session, msg.account);
      case "claim":
        return routes.claim(session, msg.claim, msg.signature);
      case "release":
        return routes.release(session);
      default:
        return;
    }
  }

  function onFrame(bytes: Uint8Array): void {
    const r = decodeFrame(bytes);
    if (r.kind !== "ok" || r.consumed !== bytes.byteLength) return ws.close(1002, "one whole frame per binary message");
    const f = r.frame;
    if (f.type === FRAME_DATA) {
      streams.get(f.streamId)?.onData(f.payload);
      return;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      const cb = streams.get(f.streamId);
      streams.delete(f.streamId);
      cb?.onRemoteClose();
      return;
    }
    ws.close(1002, "unexpected frame");
  }

  handle.send({ type: "hello", relayId: routes.relayId, serverTime: Date.now() });
}

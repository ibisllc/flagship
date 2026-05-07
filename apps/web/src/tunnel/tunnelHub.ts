import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_HELLO,
  helloAckFrame,
  type Frame,
} from "@flagship/tunnel-protocol";
import { verifyTunnelHello, type Bytes } from "@flagship/protocol";
import type { RegisteredTunnel, StreamCallbacks, TunnelRegistry } from "./registry.js";

const TUNNEL_PATH = "/tunnel";

export interface TunnelAuthLookup {
  /** Returns the server's registered STK (Server Tunnel Key) pubkey, or null if unknown. */
  (serverId: string): Bytes | null | Promise<Bytes | null>;
}

export interface TunnelHubOptions {
  /**
   * Look up a server's registered tunnel-auth pubkey. Required in production;
   * tests may pass a closure that maps known serverIds to known pubkeys.
   *
   * If omitted, HELLO signature verification is SKIPPED — only safe for v0
   * dev environments. A WARN is logged in that case.
   */
  authLookup?: TunnelAuthLookup;
  /** Reject HELLOs whose issuedAt is older than this. Default 5 min. */
  maxHelloAgeMs?: number;
  /**
   * Idle close timeout. When a HELLO update leaves the tunnel's
   * controlledDomains list empty, the hub waits this long before
   * closing the WS. A non-empty HELLO arriving in the window cancels.
   * Default 60s.
   */
  idleCloseMs?: number;
  now?: () => number;
}

/**
 * Mounts the tunnel WebSocket endpoint at /tunnel on the given HTTP server.
 * Returns a close function for graceful shutdown.
 */
export function startTunnelHub(
  httpServer: HttpServer,
  registry: TunnelRegistry,
  opts: TunnelHubOptions = {},
): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  if (!opts.authLookup) {
    console.warn(
      "[flagship tunnel hub] no authLookup provided — HELLO signatures will not be verified. v0 dev only.",
    );
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (req.url !== TUNNEL_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => attachTunnel(ws, registry, opts));
  };
  httpServer.on("upgrade", onUpgrade);

  return async () => {
    httpServer.off("upgrade", onUpgrade);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
}

function attachTunnel(
  ws: WsSocket,
  registry: TunnelRegistry,
  opts: TunnelHubOptions,
): void {
  let registered: RegisteredTunnel | null = null;
  /** Issued-at of the last accepted HELLO; subsequent ones must be newer. */
  let lastHelloIssuedAt = 0;
  let nextStream = 1;
  const streams = new Map<number, StreamCallbacks>();
  let buffered: Uint8Array = new Uint8Array(0);
  const now = opts.now ?? (() => Date.now());
  const maxHelloAgeMs = opts.maxHelloAgeMs ?? 5 * 60_000;
  const idleCloseMs = opts.idleCloseMs ?? 60_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (frame: Frame) => {
    if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame), { binary: true });
  };

  const armIdleClose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      ws.close(1000, "controlledDomains empty for idle window");
    }, idleCloseMs);
  };

  const cancelIdleClose = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  ws.on("message", (raw: Buffer) => {
    const view = new Uint8Array(raw.byteLength);
    view.set(raw);
    buffered = concat(buffered, view);
    void drain();
  });

  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const r = decodeFrame(buffered);
        if (r.kind === "incomplete") return;
        if (r.kind === "error") {
          send(helloAckFrame(false, r.reason));
          ws.close(1002, "frame decode error");
          return;
        }
        buffered = buffered.subarray(r.consumed);
        await handleFrame(r.frame);
      }
    } finally {
      draining = false;
    }
  }

  ws.on("close", () => {
    cancelIdleClose();
    if (registered) registry.unregister(registered.serverId);
    for (const cb of streams.values()) cb.onRemoteClose();
    streams.clear();
  });

  ws.on("error", () => {
    /* swallow; close handler does cleanup */
  });

  async function authenticateHello(
    helloOk: HelloPayload,
  ): Promise<{ ok: true } | { ok: false; reason: string; closeCode: number }> {
    const age = now() - helloOk.issuedAt;
    if (age > maxHelloAgeMs || age < -60_000) {
      return { ok: false, reason: "HELLO issuedAt is stale or too far in the future", closeCode: 1008 };
    }
    if (helloOk.issuedAt <= lastHelloIssuedAt) {
      // Replay defense — issuedAt must increase per WS.
      return {
        ok: false,
        reason: "HELLO issuedAt did not advance (replay?)",
        closeCode: 1008,
      };
    }
    const podUsername = extractMiddleLabel(helloOk.serverId);
    if (!podUsername) {
      return { ok: false, reason: "HELLO.serverId does not match <server>.<user>.flagship.services", closeCode: 1002 };
    }
    for (const fqdn of helloOk.controlledDomains) {
      const owner = ownerOfFqdn(fqdn);
      if (owner !== podUsername) {
        return {
          ok: false,
          reason: `HELLO.controlledDomains[${JSON.stringify(fqdn)}] is not under user ${podUsername}'s zone`,
          closeCode: 1008,
        };
      }
    }
    if (opts.authLookup) {
      const stkPub = await opts.authLookup(helloOk.serverId);
      if (!stkPub) {
        return { ok: false, reason: "serverId is not registered with the control plane", closeCode: 1008 };
      }
      const helloRecord = {
        serverId: helloOk.serverId,
        controlledDomains: helloOk.controlledDomains,
        nonce: helloOk.nonce,
        issuedAt: helloOk.issuedAt,
      };
      if (!verifyTunnelHello(helloRecord, helloOk.signature, stkPub)) {
        return { ok: false, reason: "HELLO signature failed verification", closeCode: 1008 };
      }
    }
    return { ok: true };
  }

  async function handleFrame(f: Frame): Promise<void> {
    if (!registered) {
      if (f.type !== FRAME_HELLO) {
        send(helloAckFrame(false, "expected HELLO as first frame"));
        ws.close(1002, "no HELLO");
        return;
      }
      const helloOk = parseHello(f.payload);
      if (!helloOk.ok) {
        send(helloAckFrame(false, helloOk.reason));
        ws.close(1002, "bad HELLO");
        return;
      }

      const auth = await authenticateHello(helloOk);
      if (!auth.ok) {
        send(helloAckFrame(false, auth.reason));
        ws.close(auth.closeCode, "auth failed");
        return;
      }

      const tunnel: RegisteredTunnel = {
        serverId: helloOk.serverId,
        controlledDomains: helloOk.controlledDomains,
        send,
        attachStream(streamId, cbs) {
          streams.set(streamId, cbs);
        },
        detachStream(streamId) {
          streams.delete(streamId);
        },
        nextStreamId() {
          return nextStream++;
        },
      };
      const reg = registry.register(tunnel);
      for (const t of reg.takeovers) {
        console.log(
          `[tunnel hub] takeover: ${t.fqdn} from ${t.previousServerId} → ${tunnel.serverId}`,
        );
      }
      registered = tunnel;
      lastHelloIssuedAt = helloOk.issuedAt;
      if (helloOk.controlledDomains.length === 0) armIdleClose();
      send(helloAckFrame(true));
      return;
    }

    if (f.type === FRAME_HELLO) {
      // HELLO update on a registered tunnel: re-authenticate, then
      // atomically replace the controlledDomains list.
      const helloOk = parseHello(f.payload);
      if (!helloOk.ok) {
        send(helloAckFrame(false, helloOk.reason));
        return;
      }
      if (helloOk.serverId !== registered.serverId) {
        send(helloAckFrame(false, "HELLO serverId changed mid-WS"));
        ws.close(1008, "serverId changed");
        return;
      }
      const auth = await authenticateHello(helloOk);
      if (!auth.ok) {
        send(helloAckFrame(false, auth.reason));
        // Don't close the WS; just refuse the update so the daemon can
        // retry. Hard rejections fold into close on the very next bad
        // HELLO via the freshness/identity invariants.
        return;
      }
      const result = registry.replaceClaims(registered, helloOk.controlledDomains);
      for (const t of result.takeovers) {
        console.log(
          `[tunnel hub] takeover: ${t.fqdn} from ${t.previousServerId} → ${registered.serverId}`,
        );
      }
      lastHelloIssuedAt = helloOk.issuedAt;
      if (helloOk.controlledDomains.length === 0) armIdleClose();
      else cancelIdleClose();
      send(helloAckFrame(true));
      return;
    }

    if (f.type === FRAME_DATA) {
      const cb = streams.get(f.streamId);
      if (cb) cb.onData(f.payload);
      return;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      const cb = streams.get(f.streamId);
      if (cb) cb.onRemoteClose();
      streams.delete(f.streamId);
      return;
    }
    // Unexpected control frame from client side; ignore.
  }
}

interface HelloPayload {
  serverId: string;
  controlledDomains: string[];
  nonce: Uint8Array;
  issuedAt: number;
  signature: Uint8Array;
}

type HelloParse = ({ ok: true } & HelloPayload) | { ok: false; reason: string };

function parseHello(payload: Uint8Array): HelloParse {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { ok: false, reason: "HELLO payload not JSON" };
  }
  if (typeof obj !== "object" || obj === null) return { ok: false, reason: "HELLO not object" };
  const o = obj as Record<string, unknown>;
  if (typeof o.serverId !== "string" || o.serverId.length === 0) {
    return { ok: false, reason: "HELLO.serverId missing" };
  }
  if (!Array.isArray(o.controlledDomains)) {
    return { ok: false, reason: "HELLO.controlledDomains missing" };
  }
  const sds: string[] = [];
  for (const sd of o.controlledDomains) {
    if (typeof sd !== "string" || sd.length === 0 || sd.length > 253) {
      return { ok: false, reason: "HELLO.controlledDomains contains invalid entry" };
    }
    sds.push(sd.toLowerCase());
  }
  if (typeof o.nonce !== "string" || !/^[0-9a-f]+$/.test(o.nonce) || o.nonce.length !== 64) {
    return { ok: false, reason: "HELLO.nonce must be 32-byte hex" };
  }
  if (typeof o.issuedAt !== "number" || !Number.isFinite(o.issuedAt)) {
    return { ok: false, reason: "HELLO.issuedAt must be a number" };
  }
  if (typeof o.signature !== "string" || !/^[0-9a-f]+$/.test(o.signature) || o.signature.length !== 128) {
    return { ok: false, reason: "HELLO.signature must be 64-byte hex" };
  }
  return {
    ok: true,
    serverId: o.serverId,
    controlledDomains: sds,
    nonce: hexToBytes(o.nonce),
    issuedAt: o.issuedAt,
    signature: hexToBytes(o.signature),
  };
}

/**
 * For a serverId of the form `<server>.<user>.flagship.services`,
 * return `<user>`. Returns null if the shape doesn't match.
 *
 * The label between the server and the apex is the username; the hub
 * uses it as the per-pod identity check anchor.
 */
function extractMiddleLabel(serverId: string): string | null {
  const lower = serverId.toLowerCase();
  if (!lower.endsWith(".flagship.services")) return null;
  const head = lower.slice(0, -".flagship.services".length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(user)) return null;
  return user;
}

/**
 * The user (middle label) that owns a claimed FQDN. For
 * `<*|app>.<user>.flagship.services` returns `<user>`. For
 * `<server>.<user>.flagship.services` returns `<user>`. For anything
 * else returns null.
 */
function ownerOfFqdn(fqdn: string): string | null {
  const lower = fqdn.toLowerCase();
  if (!lower.endsWith(".flagship.services")) return null;
  const head = lower.slice(0, -".flagship.services".length);
  if (head.length === 0) return null;
  const parts = head.split(".");
  // The owner is always the rightmost remaining label.
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(user)) return null;
  return user;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

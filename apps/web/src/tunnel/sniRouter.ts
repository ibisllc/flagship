import { createServer, type Server, type Socket } from "node:net";
import {
  closeFrame,
  dataFrame,
  openFrame,
  parseClientHelloSni,
} from "@flagship/tunnel-protocol";
import type { TunnelRegistry } from "./registry.js";

export interface SniRouterOptions {
  port: number;
  host?: string;
  /** Max bytes to buffer waiting for the ClientHello before giving up. */
  maxPeekBytes?: number;
  /** Max wall-clock time (ms) to wait for a ClientHello before closing. */
  peekTimeoutMs?: number;
}

export interface RunningSniRouter {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_PEEK_BYTES = 16 * 1024; // covers any plausible ClientHello
const DEFAULT_PEEK_TIMEOUT_MS = 10_000;

export function startSniRouter(
  registry: TunnelRegistry,
  opts: SniRouterOptions,
): Promise<RunningSniRouter> {
  const maxPeek = opts.maxPeekBytes ?? DEFAULT_MAX_PEEK_BYTES;
  const peekTimeoutMs = opts.peekTimeoutMs ?? DEFAULT_PEEK_TIMEOUT_MS;

  const server: Server = createServer((client) => handleConnection(client, registry, maxPeek, peekTimeoutMs));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("router failed to obtain address"));
        return;
      }
      resolve({
        port: address.port,
        close() {
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

function handleConnection(
  client: Socket,
  registry: TunnelRegistry,
  maxPeek: number,
  peekTimeoutMs: number,
): void {
  let peeked: Uint8Array = new Uint8Array(0);
  let resolved = false;

  const peekTimer = setTimeout(() => {
    if (!resolved) {
      client.destroy(new Error("ClientHello peek timeout"));
    }
  }, peekTimeoutMs);

  const onData = (chunk: Buffer) => {
    if (resolved) return;
    peeked = concat(peeked, bufferToBytes(chunk));
    if (peeked.length > maxPeek) {
      bail("peek buffer exceeded");
      return;
    }
    const r = parseClientHelloSni(peeked);
    if (r.kind === "incomplete") return; // keep buffering
    resolved = true;
    clearTimeout(peekTimer);
    client.off("data", onData);
    if (r.kind === "error") {
      bail(`ClientHello error: ${r.reason}`);
      return;
    }
    if (r.sni === null) {
      bail("no SNI — refusing to route");
      return;
    }
    routeToTunnel(client, registry, r.sni, peeked);
  };

  function bail(reason: string): void {
    if (!resolved) {
      resolved = true;
      clearTimeout(peekTimer);
    }
    client.destroy(new Error(reason));
  }

  client.on("data", onData);
  client.once("error", () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(peekTimer);
    }
  });
}

function routeToTunnel(
  client: Socket,
  registry: TunnelRegistry,
  sni: string,
  initialBytes: Uint8Array,
): void {
  const tunnel = registry.findBySni(sni);
  if (!tunnel) {
    client.destroy(new Error(`no tunnel for ${sni}`));
    return;
  }
  const streamId = tunnel.nextStreamId();
  let closed = false;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    tunnel.detachStream(streamId);
    try {
      tunnel.send(closeFrame(streamId, false));
    } catch {
      /* tunnel may be down */
    }
  };

  tunnel.attachStream(streamId, {
    onData(data) {
      client.write(Buffer.from(data));
    },
    onRemoteClose() {
      closed = true;
      tunnel.detachStream(streamId);
      client.end();
    },
  });

  // Hand off the ClientHello bytes we already buffered.
  tunnel.send(openFrame(streamId, sni));
  tunnel.send(dataFrame(streamId, initialBytes));

  client.on("data", (chunk: Buffer) => {
    tunnel.send(dataFrame(streamId, bufferToBytes(chunk)));
  });
  client.on("end", closeStream);
  client.on("close", closeStream);
  client.on("error", () => closeStream());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bufferToBytes(b: Buffer): Uint8Array {
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}

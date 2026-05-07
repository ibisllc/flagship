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
  FRAME_DOMAIN_GRANTED,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_OPEN,
  requestTransferFrame,
  type Frame,
} from "@flagship/tunnel-protocol";
import {
  appEntitlementCertId,
  rootEntitlementCertId,
  signTunnelHelloV2,
  type AppEntitlement,
  type Bytes,
  type Keypair,
  type RootEntitlement,
  type TunnelHelloV2,
} from "@flagship/protocol";

export interface BackendTarget {
  host: string;
  port: number;
}

export type BackendResolver = (sni: string) => BackendTarget | null;

/**
 * Snapshot of the entitlement certs the daemon currently holds. The
 * daemon caches these on disk (re-loaded on boot) and presents them
 * on every HELLO. The phone re-issues + ships fresh certs whenever
 * apps change OR on rolling refresh before TTL.
 */
export interface EntitlementBundle {
  rootEntitlement: RootEntitlement;
  rootEntitlementSig: Bytes;
  /** Optional. Pods can boot with no apps yet (root-only HELLO). */
  appEntitlement?: AppEntitlement | null;
  appEntitlementSig?: Bytes | null;
}

export interface TunnelClientOptions {
  /** ws:// or wss:// URL of the control-plane tunnel hub. */
  hubUrl: string;
  /** Pod's STK keypair (signs the HELLO envelope). */
  signingKey: Keypair;
  /**
   * Source of fresh entitlement bundles. Called every HELLO so the
   * pod can pick up rotated certs on the fly. The serverId for HELLO
   * is taken from `bundle.rootEntitlement.podCanonical`.
   */
  getEntitlements: () => EntitlementBundle | Promise<EntitlementBundle>;
  /** Given an SNI hostname, return the local backend to forward to. */
  resolveBackend: BackendResolver;
  /**
   * Called when the hub broadcasts a domain-granted event (FRAME 0x12).
   * Daemon plumbs into the in-pod live-siblings router so apps observe
   * the grant via /api/live_siblings/poll. Optional.
   */
  onDomainGranted?: (e: { fqdn: string; ownerServerId: string }) => void;
}

export interface TunnelClient {
  /** Resolves once HELLO_ACK is received and registration is confirmed. */
  ready(): Promise<void>;
  /**
   * Re-send a HELLO with the latest entitlement bundle. Used after
   * the phone delivers fresh certs (new app installed, rotation).
   * Idempotent.
   */
  rehello(): Promise<void>;
  /**
   * Ask the hub to transfer ownership of `fqdn` to this pod. The hub
   * validates the pod has a derivable claim (via the cert it
   * presented at HELLO) and atomically reassigns. Result surfaces via
   * the next FRAME_DOMAIN_GRANTED broadcast.
   */
  requestTransfer(fqdn: string): void;
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
  let lastIssuedAt = 0;

  function send(frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame), { binary: true });
  }

  async function sendHello(): Promise<void> {
    const bundle = await opts.getEntitlements();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    let issuedAt = Date.now();
    if (issuedAt <= lastIssuedAt) issuedAt = lastIssuedAt + 1;
    lastIssuedAt = issuedAt;
    const rootCertId = await rootEntitlementCertId(bundle.rootEntitlement);
    const appCertId = bundle.appEntitlement
      ? await appEntitlementCertId(bundle.appEntitlement)
      : "";
    const envelope: TunnelHelloV2 = {
      serverId: bundle.rootEntitlement.podCanonical,
      rootEntitlementCertId: rootCertId,
      appEntitlementCertId: appCertId,
      nonce,
      issuedAt,
    };
    const signature = signTunnelHelloV2(envelope, opts.signingKey);
    const payload = JSON.stringify({
      version: 2,
      serverId: bundle.rootEntitlement.podCanonical,
      rootEntitlement: {
        username: bundle.rootEntitlement.username,
        podPubKey: bytesToHex(bundle.rootEntitlement.podPubKey),
        podCanonical: bundle.rootEntitlement.podCanonical,
        issuedAt: bundle.rootEntitlement.issuedAt,
      },
      rootEntitlementSig: bytesToHex(bundle.rootEntitlementSig),
      rootEntitlementCertId: rootCertId,
      appEntitlement: bundle.appEntitlement
        ? {
            username: bundle.appEntitlement.username,
            podPubKey: bytesToHex(bundle.appEntitlement.podPubKey),
            canonicals: bundle.appEntitlement.canonicals,
            issuedAt: bundle.appEntitlement.issuedAt,
            expiresAt: bundle.appEntitlement.expiresAt,
          }
        : null,
      appEntitlementSig: bundle.appEntitlementSig ? bytesToHex(bundle.appEntitlementSig) : null,
      appEntitlementCertId: appCertId,
      nonce: bytesToHex(nonce),
      issuedAt,
      signature: bytesToHex(signature),
    });
    send({
      streamId: 0,
      type: FRAME_HELLO,
      payload: new TextEncoder().encode(payload),
    });
  }

  ws.on("open", () => {
    void sendHello();
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
    if (f.type === FRAME_DOMAIN_GRANTED) {
      if (!opts.onDomainGranted) return;
      try {
        const body = JSON.parse(new TextDecoder().decode(f.payload)) as {
          fqdn?: unknown;
          ownerServerId?: unknown;
        };
        if (typeof body.fqdn === "string" && typeof body.ownerServerId === "string") {
          opts.onDomainGranted({ fqdn: body.fqdn, ownerServerId: body.ownerServerId });
        }
      } catch {
        /* malformed; drop */
      }
      return;
    }
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
      sock.on("end", () => send(closeFrame(f.streamId, true)));
      sock.on("close", () => streams.delete(f.streamId));
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
    rehello: () => sendHello(),
    requestTransfer: (fqdn: string) => {
      send(requestTransferFrame({ fqdn: fqdn.toLowerCase() }));
    },
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

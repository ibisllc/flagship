// `.services` side of the per-account gossip fan-out (Phase 4).
//
//   POST  https://broadcast--<user>.<apex>/   (any path)
//     body = OPAQUE, end-to-end-encrypted (CGK-sealed) gossip blob
//     → the hub looks up every connected tunnel of `<user>`'s account and
//       delivers the VERBATIM body to each via the box-side inbound gossip
//       endpoint `POST /internal/gossip` over the tunnel (content-blind).
//     → responds 204 EMPTY — no membership count / liveness leaks back.
//
// The hub NEVER decrypts or parses the body. Recognition is by the request
// Host (`broadcast--<user>.<apex>`), which is TLS-TERMINATED here (a *.flagship
// .services cert terminates it) — NOT SNI-passthrough, because the target is N
// boxes, not one. The sender excludes itself via an optional header.
//
// Implemented as an `onRequest` hook (not a normal route) so it claims ONLY
// requests to the broadcast host — by Host, before Fastify routing — and never
// collides with the other POST routes on a `surface:"both"` instance. It reads
// the raw body off the socket itself (the body is opaque bytes, not JSON), so
// no global content-type parser is touched.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TunnelRegistry } from "../tunnel/registry.js";
import { fanOutGossip, parseGossipHost } from "../tunnel/gossipFanout.js";

export interface GossipFanoutRouteOptions {
  registry: TunnelRegistry;
  /** Data-plane apex (`flagship.services` prod, `gym.flagship.services` test). */
  apex: string;
  /**
   * Max opaque body size accepted (bytes). The hub is content-blind but still
   * caps the relay so a single POST can't fan a huge buffer to every box.
   * Defaults to the tunnel frame max (1 MiB).
   */
  maxBodyBytes?: number;
}

/**
 * The sender box names itself here so the hub can exclude it from its own
 * fan-out (a box should not re-receive the gossip it just sent). The value is
 * the sender's pod canonical. Harmless/ignored if absent or unrecognized.
 */
export const GOSSIP_SENDER_HEADER = "x-flagship-gossip-sender";

const DEFAULT_MAX_BODY = 1 << 20; // 1 MiB — matches MAX_FRAME_PAYLOAD.

export function registerGossipFanout(
  app: FastifyInstance,
  opts: GossipFanoutRouteOptions,
): void {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers["host"] as string | undefined) ?? "";
    const user = parseGossipHost(host, opts.apex);
    if (!user) return; // not a gossip target — let normal routing handle it.

    // The broadcast host is a fan-out submit endpoint: POST only.
    if (req.method !== "POST") {
      reply.code(405).header("allow", "POST").send();
      return reply;
    }

    let opaque: Uint8Array;
    try {
      opaque = await readBody(req, maxBody);
    } catch (e) {
      if ((e as { tooLarge?: boolean }).tooLarge) {
        reply.code(413).send();
        return reply;
      }
      reply.code(400).send();
      return reply;
    }

    const senderHeader = req.headers[GOSSIP_SENDER_HEADER];
    const sender =
      typeof senderHeader === "string" && senderHeader.length > 0
        ? senderHeader
        : undefined;

    // Fan out. The result count is hub-internal ONLY — we DO NOT return it.
    fanOutGossip(opts.registry, user, opaque, sender);

    // Return NOTHING: empty 204 so no membership count / liveness leaks back.
    reply.code(204).send();
    return reply;
  });
}

/** Drain the raw request body into a single Uint8Array, capping at `max`. */
function readBody(req: FastifyRequest, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = req.raw;
    const onData = (c: Buffer) => {
      total += c.byteLength;
      if (total > max) {
        cleanup();
        stream.destroy();
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      cleanup();
      resolve(new Uint8Array(Buffer.concat(chunks, total)));
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onErr);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onErr);
  });
}

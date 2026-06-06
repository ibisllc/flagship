import type { FastifyInstance } from "fastify";
import {
  handleNfcRendezvousConsume,
  handleNfcRendezvousDeposit,
} from "@flagship/control-plane";
import {
  InMemoryNfcRendezvousStorage,
  type NfcRendezvousStorage,
} from "@flagship/storage";

/**
 * C3 — NFC tap-to-pair rendezvous (cloud-side drop-box).
 *
 * Phone → POST /api/nfc/rendezvous/:rendezvousId/wifi
 *   Body: { sealedHex: string; nonceHex: string }
 *
 * Box  → GET  /api/nfc/rendezvous/:rendezvousId/wifi
 *   Response: { rendezvousId, sealedHex, nonceHex, depositedAt }
 *   One-shot — the row is deleted on read.
 *
 * No auth at this layer: the blob is AEAD-sealed under K_session
 * (the ECDH both sides derived from the NFC tap). The Worker enforces
 * per-IP + per-slot rate limits at the edge.
 *
 * See packages/control-plane/src/nfcRendezvous.ts for the handler
 * contracts + edge protections.
 */

export interface NfcRendezvousOptions {
  /** Defaults to an in-memory store — fine for dev / tests. */
  rendezvous?: NfcRendezvousStorage;
  /** Override the deposit TTL (default 15 min). */
  ttlMs?: number;
  now?: () => number;
}

export function registerNfcRendezvous(
  app: FastifyInstance,
  opts: NfcRendezvousOptions = {},
): void {
  const deps = {
    rendezvous: opts.rendezvous ?? new InMemoryNfcRendezvousStorage(),
    ttlMs: opts.ttlMs,
    now: opts.now,
  };

  app.post<{ Params: { rendezvousId: string } }>(
    "/api/nfc/rendezvous/:rendezvousId/wifi",
    async (req, reply) => {
      const r = await handleNfcRendezvousDeposit(
        deps,
        req.params.rendezvousId,
        req.body as never,
      );
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );

  app.get<{ Params: { rendezvousId: string } }>(
    "/api/nfc/rendezvous/:rendezvousId/wifi",
    async (req, reply) => {
      const r = await handleNfcRendezvousConsume(deps, req.params.rendezvousId);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );
}

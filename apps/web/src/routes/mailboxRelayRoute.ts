/**
 * `POST /pb/m/<mailboxId>`: an owner's sealed envelope for a holder's
 * mailbox (docs/peer-backup.md §5.3). Carried over the holder's tunnel and
 * answered with the sealed reply. Nothing is logged or kept; the number of
 * envelopes in flight is capped so a burst can't exhaust the machine.
 */
import type { FastifyInstance } from "fastify";
import { MAIL_MAX_ENVELOPE } from "@flagship/tunnel-protocol";
import type { MailboxRegistry } from "../tunnel/mailboxRelay.js";

export interface MailboxRelayRouteOptions {
  mailboxes: MailboxRegistry;
  /** Envelopes in flight across the machine. Default 16. */
  maxInFlight?: number;
}

export function registerMailboxRelay(app: FastifyInstance, o: MailboxRelayRouteOptions): void {
  let inFlight = 0;
  const max = o.maxInFlight ?? 16;
  void app.register(async (sub) => {
    sub.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAIL_MAX_ENVELOPE }, (_req, body, done) => done(null, body));
    sub.post<{ Params: { mailbox: string } }>("/pb/m/:mailbox", { bodyLimit: MAIL_MAX_ENVELOPE }, async (req, reply) => {
      const id = req.params.mailbox;
      if (!/^[0-9a-f]{32}$/.test(id)) return reply.code(400).send({ error: "bad mailbox" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "send the sealed envelope as application/octet-stream" });
      if (!o.mailboxes.has(id)) return reply.code(404).send({ error: "that holder isn't connected here" });
      if (inFlight >= max) return reply.code(503).header("retry-after", "5").send({ error: "busy" });
      inFlight++;
      try {
        const r = await o.mailboxes.deliver(id, new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
        if (!r) return reply.code(404).send({ error: "that holder isn't connected here" });
        if (r.status !== 200) return reply.code(r.status === 504 ? 504 : 502).send({ error: "the holder didn't answer" });
        return reply.code(200).header("content-type", "application/octet-stream").header("cache-control", "no-store").send(Buffer.from(r.body));
      } finally {
        inFlight--;
      }
    });
  });
}

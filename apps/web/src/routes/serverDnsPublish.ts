import type { FastifyInstance } from "fastify";
import {
  verifyPublishServerDns,
  type PublishServerDns,
} from "@flagship/protocol";
import type { ServerDnsPublisher } from "@flagship/services-zone";
import { hexToBytes } from "../lib/hex.js";

/**
 * .services route: phone tells us how to publish DNS for a server.
 * Pure-control-plane; no traffic touches this. The DNS records that get
 * written either point at the tunnel ingress (default for NATed servers)
 * or at the user's own A record (for users with dedicated IPs).
 */
export interface PublishServerDnsOptions {
  publisher: ServerDnsPublisher;
  resolveUserIrk: (userId: string) => Uint8Array | null;
  maxAgeMs?: number;
  now?: () => number;
}

interface Body {
  request?: {
    userId?: string;
    serverId?: string;
    mode?: "tunnel" | "direct";
    directIp?: string;
    issuedAt?: number;
  };
  signature?: string;
}

export function registerServerDnsPublish(
  app: FastifyInstance,
  opts: PublishServerDnsOptions,
): void {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  app.post<{ Body: Body }>("/api/services-zone/publish-server", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      typeof r.serverId !== "string" ||
      (r.mode !== "tunnel" && r.mode !== "direct") ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (r.mode === "direct" && (typeof r.directIp !== "string" || r.directIp.length === 0)) {
      return reply.status(400).send({ error: "directIp required when mode=direct" });
    }

    const irkPub = opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }
    const claim: PublishServerDns = {
      userId: r.userId,
      serverId: r.serverId,
      mode: r.mode,
      directIp: r.directIp ?? "",
      issuedAt: r.issuedAt,
    };
    if (!verifyPublishServerDns(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return reply.status(403).send({ error: "stale request" });
    }

    try {
      const out = await opts.publisher.publish({
        username: r.userId,
        serverName: r.serverId,
        mode: r.mode,
        directIp: r.mode === "direct" ? r.directIp : undefined,
      });
      return out;
    } catch (e) {
      return reply.status(500).send({ error: "publish failed", message: errMsg(e) });
    }
  });

  app.delete<{ Params: { userId: string; serverId: string }; Body: Body }>(
    "/api/services-zone/server/:userId/:serverId",
    async (req, reply) => {
      const body = req.body ?? {};
      // Removal also requires an IRK-signed claim with mode="tunnel" (or any
      // mode — we only care that the IRK verifies for this user). Reuse the
      // same shape rather than minting a separate canonical-bytes tag.
      const r = body.request;
      if (
        !r ||
        typeof body.signature !== "string" ||
        typeof r.userId !== "string" ||
        r.userId !== req.params.userId ||
        typeof r.serverId !== "string" ||
        r.serverId !== req.params.serverId
      ) {
        return reply.status(400).send({ error: "signature must commit to URL params" });
      }
      const irkPub = opts.resolveUserIrk(req.params.userId);
      if (!irkPub) return reply.status(404).send({ error: "unknown user" });
      let sig: Uint8Array;
      try {
        sig = hexToBytes(body.signature);
      } catch {
        return reply.status(400).send({ error: "invalid hex signature" });
      }
      const claim: PublishServerDns = {
        userId: r.userId,
        serverId: r.serverId,
        mode: r.mode === "direct" ? "direct" : "tunnel",
        directIp: r.directIp ?? "",
        issuedAt: r.issuedAt ?? 0,
      };
      if (!verifyPublishServerDns(claim, sig, irkPub)) {
        return reply.status(403).send({ error: "invalid signature" });
      }
      if (
        typeof claim.issuedAt === "number" &&
        Math.abs(now() - claim.issuedAt) > maxAgeMs
      ) {
        return reply.status(403).send({ error: "stale request" });
      }
      await opts.publisher.unpublish({
        username: req.params.userId,
        serverName: req.params.serverId,
      });
      return { ok: true };
    },
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

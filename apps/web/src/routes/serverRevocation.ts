import type { FastifyInstance } from "fastify";
import {
  verifyRevocation,
  type RevocationReason,
  type ServerRevocation,
} from "@flagship/protocol";
import { hexToBytes } from "../lib/hex.js";
import type { ServerRegistry } from "./serverRegistry.js";

export interface ServerRevocationOptions {
  registry: ServerRegistry;
  resolveUserIrk: (userId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  /** Replay window. Default 5 min. */
  maxAgeMs?: number;
  now?: () => number;
  /**
   * Optional hook fired after a successful revocation. Used for, e.g.,
   * dropping the server out of the peer-backup matchmaker pool, sending a
   * confirmation push, or unwiring the tunnel registry.
   */
  onRevoked?: (reg: ServerRevocation) => void | Promise<void>;
}

interface Body {
  request?: {
    userId?: string;
    revokedServerId?: string;
    reason?: RevocationReason;
    issuedAt?: number;
  };
  signature?: string;
}

const VALID_REASONS: ReadonlySet<RevocationReason> = new Set(["lost", "stolen", "decommissioned"]);

export function registerServerRevocation(app: FastifyInstance, opts: ServerRevocationOptions): void {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  app.post<{ Body: Body }>("/api/server-registry/revoke", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      typeof r.revokedServerId !== "string" ||
      typeof r.reason !== "string" ||
      !VALID_REASONS.has(r.reason as RevocationReason) ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }

    const irkPub = await opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }

    const revocation: ServerRevocation = {
      userId: r.userId,
      revokedServerId: r.revokedServerId,
      reason: r.reason,
      issuedAt: r.issuedAt,
    };

    if (!verifyRevocation(revocation, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }

    const age = now() - revocation.issuedAt;
    if (age > maxAgeMs || age < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    const target = opts.registry.get(r.revokedServerId);
    if (!target) return reply.status(404).send({ error: "unknown server" });
    if (target.userId !== r.userId) {
      // Cannot revoke someone else's server. The IRK signature already
      // ensures *which* user signed; this defends against the IRK and
      // serverId being mismatched in the revocation body.
      return reply.status(403).send({ error: "server is not owned by signer" });
    }

    const ok = opts.registry.revoke(revocation.revokedServerId, revocation.reason, now());
    if (!ok) return reply.status(500).send({ error: "registry rejected revocation" });

    if (opts.onRevoked) {
      try {
        await opts.onRevoked(revocation);
      } catch {
        // best-effort: revocation succeeded in the registry, side-effects logged elsewhere
      }
    }
    return { ok: true };
  });
}

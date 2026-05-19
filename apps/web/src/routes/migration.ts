import type { FastifyInstance } from "fastify";
import {
  verifyMigrationRequest,
  type MigrationRequest,
} from "@flagship/protocol";
import { hexToBytes, bytesToHex } from "../lib/hex.js";

/**
 * Matchmaker for app migration. Both sender and recipient sign with their
 * respective IRKs; the control plane verifies the signatures and brokers the
 * destination tunnel address. Bytes never flow through this service — once
 * matchmaking succeeds, the source server pushes git + data directly to the
 * destination server's tunnel.
 *
 * State machine:
 *   pending  → sender posted /start; awaiting recipient consent
 *   accepted → recipient posted /accept with a verifying acceptance signature
 *   rejected → recipient declined or session expired
 *   completed → either side posted /complete with an acknowledgement receipt
 */

type SessionStatus = "pending" | "accepted" | "rejected" | "completed";

interface MigrationSession {
  id: string;
  request: MigrationRequest;
  fromIrkPubHex: string;
  toIrkPubHex: string;
  status: SessionStatus;
  createdAt: number;
  acceptedAt?: number;
  completedAt?: number;
  /** Tunnel info for the recipient — opaque to control plane. */
  recipientTunnelInfo?: string;
}

const DEFAULT_TTL_MS = 30 * 60_000;

export interface MigrationOptions {
  /** Resolve a userId to its registered IRK pubkey. */
  resolveIrkPubKey: (userId: string) => Uint8Array | null;
  ttlMs?: number;
  now?: () => number;
}

interface StartBody {
  request: {
    serviceId: string;
    fromUser: string;
    toUser: string;
    mode: "cut" | "copy";
    withData: boolean;
    issuedAt: number;
  };
  signature: string;
}

interface AcceptBody {
  sessionId: string;
  signature: string;
  recipientTunnelInfo: string;
}

interface CompleteBody {
  sessionId: string;
  side: "sender" | "recipient";
  signature: string;
}

export function registerMigration(app: FastifyInstance, opts: MigrationOptions): void {
  const sessions = new Map<string, MigrationSession>();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  function expire(s: MigrationSession): void {
    if (s.status !== "pending") return;
    if (now() - s.createdAt > ttl) s.status = "rejected";
  }

  app.post<{ Body: StartBody }>("/api/migration/start", async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      !body.request ||
      typeof body.signature !== "string" ||
      typeof body.request.serviceId !== "string" ||
      typeof body.request.fromUser !== "string" ||
      typeof body.request.toUser !== "string" ||
      (body.request.mode !== "cut" && body.request.mode !== "copy") ||
      typeof body.request.withData !== "boolean" ||
      typeof body.request.issuedAt !== "number"
    ) {
      return reply.status(400).send({ error: "malformed start body" });
    }

    const fromIrk = opts.resolveIrkPubKey(body.request.fromUser);
    if (!fromIrk) {
      return reply.status(403).send({ error: "fromUser has no registered IRK" });
    }
    const toIrk = opts.resolveIrkPubKey(body.request.toUser);
    if (!toIrk) {
      return reply.status(403).send({ error: "toUser has no registered IRK" });
    }
    if (body.request.fromUser === body.request.toUser) {
      return reply.status(400).send({ error: "fromUser and toUser must differ" });
    }

    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "signature not hex" });
    }
    if (sig.length !== 64) return reply.status(400).send({ error: "signature wrong length" });

    const request: MigrationRequest = body.request;
    if (!verifyMigrationRequest(request, sig, fromIrk)) {
      return reply.status(403).send({ error: "invalid sender signature" });
    }
    const age = now() - request.issuedAt;
    if (age > 5 * 60_000 || age < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    const idBytes = new Uint8Array(8);
    crypto.getRandomValues(idBytes);
    const sessionId = bytesToHex(idBytes);
    sessions.set(sessionId, {
      id: sessionId,
      request,
      fromIrkPubHex: bytesToHex(fromIrk),
      toIrkPubHex: bytesToHex(toIrk),
      status: "pending",
      createdAt: now(),
    });
    return { sessionId, status: "pending", expiresAt: now() + ttl };
  });

  app.get<{ Params: { id: string } }>("/api/migration/:id/state", async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) return reply.status(404).send({ error: "session not found" });
    expire(s);
    return {
      sessionId: s.id,
      status: s.status,
      request: s.request
        ? {
            serviceId: s.request.serviceId,
            fromUser: s.request.fromUser,
            toUser: s.request.toUser,
            mode: s.request.mode,
            withData: s.request.withData,
            issuedAt: s.request.issuedAt,
          }
        : undefined,
      recipientTunnelInfo: s.recipientTunnelInfo,
    };
  });

  app.post<{ Body: AcceptBody }>("/api/migration/accept", async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      typeof body.sessionId !== "string" ||
      typeof body.signature !== "string" ||
      typeof body.recipientTunnelInfo !== "string"
    ) {
      return reply.status(400).send({ error: "malformed accept body" });
    }
    const s = sessions.get(body.sessionId);
    if (!s) return reply.status(404).send({ error: "session not found" });
    expire(s);
    if (s.status !== "pending") {
      return reply.status(409).send({ error: `session is ${s.status}` });
    }

    const toIrk = opts.resolveIrkPubKey(s.request.toUser);
    if (!toIrk) {
      return reply.status(500).send({ error: "toUser IRK lookup vanished" });
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "signature not hex" });
    }
    // Recipient signs the same MigrationRequest bytes — proves they accept the
    // exact terms (mode, withData, etc.) the sender proposed.
    if (!verifyMigrationRequest(s.request, sig, toIrk)) {
      return reply.status(403).send({ error: "invalid recipient signature" });
    }

    s.status = "accepted";
    s.acceptedAt = now();
    s.recipientTunnelInfo = body.recipientTunnelInfo;
    return { sessionId: s.id, status: "accepted" };
  });

  app.post<{ Body: CompleteBody }>("/api/migration/complete", async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      typeof body.sessionId !== "string" ||
      (body.side !== "sender" && body.side !== "recipient") ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed complete body" });
    }
    const s = sessions.get(body.sessionId);
    if (!s) return reply.status(404).send({ error: "session not found" });
    if (s.status !== "accepted") {
      return reply.status(409).send({ error: `session is ${s.status}` });
    }
    const irk =
      body.side === "sender"
        ? opts.resolveIrkPubKey(s.request.fromUser)
        : opts.resolveIrkPubKey(s.request.toUser);
    if (!irk) {
      return reply.status(500).send({ error: "IRK lookup vanished" });
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "signature not hex" });
    }
    if (!verifyMigrationRequest(s.request, sig, irk)) {
      return reply.status(403).send({ error: "invalid completion signature" });
    }
    s.status = "completed";
    s.completedAt = now();
    return { sessionId: s.id, status: "completed" };
  });
}

import type { FastifyInstance } from "fastify";
import { bytesToHex } from "../lib/hex.js";

interface QrSession {
  id: string;
  challenge: Uint8Array;
  createdAt: number;
  status: "pending" | "approved" | "denied" | "expired";
}

const SESSION_TTL_MS = 2 * 60_000;

export function registerQrAuth(app: FastifyInstance): void {
  const sessions = new Map<string, QrSession>();

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > SESSION_TTL_MS && s.status === "pending") {
        s.status = "expired";
      }
      if (now - s.createdAt > SESSION_TTL_MS * 5) sessions.delete(id);
    }
  }, 30_000).unref();

  app.post("/api/qr/start", async () => {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const id = bytesToHex(challenge).slice(0, 16);
    const session: QrSession = {
      id,
      challenge,
      createdAt: Date.now(),
      status: "pending",
    };
    sessions.set(id, session);
    return {
      sessionId: id,
      challenge: bytesToHex(challenge),
      qrPayload: `flagship://qr/${id}/${bytesToHex(challenge)}`,
      ttlSeconds: SESSION_TTL_MS / 1000,
    };
  });

  app.get<{ Params: { id: string } }>("/api/qr/:id/status", async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) return reply.status(404).send({ error: "session not found" });
    return { sessionId: s.id, status: s.status };
  });

  // Phone calls this after biometric-gated approval. Real impl will verify
  // an Ed25519 signature over the challenge using a registered user IRK pubkey.
  app.post<{ Params: { id: string }; Body: { approved: boolean } }>(
    "/api/qr/:id/respond",
    async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.status(404).send({ error: "session not found" });
      if (s.status !== "pending") {
        return reply.status(409).send({ error: `session already ${s.status}` });
      }
      s.status = req.body?.approved ? "approved" : "denied";
      return { sessionId: s.id, status: s.status };
    },
  );
}

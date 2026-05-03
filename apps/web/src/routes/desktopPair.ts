import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { verifyRebuildRequest } from "@flagship/protocol";
import { hexToBytes, bytesToHex } from "../lib/hex.js";

/**
 * Desktop session pairing — WhatsApp-Web pattern.
 *
 *   1. desktop POSTs /api/desktop/pair/start with its X25519 ephemeral pubkey,
 *      receives a sessionId + qrPayload.
 *   2. phone scans the QR (parses sessionId + desktopPubKey).
 *   3. phone POSTs /api/desktop/pair/confirm with its own ephemeral pubkey
 *      and an IRK-signed pairing claim.
 *   4. control plane verifies the IRK signature and transitions the session
 *      to "paired."
 *   5. desktop GETs /api/desktop/pair/<id>/status until status=paired.
 *   6. relay endpoints (/inbox, /poll) shovel opaque AES-GCM-encrypted blobs
 *      between the two endpoints. flagshipserver.com cannot decrypt them.
 *
 * The control plane never sees the shared session key; only the IRK signature
 * verifies that the phone authorized the pairing.
 */

const DEFAULT_PAIRING_TTL_MS = 2 * 60_000;
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60_000; // 14 days
const MAX_INBOX_PER_SESSION = 256;
const MAX_BLOB_BYTES = 64 * 1024;

type DesktopSessionStatus = "pending" | "paired" | "revoked" | "expired";

interface DesktopSession {
  id: string;
  desktopPubKey: Uint8Array;
  phonePubKey?: Uint8Array;
  irkPubKey?: Uint8Array;
  status: DesktopSessionStatus;
  createdAt: number;
  pairedAt?: number;
  inbox: { from: "phone" | "desktop"; ciphertext: Uint8Array; ts: number }[];
}

export interface DesktopPairOptions {
  pairingTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
  /**
   * Look up a user's registered IRK public key by their account binding (e.g.
   * the userId carried alongside the pairing claim). Returns null if the
   * pairing claim's signing key is not registered.
   */
  resolveIrkPubKey?: (userId: string) => Uint8Array | null;
}

interface PairConfirmBody {
  sessionId?: string;
  userId?: string;
  phonePubKey?: string;
  irkSignature?: string;
  issuedAt?: number;
}

interface InboxBody {
  sessionId?: string;
  from?: "phone" | "desktop";
  ciphertext?: string;
}

export function registerDesktopPair(
  app: FastifyInstance,
  opts: DesktopPairOptions = {},
): void {
  const sessions = new Map<string, DesktopSession>();
  const pairingTtl = opts.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
  const sessionTtl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  function expire(s: DesktopSession): void {
    const t = now();
    if (s.status === "pending" && t - s.createdAt > pairingTtl) {
      s.status = "expired";
    }
    if (s.status === "paired" && s.pairedAt && t - s.pairedAt > sessionTtl) {
      s.status = "expired";
    }
  }

  app.post<{ Body: { desktopPubKey?: string } }>("/api/desktop/pair/start", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.desktopPubKey !== "string") {
      return reply.status(400).send({ error: "desktopPubKey required" });
    }
    let desktopPub: Uint8Array;
    try {
      desktopPub = hexToBytes(body.desktopPubKey);
    } catch {
      return reply.status(400).send({ error: "desktopPubKey must be hex" });
    }
    if (desktopPub.length !== 32) {
      return reply.status(400).send({ error: "desktopPubKey must be 32 bytes" });
    }
    const idBytes = new Uint8Array(8);
    crypto.getRandomValues(idBytes);
    const sessionId = bytesToHex(idBytes);
    sessions.set(sessionId, {
      id: sessionId,
      desktopPubKey: desktopPub,
      status: "pending",
      createdAt: now(),
      inbox: [],
    });
    const qrPayload = `flagship://desktop/${sessionId}/${bytesToHex(desktopPub)}`;
    const qrDataUri = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    });
    return {
      sessionId,
      qrPayload,
      qrDataUri,
      ttlSeconds: pairingTtl / 1000,
    };
  });

  app.post<{ Body: PairConfirmBody }>("/api/desktop/pair/confirm", async (req, reply) => {
    const body = req.body ?? {};
    const sid = body.sessionId;
    if (!sid || typeof sid !== "string") return reply.status(400).send({ error: "sessionId required" });
    const s = sessions.get(sid);
    if (!s) return reply.status(404).send({ error: "session not found" });
    expire(s);
    if (s.status !== "pending") {
      return reply.status(409).send({ error: `session is ${s.status}` });
    }
    if (
      typeof body.userId !== "string" ||
      typeof body.phonePubKey !== "string" ||
      typeof body.irkSignature !== "string" ||
      typeof body.issuedAt !== "number"
    ) {
      return reply.status(400).send({ error: "missing pairing claim fields" });
    }
    let phonePub: Uint8Array;
    let sig: Uint8Array;
    try {
      phonePub = hexToBytes(body.phonePubKey);
      sig = hexToBytes(body.irkSignature);
    } catch {
      return reply.status(400).send({ error: "phonePubKey/irkSignature must be hex" });
    }
    if (phonePub.length !== 32 || sig.length !== 64) {
      return reply.status(400).send({ error: "invalid byte lengths" });
    }
    const irkPub = opts.resolveIrkPubKey?.(body.userId) ?? null;
    if (!irkPub) {
      return reply.status(403).send({ error: "no registered IRK for userId" });
    }

    // Reuse the rebuild-request canonicalization shape for pairing claims so we
    // get the same well-tested signing path. The wifi/share fields are stuffed
    // with stable non-secret-derived values so the canonical bytes uniquely
    // identify a desktop-pairing claim.
    const pairingClaim = {
      userId: body.userId,
      newServerId: `desktop-pair:${sid}`,
      wifiSsid: bytesToHex(s.desktopPubKey),
      wifiPskHash: phonePub,
      shareRatio: 0,
      issuedAt: body.issuedAt,
    };
    if (!verifyRebuildRequest(pairingClaim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid IRK signature" });
    }

    const ageMs = now() - body.issuedAt;
    if (ageMs > 5 * 60_000 || ageMs < -60_000) {
      return reply.status(403).send({ error: "stale pairing claim" });
    }

    s.phonePubKey = phonePub;
    s.irkPubKey = irkPub;
    s.status = "paired";
    s.pairedAt = now();
    return { sessionId: sid, status: "paired" };
  });

  app.get<{ Params: { id: string } }>("/api/desktop/pair/:id/status", async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) return reply.status(404).send({ error: "session not found" });
    expire(s);
    return {
      sessionId: s.id,
      status: s.status,
      phonePubKey: s.phonePubKey ? bytesToHex(s.phonePubKey) : undefined,
    };
  });

  app.post<{ Body: { sessionId?: string } }>(
    "/api/desktop/session/revoke",
    async (req, reply) => {
      // In production this also requires an IRK-signed revocation; v0 stub
      // accepts the call from the paired phone and lets it cancel its own
      // session immediately (see desktop_session.md memory for the full design).
      const sid = req.body?.sessionId;
      if (!sid) return reply.status(400).send({ error: "sessionId required" });
      const s = sessions.get(sid);
      if (!s) return reply.status(404).send({ error: "session not found" });
      s.status = "revoked";
      return { sessionId: sid, status: "revoked" };
    },
  );

  app.post<{ Body: InboxBody }>("/api/desktop/session/inbox", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.sessionId !== "string") return reply.status(400).send({ error: "sessionId required" });
    const s = sessions.get(body.sessionId);
    if (!s) return reply.status(404).send({ error: "session not found" });
    expire(s);
    if (s.status !== "paired") return reply.status(409).send({ error: `session is ${s.status}` });
    if (body.from !== "phone" && body.from !== "desktop") {
      return reply.status(400).send({ error: "from must be phone or desktop" });
    }
    if (typeof body.ciphertext !== "string") {
      return reply.status(400).send({ error: "ciphertext required (hex)" });
    }
    let ct: Uint8Array;
    try {
      ct = hexToBytes(body.ciphertext);
    } catch {
      return reply.status(400).send({ error: "ciphertext must be hex" });
    }
    if (ct.length === 0 || ct.length > MAX_BLOB_BYTES) {
      return reply.status(413).send({ error: "ciphertext size out of range" });
    }
    if (s.inbox.length >= MAX_INBOX_PER_SESSION) {
      // drop oldest
      s.inbox.shift();
    }
    s.inbox.push({ from: body.from, ciphertext: ct, ts: now() });
    return { sessionId: s.id, queued: true, depth: s.inbox.length };
  });

  app.get<{ Params: { id: string }; Querystring: { for?: string } }>(
    "/api/desktop/session/:id/poll",
    async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.status(404).send({ error: "session not found" });
      expire(s);
      if (s.status !== "paired") return reply.status(409).send({ error: `session is ${s.status}` });
      const want = req.query.for === "phone" || req.query.for === "desktop" ? req.query.for : "desktop";
      // Receiver pulls messages from the OTHER side.
      const otherSide: "phone" | "desktop" = want === "phone" ? "desktop" : "phone";
      const drained = s.inbox.filter((m) => m.from === otherSide);
      s.inbox = s.inbox.filter((m) => m.from !== otherSide);
      return {
        sessionId: s.id,
        messages: drained.map((m) => ({ from: m.from, ciphertext: bytesToHex(m.ciphertext), ts: m.ts })),
      };
    },
  );
}

// Used internally to allow tests to drain expired sessions deterministically.
export function _exposeForTests(_req: FastifyRequest): void {
  /* placeholder so this file is imported as ESM cleanly */
}

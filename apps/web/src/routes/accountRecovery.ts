import type { FastifyInstance } from "fastify";
import { sha256 } from "@noble/hashes/sha256";
import {
  verifyAccountRecovery,
  type AccountRecovery,
} from "@flagship/protocol";
import { hexToBytes } from "../lib/hex.js";
import type { ServerRegistry } from "./serverRegistry.js";
import type { PushPlatform, PushTokenStore } from "./pushRelay.js";

/**
 * Post-recovery flow used by a fresh phone after iCloud Keychain / Google
 * Block Store has restored the user's UMK. The IRK is unchanged (it's
 * deterministically UMK-derived), so signing with it is the proof of
 * continuity. The route lets the recovered phone:
 *
 *   1. Replace its push token (the new device has a fresh APNs/FCM token).
 *   2. Get back the list of servers that were registered to this user, so
 *      it can re-pair with each.
 *   3. Trigger a side-effect to revoke any paired-desktop sessions (so a
 *      thief who has the OLD phone can't continue browsing).
 */
export interface AccountRecoveryOptions {
  registry: ServerRegistry;
  pushTokenStore: PushTokenStore;
  resolveUserIrk: (userId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  /**
   * Optional: revoke all paired desktop sessions for this user. Plug in the
   * desktop-pair store from `desktopPair.ts`.
   */
  revokeAllDesktopSessions?: (irkPub: Uint8Array) => Promise<number> | number;
  /** Replay window. Default 5 min. */
  maxAgeMs?: number;
  now?: () => number;
}

interface Body {
  request?: {
    userId?: string;
    newPushTokenHash?: string;
    platform?: PushPlatform;
    issuedAt?: number;
  };
  signature?: string;
  /**
   * The actual push token. Carried separately so the canonical-bytes payload
   * only includes the *hash* (avoids logging concerns and keeps the canonical
   * bytes short). Server compares hash(actualToken) === request.newPushTokenHash.
   */
  pushToken?: string;
}

export function registerAccountRecovery(app: FastifyInstance, opts: AccountRecoveryOptions): void {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  app.post<{ Body: Body }>("/api/account/recovery", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      typeof r.newPushTokenHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(r.newPushTokenHash) ||
      (r.platform !== "apns" && r.platform !== "fcm") ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      typeof body.pushToken !== "string" ||
      body.pushToken.length === 0 ||
      body.pushToken.length > 512
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }

    const irkPub = await opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let claimedHash: Uint8Array;
    let sig: Uint8Array;
    try {
      claimedHash = hexToBytes(r.newPushTokenHash);
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }

    const expected = sha256(new TextEncoder().encode(body.pushToken));
    if (!equalBytes(expected, claimedHash)) {
      return reply.status(400).send({ error: "pushToken does not match newPushTokenHash" });
    }

    const claim: AccountRecovery = {
      userId: r.userId,
      newPushTokenHash: claimedHash,
      platform: r.platform,
      issuedAt: r.issuedAt,
    };
    if (!verifyAccountRecovery(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const age = now() - claim.issuedAt;
    if (age > maxAgeMs || age < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    opts.pushTokenStore.putToken({
      irkPub,
      platform: claim.platform,
      pushToken: body.pushToken,
      registeredAt: now(),
    });

    let desktopSessionsRevoked = 0;
    if (opts.revokeAllDesktopSessions) {
      const v = await opts.revokeAllDesktopSessions(irkPub);
      desktopSessionsRevoked = typeof v === "number" ? v : 0;
    }

    const servers = opts.registry.listForUser(r.userId).map((s) => ({
      serverId: s.serverId,
      stkPub: bytesToHex(s.stkPub),
      registeredAt: s.registeredAt,
      revoked: s.revokedAt
        ? { reason: s.revocationReason ?? "lost", at: s.revokedAt }
        : null,
    }));

    return {
      ok: true,
      servers,
      desktopSessionsRevoked,
    };
  });
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

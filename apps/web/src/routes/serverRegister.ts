import type { FastifyInstance } from "fastify";
import {
  verifyAuthCode,
  verifyServerRegister,
  type AuthCode,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import { hexToBytes, bytesToHex } from "../lib/hex.js";
import type { ServerRegistry } from "./serverRegistry.js";

/**
 * Server-side of the install-flow registration. The newly-installed server
 * presents:
 *   - the AuthCode (with the user's IRK signature carried separately),
 *   - its own identity pubkey (generated locally on first boot),
 *   - a registration request signed by that identity pubkey.
 *
 * On success: the auth-code serial is marked used (single-use), and the
 * server is recorded in the server registry under serverDomain.
 */

export interface AuthCodeUseClient {
  /**
   * Validate the serial against the issuer (typically .com). Returns the
   * stored auth code if active+unexpired, otherwise an error reason.
   * Also marks the serial used atomically — a second call with the same
   * serial fails.
   */
  validateAndUse(serial: string): Promise<{ ok: true; code: AuthCode } | { ok: false; reason: string }>;
}

export interface ServerRegisterOptions {
  serverRegistry: ServerRegistry;
  authCodeUseClient: AuthCodeUseClient;
  /** Replay window for the registration request signature. Default 5 min. */
  maxAgeMs?: number;
  now?: () => number;
}

interface RegisterBody {
  request?: {
    authCode?: AuthCodeJson;
    authCodeUserSignature?: string;
    serverIdentityPubKey?: string;
    issuedAt?: number;
    nonce?: string;
  };
  signature?: string;
}

interface AuthCodeJson {
  version?: number;
  serial?: string;
  username?: string;
  serverName?: string;
  serverDomain?: string;
  delegatedPubKey?: string;
  userPubKey?: string;
  issuedAt?: number;
  expiresAt?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const NONCE_HEX = /^[0-9a-f]{16,128}$/;
const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function registerServerRegister(
  app: FastifyInstance,
  opts: ServerRegisterOptions,
): void {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;

  app.post<{ Body: RegisterBody }>("/api/server/register", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      !r.authCode ||
      typeof r.authCodeUserSignature !== "string" ||
      !HEX128.test(r.authCodeUserSignature) ||
      typeof r.serverIdentityPubKey !== "string" ||
      !HEX64.test(r.serverIdentityPubKey) ||
      typeof r.issuedAt !== "number" ||
      typeof r.nonce !== "string" ||
      !NONCE_HEX.test(r.nonce) ||
      typeof body.signature !== "string" ||
      !HEX128.test(body.signature)
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }

    const ac = r.authCode;
    if (
      ac.version !== 1 ||
      typeof ac.serial !== "string" ||
      !SERIAL_RE.test(ac.serial) ||
      typeof ac.username !== "string" ||
      typeof ac.serverName !== "string" ||
      typeof ac.serverDomain !== "string" ||
      typeof ac.delegatedPubKey !== "string" ||
      !HEX64.test(ac.delegatedPubKey) ||
      typeof ac.userPubKey !== "string" ||
      !HEX64.test(ac.userPubKey) ||
      typeof ac.issuedAt !== "number" ||
      typeof ac.expiresAt !== "number"
    ) {
      return reply.status(400).send({ error: "malformed authCode" });
    }

    const authCode: AuthCode = {
      version: 1,
      serial: ac.serial,
      username: ac.username,
      serverName: ac.serverName,
      serverDomain: ac.serverDomain,
      delegatedPubKey: hexToBytes(ac.delegatedPubKey),
      userPubKey: hexToBytes(ac.userPubKey),
      issuedAt: ac.issuedAt,
      expiresAt: ac.expiresAt,
    };
    const userSig = hexToBytes(r.authCodeUserSignature);
    if (!verifyAuthCode(authCode, userSig, authCode.userPubKey)) {
      return reply.status(403).send({ error: "invalid auth-code signature" });
    }
    if (now() > authCode.expiresAt) {
      return reply.status(403).send({ error: "auth-code expired" });
    }

    const identityPub = hexToBytes(r.serverIdentityPubKey);
    const nonce = hexToBytes(r.nonce);
    const sigBytes = hexToBytes(body.signature);
    const reqObj: ServerRegisterRequest = {
      authCode,
      authCodeUserSignature: userSig,
      serverIdentityPubKey: identityPub,
      issuedAt: r.issuedAt,
      nonce,
    };
    if (!verifyServerRegister(reqObj, sigBytes, identityPub)) {
      return reply.status(403).send({ error: "invalid server-identity signature" });
    }
    const age = now() - r.issuedAt;
    if (age > maxAgeMs || age < -60_000) {
      return reply.status(403).send({ error: "stale registration" });
    }

    const useResult = await opts.authCodeUseClient.validateAndUse(authCode.serial);
    if (!useResult.ok) {
      const code = useResult.reason === "unknown serial" ? 404 : 409;
      return reply.status(code).send({ error: useResult.reason });
    }
    if (useResult.code.serverDomain !== authCode.serverDomain) {
      return reply
        .status(400)
        .send({ error: "auth-code/registration serverDomain mismatch" });
    }

    opts.serverRegistry.put({
      userId: authCode.username,
      serverId: authCode.serverDomain,
      stkPub: identityPub,
      registeredAt: now(),
    });

    return {
      ok: true,
      serverDomain: authCode.serverDomain,
      registeredAt: now(),
    };
  });

  app.get<{ Params: { domain: string } }>(
    "/api/server/by-domain/:domain",
    async (req, reply) => {
      const reg = opts.serverRegistry.get(req.params.domain);
      if (!reg) return reply.status(404).send({ error: "unknown server" });
      return {
        serverDomain: reg.serverId,
        username: reg.userId,
        identityPubKey: bytesToHex(reg.stkPub),
        registeredAt: reg.registeredAt,
        revoked: reg.revokedAt
          ? { reason: reg.revocationReason ?? "lost", at: reg.revokedAt }
          : null,
      };
    },
  );
}

/**
 * Adapter: a same-process AuthCodeStore (when .com and .services run in the
 * same Fastify app, as on Fly today) plugged into the AuthCodeUseClient
 * interface. The HTTP-bridged variant for a real .com / .services split
 * lives in `apps/web/src/lib/remoteAuthCodeUseClient.ts` (deferred).
 */
export function inProcessAuthCodeUseClient(
  store: import("./authCode.js").AuthCodeStore,
  now: () => number = () => Date.now(),
): AuthCodeUseClient {
  return {
    async validateAndUse(serial) {
      const r = store.get(serial);
      if (!r) return { ok: false, reason: "unknown serial" };
      if (r.status === "revoked") return { ok: false, reason: "revoked" };
      if (r.status === "used") return { ok: false, reason: "already used" };
      if (now() > r.code.expiresAt) return { ok: false, reason: "expired" };
      const used = store.markUsed(serial, now());
      if (!used.ok) return { ok: false, reason: used.reason };
      return { ok: true, code: r.code };
    },
  };
}

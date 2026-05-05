import type { FastifyInstance } from "fastify";
import {
  verifyAuthCode,
  verifyAuthCodeRevocation,
  type AuthCode,
  type AuthCodeRevocation,
} from "@flagship/protocol";
import { validateUserLabel, validateAppLabel } from "@flagship/services-zone";
import { hexToBytes, bytesToHex } from "../lib/hex.js";
import type { UsernameRegistry } from "./usernameRegistry.js";

export type AuthCodeStatus = "active" | "used" | "revoked";

export interface AuthCodeRecord {
  code: AuthCode;
  userSignature: Uint8Array;
  status: AuthCodeStatus;
  recordedAt: number;
  usedAt?: number;
  revokedAt?: number;
}

export interface AuthCodeStore {
  put(rec: AuthCodeRecord): { ok: true } | { ok: false; reason: string };
  get(serial: string): AuthCodeRecord | undefined;
  markUsed(serial: string, now: number): { ok: true } | { ok: false; reason: string };
  markRevoked(serial: string, now: number): { ok: true } | { ok: false; reason: string };
  list(): AuthCodeRecord[];
}

export class InMemoryAuthCodeStore implements AuthCodeStore {
  private bySerial = new Map<string, AuthCodeRecord>();

  put(rec: AuthCodeRecord): { ok: true } | { ok: false; reason: string } {
    if (this.bySerial.has(rec.code.serial)) {
      return { ok: false, reason: "serial already issued" };
    }
    this.bySerial.set(rec.code.serial, rec);
    return { ok: true };
  }
  get(serial: string): AuthCodeRecord | undefined {
    return this.bySerial.get(serial);
  }
  markUsed(serial: string, now: number): { ok: true } | { ok: false; reason: string } {
    const r = this.bySerial.get(serial);
    if (!r) return { ok: false, reason: "unknown serial" };
    if (r.status === "used") return { ok: false, reason: "already used" };
    if (r.status === "revoked") return { ok: false, reason: "revoked" };
    if (now > r.code.expiresAt) return { ok: false, reason: "expired" };
    r.status = "used";
    r.usedAt = now;
    return { ok: true };
  }
  markRevoked(serial: string, now: number): { ok: true } | { ok: false; reason: string } {
    const r = this.bySerial.get(serial);
    if (!r) return { ok: false, reason: "unknown serial" };
    if (r.status === "revoked") return { ok: true };
    r.status = "revoked";
    r.revokedAt = now;
    return { ok: true };
  }
  list(): AuthCodeRecord[] {
    return [...this.bySerial.values()];
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface IssueBody {
  code?: {
    version?: number;
    serial?: string;
    username?: string;
    serverName?: string;
    serverDomain?: string;
    delegatedPubKey?: string;
    userPubKey?: string;
    issuedAt?: number;
    expiresAt?: number;
  };
  signature?: string;
}

interface RevokeBody {
  request?: { serial?: string; username?: string; issuedAt?: number };
  signature?: string;
}

export interface AuthCodeOptions {
  store: AuthCodeStore;
  usernameRegistry: UsernameRegistry;
  /** Window from issuedAt within which we accept the request. */
  freshnessMs?: number;
  /** Hard cap on requested expiry duration (issuedAt → expiresAt). */
  maxExpiryMs?: number;
  now?: () => number;
}

export function registerAuthCode(app: FastifyInstance, opts: AuthCodeOptions): void {
  const now = opts.now ?? (() => Date.now());
  const freshnessMs = opts.freshnessMs ?? 5 * 60_000;
  const maxExpiryMs = opts.maxExpiryMs ?? 24 * 3_600_000;

  app.post<{ Body: IssueBody }>("/api/auth-code/issue", async (req, reply) => {
    const body = req.body ?? {};
    const c = body.code;
    if (
      !c ||
      c.version !== 1 ||
      typeof c.serial !== "string" ||
      !SERIAL_RE.test(c.serial) ||
      typeof c.username !== "string" ||
      typeof c.serverName !== "string" ||
      typeof c.serverDomain !== "string" ||
      typeof c.delegatedPubKey !== "string" ||
      !HEX64.test(c.delegatedPubKey) ||
      typeof c.userPubKey !== "string" ||
      !HEX64.test(c.userPubKey) ||
      typeof c.issuedAt !== "number" ||
      typeof c.expiresAt !== "number" ||
      typeof body.signature !== "string" ||
      !HEX128.test(body.signature)
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }

    const userV = validateUserLabel(c.username);
    if (!userV.ok) return reply.status(400).send({ error: userV.reason });
    const serverV = validateAppLabel(c.serverName);
    if (!serverV.ok) return reply.status(400).send({ error: serverV.reason });

    const expectedDomain = `${serverV.label}.${userV.label}.flagship.services`;
    if (c.serverDomain !== expectedDomain) {
      return reply.status(400).send({ error: `serverDomain must equal ${expectedDomain}` });
    }

    if (c.expiresAt - c.issuedAt > maxExpiryMs || c.expiresAt <= c.issuedAt) {
      return reply.status(400).send({ error: "expiry out of range" });
    }
    if (Math.abs(now() - c.issuedAt) > freshnessMs) {
      return reply.status(400).send({ error: "stale request" });
    }
    if (c.expiresAt < now()) {
      return reply.status(400).send({ error: "already expired" });
    }

    const userPubKey = hexToBytes(c.userPubKey);
    const registered = opts.usernameRegistry.lookup(c.username);
    if (!registered) {
      return reply.status(404).send({ error: "username not registered" });
    }
    if (!equalBytes(registered.irkPub, userPubKey)) {
      return reply.status(403).send({ error: "userPubKey does not match registered IRK" });
    }

    const code: AuthCode = {
      version: 1,
      serial: c.serial,
      username: userV.label,
      serverName: serverV.label,
      serverDomain: expectedDomain,
      delegatedPubKey: hexToBytes(c.delegatedPubKey),
      userPubKey,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    };
    const sig = hexToBytes(body.signature);
    if (!verifyAuthCode(code, sig, userPubKey)) {
      return reply.status(403).send({ error: "invalid signature" });
    }

    const out = opts.store.put({
      code,
      userSignature: sig,
      status: "active",
      recordedAt: now(),
    });
    if (!out.ok) return reply.status(409).send({ error: out.reason });
    return { ok: true, serial: code.serial, expiresAt: code.expiresAt };
  });

  app.get<{ Params: { serial: string } }>(
    "/api/auth-code/:serial",
    async (req, reply) => {
      const r = opts.store.get(req.params.serial);
      if (!r) return reply.status(404).send({ error: "unknown serial" });
      const expired = now() > r.code.expiresAt;
      return {
        serial: r.code.serial,
        username: r.code.username,
        serverDomain: r.code.serverDomain,
        delegatedPubKey: bytesToHex(r.code.delegatedPubKey),
        userPubKey: bytesToHex(r.code.userPubKey),
        issuedAt: r.code.issuedAt,
        expiresAt: r.code.expiresAt,
        status: r.status === "active" && expired ? "expired" : r.status,
        usedAt: r.usedAt ?? null,
        revokedAt: r.revokedAt ?? null,
      };
    },
  );

  app.post<{ Params: { serial: string } }>(
    "/api/auth-code/:serial/use",
    async (req, reply) => {
      const out = opts.store.markUsed(req.params.serial, now());
      if (!out.ok) {
        const code = out.reason === "unknown serial" ? 404 : 409;
        return reply.status(code).send({ error: out.reason });
      }
      return { ok: true };
    },
  );

  app.post<{ Body: RevokeBody; Params: { serial: string } }>(
    "/api/auth-code/:serial/revoke",
    async (req, reply) => {
      const body = req.body ?? {};
      const r = body.request;
      if (
        !r ||
        typeof r.serial !== "string" ||
        r.serial !== req.params.serial ||
        typeof r.username !== "string" ||
        typeof r.issuedAt !== "number" ||
        typeof body.signature !== "string" ||
        !HEX128.test(body.signature)
      ) {
        return reply.status(400).send({ error: "malformed body" });
      }
      if (Math.abs(now() - r.issuedAt) > freshnessMs) {
        return reply.status(400).send({ error: "stale request" });
      }
      const existing = opts.store.get(r.serial);
      if (!existing) return reply.status(404).send({ error: "unknown serial" });

      const userRec = opts.usernameRegistry.lookup(r.username);
      if (!userRec) return reply.status(404).send({ error: "username not registered" });
      if (!equalBytes(userRec.irkPub, existing.code.userPubKey)) {
        return reply.status(403).send({ error: "username/auth-code mismatch" });
      }
      const revocation: AuthCodeRevocation = {
        serial: r.serial,
        username: r.username,
        issuedAt: r.issuedAt,
      };
      const sig = hexToBytes(body.signature);
      if (!verifyAuthCodeRevocation(revocation, sig, existing.code.userPubKey)) {
        return reply.status(403).send({ error: "invalid signature" });
      }
      opts.store.markRevoked(r.serial, now());
      return { ok: true };
    },
  );
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

import type { FastifyInstance } from "fastify";
import { verifyRegisterServer, type RegisterServer } from "@flagship/protocol";
import { hexToBytes } from "../lib/hex.js";

/**
 * The control-plane registry of known Flagship servers. Maps a server's id
 * to (a) the user it belongs to, (b) the server's STK pubkey (for tunnel
 * HELLO verification). The phone signs registration entries with the
 * user's IRK at image-build time.
 *
 * In v0 we hold this in memory; v1 swaps in a SQLite (or KV) backend
 * behind the same `ServerRegistry` interface. The route file does not
 * care which is in use.
 */
export interface ServerRegistration {
  userId: string;
  serverId: string;
  stkPub: Uint8Array;
  registeredAt: number;
  /** Set when the user reports the server lost/stolen — see revocation route. */
  revokedAt?: number;
  revocationReason?: "lost" | "stolen" | "decommissioned";
}

export interface ServerRegistry {
  put(reg: ServerRegistration): void;
  get(serverId: string): ServerRegistration | undefined;
  listForUser(userId: string): ServerRegistration[];
  revoke(serverId: string, reason: "lost" | "stolen" | "decommissioned", at: number): boolean;
}

export class InMemoryServerRegistry implements ServerRegistry {
  private byId = new Map<string, ServerRegistration>();

  put(reg: ServerRegistration): void {
    this.byId.set(reg.serverId, { ...reg });
  }

  get(serverId: string): ServerRegistration | undefined {
    const r = this.byId.get(serverId);
    return r ? { ...r } : undefined;
  }

  listForUser(userId: string): ServerRegistration[] {
    return [...this.byId.values()].filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  revoke(serverId: string, reason: "lost" | "stolen" | "decommissioned", at: number): boolean {
    const r = this.byId.get(serverId);
    if (!r) return false;
    r.revokedAt = at;
    r.revocationReason = reason;
    return true;
  }
}

export interface RegisterServerOptions {
  registry: ServerRegistry;
  /** Resolves a userId to its IRK pubkey. The control plane stores this on signup. */
  resolveUserIrk: (userId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  /** Replay window. Default 5 min. */
  maxAgeMs?: number;
  now?: () => number;
}

interface Body {
  request: {
    userId?: string;
    serverId?: string;
    stkPub?: string;
    issuedAt?: number;
  };
  signature?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function registerServerRegistry(app: FastifyInstance, opts: RegisterServerOptions): void {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  app.post<{ Body: Body }>("/api/server-registry/register", async (req, reply) => {
    const body = req.body ?? ({} as Body);
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      typeof r.serverId !== "string" ||
      typeof r.stkPub !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (!HEX64.test(r.stkPub)) return reply.status(400).send({ error: "stkPub must be 32-byte hex" });
    if (!HEX128.test(body.signature)) {
      return reply.status(400).send({ error: "signature must be 64-byte hex" });
    }

    const irkPub = await opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let stkPub: Uint8Array;
    let sig: Uint8Array;
    try {
      stkPub = hexToBytes(r.stkPub);
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }

    const reg: RegisterServer = {
      userId: r.userId,
      serverId: r.serverId,
      stkPub,
      issuedAt: r.issuedAt,
    };

    if (!verifyRegisterServer(reg, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }

    const age = now() - reg.issuedAt;
    if (age > maxAgeMs || age < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    const existing = opts.registry.get(r.serverId);
    if (existing && existing.userId !== r.userId) {
      return reply.status(409).send({ error: "serverId belongs to another user" });
    }

    opts.registry.put({
      userId: r.userId,
      serverId: r.serverId,
      stkPub,
      registeredAt: now(),
    });
    return { ok: true };
  });

  app.get<{ Params: { serverId: string } }>(
    "/api/server-registry/:serverId",
    async (req, reply) => {
      const reg = opts.registry.get(req.params.serverId);
      if (!reg) return reply.status(404).send({ error: "unknown server" });
      return {
        userId: reg.userId,
        serverId: reg.serverId,
        stkPub: bytesToHex(reg.stkPub),
        registeredAt: reg.registeredAt,
        revoked: reg.revokedAt
          ? { reason: reg.revocationReason ?? "lost", at: reg.revokedAt }
          : null,
      };
    },
  );
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * authLookup factory bound to a ServerRegistry. The tunnel hub uses this
 * to verify HELLO signatures: an unknown or revoked server is rejected.
 */
export function authLookupFromRegistry(registry: ServerRegistry) {
  return (serverId: string): Uint8Array | null => {
    const r = registry.get(serverId);
    if (!r) return null;
    if (r.revokedAt) return null;
    return r.stkPub;
  };
}

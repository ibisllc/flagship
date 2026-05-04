import type { FastifyInstance } from "fastify";
import {
  verifyClaimUsername,
  type ClaimUsername,
} from "@flagship/protocol";
import { validateUserLabel } from "@flagship/services-zone";
import { hexToBytes } from "../lib/hex.js";

/**
 * Username registry on flagshipserver.com.
 *
 * The minimal identity surface: one row per user, keyed on `username`,
 * carrying the IRK pubkey that owns it. .services queries this to verify
 * server registrations and tunnel HELLOs.
 *
 * Re-claiming the same username with the same IRK is idempotent (image
 * rebuild / account recovery). Re-claiming with a different IRK is a 409.
 */

export interface UsernameRecord {
  username: string;
  irkPub: Uint8Array;
  claimedAt: number;
}

export interface UsernameRegistry {
  put(rec: UsernameRecord): { ok: true } | { ok: false; reason: string };
  lookup(username: string): UsernameRecord | undefined;
  list(): UsernameRecord[];
}

export class InMemoryUsernameRegistry implements UsernameRegistry {
  private byName = new Map<string, UsernameRecord>();

  put(rec: UsernameRecord): { ok: true } | { ok: false; reason: string } {
    const v = validateUserLabel(rec.username);
    if (!v.ok) return { ok: false, reason: v.reason };
    const norm = v.label;
    const existing = this.byName.get(norm);
    if (existing && !equalBytes(existing.irkPub, rec.irkPub)) {
      return { ok: false, reason: "username already claimed" };
    }
    this.byName.set(norm, {
      username: norm,
      irkPub: rec.irkPub.slice(),
      claimedAt: rec.claimedAt,
    });
    return { ok: true };
  }

  lookup(username: string): UsernameRecord | undefined {
    const r = this.byName.get(username.toLowerCase());
    return r ? { ...r, irkPub: r.irkPub.slice() } : undefined;
  }

  list(): UsernameRecord[] {
    return [...this.byName.values()].map((r) => ({ ...r, irkPub: r.irkPub.slice() }));
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface UsernameRegistryOptions {
  registry: UsernameRegistry;
  maxAgeMs?: number;
  now?: () => number;
}

interface ClaimBody {
  request?: { username?: string; irkPub?: string; issuedAt?: number };
  signature?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function registerUsernameRegistry(
  app: FastifyInstance,
  opts: UsernameRegistryOptions,
): void {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  app.post<{ Body: ClaimBody }>("/api/username/claim", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.username !== "string" ||
      typeof r.irkPub !== "string" ||
      !HEX64.test(r.irkPub) ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      !HEX128.test(body.signature)
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }

    let irkPub: Uint8Array;
    let sig: Uint8Array;
    try {
      irkPub = hexToBytes(r.irkPub);
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }

    const claim: ClaimUsername = {
      username: r.username,
      irkPub,
      issuedAt: r.issuedAt,
    };
    if (!verifyClaimUsername(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return reply.status(403).send({ error: "stale request" });
    }

    const out = opts.registry.put({
      username: r.username,
      irkPub,
      claimedAt: now(),
    });
    if (!out.ok) {
      // 409 for "already claimed by someone else"; 400 for label-validation failures.
      const code = out.reason === "username already claimed" ? 409 : 400;
      return reply.status(code).send({ error: out.reason });
    }
    return { ok: true, username: r.username.toLowerCase() };
  });

  // Public lookup so .services can resolve `username → irkPub` to verify
  // server registrations. No auth required — the data is intentionally
  // public (it's the unique-username DNS-style registry).
  app.get<{ Params: { username: string } }>(
    "/api/username/:username",
    async (req, reply) => {
      const rec = opts.registry.lookup(req.params.username);
      if (!rec) return reply.status(404).send({ error: "not found" });
      return {
        username: rec.username,
        irkPub: bytesToHex(rec.irkPub),
        claimedAt: rec.claimedAt,
      };
    },
  );
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

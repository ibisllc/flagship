import type { FastifyInstance } from "fastify";
import {
  handleUsernameClaim,
  handleUsernameLookup,
} from "@flagship/control-plane";
import type { UsernameStorage as ControlPlaneUsernameStorage } from "@flagship/storage";
import { validateUserLabel } from "@flagship/services-zone";
import { hexToBytes, bytesToHex } from "../lib/hex.js";

/**
 * Username registry on flagshipserver.com.
 *
 * Re-claiming the same username with the same IRK is idempotent (image
 * rebuild / account recovery). Re-claiming with a different IRK is a 409.
 *
 * The HTTP route delegates to @flagship/control-plane's pure handler
 * (which is what the Worker also calls in production); this file just
 * keeps the legacy sync `UsernameRegistry` API alive for the dozens of
 * test files that constructed it directly. An adapter bridges the two.
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

/**
 * Adapter that lets control-plane handlers (which expect the async
 * UsernameStorage interface from @flagship/storage) drive a legacy
 * sync UsernameRegistry. Used by every Fastify route that re-uses the
 * shared handler.
 */
export function adaptRegistryToStorage(
  reg: UsernameRegistry,
): ControlPlaneUsernameStorage {
  return {
    async put(rec) {
      return reg.put({
        username: rec.username,
        irkPub: hexToBytes(rec.irkPubHex),
        claimedAt: rec.claimedAt,
      });
    },
    async get(username) {
      const r = reg.lookup(username);
      if (!r) return undefined;
      return {
        username: r.username,
        irkPubHex: bytesToHex(r.irkPub),
        claimedAt: r.claimedAt,
      };
    },
    async list() {
      return reg.list().map((r) => ({
        username: r.username,
        irkPubHex: bytesToHex(r.irkPub),
        claimedAt: r.claimedAt,
      }));
    },
  };
}

export interface UsernameRegistryOptions {
  registry: UsernameRegistry;
  maxAgeMs?: number;
  now?: () => number;
}

export function registerUsernameRegistry(
  app: FastifyInstance,
  opts: UsernameRegistryOptions,
): void {
  const storage = adaptRegistryToStorage(opts.registry);

  app.post("/api/username/claim", async (req, reply) => {
    const r = await handleUsernameClaim(
      { storage, freshnessMs: opts.maxAgeMs, now: opts.now },
      req.body as never,
    );
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  });

  app.get<{ Params: { username: string } }>(
    "/api/username/:username",
    async (req, reply) => {
      const r = await handleUsernameLookup(storage, req.params.username);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );
}

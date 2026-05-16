// `.services` side of the custom-domain control channel (#87, Phase 3).
//
//   - POST /control/redirections : authed (shared SERVICES_CONTROL_
//     SECRET, constant-time bearer); { op:"add"|"delete", fqdn,
//     podCanonical? } → mutate the in-RAM TunnelRegistry redirection
//     table. `.com`'s Phase-4 verifier calls this on confirm /
//     invalidate / uninstall (replace = delete(old)+add(new), two
//     calls). Fails CLOSED when the secret is unconfigured.
//   - coldStartRedirections : on boot, pull every confirmed fqdn→pod
//     from `.com` so the RAM table survives a `.services` restart
//     (the table is RAM-only by design). Best-effort + bounded.

import type { FastifyInstance } from "fastify";
import { constantTimeEqual, bearer } from "@flagship/control-plane";
import type { TunnelRegistry } from "../tunnel/registry.js";

export interface ControlRedirectionsOptions {
  registry: TunnelRegistry;
  /** Shared bearer secret. Absent → the route 503s (fail closed). */
  secret?: string;
}

export function registerControlRedirections(
  app: FastifyInstance,
  opts: ControlRedirectionsOptions,
): void {
  app.post("/control/redirections", async (req, reply) => {
    if (!opts.secret) {
      return reply.code(503).send({ error: "control channel not configured" });
    }
    const presented = bearer(
      (req.headers["authorization"] as string | undefined) ?? null,
    );
    if (!presented || !constantTimeEqual(presented, opts.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const b = req.body as
      | { op?: unknown; fqdn?: unknown; podCanonical?: unknown }
      | undefined;
    const op = b?.op;
    const fqdn = b?.fqdn;
    if ((op !== "add" && op !== "delete") || typeof fqdn !== "string" || fqdn.length === 0) {
      return reply.code(400).send({ error: "malformed" });
    }
    if (op === "add") {
      if (typeof b?.podCanonical !== "string" || b.podCanonical.length === 0) {
        return reply.code(400).send({ error: "add requires podCanonical" });
      }
      opts.registry.addRedirection(fqdn, b.podCanonical);
    } else {
      opts.registry.removeRedirection(fqdn);
    }
    return reply.code(200).send({ ok: true, count: opts.registry.redirectionCount() });
  });
}

export interface ColdStartOptions {
  registry: TunnelRegistry;
  comBaseUrl: string;
  secret?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Pull every confirmed fqdn→podCanonical from `.com` into the RAM
 * table on boot. Best-effort: returns the count loaded, or -1 on
 * skip (no secret) / failure. Non-fatal — push (#87) backfills and
 * first-party `*.flagship.services` routing is unaffected regardless.
 * Bounded by a 5s timeout so a slow `.com` can't stall `.services`
 * boot.
 */
export async function coldStartRedirections(
  opts: ColdStartOptions,
): Promise<number> {
  if (!opts.secret) return -1;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(
      `${opts.comBaseUrl.replace(/\/+$/, "")}/api/internal/active-redirections`,
      {
        headers: { authorization: `Bearer ${opts.secret}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return -1;
    const j = (await res.json()) as {
      redirections?: Array<{ fqdn?: unknown; podCanonical?: unknown }>;
    };
    const entries: Array<[string, string]> = [];
    for (const r of j.redirections ?? []) {
      if (typeof r.fqdn === "string" && typeof r.podCanonical === "string") {
        entries.push([r.fqdn, r.podCanonical]);
      }
    }
    opts.registry.loadRedirections(entries);
    return entries.length;
  } catch {
    return -1;
  }
}

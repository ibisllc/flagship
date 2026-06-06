import type { FastifyInstance } from "fastify";
import {
  handleServerLookup,
  handleServerRegister,
} from "@flagship/control-plane";
import type {
  AuthCodeStorage,
  ServerStorage,
} from "@flagship/storage";

export interface ServerRegisterOptions {
  authCodes: AuthCodeStorage;
  servers: ServerStorage;
  maxAgeMs?: number;
  now?: () => number;
}

export function registerServerRegister(
  app: FastifyInstance,
  opts: ServerRegisterOptions,
): void {
  const deps = {
    authCodes: opts.authCodes,
    servers: opts.servers,
    maxAgeMs: opts.maxAgeMs,
    now: opts.now,
  };

  app.post("/api/server/register", async (req, reply) => {
    const r = await handleServerRegister(deps, req.body as never);
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  });

  app.get<{ Params: { domain: string } }>(
    "/api/server/by-domain/:domain",
    async (req, reply) => {
      const r = await handleServerLookup(deps, req.params.domain);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );
}

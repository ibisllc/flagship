import type { FastifyInstance } from "fastify";
import {
  handleServerLookup,
  handleServerRegister,
} from "@flagship/control-plane";
import type {
  AuthCodeStorage,
  BoxSerialsStorage,
  ServerStorage,
} from "@flagship/storage";

export interface ServerRegisterOptions {
  authCodes: AuthCodeStorage;
  servers: ServerStorage;
  /** N-CLOUD-2: branded box serial enforcement. Wire when running on
   *  identity-plane / .com with the box_serials table provisioned;
   *  omit on the data-plane (.services Fastify) which never sees a
   *  registration carrying boxSerial. */
  boxSerials?: BoxSerialsStorage;
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
    boxSerials: opts.boxSerials,
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

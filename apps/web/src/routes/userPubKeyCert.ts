import type { FastifyInstance } from "fastify";
import {
  caKeypairFromEnv as caKeypairFromEnvImpl,
  handleCaCert,
  handleUserPubKeyCert,
  type CaIssuer,
} from "@flagship/control-plane";
import {
  adaptRegistryToStorage,
  type UsernameRegistry,
} from "./usernameRegistry.js";

export type { CaIssuer } from "@flagship/control-plane";

export interface UserPubKeyCertOptions {
  ca: CaIssuer;
  usernameRegistry: UsernameRegistry;
  ttlMs?: number;
  cacheMaxAgeSec?: number;
  now?: () => number;
}

export function registerUserPubKeyCert(
  app: FastifyInstance,
  opts: UserPubKeyCertOptions,
): void {
  const usernames = adaptRegistryToStorage(opts.usernameRegistry);
  const deps = {
    ca: opts.ca,
    usernames,
    ttlMs: opts.ttlMs,
    cacheMaxAgeSec: opts.cacheMaxAgeSec,
    now: opts.now,
  };

  app.get<{ Params: { username: string } }>(
    "/api/users/:username/pubkey-cert",
    async (req, reply) => {
      const r = await handleUserPubKeyCert(deps, req.params.username);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );

  app.get("/api/ca/cert", async (_req, reply) => {
    const r = handleCaCert(deps);
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  });
}

export function caKeypairFromEnv(env: NodeJS.ProcessEnv = process.env): CaIssuer {
  return caKeypairFromEnvImpl(env as Record<string, string | undefined>);
}

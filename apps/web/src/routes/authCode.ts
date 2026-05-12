import type { FastifyInstance } from "fastify";
import {
  handleAuthCodeIssue,
  handleAuthCodeLookup,
  handleAuthCodeRevoke,
} from "@flagship/control-plane";
import {
  InMemoryAuthCodeStorage,
  type AuthCodeStorage as ControlPlaneAuthCodeStorage,
  type AuthCodeRecord as ControlPlaneAuthCodeRecord,
} from "@flagship/storage";
import { adaptRegistryToStorage, type UsernameRegistry } from "./usernameRegistry.js";

export {
  InMemoryAuthCodeStorage as InMemoryAuthCodeStore,
  type AuthCodeStorage as AuthCodeStore,
  type AuthCodeRecord,
  type AuthCodeStatus,
} from "@flagship/storage";

export interface AuthCodeOptions {
  store: ControlPlaneAuthCodeStorage;
  usernameRegistry: UsernameRegistry;
  freshnessMs?: number;
  maxExpiryMs?: number;
  now?: () => number;
}

export function registerAuthCode(app: FastifyInstance, opts: AuthCodeOptions): void {
  const usernames = adaptRegistryToStorage(opts.usernameRegistry);
  const deps = {
    storage: opts.store,
    usernames,
    freshnessMs: opts.freshnessMs,
    maxExpiryMs: opts.maxExpiryMs,
    now: opts.now,
  };

  app.post("/api/auth-code/issue", async (req, reply) => {
    const r = await handleAuthCodeIssue(deps, req.body as never);
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  });

  app.get<{ Params: { serial: string } }>(
    "/api/auth-code/:serial",
    async (req, reply) => {
      const r = await handleAuthCodeLookup(deps, req.params.serial);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );

  app.post<{ Params: { serial: string } }>(
    "/api/auth-code/:serial/revoke",
    async (req, reply) => {
      const r = await handleAuthCodeRevoke(deps, req.params.serial, req.body as never);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );
}

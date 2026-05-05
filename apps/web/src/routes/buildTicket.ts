import type { FastifyInstance } from "fastify";
import {
  handleBuildTicketIssue,
  handleBuildTicketLookup,
  handleBuildTicketRedeem,
  handleBuildTicketRefresh,
} from "@flagship/control-plane";
import {
  InMemoryBuildTicketStorage,
  type BuildTicketStorage as ControlPlaneBuildTicketStorage,
} from "@flagship/storage";
import { adaptRegistryToStorage, type UsernameRegistry } from "./usernameRegistry.js";

export {
  InMemoryBuildTicketStorage as InMemoryBuildTicketStore,
  type BuildTicketStorage as BuildTicketStore,
  type BuildTicketRecord as BuildTicket,
  type BuildTicketStatus,
} from "@flagship/storage";

export {
  generateTicketCode,
  normalizeCode,
} from "@flagship/control-plane";

import { _ticketInternal } from "@flagship/control-plane";
export const _internal = _ticketInternal;

export interface BuildTicketOptions {
  store: ControlPlaneBuildTicketStorage;
  usernameRegistry: UsernameRegistry;
  defaultTtlMs?: number;
  maxRefreshMs?: number;
  maxLifetimeMs?: number;
  randomBytes?: (n: number) => Uint8Array;
  now?: () => number;
}

export function registerBuildTicket(
  app: FastifyInstance,
  opts: BuildTicketOptions,
): void {
  const usernames = adaptRegistryToStorage(opts.usernameRegistry);
  const deps = {
    storage: opts.store,
    usernames,
    defaultTtlMs: opts.defaultTtlMs,
    maxRefreshMs: opts.maxRefreshMs,
    maxLifetimeMs: opts.maxLifetimeMs,
    randomBytes: opts.randomBytes,
    now: opts.now,
  };

  app.post("/api/build-tickets/issue", async (req, reply) => {
    const r = await handleBuildTicketIssue(deps, req.body as never);
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  });

  app.post("/api/build-tickets/redeem", async (req, reply) => {
    const r = await handleBuildTicketRedeem(deps, req.body as never);
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  });

  app.post<{ Params: { code: string } }>(
    "/api/build-tickets/:code/refresh",
    async (req, reply) => {
      const r = await handleBuildTicketRefresh(deps, req.params.code, req.body as never);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/build-tickets/:code",
    async (req, reply) => {
      const r = await handleBuildTicketLookup(deps, req.params.code);
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.status(r.status).send(r.body);
    },
  );
}


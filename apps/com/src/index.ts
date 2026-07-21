import { route, type RouteEnv } from "./route.js";
import { scheduled, type ScheduledEnv } from "./scheduled.js";

export { BuildRelaySession } from "./buildRelay.js";
export { BuilderRelaySession } from "./builderRelay.js";

/**
 * flagshipserver.com — Cloudflare Worker.
 *
 * Static assets (marketing, /webapp, /deck, /security, /.well-known) live
 * on Cloudflare's edge via the [assets] binding. Anything under /api/*
 * is reverse-proxied to flagship.services on Fly. The Worker itself holds
 * no state and runs no business logic.
 *
 * scheduled() drives the D1 → R2 backup pipeline. Triggered by the cron
 * binding in wrangler.toml (every 6h); writes a JSONL.gz dump and prunes
 * hourly snapshots older than 30 days.
 */
export default {
  async fetch(request: Request, env: RouteEnv): Promise<Response> {
    return route(request, env);
  },
  async scheduled(
    controller: { scheduledTime: number; cron: string },
    env: RouteEnv & ScheduledEnv,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    return scheduled(controller, env, ctx);
  },
};

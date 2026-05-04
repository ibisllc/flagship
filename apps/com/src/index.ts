import { route, type RouteEnv } from "./route.js";

/**
 * flagshipserver.com — Cloudflare Worker.
 *
 * Static assets (marketing, /webapp, /deck, /security, /.well-known) live
 * on Cloudflare's edge via the [assets] binding. Anything under /api/*
 * is reverse-proxied to flagship.services on Fly. The Worker itself holds
 * no state and runs no business logic.
 */
export default {
  async fetch(request: Request, env: RouteEnv): Promise<Response> {
    return route(request, env);
  },
};

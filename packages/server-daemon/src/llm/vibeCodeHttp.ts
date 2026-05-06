/**
 * Vibe-code HTTP surface. Mounted as an `additionalHandler` in the
 * daemon runtime. Paired-session gated.
 *
 * Routes:
 *   POST /api/llm/sessions
 *     body: { prompt: string, provider: "anthropic" | "openai" | "google", apiKey?: string }
 *     → { sessionId }
 *
 *   POST /api/llm/sessions/<id>/feed
 *     body: { chunk: string }
 *     → { ok: true }   (test seam — production drives feed from the
 *                       provider streaming response, not from the phone)
 *
 *   POST /api/llm/sessions/<id>/end
 *     → { ok: true, files: { ... }, manifestJson: ... }
 *
 *   GET  /api/llm/sessions/<id>
 *     → { meta, files }
 *
 *   POST /api/llm/sessions/<id>/cancel
 *     → { ok: true }
 *
 *   POST /api/llm/sessions/<id>/deploy
 *     → triggers AppPlatform.install with the session's emitted files;
 *       returns { ok: true, appId, url } once deployed.
 *
 * Real WebSocket streaming lives in a sibling module (`vibeCodeWs.ts`,
 * future) — this HTTP surface is the orchestration + replay layer.
 */

import type { PairedSessionGate } from "../alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { VibeCodeSession, VibeCodeSessionRegistry } from "./vibeCodeSession.js";

export interface VibeCodeHttpDeps {
  registry: VibeCodeSessionRegistry;
  gate: PairedSessionGate;
  username: string;
  serverFqdn: string;
  /**
   * Hook called when the phone POSTs /sessions/<id>/deploy. Production
   * wires this to AppPlatform.install with the session's manifest +
   * files; tests inject a stub.
   */
  deploySession?: (session: VibeCodeSession) => Promise<{ ok: true; appId: string; url: string } | { ok: false; reason: string }>;
}

const J = { "content-type": "application/json" } as const;

export function buildVibeCodeHttpHandlers(deps: VibeCodeHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/llm/sessions")) return null;
    const denied = deps.gate.check(req);
    if (denied) return denied;

    const path = req.path.split("?")[0]!;

    if (path === "/api/llm/sessions" && req.method === "POST") {
      const body = parseJson(req.body) as { prompt?: string } | null;
      if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
        return jerr(400, "prompt required");
      }
      const session = deps.registry.create({
        username: deps.username,
        serverFqdn: deps.serverFqdn,
      });
      session.pushUserMessage(body.prompt);
      return jok({
        sessionId: session.meta.sessionId,
        status: session.meta.status,
      });
    }

    if (path === "/api/llm/sessions" && req.method === "GET") {
      return jok({ sessions: deps.registry.list() });
    }

    const m = /^\/api\/llm\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return jerr(404, "not found");
    const session = deps.registry.get(m[1]!);
    if (!session) return jerr(404, "session not found");
    const verb = (m[2] ?? "").replace(/^\//, "");

    if (verb === "" && req.method === "GET") {
      return jok({
        meta: session.meta,
        files: session.files(),
        conversation: session.conversation(),
      });
    }
    if (verb === "feed" && req.method === "POST") {
      const body = parseJson(req.body) as { chunk?: string } | null;
      if (typeof body?.chunk !== "string") return jerr(400, "chunk required");
      session.feedAssistant(body.chunk);
      return jok({ ok: true });
    }
    if (verb === "end" && req.method === "POST") {
      session.endAssistant();
      return jok({
        ok: true,
        manifestJson: session.manifestJson(),
        files: session.files(),
      });
    }
    if (verb === "cancel" && req.method === "POST") {
      session.cancel();
      return jok({ ok: true });
    }
    if (verb === "deploy" && req.method === "POST") {
      if (!deps.deploySession) {
        return jerr(503, "deploy not configured");
      }
      const r = await deps.deploySession(session);
      if (!r.ok) {
        session.fail(r.reason, true);
        return jerr(502, r.reason);
      }
      session.markDeployed({ appId: r.appId, url: r.url });
      return jok({ ok: true, appId: r.appId, url: r.url });
    }
    return jerr(405, "method not allowed");
  };
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
}
function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}
function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

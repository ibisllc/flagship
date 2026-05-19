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
 *     → triggers ServicePlatform.install with the session's emitted files;
 *       returns { ok: true, serviceId, url } once deployed.
 *
 * Real WebSocket streaming lives in a sibling module (`vibeCodeWs.ts`,
 * future) — this HTTP surface is the orchestration + replay layer.
 */

import type { PairedSessionGate } from "../alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import {
  looksLikePastedSecret,
  type EnvVarAckPayload,
  type ToolAckStatus,
  type VibeCodeSession,
  type VibeCodeSessionRegistry,
} from "./vibeCodeSession.js";

export interface VibeCodeHttpDeps {
  registry: VibeCodeSessionRegistry;
  gate: PairedSessionGate;
  username: string;
  serverFqdn: string;
  /**
   * Hook called when the phone POSTs /sessions/<id>/deploy. Production
   * wires this to ServicePlatform.install with the session's manifest +
   * files; tests inject a stub.
   */
  deploySession?: (session: VibeCodeSession) => Promise<{ ok: true; serviceId: string; url: string } | { ok: false; reason: string }>;
  /**
   * Per-app env store — used by the tool-ack endpoint to compute
   * `currentlySet` for `requestEnvVar` acks. Names ONLY; values never
   * leave the store. Optional: in-tests we inject an InMemory; in
   * production the daemon supplies the file-backed sealed store.
   */
  appEnvStore?: AppEnvStore | null;
  /**
   * The serviceId an in-flight session is editing. For brand-new sessions
   * the serviceId may not exist yet — env vars get keyed by the eventual
   * `creator-slug`. Tests inject; production resolves from the
   * session's pending manifest once the model has emitted one.
   */
  resolveAppId?: (session: VibeCodeSession) => string | null;
  /**
   * Observational hook fired when a `user-reply` body matches a
   * known-secret-shape heuristic. The orchestrator does NOT block; it
   * surfaces a warning so the daemon's operator-visible logs flag the
   * mistake. Defaults to a `console.warn`.
   */
  onPastedSecretSuspicion?: (args: { sessionId: string; toolUseId: string }) => void;
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
    if (verb === "user-reply" && req.method === "POST") {
      // The owner's free-form reply to a `talkToUser` tool_use. By
      // contract this channel is NOT a secret channel — the system
      // prompt already forbids the model from soliciting secret VALUES
      // through it. We log (but do not block) if the body looks like a
      // pasted credential so the daemon operator can see a misuse.
      const body = parseJson(req.body) as { text?: string; toolUseId?: string } | null;
      if (!body || typeof body.text !== "string" || typeof body.toolUseId !== "string") {
        return jerr(400, "text + toolUseId required");
      }
      if (looksLikePastedSecret(body.text)) {
        const cb =
          deps.onPastedSecretSuspicion ??
          (({ sessionId, toolUseId }) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[vibecode] user-reply for session=${sessionId} tool=${toolUseId} ` +
                `looks like a pasted secret — chat is NOT a secret channel; ` +
                `route through requestEnvVar instead.`,
            );
          });
        cb({ sessionId: session.meta.sessionId, toolUseId: body.toolUseId });
      }
      const r = session.pushUserReply({ toolUseId: body.toolUseId, text: body.text });
      if (!r.ok) return jerr(409, r.reason ?? "user-reply rejected");
      return jok({ ok: true });
    }
    if (verb === "tool-ack" && req.method === "POST") {
      // The owner's decision on a `requestEnvVar` tool_use. The value
      // (if any) flows entirely outside this endpoint — via the signed
      // `set-app-env` order — and this body is value-free. The daemon
      // reads `appEnvStore.names()` to compute `currentlySet`; the
      // ACTUAL value never touches this code path.
      const body = parseJson(req.body) as {
        toolUseId?: string;
        status?: ToolAckStatus;
      } | null;
      if (!body || typeof body.toolUseId !== "string") {
        return jerr(400, "toolUseId required");
      }
      const status: ToolAckStatus | null =
        body.status === "set" || body.status === "declined" || body.status === "deferred"
          ? body.status
          : null;
      if (!status) return jerr(400, "status must be 'set' | 'declined' | 'deferred'");
      const pending = session.pendingToolUses().find((p) => p.id === body.toolUseId);
      if (!pending) return jerr(404, "no pending tool with that id");
      if (pending.name !== "requestEnvVar") {
        return jerr(400, `tool '${pending.name}' is not requestEnvVar; use user-reply`);
      }
      const name = typeof pending.input.name === "string" ? pending.input.name : "";
      let currentlySet = false;
      if (deps.appEnvStore && deps.resolveAppId) {
        const serviceId = deps.resolveAppId(session);
        if (serviceId) {
          try {
            const names = await deps.appEnvStore.names(serviceId);
            currentlySet = name.length > 0 && names.includes(name);
          } catch {
            currentlySet = false;
          }
        }
      }
      const ack: EnvVarAckPayload = {
        acknowledged: true,
        name,
        status,
        currentlySet,
      };
      const r = session.pushEnvVarAck({ toolUseId: body.toolUseId, ack });
      if (!r.ok) return jerr(409, r.reason ?? "tool-ack rejected");
      return jok({ ok: true, ack });
    }
    if (verb === "deploy" && req.method === "POST") {
      if (!deps.deploySession) {
        return jerr(503, "deploy not configured");
      }
      if (session.meta.status === "awaiting-tool-response") {
        return jerr(409, "cannot deploy while awaiting a tool response");
      }
      const r = await deps.deploySession(session);
      if (!r.ok) {
        session.fail(r.reason, true);
        return jerr(502, r.reason);
      }
      session.markDeployed({ serviceId: r.serviceId, url: r.url });
      return jok({ ok: true, serviceId: r.serviceId, url: r.url });
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

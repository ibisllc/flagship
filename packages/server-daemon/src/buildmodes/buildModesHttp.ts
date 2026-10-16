/**
 * HTTP surface for the git + mcp build modes. Mounted as an
 * `additionalHandler` in the daemon runtime.
 *
 * Two trust zones in one handler:
 *
 *   /api/build/*   — PAIRED-SESSION gated (the authenticated phone /
 *                    webapp drives builds, mints mcp keys, deploys).
 *
 *   /mcp/build/:id — BEARER gated by the per-build mcp key only (NOT the
 *                    paired session): this is the endpoint an external
 *                    IDE agent reaches. The key binds the connection to
 *                    exactly one build session.
 *
 * Scratch mode keeps its existing /api/llm + /api/screens/vibe-code
 * surface; this handler covers the two new modes plus the shared journal
 * read + build list.
 */

import type { PairedSessionGate } from "../alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { CLOSED_TO_AI, type BuildOrchestrator } from "./buildOrchestrator.js";
import type { BuildCredentialStore } from "../llm/buildCredentialStore.js";
import { parseRelayFlag, type LlmCredential } from "../llmHarness.js";

export interface BuildModesHttpDeps {
  orchestrator: BuildOrchestrator;
  gate: PairedSessionGate;
  /**
   * Transient, sealed-at-rest BYOK credential store keyed by buildId.
   * The git-create + adapt endpoints stash a delivered credential here so
   * the orchestrator's `adaptRunner` can open it just-in-time for the AI
   * adapt pass. flagshipserver.com is NEVER in this path — the credential
   * arrives over the paired-session-gated pinned pipe and stays on the box.
   * Omitted ⇒ no BYOK; adapt returns the clean "AI adapt not configured".
   */
  credentials?: BuildCredentialStore;
}

const J = { "content-type": "application/json" } as const;

// IDEs show the 401 body as the server's error (Claude Code: "Error POSTing
// to endpoint: <body>"), so it says what to do. It never says which: a key
// that was replaced and a build that finished read the same.
export const MISSING_MCP_KEY =
  "This IDE connection has no key. Send this build's key as the header Authorization: Bearer <key>; the Flagship app shows it under Connect your IDE.";
export const INVALID_MCP_KEY =
  "This key doesn't open a build on this server: it was replaced, or the build has finished. Copy the current key from Connect your IDE in the Flagship app, or start a new connection there.";

export function buildBuildModesHttpHandlers(deps: BuildModesHttpDeps) {
  const o = deps.orchestrator;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;

    // ---- MCP transport (bearer-gated, NOT paired-session) ----
    if (path.startsWith("/mcp/build/")) {
      return handleMcpTransport(o, req, path);
    }

    if (!path.startsWith("/api/build")) return null;

    // ---- everything else is paired-session gated ----
    const denied = deps.gate.check(req);
    if (denied) return denied;

    // POST /api/build/git   { gitUrl, ref?, name?, credential? }  → create + inspect
    // A taken name is a 409 carrying who holds it, like the AI chat's
    // name check, so the phone can send the owner to that build.
    if (path === "/api/build/git" && req.method === "POST") {
      const body = parseJson(req.body) as
        | { gitUrl?: string; ref?: string; name?: string; share?: boolean; credential?: unknown }
        | null;
      if (!body || typeof body.gitUrl !== "string" || body.gitUrl.length === 0) {
        return jerr(400, "gitUrl required");
      }
      const cred = parseCredential(body.credential);
      if (cred === "invalid") return jerr(400, "malformed credential");
      const r = await o.createGit({
        gitUrl: body.gitUrl.trim(),
        ...(typeof body.ref === "string" && body.ref.trim() ? { ref: body.ref.trim() } : {}),
        ...(typeof body.name === "string" && body.name.trim() ? { name: body.name } : {}),
        ...(body.share === false ? { share: false } : {}),
      });
      if ("error" in r) {
        const c = r.check;
        return {
          status: r.status,
          headers: J,
          body: JSON.stringify({
            error: r.error,
            ...(c
              ? {
                  ok: false,
                  kind: c.kind,
                  message: c.message,
                  ...(c.kind === "app" ? { serviceId: c.serviceId } : {}),
                  ...(c.kind === "session" ? { sessionId: c.sessionId } : {}),
                }
              : {}),
          }),
        };
      }
      // Seal the BYOK credential for the new build, if delivered. The
      // adapt pass reuses it; never echoed, never logged.
      if (cred && deps.credentials) {
        try {
          await deps.credentials.put(r.buildId, cred);
        } catch {
          return jerr(500, "failed to store credential");
        }
      }
      return jok(r);
    }

    // POST /api/build/mcp   { label? }  → create + mint key
    if (path === "/api/build/mcp" && req.method === "POST") {
      const body = parseJson(req.body) as { label?: string; editServiceId?: string } | null;
      const r = await o.createMcp({
        ...(body?.label ? { label: body.label } : {}),
        ...(typeof body?.editServiceId === "string" ? { editServiceId: body.editServiceId } : {}),
      });
      if ("error" in r) return jerr(r.status, r.error);
      return jok(r);
    }

    // GET /api/build/sessions  → list build summaries
    if (path === "/api/build/sessions" && req.method === "GET") {
      const builds = (await o.list()).map((b) => (o.isOpen(b.buildId) ? { ...b, open: true } : b));
      return jok({ builds });
    }

    const m = /^\/api\/build\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return jerr(404, "not found");
    const buildId = decodeURIComponent(m[1]!);
    const verb = (m[2] ?? "").replace(/^\//, "");

    if (verb === "" && req.method === "GET") {
      const state = o.state(buildId);
      if (!state) return jerr(404, "build not found");
      const ws = o.workspace(buildId);
      return jok({ state, files: ws ? ws.list() : [] });
    }

    // POST .../discard → forget an open git or IDE build, freeing its name.
    if (verb === "discard" && req.method === "POST") {
      if (!o.state(buildId)) return jerr(404, "build not found");
      if (!(await o.discard(buildId))) return jerr(409, "the AI is still working on this build");
      await deps.credentials?.forget(buildId).catch(() => {});
      return jok({ ok: true });
    }

    // GET .../adapter → the flagship.app.json that makes this repo run the
    // way this build does, for the repo's author to commit.
    if (verb === "adapter" && req.method === "GET") {
      const file = o.adapterFile(buildId);
      if (!file) return jerr(404, "no flagship.app.json for this build");
      return jok({ file });
    }

    if (verb === "journal" && req.method === "GET") {
      return jok({ entries: await o.readJournal(buildId) });
    }

    // GET .../env-requests → value-free list of env vars an authoring agent
    // (IDE over MCP, or the AI) asked the owner to set. NEVER a value: only
    // the name, an optional reason, the secret flag, when it was asked, who
    // asked, and whether the owner has set it. Deduped by name (latest wins).
    if (verb === "env-requests" && req.method === "GET") {
      return jok({ requests: await o.resolvedEnvRequests(buildId) });
    }

    // POST .../adapt { instructions?, share? } → run the AI adapt pass on a
    // non-fit git build, merging the rewritten files into the workspace.
    // 503 when no model is configured (the live LLM provider isn't wired
    // into the daemon yet — the same pre-existing gap scratch has); 502
    // with the reason on any other failure; 200 {ok, fileCount} on
    // success (the owner deploys next via .../deploy).
    if (verb === "adapt" && req.method === "POST") {
      // Reject an unknown buildId BEFORE touching the credential store: the
      // store is keyed by this URL-derived id, so a non-existent / hostile id
      // (e.g. a path-traversal id) must never reach `credentials.put`. A
      // server-minted build always has state; anything else 404s here.
      if (!o.state(buildId)) return jerr(404, "build not found");
      // A sealed build never takes an AI (or its key) again.
      if (o.isSealed(buildId)) return jerr(409, CLOSED_TO_AI);
      const body = parseJson(req.body) as
        | { instructions?: string; credential?: unknown; background?: boolean; share?: boolean }
        | null;
      // A credential may be delivered here too (e.g. the owner adds an AI
      // key only when the adapt pass is actually needed). Same box-only,
      // never-echoed, never-logged contract.
      const cred = parseCredential(body?.credential);
      if (cred === "invalid") return jerr(400, "malformed credential");
      if (cred && deps.credentials) {
        try {
          await deps.credentials.put(buildId, cred);
        } catch {
          return jerr(500, "failed to store credential");
        }
      }
      // The owner chooses whether to share the adaptation on the not-ready
      // card, so it arrives with the adapt (older apps sent it on create).
      if (typeof body?.share === "boolean") o.setShare(buildId, body.share);
      const adaptOpts = typeof body?.instructions === "string" ? { instructions: body.instructions } : {};
      // `background`: answer at once; the phone polls GET .../:id for
      // `state.adapt`. Older apps wait on this request instead.
      if (body?.background === true) {
        const started = o.startAdaptGit(buildId, adaptOpts);
        if (!started.ok) return jerr(started.status, started.reason);
        return { status: 202, headers: J, body: JSON.stringify({ ok: true, started: true }) };
      }
      const r = await o.adaptGit(buildId, adaptOpts);
      if (!r.ok) {
        return jerr(r.reason === "AI adapt not configured" ? 503 : r.reason === CLOSED_TO_AI ? 409 : 502, r.reason);
      }
      // The agentic path may have already put the app live (the AI tested
      // its staging copy and finished, then the box installed it); surface
      // that so the client can skip the separate .../deploy step and link
      // straight to the live URL. `reason`: why a finished build isn't live.
      return jok({
        ok: true,
        fileCount: r.fileCount,
        ...(r.deployed != null ? { deployed: r.deployed } : {}),
        ...(r.deployedUrl != null ? { deployedUrl: r.deployedUrl } : {}),
        ...(r.serviceId != null ? { serviceId: r.serviceId } : {}),
        ...(r.turns != null ? { turns: r.turns } : {}),
        ...(r.reason != null ? { reason: r.reason } : {}),
      });
    }

    if (verb === "deploy" && req.method === "POST") {
      const r = await o.deploy(buildId);
      if (!r.ok) {
        return { status: 502, headers: J, body: JSON.stringify({ error: r.reason, ...(r.needsAdapt ? { needsAdapt: true } : {}) }) };
      }
      return jok({ ok: true, serviceId: r.serviceId, url: r.url });
    }

    if (verb === "mcp" && req.method === "GET") {
      const info = await o.getMcp(buildId);
      if (!info) return jerr(404, "no mcp connection for this build");
      return jok(info);
    }

    if (verb === "mcp/rotate" && req.method === "POST") {
      const body = parseJson(req.body) as { label?: string } | null;
      const info = await o.rotateMcpKey(buildId, body?.label);
      if (!info) return jerr(404, "no mcp build to rotate");
      return jok(info);
    }

    return jerr(405, "method not allowed");
  };
}

async function handleMcpTransport(
  o: BuildOrchestrator,
  req: HttpRequest,
  path: string,
): Promise<HttpResponse> {
  // The MCP Streamable-HTTP transport: JSON-RPC over POST. GET (SSE
  // stream) is not needed for the tool-call build flow.
  if (req.method !== "POST") {
    return { status: 405, headers: J, body: JSON.stringify({ error: "POST a JSON-RPC message" }) };
  }
  const key = bearer(req);
  if (!key) {
    return { status: 401, headers: J, body: JSON.stringify({ error: MISSING_MCP_KEY }) };
  }
  const message = parseJson(req.body);
  if (message == null) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "invalid JSON-RPC body" }) };
  }
  // The key must be the addressed build's own: another build's key is
  // refused rather than quietly working on the build it belongs to.
  const addressed = addressedBuild(path);

  // Batch support: an array of messages → an array of (non-null) responses.
  if (Array.isArray(message)) {
    const out = [];
    let authed = false;
    for (const msg of message) {
      const r = await o.handleMcpRpc(key, msg, addressed);
      authed = r.authed;
      if (!r.authed) break;
      if (r.response) out.push(r.response);
    }
    if (!authed) return { status: 401, headers: J, body: JSON.stringify({ error: INVALID_MCP_KEY }) };
    return { status: 200, headers: J, body: JSON.stringify(out) };
  }

  const r = await o.handleMcpRpc(key, message, addressed);
  if (!r.authed) {
    return { status: 401, headers: J, body: JSON.stringify({ error: INVALID_MCP_KEY }) };
  }
  // A notification yields no response body (202 Accepted, per MCP).
  if (r.response == null) {
    return { status: 202, headers: J, body: "" };
  }
  return { status: 200, headers: J, body: JSON.stringify(r.response) };
}

function addressedBuild(path: string): string {
  try {
    return decodeURIComponent(/^\/mcp\/build\/([^/]*)\/?$/.exec(path)?.[1] ?? "");
  } catch {
    return "";
  }
}

function bearer(req: HttpRequest): string | null {
  const h = req.headers["authorization"] ?? req.headers["Authorization"];
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Validate an optional BYOK credential off a request body. Mirrors the
 * screens-BFF parser: absent → null; well-formed → the LlmCredential;
 * present-but-malformed → the sentinel `"invalid"`. Never logged.
 */
function parseCredential(raw: unknown): LlmCredential | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const o = raw as Record<string, unknown>;
  if (typeof o.provider !== "string" || o.provider.length === 0) return "invalid";
  if (typeof o.apiKey !== "string" || o.apiKey.length === 0) return "invalid";
  if (o.baseUrl !== undefined && typeof o.baseUrl !== "string") return "invalid";
  if (o.source !== undefined && o.source !== "byok" && o.source !== "promo") return "invalid";
  const relay = parseRelayFlag(o.relay);
  if (relay === "invalid") return "invalid";
  const out: LlmCredential = { provider: o.provider, apiKey: o.apiKey };
  if (typeof o.baseUrl === "string" && o.baseUrl.length > 0) out.baseUrl = o.baseUrl;
  if (o.source === "byok" || o.source === "promo") out.source = o.source;
  if (relay !== undefined) out.relay = relay;
  return out;
}

function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}
function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

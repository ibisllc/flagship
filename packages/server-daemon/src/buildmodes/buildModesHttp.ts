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
import type { BuildOrchestrator } from "./buildOrchestrator.js";
import type { BuildCredentialStore } from "../llm/buildCredentialStore.js";
import type { LlmCredential } from "../llmHarness.js";

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

    // POST /api/build/git   { gitUrl, ref?, credential? }  → create + inspect
    if (path === "/api/build/git" && req.method === "POST") {
      const body = parseJson(req.body) as
        | { gitUrl?: string; ref?: string; credential?: unknown }
        | null;
      if (!body || typeof body.gitUrl !== "string" || body.gitUrl.length === 0) {
        return jerr(400, "gitUrl required");
      }
      const cred = parseCredential(body.credential);
      if (cred === "invalid") return jerr(400, "malformed credential");
      const r = await o.createGit({ gitUrl: body.gitUrl, ...(typeof body.ref === "string" ? { ref: body.ref } : {}) });
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
      const body = parseJson(req.body) as { label?: string } | null;
      const r = await o.createMcp(body?.label ? { label: body.label } : {});
      return jok(r);
    }

    // GET /api/build/sessions  → list build summaries
    if (path === "/api/build/sessions" && req.method === "GET") {
      return jok({ builds: await o.list() });
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

    // POST .../adapt { instructions? } → run the AI adapt pass on a
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
      const body = parseJson(req.body) as
        | { instructions?: string; credential?: unknown }
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
      const r = await o.adaptGit(buildId, typeof body?.instructions === "string" ? { instructions: body.instructions } : {});
      if (!r.ok) {
        return jerr(r.reason === "AI adapt not configured" ? 503 : 502, r.reason);
      }
      // The agentic path may have already deployed the app (the AI called
      // the deploy tool itself); surface that so the client can skip the
      // separate .../deploy step and link straight to the live URL.
      return jok({
        ok: true,
        fileCount: r.fileCount,
        ...(r.deployed != null ? { deployed: r.deployed } : {}),
        ...(r.deployedUrl != null ? { deployedUrl: r.deployedUrl } : {}),
        ...(r.serviceId != null ? { serviceId: r.serviceId } : {}),
        ...(r.turns != null ? { turns: r.turns } : {}),
      });
    }

    if (verb === "deploy" && req.method === "POST") {
      const r = await o.deploy(buildId);
      if (!r.ok) return jerr(502, r.reason);
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
    return { status: 401, headers: J, body: JSON.stringify({ error: "missing Authorization: Bearer <mcp-key>" }) };
  }
  const message = parseJson(req.body);
  if (message == null) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "invalid JSON-RPC body" }) };
  }

  // Batch support: an array of messages → an array of (non-null) responses.
  if (Array.isArray(message)) {
    const out = [];
    let authed = false;
    for (const msg of message) {
      const r = await o.handleMcpRpc(key, msg);
      authed = r.authed;
      if (!r.authed) break;
      if (r.response) out.push(r.response);
    }
    if (!authed) return { status: 401, headers: J, body: JSON.stringify({ error: "invalid mcp key" }) };
    return { status: 200, headers: J, body: JSON.stringify(out) };
  }

  const r = await o.handleMcpRpc(key, message);
  if (!r.authed) {
    return { status: 401, headers: J, body: JSON.stringify({ error: "invalid mcp key" }) };
  }
  // A notification yields no response body (202 Accepted, per MCP).
  if (r.response == null) {
    return { status: 202, headers: J, body: "" };
  }
  // The build id in the path is advisory; the key is authoritative. If
  // they disagree, the key wins (the response is still for the keyed build).
  void path;
  return { status: 200, headers: J, body: JSON.stringify(r.response) };
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
  const out: LlmCredential = { provider: o.provider, apiKey: o.apiKey };
  if (typeof o.baseUrl === "string" && o.baseUrl.length > 0) out.baseUrl = o.baseUrl;
  return out;
}

function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}
function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

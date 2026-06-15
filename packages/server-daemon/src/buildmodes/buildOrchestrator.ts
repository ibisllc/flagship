/**
 * Build orchestrator — the single object the HTTP surface talks to for
 * the git + mcp build modes (scratch stays on the existing vibe-code
 * session path but writes into the SAME journal, bridged at the wiring
 * layer).
 *
 * It owns, per build:
 *   - a BuildWorkspace (the file tree being assembled)
 *   - the shared BuildJournal (one journal per build)
 *   - for mcp: a per-build McpBuildServer + a sealed auth key
 *
 * and routes deploy for every mode through the one artifact deployer.
 */

import { randomBytes } from "node:crypto";
import { BuildWorkspace } from "./buildWorkspace.js";
import { GitImporter, buildAdaptPrompt } from "./gitImport.js";
import { McpBuildServer, type JsonRpcResponse, type McpDeployResult } from "./mcpServer.js";
import type { McpKeyStore } from "./mcpKeyStore.js";
import type { BuildJournal, BuildJournalEntry, BuildJournalSummary, BuildMode } from "./buildJournal.js";
import type { DeployResult } from "./deployArtifact.js";
import { VibeCodeStreamParser } from "../llm/vibeCodeSession.js";
import { SYSTEM_PROMPT_V1 } from "../llm/systemPrompt.js";

/**
 * The model call the AI "adapt" pass makes. Provider-agnostic by design:
 * the orchestrator hands it a system + user prompt and gets back the
 * model's RAW assistant text (the `=== filename ===` … `=== END ===`
 * emit-format the `VibeCodeStreamParser` reads).
 *
 * Production wires this to the SAME live LLM provider mechanism the
 * scratch vibe path uses — which, today, is NOT constructed in
 * `index.ts` (`buildVibeCodeStartStreaming` / `VibeCodeRuntime.start
 * Streaming` is optional/undefined in production). So when that wiring
 * is absent the runner is left undefined and `adaptGit` reports it as a
 * clean "AI adapt not configured", exactly mirroring how the scratch
 * live path degrades. Tests inject a fake returning canned block text.
 */
export type AdaptRunner = (args: {
  /** The build whose transient BYOK credential drives the call. */
  buildId: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}) => Promise<string>;

export interface BuildState {
  buildId: string;
  mode: BuildMode;
  serverFqdn: string;
  createdAt: number;
  /** Set on a fit git import or a successful deploy. */
  serviceId?: string;
  /** Last git fitness verdict (git mode). */
  gitFit?: boolean;
  deployedUrl?: string;
}

/**
 * A value-free record of an env var an authoring agent asked the owner to
 * set. The VALUE is NEVER part of this shape — only the name, an optional
 * human-readable reason, whether the author flagged it secret, when it was
 * asked, and which kind of author asked. The owner supplies the value later
 * over the signed set-app-env path from their phone — never through the IDE
 * / AI. Mirrors `serviceEnvStore`'s names-not-values rule.
 */
export interface PendingEnvRequest {
  name: string;
  why?: string;
  secret?: boolean;
  requestedAt: number;
  requestedBy: "ide" | "ai";
}

/** A pending env request annotated with whether the owner has set it yet. */
export interface ResolvedEnvRequest extends PendingEnvRequest {
  currentlySet: boolean;
}

export interface BuildOrchestratorDeps {
  journal: BuildJournal;
  gitImporter: GitImporter;
  mcpKeys: McpKeyStore;
  /** Build + install a files map. Returns the live URL. */
  deployArtifact: (a: { files: Record<string, string>; serverFqdn: string; buildId: string; mode: BuildMode }) => Promise<DeployResult>;
  serverFqdn: string;
  /** Owner-set env var NAMES (never values) for the mcp request_env_var tool. */
  envNames?: () => Promise<string[]>;
  /**
   * Side-effect hook the wiring layer supplies to react to a value-free env
   * request (journal it, etc.). The orchestrator ALWAYS records the request
   * in its own per-build list first, then awaits this; absent ⇒ list-only.
   */
  recordEnvRequest?: (req: { buildId: string; name: string; why?: string; secret?: boolean }) => Promise<void>;
  /**
   * Fired (value-free) when an authoring agent asks the owner to set an env
   * var, so a client can surface "your IDE asked for STRIPE_KEY" on the
   * phone. Carries only the build id + the env name — never a value, why, or
   * secret flag. Mirrors the vibe-code W10 notify hook.
   */
  notifyOwner?: (n: { buildId: string; name: string }) => void;
  /** Public base URL the IDE points its MCP client at (mcp mode). */
  mcpBaseUrl?: string;
  /**
   * The live model call for the git AI "adapt" pass (rewrites a non-fit
   * cloned repo into a Flagship app). Provider-agnostic. Absent ⇒ the
   * adapt endpoint reports "AI adapt not configured" (503) — the same
   * way the scratch live path degrades when the provider isn't wired.
   */
  adaptRunner?: AdaptRunner;
  /**
   * Optional per-build credential probe. When supplied AND it returns
   * false for a build, `adaptGit` short-circuits with the SAME clean
   * "AI adapt not configured" 503 it returns when `adaptRunner` is
   * absent — so the genuine no-credential case (a build for which the
   * owner never delivered a BYOK key) degrades identically to the
   * provider-not-wired case. Absent ⇒ assume a credential is available
   * (back-compat: tests inject an `adaptRunner` directly).
   */
  adaptCredentialAvailable?: (buildId: string) => boolean;
  now?: () => number;
  rand?: () => string;
}

export interface McpConnectionInfo {
  url: string;
  key: string;
  /** Drop-in JSON the user pastes into Cursor/Cline's mcp config. */
  ideConfig: Record<string, unknown>;
}

export class BuildOrchestrator {
  private readonly states = new Map<string, BuildState>();
  private readonly workspaces = new Map<string, BuildWorkspace>();
  private readonly mcpServers = new Map<string, McpBuildServer>();
  /** Value-free per-build env requests an authoring agent made. */
  private readonly envRequests = new Map<string, PendingEnvRequest[]>();
  private readonly now: () => number;
  private readonly rand: () => string;

  constructor(private readonly deps: BuildOrchestratorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.rand ?? (() => randomBytes(8).toString("hex"));
  }

  private newBuildId(): string {
    return this.rand();
  }

  workspace(buildId: string): BuildWorkspace | null {
    return this.workspaces.get(buildId) ?? null;
  }

  state(buildId: string): BuildState | null {
    const s = this.states.get(buildId);
    return s ? { ...s } : null;
  }

  async list(): Promise<BuildJournalSummary[]> {
    return this.deps.journal.list();
  }

  async readJournal(buildId: string): Promise<BuildJournalEntry[]> {
    return this.deps.journal.read(buildId);
  }

  // ----- env requests (value-free) --------------------------------------

  /**
   * Record a value-free env request from an authoring agent: append it to
   * the build's pending list, fire the (value-free) notify hook so a client
   * can surface it on the phone, and run the wiring side-effect (journal).
   * The VALUE is never an argument here, by construction.
   */
  private async recordEnvRequest(buildId: string, req: PendingEnvRequest): Promise<void> {
    const list = this.envRequests.get(buildId) ?? [];
    list.push(req);
    this.envRequests.set(buildId, list);
    this.deps.notifyOwner?.({ buildId, name: req.name });
    if (this.deps.recordEnvRequest) {
      await this.deps.recordEnvRequest({
        buildId,
        name: req.name,
        ...(req.why != null ? { why: req.why } : {}),
        ...(req.secret != null ? { secret: req.secret } : {}),
      });
    }
  }

  /** The raw per-build pending env requests (newest last). Never any value. */
  pendingEnvRequests(buildId: string): PendingEnvRequest[] {
    return [...(this.envRequests.get(buildId) ?? [])];
  }

  /**
   * The build's env requests deduped by name (latest wins), each annotated
   * with whether the owner has set it yet. Value-free.
   */
  async resolvedEnvRequests(buildId: string): Promise<ResolvedEnvRequest[]> {
    const requests = this.envRequests.get(buildId) ?? [];
    if (requests.length === 0) return [];
    const byName = new Map<string, PendingEnvRequest>();
    for (const r of requests) byName.set(r.name, r); // later wins
    const names = this.deps.envNames ? await this.deps.envNames() : [];
    const set = new Set(names);
    return [...byName.values()].map((r) => ({ ...r, currentlySet: set.has(r.name) }));
  }

  // ----- git mode --------------------------------------------------------

  /**
   * Create a git build and inspect the repo's Flagship fitness in one
   * step. On FIT, the cloned tree is loaded into the workspace ready to
   * deploy as-is; on NOT-FIT, the tree is loaded too (so the AI adapt
   * path can pick it up) and `gitFit:false` is returned.
   */
  async createGit(args: { gitUrl: string; ref?: string }): Promise<{ buildId: string; fit: boolean; reason: string; manifestName?: string; fileCount: number }> {
    const buildId = this.newBuildId();
    this.states.set(buildId, { buildId, mode: "git", serverFqdn: this.deps.serverFqdn, createdAt: this.now() });
    await this.deps.journal.append(buildId, { mode: "git", kind: "session-started", actor: "owner", summary: `import ${args.gitUrl}` });
    const fitness = await this.deps.gitImporter.inspect({ gitUrl: args.gitUrl, ref: args.ref, buildId });
    const ws = new BuildWorkspace(fitness.files);
    this.workspaces.set(buildId, ws);
    const st = this.states.get(buildId)!;
    st.gitFit = fitness.fit;
    return {
      buildId,
      fit: fitness.fit,
      reason: fitness.reason,
      ...(fitness.fit ? { manifestName: fitness.manifest.name } : {}),
      fileCount: Object.keys(fitness.files).length,
    };
  }

  /**
   * AI "adapt" pass for a NON-FIT git build: render the cloned tree into
   * the adapt user prompt, run it through the model (the injected
   * `adaptRunner`), parse the model's emit-format output with the SAME
   * `VibeCodeStreamParser` the scratch path uses, and MERGE the produced
   * files into the build's workspace (path-guarded by `workspace.write`).
   *
   * The result MUST contain a `flagship.app.json` — that's the point of
   * the pass (turn a non-Flagship repo into a Flagship app). The user
   * deploys next via the existing `POST /api/build/sessions/:id/deploy`.
   *
   * Returns `{ok:false}` (never throws) for: an unknown / non-git build,
   * a build with no loaded workspace, no `adaptRunner` configured, or a
   * model output that produced no manifest.
   */
  async adaptGit(
    buildId: string,
    opts: { instructions?: string } = {},
  ): Promise<{ ok: true; fileCount: number } | { ok: false; reason: string }> {
    const st = this.states.get(buildId);
    if (!st || st.mode !== "git") return { ok: false, reason: "not a git build" };
    const ws = this.workspaces.get(buildId);
    if (!ws) return { ok: false, reason: "no workspace for build" };
    if (!this.deps.adaptRunner) {
      // Mirror the scratch live-path degradation: the live LLM provider
      // is not wired into the daemon yet, so there is no model to adapt
      // with. The HTTP layer turns this into a 503.
      return { ok: false, reason: "AI adapt not configured" };
    }
    if (this.deps.adaptCredentialAvailable && !this.deps.adaptCredentialAvailable(buildId)) {
      // The provider IS wired, but this build has no BYOK credential —
      // the genuine no-credential case. Degrade identically (clean 503).
      return { ok: false, reason: "AI adapt not configured" };
    }

    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "adapt-step",
      actor: "ai",
      summary: `adapting ${ws.count()} repo file(s)`,
    });

    let userPrompt = buildAdaptPrompt(ws.snapshot());
    const extra = (opts.instructions ?? "").trim();
    if (extra.length > 0) {
      // The owner's free-form steering is appended as plain context. It
      // is NOT a secret channel (the system prompt forbids soliciting
      // secrets) so it's safe to pass through verbatim.
      userPrompt += `\n\nExtra instructions: ${extra}`;
    }

    let raw: string;
    try {
      raw = await this.deps.adaptRunner({ buildId, systemPrompt: SYSTEM_PROMPT_V1, userPrompt });
    } catch (e) {
      const reason = `adapt model call failed: ${(e as Error).message}`;
      await this.deps.journal.append(buildId, { mode: "git", kind: "error", actor: "ai", summary: reason });
      return { ok: false, reason };
    }

    // Parse the model's emit-format output with the SAME parser the
    // scratch vibe path uses, so the two paths can never drift on format.
    const parser = new VibeCodeStreamParser();
    let parsed: Record<string, string> = {};
    parser.on("event", (ev: { kind: string; files?: Record<string, string> }) => {
      if (ev.kind === "done" && ev.files) parsed = ev.files;
    });
    parser.feed(raw);
    parser.end();
    if (Object.keys(parsed).length === 0) parsed = parser.snapshot();

    if (parsed["flagship.app.json"] == null) {
      const reason = "adapt produced no flagship.app.json";
      await this.deps.journal.append(buildId, { mode: "git", kind: "adapt-step", actor: "ai", summary: reason });
      return { ok: false, reason };
    }

    // Merge the produced files into the workspace. `write` path-guards
    // every entry (no `..`, no leading `/`, bounded size); unsafe paths
    // are skipped + journalled, never silently overwriting the tree.
    const written: string[] = [];
    const skipped: string[] = [];
    for (const [path, content] of Object.entries(parsed)) {
      const r = ws.write(path, content);
      if (r.ok) written.push(path);
      else skipped.push(path);
    }

    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "adapt-step",
      actor: "ai",
      // Value-free: file COUNTS + NAMES only, never file contents.
      summary: `adapt wrote ${written.length} file(s)${skipped.length ? `, skipped ${skipped.length} unsafe` : ""}`,
      detail: written.join(", "),
    });

    st.gitFit = true;
    return { ok: true, fileCount: written.length };
  }

  // ----- mcp mode --------------------------------------------------------

  /** Create an mcp build, mint its auth key, and return IDE connection info. */
  async createMcp(args: { label?: string } = {}): Promise<{ buildId: string; connection: McpConnectionInfo }> {
    const buildId = this.newBuildId();
    this.states.set(buildId, { buildId, mode: "mcp", serverFqdn: this.deps.serverFqdn, createdAt: this.now() });
    const ws = new BuildWorkspace();
    this.workspaces.set(buildId, ws);
    this.mcpServers.set(buildId, this.makeMcpServer(buildId, ws));
    await this.deps.journal.append(buildId, { mode: "mcp", kind: "session-started", actor: "owner", summary: "connect IDE via MCP" });
    const rec = await this.deps.mcpKeys.mint(buildId, args.label);
    return { buildId, connection: this.connectionInfo(buildId, rec.key) };
  }

  /** Re-display the mcp connection info for a build (the user may need to re-paste). */
  async getMcp(buildId: string): Promise<McpConnectionInfo | null> {
    const st = this.states.get(buildId);
    if (!st || st.mode !== "mcp") return null;
    const rec = await this.deps.mcpKeys.get(buildId);
    if (!rec) return null;
    return this.connectionInfo(buildId, rec.key);
  }

  /** Rotate the mcp auth key (revokes the prior one). */
  async rotateMcpKey(buildId: string, label?: string): Promise<McpConnectionInfo | null> {
    const st = this.states.get(buildId);
    if (!st || st.mode !== "mcp") return null;
    const rec = await this.deps.mcpKeys.mint(buildId, label);
    return this.connectionInfo(buildId, rec.key);
  }

  /**
   * Authenticate a presented MCP bearer key and dispatch a JSON-RPC
   * message to that build's MCP server. Returns null on auth failure
   * (the HTTP layer turns that into a 401) or for notifications.
   */
  async handleMcpRpc(presentedKey: string, message: unknown): Promise<{ authed: boolean; response: JsonRpcResponse | null }> {
    const buildId = await this.deps.mcpKeys.resolve(presentedKey);
    if (!buildId) return { authed: false, response: null };
    let server = this.mcpServers.get(buildId);
    if (!server) {
      // Rehydrate after a restart: recreate the server over a fresh/empty
      // workspace if the build state is gone (best-effort).
      const ws = this.workspaces.get(buildId) ?? new BuildWorkspace();
      this.workspaces.set(buildId, ws);
      server = this.makeMcpServer(buildId, ws);
      this.mcpServers.set(buildId, server);
    }
    const response = await server.handle(message);
    return { authed: true, response };
  }

  // ----- deploy (all modes) ---------------------------------------------

  /** Deploy the build's workspace. The orchestrator owns git + mcp workspaces. */
  async deploy(buildId: string): Promise<DeployResult> {
    const st = this.states.get(buildId);
    if (!st) return { ok: false, reason: "unknown build" };
    const ws = this.workspaces.get(buildId);
    if (!ws) return { ok: false, reason: "no workspace for build" };
    const r = await this.deps.deployArtifact({ files: ws.snapshot(), serverFqdn: st.serverFqdn, buildId, mode: st.mode });
    if (r.ok) {
      st.serviceId = r.serviceId;
      st.deployedUrl = r.url;
    }
    return r;
  }

  // ----- internals -------------------------------------------------------

  private makeMcpServer(buildId: string, ws: BuildWorkspace): McpBuildServer {
    return new McpBuildServer({
      buildId,
      workspace: ws,
      journal: this.deps.journal,
      serverFqdn: this.deps.serverFqdn,
      envNames: this.deps.envNames ?? (async () => []),
      // The MCP tool is value-free; the orchestrator owns the pending list,
      // the notify-owner fan-out, and the wiring side-effect.
      recordEnvRequest: async (req) =>
        this.recordEnvRequest(buildId, {
          name: req.name,
          ...(req.why != null ? { why: req.why } : {}),
          ...(req.secret != null ? { secret: req.secret } : {}),
          requestedAt: this.now(),
          requestedBy: "ide",
        }),
      deploy: async (): Promise<McpDeployResult> => {
        const r = await this.deploy(buildId);
        return r.ok
          ? { ok: true, serviceId: r.serviceId, url: r.url }
          : { ok: false, reason: r.reason };
      },
    });
  }

  private connectionInfo(buildId: string, key: string): McpConnectionInfo {
    const url = `${(this.deps.mcpBaseUrl ?? `https://${this.deps.serverFqdn}`).replace(/\/$/, "")}/mcp/build/${buildId}`;
    return {
      url,
      key,
      ideConfig: {
        mcpServers: {
          [`flagship-${buildId}`]: {
            url,
            headers: { Authorization: `Bearer ${key}` },
          },
        },
      },
    };
  }
}

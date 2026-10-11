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
import { BuildToolHost } from "./buildToolHost.js";
import { runBuildAgent, type AgentRunner, type BuildAgentResult } from "./buildAgent.js";
import type { McpKeyStore } from "./mcpKeyStore.js";
import type { BuildJournal, BuildJournalEntry, BuildJournalSummary, BuildMode } from "./buildJournal.js";
import type { DeployResult } from "./deployArtifact.js";
import { VibeCodeStreamParser } from "../llm/vibeCodeSession.js";
import { SYSTEM_PROMPT_V1 } from "../llm/systemPrompt.js";
import {
  checkServiceName,
  deriveServiceName,
  repoNameFromUrl,
  slugifyLabel,
  type ServiceNameCheck,
  type ServiceNameDeps,
} from "../llm/serviceName.js";
import {
  applyRepoAdapter,
  buildAdapterFile,
  deriveRepoAdapter,
  parseManifest,
  repoAdapterProblems,
  splitAdapterFile,
  type AppManifest,
} from "@flagship/protocol";
import { indexableRepo, licensePathOf, type AdapterIndex } from "./adapterIndex.js";

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

export type EditableService =
  | { ok: true; serviceId: string; slug: string; files: Record<string, string>; bytes: number }
  | { ok: false; status: number; reason: string };

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
  /** The installed service this build changes; deploying replaces it. */
  editsServiceId?: string;
  /** The name it deploys under (git imports); held until it deploys. */
  name?: string;
  /** The AI adapt pass, when one was started in the background. */
  adapt?: AdaptStatus;
}

/** What a git build remembers to share its adapter once it deploys. */
interface GitSource {
  repo: string | null;
  commit?: string;
  ref?: string;
  original: Record<string, string>;
  /** Where the tree it builds came from. */
  origin: "repo" | "index" | "ai" | "as-is";
  /** The repo's own adapter, which no longer fits these files. */
  staleAdapter?: string[];
}

export type AdaptStatus =
  | { status: "running"; startedAt: number }
  | { status: "done"; fileCount: number; deployed: boolean; deployedUrl?: string; serviceId?: string; turns?: number }
  | { status: "failed"; reason: string; notConfigured?: boolean };

export type AdaptResult =
  | { ok: true; fileCount: number; deployed?: boolean; deployedUrl?: string; serviceId?: string; turns?: number }
  | { ok: false; reason: string };

export type CreateGitResult =
  | { buildId: string; fit: boolean; reason: string; manifestName?: string; fileCount: number; name?: string }
  | { error: string; status: number; check?: Extract<ServiceNameCheck, { ok: false }> };

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
  deployArtifact: (a: { files: Record<string, string>; serverFqdn: string; buildId: string; mode: BuildMode; editsServiceId?: string; name?: string; binaries?: Record<string, Buffer> }) => Promise<DeployResult>;
  /**
   * What a git import's name is checked against: installed apps and every
   * open build's name (this orchestrator's included). Unset ⇒ git imports
   * deploy under their manifest's name, as before.
   */
  names?: () => ServiceNameDeps;
  /**
   * flagshipserver.com's anonymous index of repo adapters. Unset ⇒ imports
   * never look one up and adapts are never shared.
   */
  adapterIndex?: AdapterIndex;
  /**
   * An installed service's current code, if it can be edited here (built on
   * this box, still installed). Unset ⇒ edits aren't offered.
   */
  editableService?: (serviceId: string) => Promise<EditableService>;
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
   *
   * This is the LEGACY single-shot emit-format pass; when an `agentRunner`
   * is also configured, `adaptGit` prefers the agentic tool-driving loop
   * and only falls back to this for callers that wire `adaptRunner` alone.
   */
  adaptRunner?: AdaptRunner;
  /**
   * The AGENTIC adapt path (the product bar): a provider-agnostic
   * tool-calling `chat()` runner the loop drives over the SHARED build
   * tool surface — read_file → write_file → validate → deploy — until the
   * app deploys. It is given the `buildId` so it can open THAT build's
   * transient sealed BYOK credential just-in-time per call; the harness
   * applies the SSRF guard and forwards the tools. flagshipserver.com is
   * never in the path. When present (and a credential is available), this
   * is used in preference to `adaptRunner`.
   */
  agentRunner?: AgentRunner;
  /** Turn/cost bounds for the agentic loop (optional). */
  agentMaxTurns?: number;
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
  private readonly gitSources = new Map<string, GitSource>();
  /** A git build's non-text files, carried to the deploy unchanged. */
  private readonly binaries = new Map<string, Record<string, Buffer>>();
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
  async createGit(args: { gitUrl: string; ref?: string; name?: string }): Promise<CreateGitResult> {
    const names = this.deps.names?.();
    const given = args.name?.trim().toLowerCase();
    if (given && names) {
      const check = checkServiceName(given, names);
      if (!check.ok) return { error: check.message, status: check.kind === "invalid" ? 400 : 409, check };
    }
    const buildId = this.newBuildId();
    const repoName = args.gitUrl.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/i, "");
    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "session-started",
      actor: "owner",
      summary: `import ${args.gitUrl}`,
      ...(given ? { name: given } : repoName ? { name: repoName } : {}),
    });
    let fitness = await this.deps.gitImporter.inspect({ gitUrl: args.gitUrl, ref: args.ref, buildId });
    if (!fitness.fit && fitness.unreadable) {
      return { error: fitness.reason, status: 422 };
    }
    const repo = indexableRepo(args.gitUrl);
    let origin: GitSource["origin"] = fitness.fit ? (fitness.repoAdapter === "applied" ? "repo" : "as-is") : "ai";
    if (!fitness.fit && repo && fitness.commit && fitness.original) {
      const known = await this.fromIndex(repo, fitness.commit, fitness.original);
      if (known) {
        const reason = "Flagship-ready: Flagship knows how to run this repo — installing as-is, no AI needed";
        await this.deps.journal.append(buildId, { mode: "git", kind: "fitness-check", actor: "system", summary: reason });
        fitness = { ...fitness, ...known, fit: true, reason };
        origin = "index";
      }
    }
    let name: string | undefined;
    if (names) {
      name = given ?? deriveServiceName({ gitUrl: args.gitUrl, ...(args.ref ? { ref: args.ref } : {}) }, names);
      // A build that started meanwhile may have taken it while we cloned.
      const check = checkServiceName(name, names);
      if (!check.ok) return { error: check.message, status: check.kind === "invalid" ? 400 : 409, check };
      if (!given) {
        await this.deps.journal.append(buildId, {
          mode: "git",
          kind: "fitness-check",
          actor: "system",
          summary: `named ${name}`,
          name,
        });
      }
    }
    this.states.set(buildId, {
      buildId,
      mode: "git",
      serverFqdn: this.deps.serverFqdn,
      createdAt: this.now(),
      gitFit: fitness.fit,
      ...(name ? { name } : {}),
    });
    this.workspaces.set(buildId, new BuildWorkspace(fitness.files));
    if (fitness.binaries) this.binaries.set(buildId, fitness.binaries);
    this.gitSources.set(buildId, {
      repo,
      ...(fitness.commit ? { commit: fitness.commit } : {}),
      ...(args.ref ? { ref: args.ref } : {}),
      original: fitness.original ?? fitness.files,
      origin,
      ...(!fitness.fit && typeof fitness.repoAdapter === "object" ? { staleAdapter: fitness.repoAdapter.failed } : {}),
    });
    return {
      buildId,
      fit: fitness.fit,
      reason: fitness.reason,
      ...(fitness.fit ? { manifestName: fitness.manifest.name } : {}),
      fileCount: Object.keys(fitness.files).length,
      ...(name ? { name } : {}),
    };
  }

  /** The open build holding a name, if any: a git import not yet deployed. */
  holderOf(name: string, exceptId?: string): { sessionId: string } | undefined {
    const wanted = name.toLowerCase();
    for (const st of this.states.values()) {
      if (st.buildId === exceptId || st.deployedUrl || st.name !== wanted) continue;
      return { sessionId: st.buildId };
    }
    return undefined;
  }

  /** Whether the box still holds this build (it can be resumed or discarded). */
  isOpen(buildId: string): boolean {
    const st = this.states.get(buildId);
    return st != null && st.deployedUrl == null;
  }

  /** Forget a build: its files, its IDE key and the name it held. */
  async discard(buildId: string): Promise<boolean> {
    const st = this.states.get(buildId);
    if (!st) return false;
    if (st.adapt?.status === "running") return false;
    this.states.delete(buildId);
    this.workspaces.delete(buildId);
    this.mcpServers.delete(buildId);
    this.envRequests.delete(buildId);
    this.gitSources.delete(buildId);
    this.binaries.delete(buildId);
    if (st.mode === "mcp") await this.deps.mcpKeys.revoke(buildId);
    await this.deps.journal.append(buildId, {
      mode: st.mode,
      kind: "cancelled",
      actor: "owner",
      summary: "discarded",
    });
    return true;
  }

  /**
   * Start the adapt pass and return at once; its outcome lands on the
   * build's state (`adapt`), which the phone polls. The pass can run for
   * many minutes, longer than a phone keeps one request open.
   */
  startAdaptGit(buildId: string, opts: { instructions?: string } = {}): { ok: true } | { ok: false; status: number; reason: string } {
    const st = this.states.get(buildId);
    if (!st || st.mode !== "git") return { ok: false, status: 404, reason: "not a git build" };
    if (st.adapt?.status === "running") return { ok: false, status: 409, reason: "the AI is already adapting this repo" };
    if (!this.adaptConfigured(buildId)) return { ok: false, status: 503, reason: "AI adapt not configured" };
    st.adapt = { status: "running", startedAt: this.now() };
    void this.adaptGit(buildId, opts)
      .catch((e: unknown): AdaptResult => ({ ok: false, reason: (e as Error).message }))
      .then((r) => {
        const cur = this.states.get(buildId);
        if (!cur) return;
        cur.adapt = r.ok
          ? {
              status: "done",
              fileCount: r.fileCount,
              deployed: r.deployed === true,
              ...(r.deployedUrl != null ? { deployedUrl: r.deployedUrl } : {}),
              ...(r.serviceId != null ? { serviceId: r.serviceId } : {}),
              ...(r.turns != null ? { turns: r.turns } : {}),
            }
          : { status: "failed", reason: r.reason };
      });
    return { ok: true };
  }

  private adaptConfigured(buildId: string): boolean {
    if (!this.deps.adaptRunner && !this.deps.agentRunner) return false;
    return !this.deps.adaptCredentialAvailable || this.deps.adaptCredentialAvailable(buildId);
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
  ): Promise<AdaptResult> {
    const st = this.states.get(buildId);
    if (!st || st.mode !== "git") return { ok: false, reason: "not a git build" };
    const notes: string[] = [];
    const stale = this.gitSources.get(buildId)?.staleAdapter;
    if (stale) {
      notes.push(
        `The repo's flagship.app.json carries an adapter (its "adapter" section) written for an older commit; ` +
          `its edits no longer fit ${stale.join(", ")}. It shows how this repo was adapted before: redo the same ` +
          `changes against the current files, and write flagship.app.json WITHOUT the "adapter" section.`,
      );
    }
    if (st.name) notes.push(`The app's name is "${st.name}": use exactly that as "name" in flagship.app.json.`);
    if (notes.length) {
      const extra = notes.join("\n");
      opts = { ...opts, instructions: opts.instructions?.trim() ? `${opts.instructions.trim()}\n${extra}` : extra };
    }
    const ws = this.workspaces.get(buildId);
    if (!ws) return { ok: false, reason: "no workspace for build" };
    if (!this.deps.adaptRunner && !this.deps.agentRunner) {
      // Mirror the scratch live-path degradation: no model is wired to
      // adapt with. The HTTP layer turns this into a 503.
      return { ok: false, reason: "AI adapt not configured" };
    }
    if (this.deps.adaptCredentialAvailable && !this.deps.adaptCredentialAvailable(buildId)) {
      // The provider IS wired, but this build has no BYOK credential —
      // the genuine no-credential case. Degrade identically (clean 503).
      return { ok: false, reason: "AI adapt not configured" };
    }

    // ---- Preferred path: the AGENTIC tool-driving loop ----
    if (this.deps.agentRunner) {
      return this.adaptGitAgentic(buildId, ws, opts);
    }

    // ---- Legacy path: single-shot emit-format pass ----
    // Reachable only when agentRunner is absent; the early guard proved
    // adaptRunner is set in that case.
    const adaptRunner = this.deps.adaptRunner!;
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
      raw = await adaptRunner({ buildId, systemPrompt: SYSTEM_PROMPT_V1, userPrompt });
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

  /**
   * The agentic adapt loop: the box's AI drives the SHARED build tool
   * surface (read_file / write_file / validate / deploy / request_env_var)
   * over the build's workspace, multi-turn, until the app deploys (or it
   * stops / hits the turn cap). `deploy` is wired straight to the
   * orchestrator's own deploy primitive, so the same install path every
   * mode uses runs from inside the loop. Returns the merged result; never
   * throws.
   */
  private async adaptGitAgentic(
    buildId: string,
    ws: BuildWorkspace,
    opts: { instructions?: string },
  ): Promise<AdaptResult> {
    const repoFiles = ws.list();
    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "adapt-step",
      actor: "ai",
      summary: `agentic adapt over ${repoFiles.length} repo file(s)`,
    });

    // The tool host the model drives — the SAME surface MCP exposes, but
    // here in-process. `deploy` funnels through the orchestrator's own
    // deploy (Forgejo push → docker build → signed install).
    const tools = new BuildToolHost({
      buildId,
      workspace: ws,
      journal: this.deps.journal,
      serverFqdn: this.deps.serverFqdn,
      mode: "git",
      envNames: this.deps.envNames ?? (async () => []),
      recordEnvRequest: async (req) =>
        this.recordEnvRequest(buildId, {
          name: req.name,
          ...(req.why != null ? { why: req.why } : {}),
          ...(req.secret != null ? { secret: req.secret } : {}),
          requestedAt: this.now(),
          requestedBy: "ai",
        }),
      deploy: async () => {
        const r = await this.deploy(buildId);
        return r.ok
          ? { ok: true, serviceId: r.serviceId, url: r.url }
          : { ok: false, reason: r.reason };
      },
    });

    const agentRunner = this.deps.agentRunner!;
    let result: BuildAgentResult;
    try {
      result = await runBuildAgent({
        buildId,
        runner: (req) => agentRunner(buildId, req),
        tools,
        journal: this.deps.journal,
        repoFiles,
        binaryFiles: Object.keys(this.binaries.get(buildId) ?? {}).sort(),
        ...(opts.instructions != null ? { instructions: opts.instructions } : {}),
        ...(this.deps.agentMaxTurns != null ? { options: { maxTurns: this.deps.agentMaxTurns } } : {}),
      });
    } catch (e) {
      // runBuildAgent never throws, but defend the boundary anyway.
      const reason = `agentic adapt failed: ${(e as Error).message}`;
      await this.deps.journal.append(buildId, { mode: "git", kind: "error", actor: "ai", summary: reason });
      return { ok: false, reason };
    }

    const st = this.states.get(buildId);
    if (st) st.gitFit = true;

    // The model never produced a manifest and never deployed → surface a
    // clear failure (the HTTP layer maps it to a 502).
    const hasManifest = ws.manifestJson() != null;
    if (!result.deployed && !hasManifest) {
      const reason =
        result.stopReason === "error"
          ? result.note ?? "adapt model call failed"
          : "the AI could not produce a valid Flagship app (no flagship.app.json was written)";
      return { ok: false, reason };
    }

    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "adapt-step",
      actor: "ai",
      summary: result.deployed
        ? `agentic adapt deployed in ${result.turns} turn(s)`
        : `agentic adapt wrote a manifest in ${result.turns} turn(s) (not deployed)`,
    });

    return {
      ok: true,
      fileCount: ws.count(),
      deployed: result.deployed,
      ...(result.deployedUrl != null ? { deployedUrl: result.deployedUrl } : {}),
      ...(result.serviceId != null ? { serviceId: result.serviceId } : {}),
      turns: result.turns,
    };
  }

  // ----- mcp mode --------------------------------------------------------

  /** Create an mcp build, mint its auth key, and return IDE connection info. */
  async createMcp(
    args: { label?: string; editServiceId?: string } = {},
  ): Promise<{ buildId: string; connection: McpConnectionInfo } | { error: string; status: number }> {
    let edit: Extract<EditableService, { ok: true }> | null = null;
    if (args.editServiceId) {
      if (!this.deps.editableService) return { error: "editing isn't available on this server", status: 503 };
      const r = await this.deps.editableService(args.editServiceId);
      if (!r.ok) return { error: r.reason, status: r.status };
      edit = r;
    }
    const buildId = this.newBuildId();
    this.states.set(buildId, {
      buildId,
      mode: "mcp",
      serverFqdn: this.deps.serverFqdn,
      createdAt: this.now(),
      ...(edit ? { editsServiceId: edit.serviceId } : {}),
    });
    const ws = new BuildWorkspace(edit?.files);
    this.workspaces.set(buildId, ws);
    this.mcpServers.set(buildId, this.makeMcpServer(buildId, ws));
    await this.deps.journal.append(buildId, {
      mode: "mcp",
      kind: "session-started",
      actor: "owner",
      summary: edit ? `change ${edit.slug} from the IDE` : "connect IDE via MCP",
      ...(edit ? { name: edit.slug, serviceId: edit.serviceId } : args.label ? { name: args.label } : {}),
    });
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
    const r = await this.deps.deployArtifact({
      files: ws.snapshot(),
      serverFqdn: st.serverFqdn,
      buildId,
      mode: st.mode,
      ...(st.editsServiceId ? { editsServiceId: st.editsServiceId } : {}),
      ...(st.name ? { name: st.name } : {}),
      ...(this.binaries.has(buildId) ? { binaries: this.binaries.get(buildId)! } : {}),
    });
    if (r.ok) {
      st.serviceId = r.serviceId;
      st.deployedUrl = r.url;
      const src = this.gitSources.get(buildId);
      if (src) {
        this.gitSources.delete(buildId);
        void this.shareAdapter(src, ws.snapshot());
      }
    }
    return r;
  }

  /**
   * An adapter someone shared for this repo that fits these files: the first
   * that passes the same checks the index ran and applies cleanly.
   */
  private async fromIndex(
    repo: string,
    commit: string,
    original: Record<string, string>,
  ): Promise<{ files: Record<string, string>; manifestJson: string; manifest: AppManifest } | null> {
    if (!this.deps.adapterIndex) return null;
    for (const candidate of await this.deps.adapterIndex.lookup(repo, commit)) {
      const split = splitAdapterFile(candidate.file);
      if (!split.ok || !split.adapter || split.adapter.source.repo !== repo) continue;
      if (repoAdapterProblems(split.adapter, split.manifestJson).length > 0) continue;
      const parsed = parseManifest(JSON.parse(split.manifestJson));
      if (!parsed.ok) continue;
      const applied = applyRepoAdapter(original, split.adapter, split.manifestJson);
      if (!applied.ok) continue;
      return { files: applied.files, manifestJson: split.manifestJson, manifest: parsed.manifest };
    }
    return null;
  }

  /**
   * Share what made this repo run, so the next person importing it needs no
   * AI: only for public repos on the big hosts, only once it has deployed,
   * never the repo's own adapter (that's the author's), with the owner's
   * choices (the name) taken out and nothing that says who sent it.
   */
  private async shareAdapter(src: GitSource, built: Record<string, string>): Promise<void> {
    if (!this.deps.adapterIndex || !src.repo || !src.commit || src.origin === "repo" || src.origin === "as-is") return;
    const licensePath = licensePathOf(src.original);
    const manifestText = built["flagship.app.json"];
    if (!licensePath || !manifestText) return;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestText) as Record<string, unknown>;
    } catch {
      return;
    }
    delete manifest.adapter;
    manifest.name = slugifyLabel(repoNameFromUrl(src.repo)) || "app";
    const manifestJson = JSON.stringify(manifest);
    const adapter = deriveRepoAdapter(src.original, built, {
      repo: src.repo,
      base: src.commit,
      ...(src.ref ? { ref: src.ref } : {}),
    });
    if (repoAdapterProblems(adapter, manifestJson).length > 0) return;
    await this.deps.adapterIndex.submit({
      repo: src.repo,
      base: src.commit,
      licensePath,
      file: buildAdapterFile(manifestJson, adapter),
    });
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
            type: "http",
            url,
            headers: { Authorization: `Bearer ${key}` },
          },
        },
      },
    };
  }
}

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
 *
 * An AI build (the box's own AI, or an IDE over MCP) has two phases
 * (docs/ai-privacy-and-staging.md §2). Staging: the AI's `deploy` runs a
 * private copy (`StagingHost`) that it tests with `check_app` / `get_logs`.
 * Going live: on `finish` (or when the loop ends on a staged copy of the
 * current files) the box SEALS the build — forgets its AI key, revokes its
 * IDE key, and every tool on it refuses from then on — removes the staging
 * copy, then installs or redeploys the live service with the image it
 * tested. The AI is never told how that went. A build no AI touched (a
 * Flagship-ready repo the owner installs) still installs directly.
 */

import { randomBytes } from "node:crypto";
import type { ModelRedactor } from "../llm/modelPrivacy.js";
import { BuildWorkspace } from "./buildWorkspace.js";
import { GitImporter, buildAdaptPrompt } from "./gitImport.js";
import { McpBuildServer, type JsonRpcResponse } from "./mcpServer.js";
import {
  BuildToolHost,
  type BuildToolCheckResult,
  type BuildToolDataHooks,
  type BuildToolDeployResult,
} from "./buildToolHost.js";
import { runBuildAgent, type AgentRunner, type BuildAgentResult } from "./buildAgent.js";
import type { McpKeyStore } from "./mcpKeyStore.js";
import type { BuildJournal, BuildJournalEntry, BuildJournalSummary, BuildMode } from "./buildJournal.js";
import type { DeployResult } from "./deployArtifact.js";
import { filesDigest, stagingDataHooks, type StagingHost } from "./staging.js";
import { classifyEnvironmentFailure } from "./environmentFailure.js";
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
  normalizeRepoUrl,
  repoAdapterProblems,
  splitAdapterFile,
  type AppManifest,
} from "@flagship/protocol";
import { indexableRepo, licensePathOf, type AdapterIndex, type StoreReason } from "./adapterIndex.js";

/** How many times the AI may fix an adaptation the store refused. */
const MAX_FIX_ROUNDS = 2;

export const CLOSED_TO_AI =
  "This build is closed to the AI: it was handed to the box to go live. Start a new build to change the app.";

function manifestName(files: Record<string, string>): string | null {
  try {
    const m = JSON.parse(files["flagship.app.json"] ?? "") as { name?: unknown };
    return typeof m.name === "string" && m.name ? m.name : null;
  } catch {
    return null;
  }
}

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
  /**
   * The AI adapt pass (git), or the box putting an IDE build live after
   * its `finish` (mcp), when it runs in the background.
   */
  adapt?: AdaptStatus;
  /** The build's AI/IDE access has ended for good; every tool refuses. */
  sealed?: boolean;
}

/** What a running AI build is doing: the AI testing its copy, or the box putting it live. */
export type BuildPhase = "staging" | "going-live";

/** What a git build remembers to share its adapter once it deploys. */
interface GitSource {
  /** Normalized address, if it's one the index takes. */
  repo: string | null;
  /** Normalized address, whatever the host. */
  repoUrl: string | null;
  commit?: string;
  ref?: string;
  original: Record<string, string>;
  /** Where the tree it builds came from. */
  origin: "repo" | "index" | "ai" | "as-is";
  /** The repo's own adapter, which no longer fits these files. */
  staleAdapter?: string[];
  shared?: boolean;
  /** The owner steered the AI in their own words, which may be personal. */
  steered?: boolean;
  /** Share the adaptation once it deploys (the owner can switch it off). */
  share: boolean;
  /** The published adapter this build installs (origin "index"). */
  indexFile?: string;
  /** Fix rounds the AI ran after the store refused the adaptation. */
  rounds: number;
  /** The published adapter the store kept for this build, once shared. */
  sharedFile?: string;
}

export type AdaptStatus =
  | { status: "running"; startedAt: number; phase?: BuildPhase }
  | {
      status: "done";
      fileCount: number;
      /** The app is live (installed or updated). */
      deployed: boolean;
      deployedUrl?: string;
      serviceId?: string;
      turns?: number;
      /** Why it isn't live, when the AI's tested copy failed to go live. */
      reason?: string;
    }
  | { status: "failed"; reason: string; notConfigured?: boolean };

export type AdaptResult =
  | { ok: true; fileCount: number; deployed?: boolean; deployedUrl?: string; serviceId?: string; turns?: number; reason?: string }
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
   * Install a files map with an image already built for it: an AI build's
   * tested staging image, so going live never rebuilds. Unset ⇒ going live
   * rebuilds through `deployArtifact`.
   */
  installArtifact?: (a: { files: Record<string, string>; serverFqdn: string; buildId: string; mode: BuildMode; editsServiceId?: string; name?: string; binaries?: Record<string, Buffer>; image: string }) => Promise<DeployResult>;
  /**
   * The private staging copy an AI or IDE build deploys to. Unset ⇒ their
   * deploy tool is unavailable (nothing an AI builds goes straight live).
   */
  staging?: StagingHost;
  /** Forget a build's AI credential: part of sealing it. */
  forgetCredential?: (buildId: string) => Promise<void>;
  /** The env var NAMES the owner set for a service (staging gets placeholders). */
  ownerEnvNames?: (serviceId: string) => Promise<string[]>;
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
   * Remember which published adapter an installed service came from, so its
   * owner can report a problem with it later.
   */
  recordAdapterOrigin?: (serviceId: string, origin: { repo: string; file: string } | null) => Promise<void>;
  /**
   * An installed service's current code, if it can be edited here (built on
   * this box, still installed). Unset ⇒ edits aren't offered.
   */
  editableService?: (serviceId: string) => Promise<EditableService>;
  serverFqdn: string;
  /** Strips the owner's identity from what the AI or IDE reads back. */
  modelRedactor?: ModelRedactor;
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

/** The single-file adapter for a git build, with the owner's choices taken out. */
function adapterFileFor(src: GitSource, built: Record<string, string>): string | null {
  const manifestText = built["flagship.app.json"];
  if (!src.repoUrl || !src.commit || !manifestText) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    return null;
  }
  // The file is published: nothing the owner chose or wrote may survive.
  delete manifest.adapter;
  const repoName = repoNameFromUrl(src.repoUrl);
  const slug = slugifyLabel(repoName) || "app";
  manifest.name = slug;
  manifest.description = repoName.slice(0, 30);
  if (manifest.network && typeof manifest.network === "object") {
    manifest.network = { ...(manifest.network as Record<string, unknown>), subdomain: slug };
  }
  const manifestJson = JSON.stringify(manifest);
  const adapter = deriveRepoAdapter(src.original, built, {
    repo: src.repoUrl,
    base: src.commit,
    ...(src.ref ? { ref: src.ref } : {}),
  });
  if (repoAdapterProblems(adapter, manifestJson, { publicText: Object.values(src.original) }).length > 0) return null;
  return buildAdapterFile(manifestJson, adapter);
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
  /** Published adapters that failed to install here; never offered again. */
  private readonly failedHere = new Set<string>();
  /** Builds an AI (or IDE) has worked on: they go live through staging. */
  private readonly aiTouched = new Set<string>();
  /** Builds whose AI access ended for good. */
  private readonly sealedBuilds = new Set<string>();
  /** Go-lives in progress, so a second request joins the first. */
  private readonly goingLive = new Map<string, Promise<DeployResult>>();
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
  async createGit(args: { gitUrl: string; ref?: string; name?: string; share?: boolean }): Promise<CreateGitResult> {
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
    let indexFile: string | undefined;
    // A repo with its own flagship.app.json is its author's to describe:
    // never looked up in the index, never shared to it.
    const authored = fitness.original?.["flagship.app.json"] != null;
    if (!fitness.fit && repo && !authored && fitness.commit && fitness.original) {
      const known = await this.fromIndex(repo, fitness.commit, fitness.original);
      if (known) {
        const reason = "Flagship-ready: Flagship knows how to run this repo — installing as-is, no AI needed";
        await this.deps.journal.append(buildId, { mode: "git", kind: "fitness-check", actor: "system", summary: reason });
        fitness = { ...fitness, ...known, fit: true, reason };
        origin = "index";
        indexFile = known.sha;
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
      repo: authored ? null : repo,
      repoUrl: normalizeRepoUrl(args.gitUrl),
      ...(fitness.commit ? { commit: fitness.commit } : {}),
      ...(args.ref ? { ref: args.ref } : {}),
      original: fitness.original ?? fitness.files,
      origin,
      share: args.share !== false,
      rounds: 0,
      ...(indexFile ? { indexFile } : {}),
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
    if (st.adapt?.status === "running" || this.goingLive.has(buildId)) return false;
    await this.deps.staging?.teardown(buildId).catch(() => {});
    this.deps.staging?.forget(buildId);
    this.aiTouched.delete(buildId);
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

  /** Whether a git build's adaptation is shared once it deploys. */
  setShare(buildId: string, share: boolean): void {
    const src = this.gitSources.get(buildId);
    if (src) src.share = share;
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
    if (this.sealedBuilds.has(buildId)) return { ok: false, status: 409, reason: CLOSED_TO_AI };
    if (!this.adaptConfigured(buildId)) return { ok: false, status: 503, reason: "AI adapt not configured" };
    st.adapt = { status: "running", startedAt: this.now(), phase: "staging" };
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
              ...(r.reason != null ? { reason: r.reason } : {}),
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
  async adaptGit(buildId: string, opts: { instructions?: string } = {}): Promise<AdaptResult> {
    const st = this.states.get(buildId);
    if (!st || st.mode !== "git") return { ok: false, reason: "not a git build" };
    if (this.sealedBuilds.has(buildId)) return { ok: false, reason: CLOSED_TO_AI };
    const notes: string[] = [];
    const source = this.gitSources.get(buildId);
    if (source && opts.instructions?.trim()) source.steered = true;
    const stale = source?.staleAdapter;
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
    this.aiTouched.add(buildId);
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
   * surface over the build's workspace, multi-turn, deploying to its private
   * staging copy and testing it until it calls finish (or stops / hits the
   * turn cap). Then the box seals the build and puts the tested image live.
   * Returns the merged result; never throws.
   */
  private async adaptGitAgentic(
    buildId: string,
    ws: BuildWorkspace,
    opts: { instructions?: string },
  ): Promise<AdaptResult> {
    const repoFiles = ws.list();
    this.aiTouched.add(buildId);
    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "adapt-step",
      actor: "ai",
      summary: `agentic adapt over ${repoFiles.length} repo file(s)`,
    });

    const tools = new BuildToolHost({
      buildId,
      workspace: ws,
      journal: this.deps.journal,
      serverFqdn: this.deps.serverFqdn,
      mode: "git",
      ...(this.deps.modelRedactor ? { redact: this.deps.modelRedactor } : {}),
      envNames: this.deps.envNames ?? (async () => []),
      recordEnvRequest: async (req) =>
        this.recordEnvRequest(buildId, {
          name: req.name,
          ...(req.why != null ? { why: req.why } : {}),
          ...(req.secret != null ? { secret: req.secret } : {}),
          requestedAt: this.now(),
          requestedBy: "ai",
        }),
      ...this.stagingTools(buildId, { liveBy: "caller" }),
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
      await this.deps.staging?.teardown(buildId).catch(() => {});
      return { ok: false, reason };
    }

    const st = this.states.get(buildId);
    if (st) st.gitFit = true;

    // The box itself failed (its data layer, fence, docker…): nothing the AI
    // wrote is at fault or goes live, and the owner gets the reason.
    if (result.stopReason === "environment" && result.environment) {
      await this.deps.staging?.teardown(buildId).catch(() => {});
      return { ok: false, reason: result.environment.ownerReason };
    }

    // Finished, or stopped with a tested copy of exactly these files: the
    // box puts it live. Otherwise nothing goes live and the copy goes away.
    const live = result.finished || this.stagedMatches(buildId);
    if (!live) {
      await this.deps.staging?.teardown(buildId).catch(() => {});
      const hasManifest = ws.manifestJson() != null;
      if (!hasManifest) {
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
        summary: `agentic adapt wrote a manifest in ${result.turns} turn(s) (no tested copy to put live)`,
      });
      return { ok: true, fileCount: ws.count(), deployed: false, turns: result.turns };
    }

    await this.deps.journal.append(buildId, {
      mode: "git",
      kind: "adapt-step",
      actor: "ai",
      summary: `agentic adapt ${result.finished ? "finished" : "stopped on a tested copy"} in ${result.turns} turn(s)`,
    });
    const r = await this.goLive(buildId);
    return {
      ok: true,
      fileCount: ws.count(),
      deployed: r.ok,
      ...(r.ok ? { deployedUrl: r.url, serviceId: r.serviceId } : { reason: r.reason }),
      turns: result.turns,
    };
  }

  // ----- staging, sealing, going live -----------------------------------

  /** Whether the build's AI/IDE access has ended for good. */
  isSealed(buildId: string): boolean {
    return this.sealedBuilds.has(buildId);
  }

  /**
   * The staging half of the tool surface, bound to one build: deploy to its
   * private copy, check it, read its logs, finish. `liveBy` says who puts it
   * live after finish: the loop that called the AI ("caller"), or the box
   * in the background (an IDE, which has no loop on the box).
   */
  private stagingTools(
    buildId: string,
    opts: { liveBy: "caller" | "background" },
  ): {
    deploy: () => Promise<BuildToolDeployResult>;
    checkApp: (req: { path: string; method?: string; body?: string }) => Promise<BuildToolCheckResult>;
    logs: () => Promise<string | null>;
    data: BuildToolDataHooks;
    finish: () => Promise<{ ok: boolean; reason?: string }>;
    sealed: () => boolean;
  } {
    return {
      deploy: () => this.stage(buildId),
      checkApp: async (req) => {
        if (!this.deps.staging) return { ok: false, reason: "check_app is not available on this server" };
        const r = await this.deps.staging.checkApp(buildId, req);
        return r.ok
          ? { ok: true, status: r.status, contentType: r.contentType, body: r.body, truncated: r.truncated }
          : { ok: false, reason: r.reason };
      },
      logs: async () => (this.deps.staging ? this.deps.staging.logs(buildId) : null),
      data: stagingDataHooks(this.deps.staging, buildId, () => this.sealedBuilds.has(buildId)),
      finish: async () => {
        const f = await this.finishFromAgent(buildId);
        if (f.ok && opts.liveBy === "background") this.startGoLive(buildId);
        return f;
      },
      sealed: () => this.sealedBuilds.has(buildId),
    };
  }

  /** Build the workspace and run it as the build's private staging copy. */
  private async stage(buildId: string): Promise<BuildToolDeployResult> {
    const staging = this.deps.staging;
    if (!staging) return { ok: false, reason: "deploy is not available on this server" };
    if (this.sealedBuilds.has(buildId)) return { ok: false, reason: CLOSED_TO_AI };
    const st = this.states.get(buildId);
    const ws = this.workspaces.get(buildId);
    if (!st || !ws) return { ok: false, reason: "unknown build" };
    this.aiTouched.add(buildId);
    const files = ws.snapshot();
    const slug = (st.name ?? manifestName(files) ?? "app").toLowerCase();
    const r = await staging.stage({
      buildId,
      files,
      ...(this.binaries.has(buildId) ? { binaries: this.binaries.get(buildId)! } : {}),
      ...(st.editsServiceId ? { carryBinariesFrom: st.editsServiceId } : {}),
      slug,
      envNames: await this.stagingEnvNames(buildId, st, slug),
    });
    if (st.mode === "mcp" && st.adapt?.status !== "running") {
      // An IDE build has no loop on the box to stop: the owner sees the
      // server's problem on the build, and the IDE is told to stop.
      if (!r.ok && r.environment) {
        st.adapt = { status: "failed", reason: r.environment.ownerReason };
        await this.deps.journal
          .append(buildId, { mode: "mcp", kind: "error", actor: "system", summary: r.environment.ownerReason })
          .catch(() => {});
      } else if (st.adapt?.status === "failed") {
        delete st.adapt;
      }
    }
    if (r.ok) return { ok: true };
    return { ok: false, reason: r.reason, ...(r.environment ? { environment: r.environment } : {}) };
  }

  /** The owner env var names the copy gets placeholders for: set ones and requested ones. */
  private async stagingEnvNames(buildId: string, st: BuildState, slug: string): Promise<string[]> {
    const names = new Set<string>((this.envRequests.get(buildId) ?? []).map((r) => r.name));
    for (const n of (await this.deps.envNames?.().catch(() => [])) ?? []) names.add(n);
    const host = this.deps.names?.().hostUsername;
    const serviceId = st.editsServiceId ?? (host ? `${host}--${slug}` : null);
    if (serviceId && this.deps.ownerEnvNames) {
      for (const n of await this.deps.ownerEnvNames(serviceId).catch(() => [])) names.add(n);
    }
    return [...names].sort();
  }

  /** Whether the build's last good staging copy was built from its current files. */
  private stagedMatches(buildId: string): boolean {
    const copy = this.deps.staging?.staged(buildId);
    const ws = this.workspaces.get(buildId);
    return !!copy && !!ws && copy.filesDigest === filesDigest(ws.snapshot());
  }

  /**
   * The AI (or IDE) says the app works. Accepted only for a tested copy of
   * the current files; a git build's adaptation is offered to the public
   * store first, and a fixable refusal goes back to the AI to fix while it
   * is still on staging. Accepting seals the build.
   */
  private async finishFromAgent(buildId: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.sealedBuilds.has(buildId)) return { ok: false, reason: CLOSED_TO_AI };
    const ws = this.workspaces.get(buildId);
    if (!ws) return { ok: false, reason: "unknown build" };
    if (!this.deps.staging?.staged(buildId)) {
      return { ok: false, reason: "deploy first: finish only works after a successful deploy" };
    }
    if (!this.stagedMatches(buildId)) {
      return { ok: false, reason: "the files changed since the last deploy: deploy again, test it, then finish" };
    }
    const src = this.gitSources.get(buildId);
    if (src && !src.shared && this.shareable(src)) {
      const refused = await this.shareAdapter(buildId, src, ws.snapshot());
      if (refused && src.rounds < MAX_FIX_ROUNDS && this.adaptConfigured(buildId)) {
        src.rounds++;
        return {
          ok: false,
          reason:
            `Flagship's public store of adaptations, which shares this adaptation with others, refused it for these reasons:\n` +
            refused.map((r) => `- ${r.message}`).join("\n") +
            `\nFix only these, with the smallest change that keeps the app working, validate, deploy again, test it, and call finish.`,
        };
      }
      src.shared = true;
    }
    await this.seal(buildId);
    return { ok: true };
  }

  /**
   * End the build's AI access for good, BEFORE anything goes live: forget
   * its AI key, revoke its IDE key, and make every tool on it refuse. The
   * journal records it, so an IDE build stays closed across a restart.
   */
  async seal(buildId: string): Promise<void> {
    if (this.sealedBuilds.has(buildId)) return;
    this.sealedBuilds.add(buildId);
    const st = this.states.get(buildId);
    if (st) st.sealed = true;
    await this.deps.forgetCredential?.(buildId).catch(() => {});
    if (st?.mode === "mcp" || this.mcpServers.has(buildId)) await this.deps.mcpKeys.revoke(buildId).catch(() => {});
    this.mcpServers.delete(buildId);
    await this.deps.journal.append(buildId, {
      mode: st?.mode ?? "mcp",
      kind: "sealed",
      actor: "system",
      summary: "the AI's work is done; the box is putting it live",
    });
  }

  /** Put an IDE build live in the background; its progress lands on `state.adapt`. */
  private startGoLive(buildId: string): void {
    const st = this.states.get(buildId);
    if (!st) return;
    st.adapt = { status: "running", startedAt: this.now(), phase: "going-live" };
    void this.goLive(buildId)
      .catch((e: unknown): DeployResult => ({ ok: false, reason: (e as Error).message }))
      .then((r) => {
        const cur = this.states.get(buildId);
        if (!cur) return;
        const fileCount = this.workspaces.get(buildId)?.count() ?? 0;
        cur.adapt = r.ok
          ? { status: "done", fileCount, deployed: true, deployedUrl: r.url, serviceId: r.serviceId }
          : { status: "done", fileCount, deployed: false, reason: r.reason };
      });
  }

  /**
   * The box's phase: seal the build (idempotent), remove the staging copy
   * and its dev data, then install (create) or redeploy (edit) the live
   * service with the image the AI tested, real stores, real env and its
   * migrations. Nothing here reaches the AI.
   */
  private goLive(buildId: string): Promise<DeployResult> {
    const running = this.goingLive.get(buildId);
    if (running) return running;
    const p = this.goLiveNow(buildId).finally(() => this.goingLive.delete(buildId));
    this.goingLive.set(buildId, p);
    return p;
  }

  private async goLiveNow(buildId: string): Promise<DeployResult> {
    const st = this.states.get(buildId);
    if (!st) return { ok: false, reason: "unknown build" };
    const ws = this.workspaces.get(buildId);
    if (!ws) return { ok: false, reason: "no workspace for build" };
    await this.seal(buildId);
    if (st.adapt?.status === "running") st.adapt.phase = "going-live";
    const copy = this.stagedMatches(buildId) ? this.deps.staging?.staged(buildId) ?? null : null;
    await this.deps.staging?.teardown(buildId).catch(() => {});
    const args = {
      files: ws.snapshot(),
      serverFqdn: st.serverFqdn,
      buildId,
      mode: st.mode,
      ...(st.editsServiceId ? { editsServiceId: st.editsServiceId } : {}),
      ...(st.name ? { name: st.name } : {}),
      ...(this.binaries.has(buildId) ? { binaries: this.binaries.get(buildId)! } : {}),
    };
    const r =
      copy && this.deps.installArtifact
        ? await this.deps.installArtifact({ ...args, image: copy.image })
        : await this.deps.deployArtifact(args);
    if (r.ok) {
      this.deps.staging?.forget(buildId);
      this.wentLive(buildId, st, r);
    }
    return r;
  }

  /** Record a build that went live, and share its adaptation if it wasn't yet. */
  private wentLive(buildId: string, st: BuildState, r: Extract<DeployResult, { ok: true }>): void {
    st.serviceId = r.serviceId;
    st.deployedUrl = r.url;
    // Deploying again (the owner) replaces it in place.
    st.editsServiceId ??= r.serviceId;
    const src = this.gitSources.get(buildId);
    if (!src) return;
    const origin =
      src.origin === "index" && src.indexFile && src.repo
        ? { repo: src.repo, file: src.indexFile }
        : src.sharedFile && src.repo
          ? { repo: src.repo, file: src.sharedFile }
          : null;
    void this.deps.recordAdapterOrigin?.(r.serviceId, origin).catch(() => {});
    if (!src.shared) {
      src.shared = true;
      const ws = this.workspaces.get(buildId);
      // Live already: a refusal is only journalled, never sent back to an AI.
      if (ws && this.shareable(src)) {
        void this.shareAdapter(buildId, src, ws.snapshot())
          .then(() => {
            if (src.sharedFile && src.repo) return this.deps.recordAdapterOrigin?.(r.serviceId, { repo: src.repo, file: src.sharedFile });
          })
          .catch(() => {});
      }
    }
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
    this.aiTouched.add(buildId);
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
    if (!st || st.mode !== "mcp" || this.sealedBuilds.has(buildId)) return null;
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
    if (!buildId || this.sealedBuilds.has(buildId)) return { authed: false, response: null };
    let server = this.mcpServers.get(buildId);
    if (!server) {
      // A build sealed before a restart stays closed: its key was revoked,
      // and the journal remembers.
      const entries = await this.deps.journal.read(buildId).catch(() => []);
      if (entries.some((e) => e.kind === "sealed")) {
        this.sealedBuilds.add(buildId);
        await this.deps.mcpKeys.revoke(buildId).catch(() => {});
        return { authed: false, response: null };
      }
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

  /**
   * The owner's Deploy / "Install it". A build an AI or IDE worked on goes
   * live through `goLive` (sealed first, the tested image when there is
   * one). A build no AI touched installs directly.
   */
  async deploy(buildId: string): Promise<DeployResult> {
    const st = this.states.get(buildId);
    if (!st) return { ok: false, reason: "unknown build" };
    const ws = this.workspaces.get(buildId);
    if (!ws) return { ok: false, reason: "no workspace for build" };
    // While the box itself is putting it live, the owner's Deploy joins that.
    if (st.adapt?.status === "running" && st.adapt.phase !== "going-live") {
      return { ok: false, reason: "the AI is still working on this build" };
    }
    if (this.aiTouched.has(buildId) || st.mode === "mcp") return this.goLive(buildId);
    const r = await this.deps.deployArtifact({
      files: ws.snapshot(),
      serverFqdn: st.serverFqdn,
      buildId,
      mode: st.mode,
      ...(st.editsServiceId ? { editsServiceId: st.editsServiceId } : {}),
      ...(st.name ? { name: st.name } : {}),
      ...(this.binaries.has(buildId) ? { binaries: this.binaries.get(buildId)! } : {}),
    });
    const src = this.gitSources.get(buildId);
    if (!r.ok) return src ? this.installFailed(buildId, st, src, r.reason) : r;
    this.wentLive(buildId, st, r);
    return r;
  }

  /**
   * A published adapter that fails to build or start here is reported (which
   * one and at what stage, nothing else) and never offered on this box
   * again; the build goes back to the repo's own files for the AI.
   */
  private installFailed(buildId: string, st: BuildState, src: GitSource, reason: string): DeployResult {
    // The server failing (its data layer, docker, a registry…) says nothing
    // about the adapter: no complaint to the public store, no AI.
    const environment = classifyEnvironmentFailure(reason);
    if (environment) return { ok: false, reason: environment.ownerReason };
    const stage = /^docker build failed/.test(reason) ? "build" : /^install rejected/.test(reason) ? "start" : null;
    if (src.origin !== "index" || !src.indexFile || !src.repo || !stage) return { ok: false, reason };
    void this.deps.adapterIndex?.complain({ repo: src.repo, file: src.indexFile, stage }).catch(() => {});
    this.failedHere.add(src.indexFile);
    this.workspaces.set(buildId, new BuildWorkspace(src.original));
    st.gitFit = false;
    src.origin = "ai";
    delete src.indexFile;
    // The owner's own AI makes a better one; if this build already has a
    // key, it starts now.
    if (this.adaptConfigured(buildId)) this.startAdaptGit(buildId);
    return {
      ok: false,
      reason: `${reason}. The shared adaptation of this repo didn't work on this server, so it has been reported. Use AI to prepare the repo for Flagship instead.`,
      needsAdapt: true,
    };
  }

  /**
   * An adapter someone shared for this repo that fits these files: the first
   * that passes the same checks the index ran and applies cleanly.
   */
  private async fromIndex(
    repo: string,
    commit: string,
    original: Record<string, string>,
  ): Promise<{ files: Record<string, string>; manifestJson: string; manifest: AppManifest; sha: string } | null> {
    if (!this.deps.adapterIndex) return null;
    for (const candidate of await this.deps.adapterIndex.lookup(repo, commit)) {
      const split = splitAdapterFile(candidate.file);
      if (this.failedHere.has(candidate.sha)) continue;
      if (!split.ok || !split.adapter || split.adapter.source.repo !== repo) continue;
      if (repoAdapterProblems(split.adapter, split.manifestJson, { publicText: Object.values(original) }).length > 0) continue;
      const parsed = parseManifest(JSON.parse(split.manifestJson));
      if (!parsed.ok) continue;
      const applied = applyRepoAdapter(original, split.adapter, split.manifestJson);
      if (!applied.ok) continue;
      return { files: applied.files, manifestJson: split.manifestJson, manifest: parsed.manifest, sha: candidate.sha };
    }
    return null;
  }

  /** Whether this build's adaptation may go to the public store at all. */
  private shareable(src: GitSource): boolean {
    return !!this.deps.adapterIndex && !!src.repo && src.share && !src.steered && src.origin !== "repo" && src.origin !== "as-is";
  }

  /**
   * Share what made this repo run, so the next person importing it needs no
   * AI: only for public repos on the big hosts, never the repo's own adapter
   * (that's the author's), with the owner's choices (the name) taken out and
   * nothing that says who sent it. Returns the store's fixable reasons when
   * it refused, else null.
   */
  private async shareAdapter(buildId: string, src: GitSource, built: Record<string, string>): Promise<StoreReason[] | null> {
    const index = this.deps.adapterIndex;
    if (!index || !src.repo || !this.shareable(src)) return null;
    const licensePath = licensePathOf(src.original);
    const file = licensePath ? adapterFileFor(src, built) : null;
    if (!file || !src.commit || !licensePath) return null;
    const v = await index.submit({ repo: src.repo, base: src.commit, licensePath, file });
    const note = (summary: string, detail?: string) =>
      this.deps.journal.append(buildId, {
        mode: "git",
        kind: "adapt-step",
        actor: "system",
        summary,
        ...(detail ? { detail } : {}),
      });
    if (!v) {
      await note("couldn't reach Flagship's store of adaptations; not shared");
      return null;
    }
    if (v.status !== "refused") {
      await note(v.status === "kept" ? "shared the adaptation with Flagship's public store" : "the public store already had this adaptation");
      if (v.file) src.sharedFile = v.file;
      return null;
    }
    const reasons = v.reasons ?? [];
    await note("the public store refused the adaptation", reasons.map((r) => r.message).join("; "));
    if (!reasons.length || reasons.some((r) => !r.fixable)) return null;
    return reasons;
  }

  /**
   * The flagship.app.json that makes this repo run the way this build does,
   * for its author to commit: the manifest with an adapter from the cloned
   * commit to the build's files. Null when the build isn't a git import or
   * its commit is unknown.
   */
  adapterFile(buildId: string): string | null {
    const src = this.gitSources.get(buildId);
    const ws = this.workspaces.get(buildId);
    return src && ws ? adapterFileFor(src, ws.snapshot()) : null;
  }

  // ----- internals -------------------------------------------------------

  private makeMcpServer(buildId: string, ws: BuildWorkspace): McpBuildServer {
    return new McpBuildServer({
      buildId,
      workspace: ws,
      journal: this.deps.journal,
      serverFqdn: this.deps.serverFqdn,
      envNames: this.deps.envNames ?? (async () => []),
      ...(this.deps.modelRedactor ? { redact: this.deps.modelRedactor } : {}),
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
      ...this.stagingTools(buildId, { liveBy: "background" }),
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

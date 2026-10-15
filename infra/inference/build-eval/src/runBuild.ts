/**
 * One measured run: a scenario's first build and its follow-up edits,
 * driven through the box's own build loop, in-process.
 *
 * What runs is the daemon's code, wired the way `index.ts` wires it:
 *   - `VibeCodeSessionRegistry` / `VibeCodeSession` (state machine, parser);
 *   - `buildVibeCodeStartStreaming` / `buildVibeCodeResumeStreaming` (the
 *     system prompt, tools, compaction, streaming through `LlmHarness` and
 *     the `flagship` provider adapter);
 *   - `buildStagedChatDeploy` (stage the copy; when it won't build or start,
 *     the staged agent loop `runBuildAgent` with `BuildToolHost` fixes it);
 *   - an edit is a new session on the live app's files, as
 *     `/api/screens/vibe-code/start` with `editServiceId` makes it.
 *
 * Stubbed, because they need a box: the staging copy (`staticStaging.ts`
 * or `dockerStage.ts`), going live (the files are written to a folder an
 * edit reads back with the box's `readServiceSource`), the credential
 * store (in memory), the env store (names the owner "set"), the hub relay
 * (calls go straight to the in-process shim), and `.com` (`shimHost.ts`).
 * The owner's answers come from the scenario (`ownerScript.ts`).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRequest } from "@flagship/llm-providers";
import { inferenceCatalog, inferenceCatalogResponse } from "@flagship/control-plane";
import { LlmHarness, type LlmCredential } from "../../../../packages/server-daemon/src/llmHarness.js";
import type { SwkOps } from "../../../../packages/server-daemon/src/keyCustodian.js";
import type { AppEnvStore } from "../../../../packages/server-daemon/src/serviceEnvStore.js";
import type { BuildCredentialStore } from "../../../../packages/server-daemon/src/llm/buildCredentialStore.js";
import { VibeCodeSessionRegistry, type VibeCodeSession } from "../../../../packages/server-daemon/src/llm/vibeCodeSession.js";
import {
  EDIT_SOURCE_MAX_BYTES,
  buildVibeCodeResumeStreaming,
  buildVibeCodeStartStreaming,
  defaultModelsFromEnv,
  modelForProvider,
} from "../../../../packages/server-daemon/src/llm/vibeCodeStartStreaming.js";
import { buildStagedChatDeploy, type DeployResult, type DeploySessionOverride } from "../../../../packages/server-daemon/src/llm/deploySession.js";
import { ModelCatalog } from "../../../../packages/server-daemon/src/llm/modelCatalog.js";
import { buildModelRedactor } from "../../../../packages/server-daemon/src/llm/modelPrivacy.js";
import { readServiceSource, writeSourceTree } from "../../../../packages/server-daemon/src/llm/serviceSource.js";
import { withoutBuildFiles } from "../../../../packages/server-daemon/src/buildmodes/buildWorkspace.js";
import type { AgentRunner } from "../../../../packages/server-daemon/src/buildmodes/buildAgent.js";
import type { StagingHost } from "../../../../packages/server-daemon/src/buildmodes/staging.js";
import { DEFAULT_WEIGHTS, totalsOf, type CallRecord, type Totals } from "./accounting.js";
import type { BudgetGuard } from "./budget.js";
import { callContext, type CallContext } from "./context.js";
import { MAX_OWNER_ANSWERS, ownerAnswer } from "./ownerScript.js";
import type { Scenario } from "./scenarios.js";
import type { ShimHost } from "./shimHost.js";
import type { StageOutcome } from "./staticStaging.js";

/** The neutral owner and box the runs pretend to be. */
export const EVAL_USERNAME = "evalowner";
export const EVAL_SERVER = "home.evalowner.flagship.services";

export interface StepResult {
  /** "build", "edit-1", … */
  step: string;
  kind: "build" | "edit";
  pass: boolean;
  /** Why it failed, in the box's words. */
  reason?: string;
  /** Skipped because an earlier step failed or the budget stopped the run. */
  skipped?: boolean;
  /** Questions and env-var requests the owner answered. */
  ownerAnswers: number;
  /** Test copies staged, and how many of them failed. */
  stages: number;
  failedStages: number;
  /** The AI fix loop ran (the first test copy failed). */
  fixLoop: boolean;
  /** Failures fed back to the model: the first one, then each failed deploy inside the loop. */
  fixRounds: number;
  totals: Totals;
  wallMs: number;
  /** Files the app had when the step ended. */
  files: number;
}

export interface RunResult {
  runId: string;
  model: string;
  modelLabel: string;
  multiplier: number;
  scenario: string;
  size: Scenario["size"];
  repeat: number;
  upstream: "deepinfra" | "mock";
  stage: "static" | "docker";
  startedAt: string;
  wallMs: number;
  pass: boolean;
  failure?: string;
  /** The budget guard stopped this run. */
  stoppedByBudget?: boolean;
  steps: StepResult[];
  totals: Totals;
  calls: CallRecord[];
  /** Usage the shim reported to `.com` for this run, summed (a cross-check). */
  shimReported?: { inputTokens: number; outputTokens: number };
}

export interface RunOptions {
  runId: string;
  scenario: Scenario;
  /** Catalog id ("low", …). */
  model: string;
  repeat: number;
  host: ShimHost;
  guard: BudgetGuard;
  upstream: "deepinfra" | "mock";
  stage: "static" | "docker";
  /** Makes the staging host for this run; `onStage` reports each attempt. */
  staging: (onStage: (o: StageOutcome) => void) => StagingHost;
  /** Scratch space for the "live" apps. */
  workDir: string;
  /** Where to save each step's final files (optional). */
  saveAppsDir?: string;
  /** The fix loop's turn cap (the box's default, 24, when unset). */
  agentMaxTurns?: number;
  log?: (m: string) => void;
}

class MemoryCredentials implements BuildCredentialStore {
  private readonly m = new Map<string, LlmCredential>();
  async put(id: string, c: LlmCredential): Promise<void> {
    this.m.set(id, c);
  }
  async get(id: string): Promise<LlmCredential | null> {
    return this.m.get(id) ?? null;
  }
  has(id: string): boolean {
    return this.m.has(id);
  }
  providerName(id: string): string | null {
    return this.m.get(id)?.provider ?? null;
  }
  async forget(id: string): Promise<void> {
    this.m.delete(id);
  }
}

/** The harness never seals: `chatStream` and `chatWithCredential` take the key in memory. */
const NO_SWK = new Proxy({} as SwkOps, {
  get() {
    throw new Error("the build-eval harness has no SWK");
  },
});

export async function runOne(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const calls: CallRecord[] = [];
  const steps: StepResult[] = [];
  const served = inferenceCatalog().find((m) => m.id === o.model);
  if (!served) throw new Error(`unknown model ${o.model}`);
  const liveDir = join(o.workDir, o.runId, "apps");
  await mkdir(liveDir, { recursive: true });

  const registry = new VibeCodeSessionRegistry(null);
  const credentials = new MemoryCredentials();
  const envNames = new Set<string>();
  const appEnvStore = {
    names: async () => [...envNames].sort(),
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  } as unknown as AppEnvStore;
  const harness = new LlmHarness({ swk: NO_SWK, fetchImpl: o.host.fetchLike, streamingFetchImpl: o.host.streamingFetchLike });
  const catalog = new ModelCatalog({
    baseUrl: "https://com.build-eval.test",
    fetch: async () => ({ ok: true, json: async () => inferenceCatalogResponse(DEFAULT_WEIGHTS) }),
  });
  const redact = buildModelRedactor(() => ({ username: EVAL_USERNAME, serverFqdn: EVAL_SERVER, extra: [] }));
  const defaultModels = defaultModelsFromEnv({});
  const serviceIdFor = (session: VibeCodeSession): string | null => {
    if (session.meta.editsServiceId) return session.meta.editsServiceId;
    if (session.meta.name) return `${EVAL_USERNAME}--${session.meta.name}`;
    try {
      const m = JSON.parse(session.manifestJson() ?? "") as { name?: unknown };
      return typeof m.name === "string" && m.name ? `${EVAL_USERNAME}--${m.name.toLowerCase()}` : null;
    } catch {
      return null;
    }
  };
  const streamArgs = {
    registry,
    harness,
    credentials,
    resolveAppId: (id: string) => {
      const s = registry.get(id);
      return s ? serviceIdFor(s) : null;
    },
    appEnvStore,
    defaultModels,
    contextTokens: (provider: string, model: string) => catalog.contextTokens(provider, model),
    redact,
  };
  const startStreaming = buildVibeCodeStartStreaming(streamArgs);
  const resumeStreaming = buildVibeCodeResumeStreaming(streamArgs);

  // As index.ts builds `buildAgentRunner`: the session's key and model.
  const sessionChoice = (id: string) => {
    const meta = registry.get(id)?.meta;
    return { ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort } : {}) };
  };
  const agentModel = (provider: string, id: string, requested?: string) =>
    modelForProvider(provider, requested && requested.length > 0 ? requested : sessionChoice(id).model, defaultModels);
  const agentRunner: AgentRunner = Object.assign(
    async (id: string, req: ChatRequest) => {
      const credential = await credentials.get(id);
      if (!credential) throw new Error("AI adapt not configured");
      const effort = req.reasoningEffort ?? sessionChoice(id).effort;
      return harness.chatWithCredential(credential, {
        ...req,
        model: agentModel(credential.provider, id, req.model),
        ...(effort ? { reasoningEffort: effort } : {}),
      });
    },
    {
      contextTokens: async (id: string) => {
        const credential = await credentials.get(id);
        return credential ? catalog.contextTokens(credential.provider, agentModel(credential.provider, id)) : undefined;
      },
    },
  );

  // Going live: the files land where an edit reads them back.
  const goLive = async (session: VibeCodeSession, override: DeploySessionOverride): Promise<DeployResult> => {
    const files = withoutBuildFiles(override.files ?? session.files());
    let name = session.meta.name;
    if (!name) {
      try {
        const m = JSON.parse(files["flagship.app.json"] ?? "") as { name?: unknown };
        if (typeof m.name === "string") name = m.name.toLowerCase();
      } catch {
        return { ok: false, reason: "manifest is not valid JSON" };
      }
    }
    if (!name) return { ok: false, reason: "manifest.name missing" };
    const serviceId = session.meta.editsServiceId ?? `${EVAL_USERNAME}--${name}`;
    const w = await writeSourceTree(join(liveDir, serviceId), files);
    if (!w.ok) return { ok: false, reason: `unsafe path in session files: ${w.unsafePath}` };
    return { ok: true, serviceId, url: `https://${name}.${EVAL_SERVER}`, image: override.image ?? `flagship-vibe-${serviceId}:eval` };
  };

  let outcomes: Array<StageOutcome & { fixing: boolean }> = [];
  let fixing = false;
  const staging = o.staging((s) => outcomes.push({ ...s, fixing }));
  const stagedDeploy = buildStagedChatDeploy({
    deploy: goLive,
    staging,
    agentRunner,
    hasCredential: (id) => credentials.has(id),
    forgetCredential: (id) => credentials.forget(id),
    redact,
    envNames: async () => [...envNames].sort(),
    hostUsername: EVAL_USERNAME,
    ...(o.agentMaxTurns ? { agentMaxTurns: o.agentMaxTurns } : {}),
  });

  const credential = await o.host.credential(EVAL_USERNAME);
  const baseCtx: CallContext = {
    runId: o.runId,
    step: "build",
    phase: "chat",
    mock: o.scenario.mock,
    record: (c) => calls.push(c),
  };

  async function step(
    name: string,
    kind: "build" | "edit",
    prompt: string,
    edit: { serviceId: string; slug: string; files: Record<string, string> } | null,
  ): Promise<{ result: StepResult; serviceId?: string }> {
    const t0 = Date.now();
    outcomes = [];
    fixing = false;
    let answers = 0;
    const ctx: CallContext = { ...baseCtx, step: name, phase: "chat" };
    const finish = (pass: boolean, reason?: string, files = 0): StepResult => {
      const failed = outcomes.filter((x) => !x.ok);
      return {
        step: name,
        kind,
        pass,
        ...(reason ? { reason: o.guard.tripped() && !pass ? `${reason} (${o.guard.tripped()})` : reason } : {}),
        ownerAnswers: answers,
        stages: outcomes.length,
        failedStages: failed.length,
        fixLoop: fixing,
        fixRounds: fixing ? 1 + failed.filter((x) => x.fixing).length : 0,
        totals: totalsOf(calls.filter((c) => c.step === name)),
        wallMs: Date.now() - t0,
        files,
      };
    };
    const session = registry.create({
      username: EVAL_USERNAME,
      serverFqdn: EVAL_SERVER,
      ...(edit
        ? { name: edit.slug, editsServiceId: edit.serviceId, files: edit.files }
        : { ...(o.scenario.name ? { name: o.scenario.name } : {}), ...(o.scenario.visibility ? { visibility: o.scenario.visibility } : {}) }),
    });
    const id = session.meta.sessionId;
    session.pushUserMessage(prompt);
    await credentials.put(id, credential);
    await callContext.run(ctx, () =>
      startStreaming({
        sessionId: id,
        prompt,
        model: o.model,
        ...(!edit && o.scenario.name ? { preferredName: o.scenario.name } : {}),
        ...(!edit && o.scenario.visibility ? { visibility: o.scenario.visibility } : {}),
      }),
    );
    let questions = 0;
    for (;;) {
      const st = session.meta.status;
      if (st === "ready-to-deploy") break;
      if (st === "failed" || st === "cancelled") return { result: finish(false, `chat: ${session.meta.failureReason ?? st}`) };
      if (st !== "awaiting-tool-response") return { result: finish(false, "chat: the model's turn ended without an answer") };
      const pending = session.pendingRequest();
      if (!pending) {
        const tool = session.pendingToolUses()[0]?.name ?? "?";
        return { result: finish(false, `chat: the model called a tool the chat doesn't have (${tool})`) };
      }
      if (answers >= MAX_OWNER_ANSWERS) return { result: finish(false, `chat: still asking after ${MAX_OWNER_ANSWERS} answers`) };
      const a = ownerAnswer(o.scenario, pending, questions);
      answers++;
      if (a.kind === "reply") {
        questions++;
        const r = session.pushUserReply({ toolUseId: a.toolUseId, text: a.text });
        if (!r.ok) return { result: finish(false, `chat: reply refused: ${r.reason}`) };
      } else {
        if (a.status === "set" && a.name) envNames.add(a.name);
        const r = session.pushEnvVarAck({
          toolUseId: a.toolUseId,
          ack: { acknowledged: true, name: a.name, status: a.status, currentlySet: envNames.has(a.name) },
        });
        if (!r.ok) return { result: finish(false, `chat: env-var answer refused: ${r.reason}`) };
      }
      await callContext.run(ctx, () => resumeStreaming(id));
    }

    const deployed = await callContext.run({ ...ctx, phase: "fix" }, () =>
      stagedDeploy(session, {
        onPhase: (p) => {
          if (p === "fixing") fixing = true;
        },
      }),
    );
    const files = Object.keys(session.files()).length;
    if (o.saveAppsDir) await saveFiles(join(o.saveAppsDir, o.runId, name), session.files());
    if (!deployed.ok) return { result: finish(false, `deploy: ${deployed.reason}`, files) };
    session.markDeployed({ serviceId: deployed.serviceId, url: deployed.url });
    return { result: finish(true, undefined, files), serviceId: deployed.serviceId };
  }

  let failure: string | undefined;
  try {
    const first = await step("build", "build", o.scenario.prompt, null);
    steps.push(first.result);
    let serviceId = first.serviceId;
    if (!first.result.pass) failure = `build: ${first.result.reason}`;
    for (let i = 0; i < o.scenario.edits.length; i++) {
      const name = `edit-${i + 1}`;
      if (failure || !serviceId || o.guard.tripped()) {
        steps.push(skipped(name));
        continue;
      }
      const src = await readServiceSource(liveDir, serviceId);
      if (!src.ok) {
        failure = `${name}: ${src.reason}`;
        steps.push({ ...skipped(name), skipped: false, reason: src.reason });
        continue;
      }
      if (src.bytes > EDIT_SOURCE_MAX_BYTES) {
        failure = `${name}: the app is too big to change in the AI chat`;
        steps.push({ ...skipped(name), skipped: false, reason: "too big to change in the AI chat" });
        continue;
      }
      const slug = serviceId.slice(serviceId.indexOf("--") + 2);
      const r = await step(name, "edit", o.scenario.edits[i]!, { serviceId, slug, files: src.files });
      steps.push(r.result);
      if (!r.result.pass) failure = `${name}: ${r.result.reason}`;
      else serviceId = r.serviceId ?? serviceId;
    }
  } finally {
    await rm(join(o.workDir, o.runId), { recursive: true, force: true }).catch(() => {});
  }

  const reports = o.host.usageReports.filter((r) => r.runId === o.runId);
  const tripped = o.guard.tripped();
  return {
    runId: o.runId,
    model: o.model,
    modelLabel: served.label,
    multiplier: served.multiplier,
    scenario: o.scenario.id,
    size: o.scenario.size,
    repeat: o.repeat,
    upstream: o.upstream,
    stage: o.stage,
    startedAt: new Date(started).toISOString(),
    wallMs: Date.now() - started,
    pass: !failure,
    ...(failure ? { failure } : {}),
    ...(failure && tripped ? { stoppedByBudget: true } : {}),
    steps,
    totals: totalsOf(calls),
    calls,
    shimReported: reports.reduce((a, r) => ({ inputTokens: a.inputTokens + r.inputTokens, outputTokens: a.outputTokens + r.outputTokens }), {
      inputTokens: 0,
      outputTokens: 0,
    }),
  };
}

function skipped(step: string): StepResult {
  return {
    step,
    kind: "edit",
    pass: false,
    skipped: true,
    ownerAnswers: 0,
    stages: 0,
    failedStages: 0,
    fixLoop: false,
    fixRounds: 0,
    totals: totalsOf([]),
    wallMs: 0,
    files: 0,
  };
}

async function saveFiles(dir: string, files: Record<string, string>): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  for (const [p, c] of Object.entries(files)) {
    if (p.includes("..") || p.startsWith("/")) continue;
    const full = join(dir, p);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, c);
  }
}

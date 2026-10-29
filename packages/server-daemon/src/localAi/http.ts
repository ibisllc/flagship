/**
 * The owner's Local AI screen (paired session; companion sessions may look but not change):
 *
 *   GET  /api/screens/local-ai                      everything the screen shows
 *   GET  /api/screens/local-ai/jobs/<jobId>         one training job with its checkpoints
 *   POST /api/screens/local-ai/settings             {useGpu?, serveModel?}
 *   POST /api/screens/local-ai/models/download      {modelId}
 *   POST /api/screens/local-ai/models/cancel        {modelId}
 *   POST /api/screens/local-ai/models/delete        {modelId}
 *   POST /api/screens/local-ai/service/start        {modelId?}
 *   POST /api/screens/local-ai/service/stop         {}
 *   POST /api/screens/local-ai/train                {order: flagship/local-ai-train/v1, signature}
 *   POST /api/screens/local-ai/jobs/cancel|resume|delete   {jobId}
 *   POST /api/screens/local-ai/apps/grant           {order: flagship/local-ai-app-grant/v1, signature}
 *
 * Every list says what is true on this server only: local work costs nothing and never leaves it
 * (`cost: "none"`, `privacy: "this-server"`), and the queue positions are the box's own.
 */
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { AcceleratorBroker } from "../gpu/broker.js";
import { expectedTokensPerSecond, LOCAL_MODELS, memoryNeededMiB, type LocalModel } from "./catalog.js";
import { LOCAL_AI_APP } from "./devices.js";
import type { LocalAi } from "./index.js";
import { refusalText } from "./modelStore.js";
import { checkAppGrant, checkTrainOrder } from "./orders.js";
import { TrainingRefused, trainingMemoryMiB, type TrainingJob } from "./training.js";
import { LocalAiUnavailable } from "./service.js";

export const LOCAL_AI_PATH = "/api/screens/local-ai";

const J = { "content-type": "application/json" } as const;
function json(status: number, body: unknown): HttpResponse {
  return { status, headers: J, body: Buffer.from(JSON.stringify(body)) };
}

export interface LocalAiHttpDeps {
  ai: LocalAi;
  broker: AcceleratorBroker | null;
  serverDomain: string;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
  now?: () => number;
}

export interface ModelRow {
  id: string;
  name: string;
  descriptor: string;
  parameters: string;
  quantization: string;
  sizeBytes: number;
  license: { id: string; url: string };
  contextTokens: number;
  tools: boolean;
  purpose: string;
  trainable: boolean;
  state: string;
  progress: { state: string; receivedBytes: number; totalBytes: number } | null;
  reason: string | null;
  memoryNeededMiB: number;
  fits: boolean;
  speed: { tokensPerSecond: number; measured: boolean; on: "cpu" | "gpu" };
}

export interface JobRow {
  id: string;
  kind: "inference" | "training";
  appId: string | null;
  appName: string | null;
  modelId: string | null;
  state: string;
  device: "cpu" | "gpu" | null;
  gpu: { deviceIds: string[] } | null;
  queuePosition: number | null;
  createdAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  reason: string | null;
  epochs: number | null;
  epochsDone: number | null;
  checkpoints: number | null;
  cost: "none";
}

function trainingRow(j: TrainingJob, appName: string | null, queuePosition: number | null): JobRow {
  return {
    id: j.jobId,
    kind: "training",
    appId: j.serviceId,
    appName,
    modelId: j.baseModel,
    state: j.state,
    device: j.device ?? null,
    gpu: j.gpu ? { deviceIds: j.gpu.deviceIds } : null,
    queuePosition,
    createdAt: j.createdAt,
    startedAt: j.startedAt ?? null,
    endedAt: j.endedAt ?? null,
    reason: j.reason ?? null,
    epochs: j.epochs,
    epochsDone: j.epochsDone,
    checkpoints: j.checkpoints.length,
    cost: "none",
  };
}

async function readJson(req: HttpRequest): Promise<Record<string, unknown> | null> {
  if (req.body.length === 0) return {};
  if (req.body.length > 64 * 1024) return null;
  try {
    const v = JSON.parse(req.body.toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function localAiView(d: LocalAiHttpDeps) {
  const ai = d.ai;
  const hw = ai.hardware();
  const inv = d.broker ? await d.broker.inventory() : null;
  const gpus = (inv?.devices ?? []).filter((x) => !x.displayOwned);
  const bestGpuMiB = gpus.filter((x) => x.qualified.length > 0 && !x.quarantined).reduce<number | null>((n, x) => Math.max(n ?? 0, x.memoryMiB), null);
  const apps = ai.o.apps();
  const appName = (id: string) => (id === LOCAL_AI_APP.appId ? "Local AI" : apps.find((a) => a.serviceId === id)?.name ?? null);
  const models: ModelRow[] = LOCAL_MODELS.map((m: LocalModel) => {
    const s = ai.store.stateOf(m.id);
    const rec = ai.store.installed(m.id);
    const useGpu = ai.settings().useGpu && bestGpuMiB !== null && bestGpuMiB >= memoryNeededMiB(m);
    return {
      id: m.id,
      name: m.name,
      descriptor: m.descriptor,
      parameters: m.parameters,
      quantization: m.quantization,
      sizeBytes: m.sizeBytes,
      license: m.license,
      contextTokens: m.contextTokens,
      tools: m.tools,
      purpose: m.purpose,
      trainable: m.trainable,
      state: s.state,
      progress: s.progress ?? null,
      reason: s.reason ?? null,
      memoryNeededMiB: memoryNeededMiB(m),
      fits: memoryNeededMiB(m) <= hw.memoryMiB * 0.8 || useGpu,
      speed: rec?.measuredTokensPerSecond
        ? { tokensPerSecond: rec.measuredTokensPerSecond, measured: true, on: rec.measuredOn ?? "cpu" }
        : { tokensPerSecond: expectedTokensPerSecond(m, { cpus: hw.cpus, gpuMemoryMiB: useGpu ? bestGpuMiB : null }), measured: false, on: useGpu ? "gpu" : "cpu" },
    };
  });
  const sv = ai.service.view();
  const jobs: JobRow[] = [];
  if (sv.state !== "stopped" || sv.jobId) {
    jobs.push({
      id: sv.jobId ?? "service",
      kind: "inference",
      appId: null,
      appName: null,
      modelId: sv.modelId,
      state: sv.state,
      device: sv.device,
      gpu: sv.gpu ? { deviceIds: sv.gpu.deviceIds } : null,
      queuePosition: sv.queuePosition,
      createdAt: sv.startedAt,
      startedAt: sv.startedAt,
      endedAt: null,
      reason: sv.reason,
      epochs: null,
      epochsDone: null,
      checkpoints: null,
      cost: "none",
    });
  }
  for (const j of ai.training.list().sort((a, b) => b.createdAt - a.createdAt)) {
    jobs.push(trainingRow(j, appName(j.serviceId), ai.training.queuePosition(j.jobId)));
  }
  const free = await ai.store.freeBytes();
  return {
    available: ai.o.available?.().ok ?? true,
    reason: ai.o.available?.().reason ?? null,
    privacy: "this-server" as const,
    cost: "none" as const,
    settings: ai.settings(),
    hardware: {
      cpus: hw.cpus,
      memoryMiB: hw.memoryMiB,
      diskFreeBytes: free,
      gpuService: inv ? inv.available || inv.reason !== "no-gpu-service" : false,
      gpus: gpus.map((g) => ({
        id: g.id,
        model: g.model,
        vendor: g.vendor,
        memoryMiB: g.memoryMiB,
        state: g.quarantined ? "quarantined" : g.holders.length ? "in-use" : g.qualified.length ? "free" : "unqualified",
        holders: g.holders.map((h) => ({ appId: h.appId, appName: appName(h.appId), allocationId: h.allocationId, state: h.state })),
      })),
    },
    budget: { usedBytes: ai.store.usedBytes(), budgetBytes: ai.store.budgetBytes() },
    models,
    service: sv,
    jobs,
    apps: apps
      .filter((a) => a.declaresLocalAi)
      .map((a) => ({ serviceId: a.serviceId, name: a.name, grant: ai.grants.get(a.serviceId), usage: ai.grants.usageOf(a.serviceId) })),
    datasets: apps.map((a) => ({ serviceId: a.serviceId, name: a.name, hasSampleData: ai.o.hasSampleData(a.serviceId) })),
    trainableModels: LOCAL_MODELS.filter((m) => m.trainable).map((m) => ({ id: m.id, name: m.name, installed: ai.store.installed(m.id) !== null, memoryNeededMiB: trainingMemoryMiB(m) })),
  };
}

export function buildLocalAiHttp(d: LocalAiHttpDeps) {
  const now = d.now ?? Date.now;
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== LOCAL_AI_PATH && !path.startsWith(`${LOCAL_AI_PATH}/`)) return null;
    const ai = d.ai;
    if (method === "GET") {
      if (path === LOCAL_AI_PATH) return json(200, await localAiView(d));
      const m = /^\/api\/screens\/local-ai\/jobs\/([0-9a-f]{16})$/.exec(path);
      if (m) {
        const j = ai.training.get(m[1]!);
        if (!j) return json(404, { error: "No such training job." });
        const appName = ai.o.apps().find((a) => a.serviceId === j.serviceId)?.name ?? null;
        return json(200, {
          job: trainingRow(j, appName, ai.training.queuePosition(j.jobId)),
          datasetDigest: j.datasetDigest ?? null,
          datasetBytes: j.datasetBytes ?? null,
          checkpoints: j.checkpoints.map((c) => ({ epoch: c.epoch, sha256: c.sha256, sizeBytes: c.sizeBytes, at: c.at, loss: c.loss ?? null })),
        });
      }
      return json(404, { error: "not found" });
    }
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = d.denyCompanion(req);
    if (denied) return denied;
    const body = await readJson(req);
    if (body === null) return json(400, { error: "The body must be a JSON object." });
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    switch (path) {
      case `${LOCAL_AI_PATH}/settings`: {
        const patch: { useGpu?: boolean; serveModel?: string | null } = {};
        if (body.useGpu !== undefined) {
          if (typeof body.useGpu !== "boolean") return json(400, { error: "useGpu is true or false." });
          patch.useGpu = body.useGpu;
        }
        if (body.serveModel !== undefined) {
          if (body.serveModel !== null && (typeof body.serveModel !== "string" || !LOCAL_MODELS.some((m) => m.id === body.serveModel))) return json(400, { error: "Unknown model." });
          patch.serveModel = body.serveModel as string | null;
        }
        return json(200, { ok: true, settings: await ai.setSettings(patch) });
      }
      case `${LOCAL_AI_PATH}/models/download`: {
        const r = await ai.store.download(str("modelId"));
        if (!r.ok) return json(r.refusal === "unknown-model" ? 404 : 409, { error: refusalText(r.refusal), code: r.refusal });
        void r.done.catch(() => {});
        return json(202, { ok: true });
      }
      case `${LOCAL_AI_PATH}/models/cancel`:
        return ai.store.cancel(str("modelId")) ? json(200, { ok: true }) : json(404, { error: "That model isn't downloading." });
      case `${LOCAL_AI_PATH}/models/delete`: {
        const id = str("modelId");
        if (ai.service.view().modelId === id) await ai.service.stop("its model was deleted");
        if (ai.settings().serveModel === id) await ai.setSettings({ serveModel: null });
        return (await ai.store.remove(id)) ? json(200, { ok: true }) : json(404, { error: "That model isn't on this server." });
      }
      case `${LOCAL_AI_PATH}/service/start`: {
        try {
          const lease = await ai.service.lease(str("modelId") || undefined);
          lease.release();
          return json(200, { ok: true, service: ai.service.view() });
        } catch (e) {
          if (!(e instanceof LocalAiUnavailable)) console.error(`[local-ai] start failed unexpectedly: ${(e as Error).stack ?? e}`);
          return json(503, { error: e instanceof LocalAiUnavailable ? e.message : "The model server didn't start.", code: e instanceof LocalAiUnavailable ? e.code : "start-failed" });
        }
      }
      case `${LOCAL_AI_PATH}/service/stop`:
        await ai.service.stop("stopped by the owner");
        return json(200, { ok: true, service: ai.service.view() });
      case `${LOCAL_AI_PATH}/train`: {
        const v = checkTrainOrder(body, d.serverDomain, ai.o.authority(), now());
        if (!v.ok) return json(v.status, { error: v.error });
        if (!ai.o.apps().some((a) => a.serviceId === v.order.serviceId)) return json(404, { error: "That app isn't on this server." });
        try {
          const job = await ai.training.submit(v.order);
          return json(202, { ok: true, job: trainingRow(job, null, ai.training.queuePosition(job.jobId)) });
        } catch (e) {
          return json(e instanceof TrainingRefused ? 409 : 500, { error: e instanceof TrainingRefused ? e.message : "The job could not be started." });
        }
      }
      case `${LOCAL_AI_PATH}/jobs/cancel`:
        return (await ai.training.cancel(str("jobId"))) ? json(200, { ok: true }) : json(404, { error: "That job isn't running or waiting." });
      case `${LOCAL_AI_PATH}/jobs/resume`:
        try {
          const j = await ai.training.resume(str("jobId"));
          return json(200, { ok: true, job: trainingRow(j, null, ai.training.queuePosition(j.jobId)) });
        } catch (e) {
          return json(409, { error: e instanceof TrainingRefused ? e.message : "The job could not be resumed." });
        }
      case `${LOCAL_AI_PATH}/jobs/delete`:
        return (await ai.training.remove(str("jobId"))) ? json(200, { ok: true }) : json(409, { error: "Only a stopped job can be deleted." });
      case `${LOCAL_AI_PATH}/apps/grant`: {
        const v = checkAppGrant(body, d.serverDomain, ai.o.authority(), now());
        if (!v.ok) return json(v.status, { error: v.error });
        const app = ai.o.apps().find((a) => a.serviceId === v.order.serviceId);
        if (!app) return json(404, { error: "That app isn't on this server." });
        if (!app.declaresLocalAi && v.order.requestsPerDay > 0) return json(422, { error: "This app doesn't ask to use the server's AI model." });
        const held = ai.grants.heldIssuedAt(v.order.serviceId);
        if (held !== null && v.order.issuedAt <= held) return json(409, { error: "A newer choice is already in place." });
        await ai.applyGrant(v.order, v.signature!);
        return json(200, { ok: true, grant: ai.grants.get(v.order.serviceId), usage: ai.grants.usageOf(v.order.serviceId) });
      }
      default:
        return json(404, { error: "not found" });
    }
  };
}

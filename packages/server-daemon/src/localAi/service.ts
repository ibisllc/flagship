/**
 * The box-local, OpenAI-compatible model server (AI01): llama.cpp's server in a pinned image, one
 * model at a time, started when something asks for it and stopped after a quiet spell so a GPU it
 * holds goes back to apps. It listens on loopback only, behind a per-start random key; the harness
 * (the builder, "On this server") and the app SDK proxy are its only callers.
 *
 * A private request never falls back to a cloud provider: when the server can't run (no model,
 * not enough memory, a failed start) the caller gets `LocalAiUnavailable` with a sentence, and the
 * apps say so. The owner may pick another provider themselves.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { CommandRunner } from "../serviceRunner.js";
import type { AcceleratorBroker } from "../gpu/broker.js";
import { localModel, memoryNeededMiB, serverImageFor, type LocalModel } from "./catalog.js";
import { checkLocalAiRunArgs, serviceRunArgs } from "./containers.js";
import { place, PlacementRefused, type Placement } from "./devices.js";
import type { ModelStore } from "./modelStore.js";

export class LocalAiUnavailable extends Error {
  constructor(
    message: string,
    readonly code: "no-model" | "not-installed" | "too-big" | "start-failed" | "disabled" | "sandbox",
  ) {
    super(message);
    this.name = "LocalAiUnavailable";
  }
}

export interface LocalEndpoint {
  /** `http://127.0.0.1:<port>`; the OpenAI routes are under `/v1`. */
  baseUrl: string;
  apiKey: string;
  modelId: string;
  device: "cpu" | "gpu";
  release(): void;
}

export type ServiceState = "stopped" | "queued" | "starting" | "running" | "stopping" | "failed";

export interface ServiceView {
  state: ServiceState;
  jobId: string | null;
  modelId: string | null;
  device: "cpu" | "gpu" | null;
  gpu: { allocationId: string; deviceIds: string[] } | null;
  queuePosition: number | null;
  startedAt: number | null;
  lastUsedAt: number | null;
  inFlight: number;
  reason: string | null;
}

export interface LocalInferenceDeps {
  cmd: CommandRunner;
  store: ModelStore;
  broker: AcceleratorBroker | null;
  hardware: () => { cpus: number; memoryMiB: number };
  /** gVisor's run argument (`--runtime=runsc`); throws when the sandbox isn't ready. */
  sandboxArgs: () => Promise<string[]>;
  /** `--network flagship-staging` and its filtered resolver. */
  networkArgs: () => string[];
  ensureNetwork: () => Promise<void>;
  /** The owner's settings: may a GPU be used, which model serves. */
  settings: () => { useGpu: boolean; serveModel: string | null };
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  freePort?: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  idleStopMs?: number;
  gpuQueueWaitMs?: number;
  startTimeoutMs?: number;
}

interface Running {
  jobId: string;
  model: LocalModel;
  container: string;
  port: number;
  apiKey: string;
  placement: Placement;
  startedAt: number;
}

export async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export class LocalInferenceService {
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private stateValue: ServiceState = "stopped";
  private reason: string | null = null;
  private queuePosition: number | null = null;
  private inFlight = 0;
  private lastUsed: number | null = null;
  private pendingJob: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (m: string) => void;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly d: LocalInferenceDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = d.log ?? ((m) => console.warn(m));
    this.fetchImpl = d.fetch ?? ((u, i) => fetch(u, i));
  }

  view(): ServiceView {
    const r = this.running;
    return {
      state: this.stateValue,
      jobId: r?.jobId ?? this.pendingJob,
      modelId: r?.model.id ?? null,
      device: r ? r.placement.kind : null,
      gpu: r && r.placement.kind === "gpu" ? { allocationId: r.placement.allocationId, deviceIds: r.placement.deviceIds } : null,
      queuePosition: this.queuePosition,
      startedAt: r?.startedAt ?? null,
      lastUsedAt: this.lastUsed,
      inFlight: this.inFlight,
      reason: this.reason,
    };
  }

  /** The model to serve: the one asked for, else the owner's choice, else the best installed builder. */
  private pick(requested?: string): LocalModel {
    const installed = this.d.store.installedIds();
    if (installed.length === 0) throw new LocalAiUnavailable("No model is downloaded on this server yet. Download one under Local AI.", "no-model");
    const want = requested && requested.length > 0 && requested !== "auto" ? requested : this.d.settings().serveModel;
    if (want) {
      const m = localModel(want);
      if (!m || !installed.includes(want)) throw new LocalAiUnavailable("That model isn't downloaded on this server.", "not-installed");
      return m;
    }
    const order = ["build", "chat", "test"];
    const best = installed.map((id) => localModel(id)!).sort((a, b) => order.indexOf(a.purpose) - order.indexOf(b.purpose) || b.sizeBytes - a.sizeBytes)[0]!;
    return best;
  }

  /** A running server for this model, started if needed; `release()` when the call ends. */
  async lease(requested?: string): Promise<LocalEndpoint> {
    const model = this.pick(requested);
    let r = this.running;
    if (!r || r.model.id !== model.id) {
      if (r && this.inFlight > 0) throw new LocalAiUnavailable("This server's model is busy with another model's work; try again shortly.", "start-failed");
      r = await this.start(model);
    }
    this.inFlight++;
    this.lastUsed = this.now();
    let released = false;
    return {
      baseUrl: `http://127.0.0.1:${r.port}`,
      apiKey: r.apiKey,
      modelId: r.model.id,
      device: r.placement.kind,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.lastUsed = this.now();
        this.armIdle();
      },
    };
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.d.idleStopMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0 && this.running && this.lastUsed !== null && this.now() - this.lastUsed >= ms) {
        void this.stop("idle").catch(() => {});
      }
    }, ms + 50);
    this.idleTimer.unref?.();
  }

  private async start(model: LocalModel): Promise<Running> {
    if (this.starting) {
      const s = await this.starting;
      if (s.model.id === model.id) return s;
    }
    this.starting = this.doStart(model).finally(() => {
      this.starting = null;
    });
    return await this.starting;
  }

  private async doStart(model: LocalModel): Promise<Running> {
    if (this.running) await this.stop("switching model");
    const hw = this.d.hardware();
    const need = memoryNeededMiB(model);
    const jobId = randomBytes(8).toString("hex");
    const container = `flagship-localai-${jobId}`;
    this.pendingJob = jobId;
    this.reason = null;
    this.stateValue = "queued";
    let placement: Placement;
    try {
      placement = await place({
        broker: this.d.broker,
        useGpu: this.d.settings().useGpu,
        allocationId: `localai-${jobId}`,
        container,
        memoryNeededMiB: need,
        queueWaitMs: this.d.gpuQueueWaitMs ?? 120_000,
        cpuAllowed: need <= hw.memoryMiB * 0.8,
        onQueued: (p) => {
          this.queuePosition = p;
        },
      });
    } catch (e) {
      this.stateValue = "failed";
      this.pendingJob = null;
      const msg = e instanceof PlacementRefused ? e.message : "The model could not be placed on this server.";
      this.reason = need > hw.memoryMiB * 0.8 ? "This model needs more memory than this server has." : msg;
      throw new LocalAiUnavailable(this.reason, "too-big");
    }
    this.stateValue = "starting";
    const apiKey = randomBytes(24).toString("base64url");
    const port = await (this.d.freePort ?? freeLoopbackPort)();
    let sandboxArgs: string[];
    try {
      sandboxArgs = placement.kind === "gpu" ? [] : await this.d.sandboxArgs();
    } catch (e) {
      await this.releasePlacement(placement);
      this.stateValue = "failed";
      this.pendingJob = null;
      this.reason = "The app sandbox isn't ready on this server yet.";
      throw new LocalAiUnavailable(this.reason, "sandbox");
    }
    const cpus = Math.max(1, Math.min(hw.cpus, 8));
    const args = serviceRunArgs({
      name: container,
      image: serverImageFor(placement.kind === "gpu" ? placement.backend : null),
      modelSha256: model.sha256,
      hostPort: port,
      contextTokens: model.serveContextTokens,
      threads: cpus,
      memoryMiB: placement.kind === "gpu" ? Math.max(1024, Math.min(need, hw.memoryMiB)) : need,
      cpus: String(cpus),
      apiKey,
      gpuArgs: placement.kind === "gpu" ? placement.gpuArgs : [],
      sandboxArgs,
      networkArgs: this.d.networkArgs(),
    });
    checkLocalAiRunArgs(args);
    try {
      await this.d.ensureNetwork();
      await this.d.cmd.run("docker", ["rm", "-f", container]).catch(() => {});
      await this.d.cmd.run("docker", args);
      if (placement.kind === "gpu") await this.d.broker?.started(placement.allocationId).catch(() => {});
      await this.waitHealthy(port, apiKey);
    } catch (e) {
      await this.d.cmd.run("docker", ["rm", "-f", container]).catch(() => {});
      await this.releasePlacement(placement);
      this.stateValue = "failed";
      this.pendingJob = null;
      this.reason = "The model server didn't start on this server.";
      this.log(`[local-ai] ${model.id} failed to start: ${(e as Error).message}`);
      throw new LocalAiUnavailable(this.reason, "start-failed");
    }
    const r: Running = { jobId, model, container, port, apiKey, placement, startedAt: this.now() };
    this.running = r;
    this.pendingJob = null;
    this.queuePosition = null;
    this.stateValue = "running";
    this.lastUsed = this.now();
    this.armIdle();
    void this.measure(r).catch(() => {});
    this.log(`[local-ai] serving ${model.id} on ${placement.kind}${placement.kind === "gpu" ? ` (${placement.deviceIds.join(",")})` : ""}`);
    return r;
  }

  private async waitHealthy(port: number, apiKey: string): Promise<void> {
    const until = this.now() + (this.d.startTimeoutMs ?? 5 * 60_000);
    for (;;) {
      try {
        const res = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${apiKey}` } });
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      if (this.now() >= until) throw new Error("the model server did not become healthy in time");
      await this.sleep(1000);
    }
  }

  /** A short generation right after start: the measured speed replaces the estimate. */
  private async measure(r: Running): Promise<void> {
    const res = await this.fetchImpl(`http://127.0.0.1:${r.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` },
      body: JSON.stringify({ model: r.model.id, messages: [{ role: "user", content: "Count from one to ten." }], max_tokens: 32, cache_prompt: false }),
    });
    if (!res.ok) return;
    const tps = tokensPerSecondOf(await res.json().catch(() => null));
    if (tps !== null) await this.d.store.recordMeasured(r.model.id, tps, r.placement.kind);
  }

  private async releasePlacement(p: Placement): Promise<void> {
    if (p.kind === "gpu") await this.d.broker?.release(p.allocationId, "the model server stopped").catch(() => {});
  }

  async stop(why = "stopped"): Promise<void> {
    const r = this.running;
    if (!r) return;
    this.stateValue = "stopping";
    this.running = null;
    await this.d.cmd.run("docker", ["rm", "-f", r.container]).catch(() => {});
    await this.releasePlacement(r.placement);
    this.stateValue = "stopped";
    this.reason = why === "idle" ? null : why;
    this.log(`[local-ai] stopped ${r.model.id} (${why})`);
  }

  /** The model menu's rows for "On this server": what is downloaded here. */
  menuModels(): LocalModel[] {
    return this.d.store.installedIds().map((id) => localModel(id)!).filter(Boolean);
  }
}

/** llama.cpp's `timings.predicted_per_second`, when the answer carries it. */
export function tokensPerSecondOf(body: unknown): number | null {
  const t = (body as { timings?: { predicted_per_second?: unknown } } | null)?.timings?.predicted_per_second;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}

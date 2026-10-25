/**
 * Fine-tuning on the owner's own server (G05's training path, AI02): one signed job trains a small
 * model from the pinned catalog on ONE app's staged sample data, epoch by epoch, with llama.cpp's
 * `llama-finetune` in a pinned image under gVisor (or the job's GPU allocation), no network.
 *
 * - The dataset is derived from the app the owner named in the signed order: the sample files the
 *   owner attached to that app's build chats, else its private test copy's `/data/sample/` (its dev
 *   files volume, read-only). Never the live app's data, never another app's: the order cannot
 *   name a volume or a path, and both brokers refuse any other mount.
 * - Every epoch ends in a checkpoint (GGUF, never pickle) whose SHA-256 and size the box records
 *   under an HMAC that binds the job, the app, the base model and the dataset's digest. Resuming
 *   (after a cancel, a failure or a restart) starts from the newest checkpoint whose record
 *   verifies AND whose file still hashes to it; a changed dataset starts over.
 * - One training job runs at a time; the rest wait in order. A GPU is used when a qualified one is
 *   free (the same allocator and fair queue as apps), the CPU otherwise.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import type { AcceleratorBroker } from "../gpu/broker.js";
import type { CommandRunner } from "../serviceRunner.js";
import { localModel, modelFileName, trainImageFor, type LocalModel } from "./catalog.js";
import { checkLocalAiRunArgs, outVolume, trainRunArgs } from "./containers.js";
import { place, PlacementRefused, type Placement } from "./devices.js";
import type { ModelStore } from "./modelStore.js";

export type TrainingState = "queued" | "preparing" | "running" | "completed" | "cancelled" | "failed";

export interface Checkpoint {
  epoch: number;
  sha256: string;
  sizeBytes: number;
  at: number;
  /** HMAC over the job's binding and this file; a record that doesn't verify is never resumed from. */
  mac: string;
  loss?: number;
}

export interface TrainingJob {
  jobId: string;
  serviceId: string;
  baseModel: string;
  epochs: number;
  state: TrainingState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  device?: "cpu" | "gpu";
  gpu?: { allocationId: string; deviceIds: string[] };
  reason?: string;
  datasetDigest?: string;
  datasetBytes?: number;
  epochsDone: number;
  checkpoints: Checkpoint[];
}

export type DatasetSource = { kind: "text"; text: string } | { kind: "volume"; volume: string };

export interface TrainingDeps {
  dir: string;
  cmd: CommandRunner;
  store: ModelStore;
  broker: AcceleratorBroker | null;
  hardware: () => { cpus: number; memoryMiB: number };
  sandboxArgs: () => Promise<string[]>;
  networkArgs: () => string[];
  ensureNetwork: () => Promise<void>;
  settings: () => { useGpu: boolean };
  /** The app's staged sample data, by the app the signed order named; null when it has none. */
  datasetFor: (serviceId: string) => Promise<DatasetSource | null>;
  prepareOut: (hex: string) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  gpuQueueWaitMs?: number;
  /** Per epoch. */
  maxEpochMs?: number;
  /** How often a running epoch is looked at (default 2 s). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_DATASET_BYTES = 64 * 1024 * 1024;
const MAX_JOBS_KEPT = 50;

export class TrainingRefused extends Error {}

/** Writes the dataset into the job's volume and prints its SHA-256 and size (run with `sh -c`). */
export function datasetScript(kind: "text" | "volume"): string {
  return kind === "text"
    ? `head -c ${MAX_DATASET_BYTES} > /out/dataset.txt; sha256sum /out/dataset.txt; wc -c < /out/dataset.txt`
    : `find /dataset/sample -type f 2>/dev/null | LC_ALL=C sort | head -n 1000 | while IFS= read -r f; do cat "$f"; echo; done | head -c ${MAX_DATASET_BYTES} > /out/dataset.txt; sha256sum /out/dataset.txt; wc -c < /out/dataset.txt`;
}

/** One epoch of llama-finetune from `input` (the base model or the previous checkpoint). */
export function finetuneCommand(o: { input: string; epoch: number; ctx: number; threads: number; gpu: boolean }): string[] {
  return [
    "-m", o.input, "-f", "/out/dataset.txt", "-o", `/out/ckpt-${o.epoch}.gguf`,
    "-c", String(o.ctx), "-b", String(o.ctx), "-ub", String(o.ctx), "--epochs", "1", "-t", String(o.threads),
    ...(o.gpu ? ["-ngl", "999"] : []),
  ];
}

/** Prints a checkpoint's SHA-256 and size (entrypoint `sh`). */
export function hashCommand(epoch: number): string[] {
  return ["-c", 'sha256sum "$1"; wc -c < "$1"', "_", `/out/ckpt-${epoch}.gguf`];
}

export function trainingMemoryMiB(m: LocalModel): number {
  // Full fine-tuning in F32: weights, gradients and two optimizer moments, plus a working margin.
  return Math.ceil((m.sizeBytes * 4.5) / (1 << 20)) + 512;
}

export class TrainingJobs {
  private jobs: TrainingJob[] = [];
  private key: Buffer | null = null;
  private active: { jobId: string; abort: AbortController; done: Promise<void> } | null = null;
  private queuedGpu: Map<string, number | null> = new Map();
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: TrainingDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.warn(m));
  }

  private get file(): string {
    return join(this.d.dir, "training-jobs.json");
  }

  async load(): Promise<void> {
    await mkdir(this.d.dir, { recursive: true, mode: 0o700 });
    const r = await readStateFile(this.file);
    if (r.kind === "ok") {
      try {
        const v = JSON.parse(r.text) as { jobs?: TrainingJob[] };
        this.jobs = Array.isArray(v.jobs) ? v.jobs : [];
      } catch {
        this.jobs = [];
      }
    }
    for (const j of this.jobs) {
      if (j.state === "running" || j.state === "preparing") {
        j.state = "failed";
        j.reason = "The server restarted during training. Resume to continue from the last checkpoint.";
        j.endedAt = this.now();
        if (j.gpu) await this.d.broker?.release(j.gpu.allocationId, "the server restarted").catch(() => {});
        delete j.gpu;
      }
    }
    await this.save();
    this.pump();
  }

  private async save(): Promise<void> {
    await mkdir(this.d.dir, { recursive: true, mode: 0o700 });
    await writeFileDurable(this.file, JSON.stringify({ jobs: this.jobs }));
  }

  private async macKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const p = join(this.d.dir, "checkpoint.key");
    try {
      const k = await readFile(p);
      if (k.length === 32) return (this.key = k);
    } catch {
      // first use
    }
    const k = randomBytes(32);
    await writeFileDurable(p, k);
    return (this.key = k);
  }

  checkpointMac(key: Buffer, j: Pick<TrainingJob, "jobId" | "serviceId" | "baseModel">, datasetDigest: string, c: Pick<Checkpoint, "epoch" | "sha256" | "sizeBytes">): string {
    return createHmac("sha256", key)
      .update(["flagship/local-ai-checkpoint/v1", j.jobId, j.serviceId, j.baseModel, datasetDigest, c.epoch, c.sha256, c.sizeBytes].join("|"))
      .digest("hex");
  }

  list(): TrainingJob[] {
    return this.jobs.map((j) => ({ ...j, checkpoints: j.checkpoints.map((c) => ({ ...c })) }));
  }

  get(jobId: string): TrainingJob | null {
    return this.jobs.find((j) => j.jobId === jobId) ?? null;
  }

  /** The order of waiting jobs (1 = next), and a GPU wait when the running job is queued there. */
  queuePosition(jobId: string): number | null {
    if (this.active?.jobId === jobId) return this.queuedGpu.get(jobId) ?? null;
    const waiting = this.jobs.filter((j) => j.state === "queued").sort((a, b) => a.createdAt - b.createdAt);
    const i = waiting.findIndex((j) => j.jobId === jobId);
    return i < 0 ? null : i + 1 + (this.active ? 1 : 0);
  }

  /** A verified order: queue the job. */
  async submit(order: { serviceId: string; jobId: string; baseModel: string; epochs: number }): Promise<TrainingJob> {
    if (this.jobs.some((j) => j.jobId === order.jobId)) throw new TrainingRefused("That training job already exists.");
    const m = localModel(order.baseModel);
    if (!m || !m.trainable) throw new TrainingRefused("That model can't be fine-tuned on this server.");
    if (!this.d.store.installed(m.id)) throw new TrainingRefused("Download the base model first.");
    const job: TrainingJob = {
      jobId: order.jobId,
      serviceId: order.serviceId,
      baseModel: m.id,
      epochs: order.epochs,
      state: "queued",
      createdAt: this.now(),
      epochsDone: 0,
      checkpoints: [],
    };
    this.jobs.push(job);
    this.prune();
    await this.save();
    this.pump();
    return job;
  }

  /** Continue a stopped job from its newest good checkpoint. */
  async resume(jobId: string): Promise<TrainingJob> {
    const j = this.get(jobId);
    if (!j) throw new TrainingRefused("No such training job.");
    if (j.state !== "cancelled" && j.state !== "failed") throw new TrainingRefused("Only a stopped job can be resumed.");
    j.state = "queued";
    delete j.reason;
    delete j.endedAt;
    j.createdAt = this.now();
    await this.save();
    this.pump();
    return j;
  }

  async cancel(jobId: string): Promise<boolean> {
    const j = this.get(jobId);
    if (!j) return false;
    if (j.state === "queued") {
      j.state = "cancelled";
      j.endedAt = this.now();
      await this.save();
      return true;
    }
    if (this.active?.jobId === jobId) {
      this.active.abort.abort();
      await this.d.cmd.run("docker", ["rm", "-f", `flagship-aitrain-${jobId}`]).catch(() => {});
      await this.active.done.catch(() => {});
      return true;
    }
    return false;
  }

  /** Forget a stopped job and its checkpoints. */
  async remove(jobId: string): Promise<boolean> {
    const j = this.get(jobId);
    if (!j || j.state === "running" || j.state === "preparing" || j.state === "queued") return false;
    await this.d.cmd.run("docker", ["volume", "rm", "-f", outVolume(jobId)]).catch(() => {});
    this.jobs = this.jobs.filter((x) => x.jobId !== jobId);
    await this.save();
    return true;
  }

  /** The app is gone: its jobs stop and their checkpoints are deleted. */
  async forgetApp(serviceId: string): Promise<void> {
    for (const j of this.jobs.filter((x) => x.serviceId === serviceId)) {
      await this.cancel(j.jobId);
      await this.remove(j.jobId);
    }
  }

  private prune(): void {
    const finished = this.jobs.filter((j) => j.state === "completed" || j.state === "cancelled" || j.state === "failed");
    while (this.jobs.length > MAX_JOBS_KEPT && finished.length > 0) {
      const old = finished.shift()!;
      this.jobs = this.jobs.filter((j) => j !== old);
      void this.d.cmd.run("docker", ["volume", "rm", "-f", outVolume(old.jobId)]).catch(() => {});
    }
  }

  private pump(): void {
    if (this.active) return;
    const next = this.jobs.filter((j) => j.state === "queued").sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    const abort = new AbortController();
    const done = this.run(next, abort.signal).finally(() => {
      this.active = null;
      this.queuedGpu.delete(next.jobId);
      this.pump();
    });
    this.active = { jobId: next.jobId, abort, done };
  }

  /**
   * A long run: started in the background, polled until it exits, its output read, then removed.
   * Cancelling removes the container (TrainingJobs.cancel), which ends the poll.
   */
  private async execLong(args: string[], signal: AbortSignal, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    checkLocalAiRunArgs(args);
    if (signal.aborted) throw new Error("cancelled");
    if (!this.d.cmd.capture) throw new Error("this server can't run training");
    const name = args[args.indexOf("--name") + 1]!;
    await this.d.cmd.run("docker", ["rm", "-f", name]).catch(() => {});
    await this.d.cmd.run("docker", args);
    const until = this.now() + timeoutMs;
    try {
      for (;;) {
        if (signal.aborted) throw new Error("cancelled");
        const st = await this.d.cmd.capture("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name]).catch(() => null);
        const [status, code] = (st?.stdout.trim() ?? "gone 1").split(/\s+/);
        if (status === "exited" || status === "dead" || status === "gone") {
          const logs = await this.d.cmd.capture("docker", ["logs", "--tail", "200", name]).catch(() => ({ stdout: "", stderr: "" }));
          if (code !== "0") throw new Error(`the run ended with ${status === "gone" ? "no container" : `code ${code}`}`);
          return logs;
        }
        if (this.now() >= until) throw new Error("the run took too long");
        await (this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(this.d.pollMs ?? 2000);
      }
    } finally {
      await this.d.cmd.run("docker", ["rm", "-f", name]).catch(() => {});
    }
  }

  /** Run a container to completion and return its stdout (the job's own name, removed after). */
  private async exec(args: string[], signal: AbortSignal, input?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
    checkLocalAiRunArgs(args);
    if (signal.aborted) throw new Error("cancelled");
    if (!this.d.cmd.capture) throw new Error("this server can't run training");
    return await this.d.cmd.capture("docker", args, { signal, ...(input !== undefined ? { input } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private async run(job: TrainingJob, signal: AbortSignal): Promise<void> {
    const m = localModel(job.baseModel)!;
    const hw = this.d.hardware();
    let placement: Placement | null = null;
    const fail = async (reason: string) => {
      job.state = signal.aborted ? "cancelled" : "failed";
      if (!signal.aborted) job.reason = reason;
      job.endedAt = this.now();
      await this.save().catch(() => {});
    };
    try {
      job.state = "preparing";
      job.startedAt = this.now();
      await this.save();
      const source = await this.d.datasetFor(job.serviceId);
      if (!source) return await fail("This app has no staged sample data to learn from. Attach sample data in one of its build chats first.");
      await this.d.ensureNetwork();
      await this.d.prepareOut(job.jobId);
      const sandbox = await this.d.sandboxArgs();
      const base = { hex: job.jobId, image: trainImageFor(null), gpuArgs: [], sandboxArgs: sandbox, networkArgs: this.d.networkArgs(), memoryMiB: 512, cpus: "1" };
      // 1. The dataset, into the job's own volume, and its digest.
      const script = datasetScript(source.kind);
      const prep = await this.exec(
        trainRunArgs({ ...base, entrypoint: "sh", command: ["-c", script], ...(source.kind === "volume" ? { datasetVolume: source.volume } : { interactive: true }) }),
        signal,
        source.kind === "text" ? source.text.slice(0, MAX_DATASET_BYTES) : undefined,
        10 * 60_000,
      );
      const digest = /^([0-9a-f]{64})\s/m.exec(prep.stdout)?.[1];
      const bytes = Number(/^\s*(\d+)\s*$/m.exec(prep.stdout.split("\n").slice(1).join("\n"))?.[1] ?? NaN);
      if (!digest || !Number.isFinite(bytes)) return await fail("The sample data could not be read.");
      if (bytes === 0) return await fail("This app has no staged sample data to learn from. Attach sample data in one of its build chats first.");
      job.datasetDigest = digest;
      job.datasetBytes = bytes;

      // 2. Where to resume: the newest checkpoint whose record verifies and whose file still matches.
      const key = await this.macKey();
      let start = 0;
      const good: Checkpoint[] = [];
      for (const c of [...job.checkpoints].sort((a, b) => b.epoch - a.epoch)) {
        const mac = this.checkpointMac(key, job, digest, c);
        if (!safeEq(mac, c.mac)) continue;
        const h = await this.hashCheckpoint(base, c.epoch, signal).catch(() => null);
        if (h && h.sha256 === c.sha256 && h.sizeBytes === c.sizeBytes) {
          good.push(c);
          break;
        }
      }
      job.checkpoints = job.checkpoints.filter((c) => good.length > 0 && c.epoch <= good[0]!.epoch && safeEq(this.checkpointMac(key, job, digest, c), c.mac));
      start = good[0]?.epoch ?? 0;
      job.epochsDone = start;

      // 3. A device, then one run per epoch.
      const need = trainingMemoryMiB(m);
      placement = await place({
        broker: this.d.broker,
        useGpu: this.d.settings().useGpu,
        allocationId: `aitrain-${job.jobId}`,
        container: `flagship-aitrain-${job.jobId}`,
        memoryNeededMiB: need,
        queueWaitMs: this.d.gpuQueueWaitMs ?? 120_000,
        cpuAllowed: need <= hw.memoryMiB * 0.8,
        onQueued: (p) => this.queuedGpu.set(job.jobId, p),
        signal,
      });
      job.device = placement.kind;
      if (placement.kind === "gpu") job.gpu = { allocationId: placement.allocationId, deviceIds: placement.deviceIds };
      job.state = "running";
      await this.save();
      const threads = Math.max(1, Math.min(hw.cpus, 8));
      const ctx = Math.min(m.contextTokens, 256);
      for (let epoch = start + 1; epoch <= job.epochs; epoch++) {
        if (signal.aborted) break;
        const input = epoch === 1 ? `/models/${modelFileName(m.sha256)}` : `/out/ckpt-${epoch - 1}.gguf`;
        const run = await this.execLong(
          trainRunArgs({
            ...base,
            detach: true,
            image: trainImageFor(placement.kind === "gpu" ? placement.backend : null),
            gpuArgs: placement.kind === "gpu" ? placement.gpuArgs : [],
            memoryMiB: placement.kind === "gpu" ? Math.max(1024, Math.min(need, hw.memoryMiB)) : need,
            cpus: String(threads),
            entrypoint: "/app/llama-finetune",
            command: finetuneCommand({ input, epoch, ctx, threads, gpu: placement.kind === "gpu" }),
          }),
          signal,
          this.d.maxEpochMs ?? 6 * 60 * 60_000,
        );
        if (placement.kind === "gpu" && epoch === start + 1) await this.d.broker?.started(placement.allocationId).catch(() => {});
        const h = await this.hashCheckpoint(base, epoch, signal);
        if (!h) throw new Error("the checkpoint was not written");
        const c: Checkpoint = { epoch, sha256: h.sha256, sizeBytes: h.sizeBytes, at: this.now(), mac: "" };
        const loss = lastLoss(`${run.stderr}\n${run.stdout}`);
        if (loss !== null) c.loss = loss;
        c.mac = this.checkpointMac(key, job, digest, c);
        job.checkpoints.push(c);
        job.epochsDone = epoch;
        await this.save();
      }
      if (signal.aborted) {
        job.state = "cancelled";
      } else {
        job.state = "completed";
      }
      job.endedAt = this.now();
      await this.save();
    } catch (e) {
      if (e instanceof PlacementRefused) await fail("This model needs more memory than this server has to fine-tune it.");
      else await fail(signal.aborted ? "cancelled" : "Training stopped with an error. Resume to continue from the last checkpoint.");
      if (!signal.aborted) this.log(`[local-ai] training ${job.jobId} failed: ${(e as Error).message}`);
    } finally {
      if (placement?.kind === "gpu") await this.d.broker?.release(placement.allocationId, "training ended").catch(() => {});
      delete job.gpu;
      await this.save().catch(() => {});
    }
  }

  private async hashCheckpoint(
    base: { hex: string; image: string; gpuArgs: string[]; sandboxArgs: string[]; networkArgs: string[]; memoryMiB: number; cpus: string },
    epoch: number,
    signal: AbortSignal,
  ): Promise<{ sha256: string; sizeBytes: number } | null> {
    const out = await this.exec(
      trainRunArgs({ ...base, image: trainImageFor(null), gpuArgs: [], entrypoint: "sh", command: hashCommand(epoch) }),
      signal,
      undefined,
      10 * 60_000,
    );
    const sha = /^([0-9a-f]{64})\s/m.exec(out.stdout)?.[1];
    const size = Number(/^\s*(\d+)\s*$/m.exec(out.stdout.split("\n").slice(1).join("\n"))?.[1] ?? NaN);
    return sha && Number.isFinite(size) && size > 0 ? { sha256: sha, sizeBytes: size } : null;
  }
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** The last `loss=` value llama-finetune's progress line printed. */
export function lastLoss(text: string): number | null {
  const all = [...text.matchAll(/loss=\s*([0-9]+(?:\.[0-9]+)?)/g)];
  const v = all.length ? Number(all[all.length - 1]![1]) : NaN;
  return Number.isFinite(v) ? v : null;
}

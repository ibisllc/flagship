/**
 * The box's local models: downloaded only when the owner asks, from the pinned catalog, through
 * allowlisted registry hosts, checked against the catalog's SHA-256 and size, then handed to root
 * (the privileged helper's `localai model-install`, which checks the digest again on its own copy)
 * to live read-only in the `flagship-models` volume under their digest. Nothing about the owner
 * goes into a download: a public file by revision and path.
 *
 * Budgets: the total the models may take (default 64 GiB) and the disk's free space (twice the
 * file, since it is checked once more after the copy, plus a 1 GiB reserve). A download that
 * doesn't match its digest is deleted, never kept.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import { localModel, LOCAL_MODELS, modelDownloadUrl, registryHostAllowed, type LocalModel } from "./catalog.js";

export { MODELS_VOLUME } from "./containers.js";
export const DEFAULT_MODEL_BUDGET_BYTES = 64 * 1024 ** 3;
const RESERVE_BYTES = 1024 ** 3;
const MAX_REDIRECTS = 5;

export interface ModelInstaller {
  /** Put the verified file into the models volume (root-owned, read-only). */
  install(sha256: string, src: string): Promise<void>;
  remove(sha256: string): Promise<void>;
}

export type DownloadFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export type ModelState = "available" | "downloading" | "verifying" | "installing" | "installed" | "failed";

export interface ModelRecord {
  state: "installed" | "failed";
  sha256: string;
  sizeBytes: number;
  at: number;
  reason?: string;
  /** Tokens a second this box measured, generating with this model. */
  measuredTokensPerSecond?: number;
  measuredOn?: "cpu" | "gpu";
}

interface StateFile {
  models: Record<string, ModelRecord>;
}

export interface ModelProgress {
  state: "downloading" | "verifying" | "installing";
  receivedBytes: number;
  totalBytes: number;
}

export interface ModelStoreOptions {
  /** `<dataDir>/data/local-ai`. */
  dir: string;
  installer: ModelInstaller;
  fetch?: DownloadFetch;
  freeBytes?: (path: string) => Promise<number>;
  budgetBytes?: number;
  now?: () => number;
  log?: (m: string) => void;
  /** The catalog (tests pass their own fixtures). */
  catalog?: readonly LocalModel[];
}

export type DownloadRefusal =
  | "unknown-model"
  | "already-installed"
  | "in-progress"
  | "over-budget"
  | "disk-full";

const REFUSAL_TEXT: Record<DownloadRefusal, string> = {
  "unknown-model": "That model isn't in this server's catalog.",
  "already-installed": "That model is already on this server.",
  "in-progress": "That model is already downloading.",
  "over-budget": "Models on this server would take more than their space allowance. Delete one first.",
  "disk-full": "There isn't enough free disk space for that model.",
};

export function refusalText(r: DownloadRefusal): string {
  return REFUSAL_TEXT[r];
}

async function defaultFreeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return Number(s.bavail) * Number(s.bsize);
}

export class ModelStore {
  private state: StateFile = { models: {} };
  private readonly progress = new Map<string, ModelProgress & { abort: AbortController }>();
  private readonly catalog: readonly LocalModel[];
  private readonly fetch: DownloadFetch;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private loaded = false;

  constructor(private readonly o: ModelStoreOptions) {
    this.catalog = o.catalog ?? LOCAL_MODELS;
    this.fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.warn(m));
  }

  private get file(): string {
    return join(this.o.dir, "models.json");
  }

  private get incoming(): string {
    return join(this.o.dir, "incoming");
  }

  async load(): Promise<void> {
    const r = await readStateFile(this.file);
    if (r.kind === "ok") {
      try {
        const v = JSON.parse(r.text) as StateFile;
        if (v && typeof v.models === "object") this.state = { models: v.models };
      } catch {
        this.state = { models: {} };
      }
    }
    // A download the daemon was in when it stopped is gone; its partial file too.
    await rm(this.incoming, { recursive: true, force: true }).catch(() => {});
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
    await writeFileDurable(this.file, JSON.stringify(this.state));
  }

  model(id: string): LocalModel | null {
    return this.catalog.find((m) => m.id === id) ?? localModel(id);
  }

  /** The installed record when it still names the catalog's digest; anything else is not installed. */
  installed(id: string): ModelRecord | null {
    const rec = this.state.models[id];
    const m = this.model(id);
    if (!rec || rec.state !== "installed" || !m || rec.sha256 !== m.sha256 || rec.sizeBytes !== m.sizeBytes) return null;
    return rec;
  }

  installedIds(): string[] {
    return this.catalog.filter((m) => this.installed(m.id)).map((m) => m.id);
  }

  stateOf(id: string): { state: ModelState; progress?: ModelProgress; reason?: string } {
    const p = this.progress.get(id);
    if (p) return { state: p.state, progress: { state: p.state, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes } };
    if (this.installed(id)) return { state: "installed" };
    const rec = this.state.models[id];
    if (rec?.state === "failed") return { state: "failed", ...(rec.reason ? { reason: rec.reason } : {}) };
    return { state: "available" };
  }

  usedBytes(): number {
    return this.catalog.reduce((n, m) => n + (this.installed(m.id) ? m.sizeBytes : 0), 0);
  }

  budgetBytes(): number {
    return this.o.budgetBytes ?? DEFAULT_MODEL_BUDGET_BYTES;
  }

  async freeBytes(): Promise<number | null> {
    try {
      await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
      return await (this.o.freeBytes ?? defaultFreeBytes)(this.o.dir);
    } catch {
      return null;
    }
  }

  /** Start a download in the background; the reason when it can't start. */
  async download(id: string): Promise<{ ok: true; done: Promise<void> } | { ok: false; refusal: DownloadRefusal }> {
    if (!this.loaded) await this.load();
    const m = this.model(id);
    if (!m) return { ok: false, refusal: "unknown-model" };
    if (this.installed(id)) return { ok: false, refusal: "already-installed" };
    if (this.progress.has(id)) return { ok: false, refusal: "in-progress" };
    const inFlight = [...this.progress.values()].reduce((n, p) => n + p.totalBytes, 0);
    if (this.usedBytes() + inFlight + m.sizeBytes > this.budgetBytes()) return { ok: false, refusal: "over-budget" };
    const free = await this.freeBytes();
    if (free === null || free < m.sizeBytes * 2 + inFlight * 2 + RESERVE_BYTES) return { ok: false, refusal: "disk-full" };
    const abort = new AbortController();
    this.progress.set(id, { state: "downloading", receivedBytes: 0, totalBytes: m.sizeBytes, abort });
    const done = this.run(m, abort).finally(() => this.progress.delete(id));
    return { ok: true, done };
  }

  cancel(id: string): boolean {
    const p = this.progress.get(id);
    if (!p) return false;
    p.abort.abort();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const rec = this.state.models[id];
    if (!rec) return false;
    if (rec.state === "installed") await this.o.installer.remove(rec.sha256);
    delete this.state.models[id];
    await this.save();
    return true;
  }

  async recordMeasured(id: string, tokensPerSecond: number, on: "cpu" | "gpu"): Promise<void> {
    const rec = this.installed(id);
    if (!rec || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return;
    rec.measuredTokensPerSecond = Math.round(tokensPerSecond * 10) / 10;
    rec.measuredOn = on;
    await this.save().catch(() => {});
  }

  private async fail(m: LocalModel, reason: string): Promise<void> {
    this.state.models[m.id] = { state: "failed", sha256: m.sha256, sizeBytes: m.sizeBytes, at: this.now(), reason };
    await this.save().catch(() => {});
    this.log(`[local-ai] ${m.id}: ${reason}`);
  }

  private async run(m: LocalModel, abort: AbortController): Promise<void> {
    await mkdir(this.incoming, { recursive: true, mode: 0o700 });
    const part = join(this.incoming, `${randomBytes(8).toString("hex")}.partial`);
    const dest = join(this.incoming, `sha256-${m.sha256}.gguf`);
    const p = this.progress.get(m.id)!;
    try {
      const res = await this.fetchFollowing(modelDownloadUrl(m), abort.signal);
      const len = res.headers.get("content-length");
      if (len !== null && Number(len) !== m.sizeBytes) throw new DownloadError("The registry offered a file of the wrong size; nothing was kept.");
      if (!res.body) throw new DownloadError("The registry sent nothing.");
      const hash = createHash("sha256");
      const out = createWriteStream(part, { mode: 0o600 });
      let n = 0;
      try {
        for await (const chunk of Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)) {
          const b = chunk as Buffer;
          n += b.length;
          if (n > m.sizeBytes) throw new DownloadError("The download was larger than the pinned model; nothing was kept.");
          hash.update(b);
          p.receivedBytes = n;
          if (!out.write(b)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      p.state = "verifying";
      const digest = hash.digest("hex");
      if (n !== m.sizeBytes || digest !== m.sha256) {
        throw new DownloadError("The download didn't match the model's pinned digest; nothing was kept.");
      }
      const { rename } = await import("node:fs/promises");
      await rename(part, dest);
      p.state = "installing";
      await this.o.installer.install(m.sha256, dest);
      this.state.models[m.id] = { state: "installed", sha256: m.sha256, sizeBytes: m.sizeBytes, at: this.now() };
      await this.save();
      this.log(`[local-ai] ${m.id} installed (${m.sizeBytes} bytes, sha256 ${m.sha256.slice(0, 12)}…)`);
    } catch (e) {
      if (abort.signal.aborted) {
        delete this.state.models[m.id];
        await this.save().catch(() => {});
      } else {
        await this.fail(m, e instanceof DownloadError ? e.message : "The download failed. Try again later.");
      }
    } finally {
      await rm(part, { force: true }).catch(() => {});
      await rm(dest, { force: true }).catch(() => {});
    }
  }

  /** https only, every hop to an allowlisted registry host, at most a few redirects. */
  private async fetchFollowing(start: string, signal: AbortSignal): Promise<Response> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(url);
      if (u.protocol !== "https:" || !registryHostAllowed(u.hostname) || u.username || u.password || (u.port && u.port !== "443")) {
        throw new DownloadError("The registry redirected to a host this server doesn't download models from.");
      }
      const res = await this.fetch(u.toString(), { redirect: "manual", signal, headers: { "user-agent": "flagship-box" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new DownloadError("The registry redirected nowhere.");
        url = new URL(loc, u).toString();
        continue;
      }
      if (!res.ok) throw new DownloadError(`The registry answered ${res.status}.`);
      return res;
    }
    throw new DownloadError("The registry redirected too many times.");
  }
}

export class DownloadError extends Error {}

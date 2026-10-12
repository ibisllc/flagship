/**
 * The private staging copy an AI build runs on (docs/ai-privacy-and-staging.md
 * §2). The AI's `deploy` builds the image once and runs it here as
 * `flagship-stg-<buildId>`, on the `flagship-staging` network, published on a
 * loopback port only and never routed from the internet. Everything the app
 * can see is neutral: a made-up host and owner, UTC, placeholder values for
 * the owner's env vars, and a fresh dev dataspace seeded with synthetic rows.
 * The AI tests it through the box (`checkApp`, `logs`); going live later
 * installs the SAME image tag, so what goes live is what was tested.
 */

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ed, parseManifest, type AppDataStores } from "@flagship/protocol";
import {
  AppRunner,
  ensureDockerNetwork,
  type AppSpec,
  type CommandRunner,
  type ContainerLimits,
  type StartCheck,
} from "../serviceRunner.js";
import { credentialsToEnv, type AppDataCredentials, type DataProvisioner } from "../dataLayer/provisioner.js";
import { datasetToSql, generateSynthetic } from "../dataLayer/synth/index.js";
import { pickPgUrlForApp } from "../runMigration.js";
import { migrationFiles } from "../llm/serviceName.js";
import { readCarriedBinaries } from "../llm/serviceSource.js";
import { buildAppImage } from "./deployArtifact.js";

/** The docker network staging copies join. The egress gateway locks it down. */
export const STAGING_NETWORK = "flagship-staging";
/** The neutral identity a staging copy runs under. */
export const STAGING_HOST = "app.example";
export const STAGING_CREATOR = "owner";
export const STAGING_USER = "staging-user";
export const STAGING_ROLE = "owner";
/** The value every owner env var has on staging. */
export const STAGING_ENV_PLACEHOLDER = "staging-placeholder";

const CHECK_BODY_BYTES = 4096;
const LOG_TAIL_LINES = 200;
const LOG_MAX_CHARS = 16_000;
const BUILD_ID_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** A digest of a build's files, so a go-live can tell its image matches them. */
export function filesDigest(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) h.update(JSON.stringify([path, files[path]]));
  return h.digest("hex");
}

export interface StageArgs {
  buildId: string;
  files: Record<string, string>;
  /** Non-text files the build carries (a git import's images, fonts). */
  binaries?: Record<string, Buffer>;
  /** An edited live service whose non-text files the copy keeps (read, never written). */
  carryBinariesFrom?: string;
  /** The app's name (FLAGSHIP_SLUG). */
  slug: string;
  /** Owner env var NAMES; each gets the placeholder value. */
  envNames?: string[];
}

export type StageResult = { ok: true; image: string } | { ok: false; reason: string };

/** The image a build last staged successfully, and the files it was built from. */
export interface StagedCopy {
  image: string;
  filesDigest: string;
  slug: string;
}

export interface CheckAppRequest {
  path: string;
  method?: string;
  body?: string;
}

export type CheckAppResult =
  | { ok: true; status: number; contentType: string; body: string; truncated: boolean }
  | { ok: false; reason: string };

/** What the orchestrator and the chat's deploy need of staging. */
export interface StagingHost {
  stage(a: StageArgs): Promise<StageResult>;
  checkApp(buildId: string, req: CheckAppRequest): Promise<CheckAppResult>;
  /** The copy's recent output, or null when nothing is running. */
  logs(buildId: string): Promise<string | null>;
  /** Remove the copy and its dev data. The staged image stays for go-live. */
  teardown(buildId: string): Promise<void>;
  staged(buildId: string): StagedCopy | null;
  /** Drop the staged-image record (gone live, or discarded); the image itself stays. */
  forget(buildId: string): void;
}

export interface StagingRunnerDeps {
  cmd: CommandRunner;
  /** The app-clones dir; copies are built under `<workingDir>/.staging/<buildId>`. */
  workingDir: string;
  dataProvisioner?: DataProvisioner | null;
  /** Runs SQL as the dev store's own role (migrations, sample rows). */
  runSql?: ((a: { pgUrl: string; sql: string }) => Promise<void>) | null;
  startCheck?: StartCheck | null;
  limits?: Partial<ContainerLimits>;
  pickPort?: () => number;
  now?: () => number;
  checkTimeoutMs?: number;
  /**
   * Whether the box's egress fence is up. AI-written code never runs (or
   * builds) unfenced, so a test copy is refused while it's down; absent ⇒
   * fenced (tests).
   */
  fenced?: () => boolean;
}

export const UNFENCED_REASON =
  "this server can't wall off the test copy's network right now, so the AI's test copy wasn't started";

interface Running {
  container: string;
  port: number;
  slug: string;
  stores: AppDataStores | null;
  devSlug: string;
  keyPriv: Uint8Array;
  keyPub: Uint8Array;
  contextDir: string;
}

function randomPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export class StagingRunner implements StagingHost {
  private readonly runner: AppRunner;
  private readonly running = new Map<string, Running>();
  private readonly stagedCopies = new Map<string, StagedCopy>();
  /** The last image each build staged; a newer one replaces it on disk. */
  private readonly images = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private networkReady: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: StagingRunnerDeps) {
    this.runner = new AppRunner(deps.cmd, { limits: { ...(deps.limits ?? {}), network: STAGING_NETWORK } });
    this.now = deps.now ?? (() => Date.now());
  }

  staged(buildId: string): StagedCopy | null {
    const s = this.stagedCopies.get(buildId);
    return s ? { ...s } : null;
  }

  forget(buildId: string): void {
    this.stagedCopies.delete(buildId);
    // Its last image may be live now: never removed from here.
    this.images.delete(buildId);
  }

  /** Remove copies a previous daemon left behind (best-effort, at boot). */
  async sweep(): Promise<void> {
    if (!this.deps.cmd.capture) return;
    try {
      const { stdout } = await this.deps.cmd.capture("docker", ["ps", "-aq", "--filter", "name=^flagship-stg-"]);
      for (const id of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        await this.deps.cmd.run("docker", ["rm", "-f", id]).catch(() => {});
      }
    } catch {
      /* docker unavailable */
    }
  }

  stage(a: StageArgs): Promise<StageResult> {
    return this.serial(a.buildId, () => this.stageNow(a));
  }

  teardown(buildId: string): Promise<void> {
    return this.serial(buildId, () => this.teardownNow(buildId));
  }

  private serial<T>(buildId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(buildId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(buildId, next);
    void next.finally(() => {
      if (this.locks.get(buildId) === next) this.locks.delete(buildId);
    }).catch(() => {});
    return next;
  }

  private async stageNow(a: StageArgs): Promise<StageResult> {
    const { buildId, files } = a;
    if (!BUILD_ID_RE.test(buildId)) return { ok: false, reason: "invalid build id" };
    if (this.deps.fenced && !this.deps.fenced()) return { ok: false, reason: UNFENCED_REASON };
    this.stagedCopies.delete(buildId);
    const manifestJson = files["flagship.app.json"];
    if (!manifestJson) return { ok: false, reason: "nothing to deploy: write flagship.app.json first" };
    let raw: unknown;
    try {
      raw = JSON.parse(manifestJson);
    } catch (e) {
      return { ok: false, reason: `flagship.app.json is not valid JSON: ${(e as Error).message}` };
    }
    const parsed = parseManifest(raw);
    if (!parsed.ok) return { ok: false, reason: `flagship.app.json is invalid: ${parsed.errors.join("; ")}` };
    const manifest = parsed.manifest;

    await this.teardownNow(buildId);
    this.networkReady ??= ensureDockerNetwork(this.deps.cmd, STAGING_NETWORK).catch(() => {});
    await this.networkReady;

    const image = `flagship-stg-${buildId}:${this.now()}`;
    const contextDir = join(this.deps.workingDir, ".staging", buildId);
    const carried =
      a.carryBinariesFrom && /^[a-z0-9-]+$/.test(a.carryBinariesFrom)
        ? await readCarriedBinaries(join(this.deps.workingDir, a.carryBinariesFrom))
        : {};
    const binaries = { ...carried, ...(a.binaries ?? {}) };
    const built = await buildAppImage(this.deps.cmd, {
      contextDir,
      files,
      ...(Object.keys(binaries).length ? { binaries } : {}),
      image,
    });
    if (!built.ok) {
      await rm(contextDir, { recursive: true, force: true }).catch(() => {});
      return built;
    }
    // A build that hasn't gone live never needs its earlier test images.
    const previous = this.images.get(buildId);
    this.images.set(buildId, image);
    if (previous && previous !== image) await this.deps.cmd.run("docker", ["rmi", previous]).catch(() => {});

    const keyPriv = new Uint8Array(randomBytes(32));
    const run: Running = {
      container: this.runner.containerName(`stg-${buildId}`),
      port: (this.deps.pickPort ?? randomPort)(),
      slug: a.slug,
      stores: null,
      devSlug: `stg-${buildId}`,
      keyPriv,
      keyPub: ed.getPublicKey(keyPriv),
      contextDir,
    };
    this.running.set(buildId, run);

    const fail = async (reason: string): Promise<StageResult> => {
      await this.teardownNow(buildId);
      return { ok: false, reason };
    };

    // A fresh dev dataspace, never the app's real stores.
    const stores = manifest.data.stores ?? {};
    let data: AppDataCredentials | null = null;
    if (stores.postgres || stores.objects || stores.kv) {
      if (!this.deps.dataProvisioner) return fail("the app declares data stores, but this server has no data layer");
      run.stores = stores;
      try {
        data = await this.deps.dataProvisioner.provisionDevDataspace({
          creator: STAGING_CREATOR,
          slug: run.devSlug,
          stores,
        });
      } catch (e) {
        return fail(`data provisioning failed: ${(e as Error).message}`);
      }
    }

    const migrations = migrationFiles(files).sort((x, y) => x.filename.localeCompare(y.filename));
    if (migrations.length > 0) {
      const pgUrl = pickPgUrlForApp(data);
      if (!pgUrl) return fail(`migration ${migrations[0]!.filename} needs a Postgres store, and the manifest declares none`);
      if (this.deps.runSql) {
        for (const m of migrations) {
          try {
            await this.deps.runSql({ pgUrl, sql: m.sql });
          } catch (e) {
            return fail(`migration ${m.filename} failed: ${(e as Error).message}`);
          }
        }
        // Sample rows from the schema the migrations made. Best-effort: an
        // app still runs on empty tables.
        try {
          const seed = datasetToSql(
            generateSynthetic({
              sql: migrations.map((m) => m.sql).join("\n"),
              seedHex: createHash("sha256").update(`flagship/staging-seed/v1|${buildId}`).digest("hex"),
            }),
          );
          if (/\bINSERT\b/.test(seed)) await this.deps.runSql({ pgUrl, sql: seed });
        } catch {
          /* empty tables */
        }
      }
    }

    const placeholders: Record<string, string> = {};
    for (const name of a.envNames ?? []) {
      if (ENV_NAME_RE.test(name) && !name.startsWith("FLAGSHIP_")) placeholders[name] = STAGING_ENV_PLACEHOLDER;
    }
    const containerPort = manifest.runtime.port;
    const env: Record<string, string> = {
      ...placeholders,
      ...(manifest.runtime.env ?? {}),
      ...(data ? credentialsToEnv(data) : {}),
      FLAGSHIP_APP_ID: `staging--${a.slug}`,
      FLAGSHIP_CREATOR: STAGING_CREATOR,
      FLAGSHIP_SLUG: a.slug,
      FLAGSHIP_HOST: STAGING_HOST,
      PORT: String(containerPort),
      TZ: "UTC",
      LANG: "C.UTF-8",
    };
    const spec: AppSpec = { serviceId: `stg-${buildId}`, image, env, port: run.port, containerPort };
    try {
      await this.runner.deploy(spec);
    } catch (e) {
      return fail(`container deploy failed: ${(e as Error).message}`);
    }
    if (this.deps.startCheck) {
      const r = await this.deps.startCheck(spec);
      // The copy stays up so its logs can be read; the next deploy replaces it.
      if (!r.ok) return { ok: false, reason: r.reason };
    }
    this.stagedCopies.set(buildId, { image, filesDigest: filesDigest(files), slug: a.slug });
    return { ok: true, image };
  }

  private async teardownNow(buildId: string): Promise<void> {
    const run = this.running.get(buildId);
    this.running.delete(buildId);
    if (!BUILD_ID_RE.test(buildId)) return;
    await this.deps.cmd.run("docker", ["rm", "-f", this.runner.containerName(`stg-${buildId}`)]).catch(() => {});
    if (run?.stores && this.deps.dataProvisioner) {
      await this.deps.dataProvisioner
        .teardownDevDataspace({ creator: STAGING_CREATOR, slug: run.devSlug, stores: run.stores })
        .catch(() => {});
    }
    await rm(join(this.deps.workingDir, ".staging", buildId), { recursive: true, force: true }).catch(() => {});
  }

  async logs(buildId: string): Promise<string | null> {
    const run = this.running.get(buildId);
    if (!run || !this.deps.cmd.capture) return null;
    try {
      const { stdout, stderr } = await this.deps.cmd.capture("docker", ["logs", "--tail", String(LOG_TAIL_LINES), run.container]);
      const text = [stdout, stderr].map((s) => s.trimEnd()).filter(Boolean).join("\n");
      return text.length > LOG_MAX_CHARS ? `…${text.slice(-LOG_MAX_CHARS)}` : text;
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string };
      return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || "(no output)";
    }
  }

  async checkApp(buildId: string, req: CheckAppRequest): Promise<CheckAppResult> {
    const run = this.running.get(buildId);
    if (!run) return { ok: false, reason: "nothing is running yet: call deploy first" };
    const path = req.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 2048 || /[\s\0]/.test(path)) {
      return { ok: false, reason: "path must start with / and contain no spaces" };
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) return { ok: false, reason: `unsupported method ${method}` };
    if (path === "/.flagship/runtime-pubkey") {
      const body = JSON.stringify({ injectorPubKeyHex: hex(run.keyPub) });
      return { ok: true, status: 200, contentType: "application/json", body, truncated: false };
    }
    const ts = String(this.now());
    const appId = `staging--${run.slug}`;
    const canonical = [`flagship/inject/v1`, appId, STAGING_USER, STAGING_ROLE, ts].join("|");
    const sig = ed.sign(new TextEncoder().encode(canonical), run.keyPriv);
    const headers: Record<string, string> = {
      host: STAGING_HOST,
      "user-agent": "flagship-check",
      accept: "*/*",
      "x-flagship-app-id": appId,
      "x-flagship-user": STAGING_USER,
      "x-flagship-role": STAGING_ROLE,
      "x-flagship-timestamp": ts,
      "x-flagship-signature": hex(sig),
    };
    const body = typeof req.body === "string" && method !== "GET" && method !== "HEAD" ? req.body : undefined;
    if (body != null) {
      headers["content-type"] = looksJson(body) ? "application/json" : "text/plain; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    return sendLocal(run.port, { method, path, headers, body, timeoutMs: this.deps.checkTimeoutMs ?? 10_000 });
  }
}

function looksJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function isText(contentType: string): boolean {
  return /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i.test(contentType) || contentType === "";
}

function sendLocal(
  port: number,
  r: { method: string; path: string; headers: Record<string, string>; body?: string; timeoutMs: number },
): Promise<CheckAppResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: CheckAppResult) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = httpRequest(
      { host: "127.0.0.1", port, method: r.method, path: r.path, headers: r.headers, timeout: r.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          const contentType = String(res.headers["content-type"] ?? "");
          const buf = Buffer.concat(chunks).subarray(0, CHECK_BODY_BYTES);
          const body = isText(contentType) ? buf.toString("utf8") : `(${size}${truncated ? "+" : ""} bytes of ${contentType})`;
          done({ ok: true, status: res.statusCode ?? 0, contentType, body, truncated });
        };
        res.on("data", (c: Buffer) => {
          if (size >= CHECK_BODY_BYTES) {
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(c);
          size += c.length;
          if (size > CHECK_BODY_BYTES) truncated = true;
        });
        res.on("end", finish);
        res.on("error", finish);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, reason: `the app didn't answer within ${Math.round(r.timeoutMs / 1000)} s` });
    });
    req.on("error", (e) => done({ ok: false, reason: `the app didn't answer: ${e.message}` }));
    if (r.body != null) req.write(r.body);
    req.end();
  });
}

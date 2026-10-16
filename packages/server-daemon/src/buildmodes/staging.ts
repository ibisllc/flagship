/**
 * The private staging copy an AI build runs on (docs/ai-privacy-and-staging.md
 * §2). The AI's `deploy` builds the image once and runs it here as
 * `flagship-stg-<buildId>`, on the `flagship-staging` network, published on a
 * loopback port only and never routed from the internet. Everything the app
 * can see is neutral: a made-up host and owner, UTC, placeholder values for
 * the owner's env vars, and a fresh dev dataspace seeded with synthetic rows.
 * The AI tests it through the box (`checkApp`, `logs`), and after a
 * deploy (even one whose app didn't start) may look at the copy's sample data (`queryDb`,
 * `listTables`, `listDataFiles`, `readDataFile`: the dev database as its dev
 * role, and the dev files volume through a throwaway container with no
 * network). Nothing here can reach a live database or volume. Going live
 * later installs the SAME image tag, so what goes live is what was tested.
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
import {
  credentialsToEnv,
  filesVolumeOf,
  wantsAnyStore,
  type AppDataCredentials,
  type DataProvisioner,
} from "../dataLayer/provisioner.js";
import { DEV_PG_PREFIX, isFilesVolume, isProdFilesVolume } from "../dataLayer/naming.js";
import { AppSqlError, compactCell, type AppSqlRunner } from "../dataLayer/appSql.js";
import { FILES_HELPER_IMAGE } from "../volumeDump.js";
import type { BuildToolDataHooks } from "./buildToolHost.js";
import { datasetToSql, generateSynthetic, sequenceResyncSql } from "../dataLayer/synth/index.js";
import { pickPgUrlForApp } from "../runMigration.js";
import { migrationFiles } from "../llm/serviceName.js";
import { readCarriedBinaries } from "../llm/serviceSource.js";
import { buildAppImage } from "./deployArtifact.js";
import {
  classifyEnvironmentFailure,
  classifyProvisioningError,
  environmentFailure,
  looksLikeDataConnectionError,
  type EnvironmentFailure,
} from "./environmentFailure.js";

const SAMPLE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

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
  /**
   * Sample data the owner attached in the chat, name → text: written to the
   * copy's own files volume at /data/sample/<name> before it starts. Never
   * reaches the live app.
   */
  sampleFiles?: Record<string, string>;
}

/**
 * `environment` is set when the box, not the app, is at fault (its data layer,
 * fence, docker, a registry, its disk): no AI may be asked to fix that.
 */
export type StageResult =
  | { ok: true; image: string }
  | { ok: false; reason: string; environment?: EnvironmentFailure };

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

/** A data tool's answer: compact JSON text for the model, or why not. */
export type StagingDataResult = { ok: true; text: string } | { ok: false; reason: string };

/** The staging copy's sample data, for the AI's data tools (after a successful deploy). */
export interface StagingDataTools {
  queryDb(buildId: string, req: { sql: string; store?: string }): Promise<StagingDataResult>;
  listTables(buildId: string, req: { store?: string }): Promise<StagingDataResult>;
  listDataFiles(buildId: string, req: { path?: string }): Promise<StagingDataResult>;
  readDataFile(buildId: string, req: { path: string }): Promise<StagingDataResult>;
}

/** What the orchestrator and the chat's deploy need of staging. */
export interface StagingHost extends Partial<StagingDataTools> {
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
  /** Why it's down; a fence down because dockerd is reads as a Docker failure. */
  unfencedBecause?: () => string | undefined;
  /** Wait before the one retry of a registry outage. Default 15 s. */
  registryRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** SQL against the dev database as its dev role (`query_db`, `list_tables`). Absent ⇒ those tools refuse. */
  sql?: AppSqlRunner | null;
  /** Image the throwaway file-listing container runs. Default the data layer's image. */
  filesHelperImage?: string;
}

/** `query_db` limits: sample data, so small. */
export const STAGING_QUERY_MAX_ROWS = 200;
export const STAGING_QUERY_TIMEOUT_MS = 10_000;
const STAGING_CELL_CHARS = 300;
const STAGING_SQL_MAX_CHARS = 64 * 1024;
const DATA_FILES_MAX = 500;
const DATA_FILES_DEPTH = 4;
const DATA_FILE_READ_BYTES = 16 * 1024;
const DATA_PATH_RE = /^[A-Za-z0-9._@+=, -]+(\/[A-Za-z0-9._@+=, -]+)*$/;
export const NOT_STAGED_REASON = "there's no test copy yet: call deploy first, and these tools answer once its data is set up";

const DOCKER_DOWN = /docker is not available|Cannot connect to the Docker daemon|Is the docker daemon running/i;

export const UNFENCED_REASON =
  "this server can't wall off the test copy's network right now, so the AI's test copy wasn't started";

interface Running {
  container: string;
  port: number;
  slug: string;
  stores: AppDataStores | null;
  /** The copy's dev credentials (never a live store). */
  data: AppDataCredentials | null;
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

  /**
   * Remove copies a previous daemon left behind, and their dev data (the
   * sample database and files volume), best-effort at boot. A chat that is
   * continued later stages a fresh dataspace anyway (stage tears the old
   * names down first), so nothing a continuable chat needs is lost; copies
   * this process runs are kept.
   */
  async sweep(): Promise<void> {
    if (this.deps.cmd.capture) {
      try {
        const { stdout } = await this.deps.cmd.capture("docker", ["ps", "-aq", "--filter", "name=^flagship-stg-"]);
        for (const id of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
          await this.deps.cmd.run("docker", ["rm", "-f", id]).catch(() => {});
        }
      } catch {
        /* docker unavailable */
      }
    }
    const provisioner = this.deps.dataProvisioner;
    if (!provisioner) return;
    try {
      const swept = await provisioner.sweepDevDataspaces(() =>
        [...this.running.values()].flatMap((r) =>
          r.stores ? [{ creator: STAGING_CREATOR, slug: r.devSlug, stores: r.stores }] : [],
        ),
      );
      if (swept.databases + swept.volumes > 0) {
        console.warn(
          `[staging] removed ${swept.databases} test database(s) and ${swept.volumes} files volume(s) a restart left behind`,
        );
      }
    } catch {
      /* the data layer isn't up; the next boot tries again */
    }
  }

  stage(a: StageArgs): Promise<StageResult> {
    return this.serial(a.buildId, async () => {
      let r = withEnvironment(await this.stageNow(a));
      // A registry hiccup gets one more try before it counts.
      if (!r.ok && r.environment?.kind === "registry") {
        await (this.deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(this.deps.registryRetryMs ?? 15_000);
        r = withEnvironment(await this.stageNow(a));
      }
      return r;
    });
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
    if (this.deps.fenced && !this.deps.fenced()) {
      const why = this.deps.unfencedBecause?.();
      if (why && DOCKER_DOWN.test(why)) return { ok: false, reason: `${UNFENCED_REASON}: ${why}`, environment: environmentFailure("docker") };
      return { ok: false, reason: UNFENCED_REASON, environment: environmentFailure("fence") };
    }
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
      data: null,
      devSlug: `stg-${buildId}`,
      keyPriv,
      keyPub: ed.getPublicKey(keyPriv),
      contextDir,
    };
    this.running.set(buildId, run);

    const fail = async (reason: string, environment?: EnvironmentFailure): Promise<StageResult> => {
      await this.teardownNow(buildId);
      return { ok: false, reason, ...(environment ? { environment } : {}) };
    };

    // A fresh dev dataspace, never the app's real stores.
    const stores = manifest.data.stores ?? {};
    let data: AppDataCredentials | null = null;
    if (wantsAnyStore(stores)) {
      if (!this.deps.dataProvisioner) {
        return fail("the app declares data stores, but this server has no data layer", environmentFailure("data-layer"));
      }
      run.stores = stores;
      try {
        // A copy a crashed daemon left half-made would refuse the names; the
        // dev names never match a prod store, so dropping them is safe.
        await this.deps.dataProvisioner
          .teardownDevDataspace({ creator: STAGING_CREATOR, slug: run.devSlug, stores })
          .catch(() => {});
        data = await this.deps.dataProvisioner.provisionDevDataspace({
          creator: STAGING_CREATOR,
          slug: run.devSlug,
          stores,
        });
      } catch (e) {
        return fail(`data provisioning failed: ${(e as Error).message}`, classifyProvisioningError(e));
      }
      run.data = data;
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
            const msg = (e as Error).message;
            const env = looksLikeDataConnectionError(msg) ? environmentFailure("data-layer") : undefined;
            return fail(`migration ${m.filename} failed: ${msg}`, env);
          }
        }
        // Sample rows from the schema the migrations made. Best-effort: an
        // app still runs on empty tables.
        try {
          const dataset = generateSynthetic({
            sql: migrations.map((m) => m.sql).join("\n"),
            seedHex: createHash("sha256").update(`flagship/staging-seed/v1|${buildId}`).digest("hex"),
          });
          const seed = datasetToSql(dataset);
          if (/\bINSERT\b/.test(seed)) {
            await this.deps.runSql({ pgUrl, sql: seed });
            const resync = sequenceResyncSql(dataset);
            if (resync) await this.deps.runSql({ pgUrl, sql: resync }).catch(() => {});
          }
        } catch {
          /* empty tables */
        }
      }
    }

    // The owner's sample data, into this copy's files volume only.
    if (a.sampleFiles && Object.keys(a.sampleFiles).length > 0) {
      await this.seedSamples(filesVolumeOf(data), a.sampleFiles);
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
    // Its own dev files volume (never the live one), removed at teardown.
    const filesVolume = filesVolumeOf(data);
    const spec: AppSpec = {
      serviceId: `stg-${buildId}`,
      image,
      env,
      port: run.port,
      containerPort,
      ...(filesVolume ? { filesVolume } : {}),
    };
    try {
      await this.runner.deploy(spec);
    } catch (e) {
      return fail(`container deploy failed: ${(e as Error).message}`);
    }
    if (this.deps.startCheck) {
      const r = await this.deps.startCheck(spec);
      // The copy stays up so its logs can be read; the next deploy replaces it.
      if (!r.ok) {
        // An app that can't reach its stores is the app's problem only if
        // the stores are up.
        if (data && looksLikeDataConnectionError(r.reason)) {
          const down = await this.deps.dataProvisioner?.checkReady().then(
            () => null,
            (e: unknown) => classifyProvisioningError(e),
          );
          if (down) return fail(r.reason, down);
        }
        return { ok: false, reason: r.reason };
      }
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

  /** The copy's dev data, only once a deploy of it succeeded. */
  /**
   * The copy the data tools look at: any that was set up, including one whose
   * app failed to start, since its sample data is what the AI needs to debug
   * that failure (it's never the live data, so nothing is at stake).
   */
  private tested(buildId: string): Running | null {
    return this.running.get(buildId) ?? null;
  }

  /** The dev Postgres store a data tool means (the only one, or by name). */
  private devStore(run: Running, store: string | undefined): { url: string } | { reason: string } {
    const stores = run.data?.postgres ?? {};
    const names = Object.keys(stores);
    if (names.length === 0) return { reason: "the app has no database (data.stores.postgres)" };
    const name = store ?? (names.length === 1 ? names[0]! : names.includes("default") ? "default" : null);
    if (name === null) return { reason: `say which store: ${names.join(", ")}` };
    const s = Object.prototype.hasOwnProperty.call(stores, name) ? stores[name] : undefined;
    if (!s) return { reason: `no store named ${JSON.stringify(name)}; the app has ${names.join(", ")}` };
    // Defence in depth: a staging copy's credentials are always the dev dataspace.
    if (!s.database.startsWith(DEV_PG_PREFIX)) return { reason: "this store isn't the test copy's" };
    return { url: s.url };
  }

  async queryDb(buildId: string, req: { sql: string; store?: string }): Promise<StagingDataResult> {
    const run = this.tested(buildId);
    if (!run) return { ok: false, reason: NOT_STAGED_REASON };
    if (!this.deps.sql) return { ok: false, reason: "query_db is not available on this server" };
    if (typeof req.sql !== "string" || req.sql.trim() === "") return { ok: false, reason: "sql required" };
    if (req.sql.length > STAGING_SQL_MAX_CHARS) return { ok: false, reason: "the statement is too long" };
    const store = this.devStore(run, req.store);
    if ("reason" in store) return { ok: false, reason: store.reason };
    try {
      const r = await this.deps.sql.query({
        pgUrl: store.url,
        sql: req.sql,
        readOnly: false,
        multiStatement: true,
        maxRows: STAGING_QUERY_MAX_ROWS,
        timeoutMs: STAGING_QUERY_TIMEOUT_MS,
      });
      return {
        ok: true,
        text: JSON.stringify({
          command: r.command,
          columns: r.columns.map((c) => `${c.name} ${c.type}`),
          rows: r.rows.map((row) => row.map((v) => compactCell(v, STAGING_CELL_CHARS))),
          rowCount: r.rowCount,
          ...(r.truncated ? { truncated: true, note: `only the first ${STAGING_QUERY_MAX_ROWS} rows` } : {}),
        }),
      };
    } catch (e) {
      return { ok: false, reason: e instanceof AppSqlError ? `the database said: ${e.message}` : `query failed: ${(e as Error).message}` };
    }
  }

  async listTables(buildId: string, req: { store?: string }): Promise<StagingDataResult> {
    const run = this.tested(buildId);
    if (!run) return { ok: false, reason: NOT_STAGED_REASON };
    if (!this.deps.sql) return { ok: false, reason: "list_tables is not available on this server" };
    const store = this.devStore(run, req.store);
    if ("reason" in store) return { ok: false, reason: store.reason };
    try {
      const tables = await this.deps.sql.listTables({ pgUrl: store.url, timeoutMs: STAGING_QUERY_TIMEOUT_MS });
      return {
        ok: true,
        text: JSON.stringify({
          tables: tables.map((t) => ({
            name: t.name,
            ...(t.kind === "view" ? { kind: "view" } : {}),
            rows: t.rows,
            columns: t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? "" : " not null"}`),
          })),
        }),
      };
    } catch (e) {
      return { ok: false, reason: `couldn't list the tables: ${(e as Error).message}` };
    }
  }

  /**
   * Write sample files to /data/sample/ in the copy's dev files volume, one
   * throwaway container per file with no network and the content on stdin.
   * Best-effort: an app without a files folder, or a write that fails, just
   * runs without them.
   */
  private async seedSamples(volume: string | undefined, files: Record<string, string>): Promise<void> {
    const capture = this.deps.cmd.capture;
    if (!volume || !capture || !isFilesVolume(volume) || isProdFilesVolume(volume)) return;
    for (const [name, text] of Object.entries(files)) {
      if (!SAMPLE_FILE_RE.test(name)) continue;
      const args = [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_OVERRIDE",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "0:0",
        "--memory",
        "64m",
        "--pids-limit",
        "32",
        "--mount",
        `type=volume,src=${volume},dst=/data`,
        "--entrypoint",
        "sh",
        this.deps.filesHelperImage ?? FILES_HELPER_IMAGE,
        "-c",
        'mkdir -p /data/sample && cat > "/data/sample/$1"',
        "sh",
        name,
      ];
      await capture.call(this.deps.cmd, "docker", args, { timeoutMs: 60_000, input: text }).catch(() => {});
    }
  }

  /** `docker run` over the copy's files volume, read-only, with no network. */
  private filesArgs(volume: string, entrypoint: string, args: string[]): string[] {
    return [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "DAC_READ_SEARCH",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--user",
      "0:0",
      "--memory",
      "64m",
      "--pids-limit",
      "32",
      "--mount",
      `type=volume,src=${volume},dst=/data,readonly`,
      "--entrypoint",
      entrypoint,
      this.deps.filesHelperImage ?? FILES_HELPER_IMAGE,
      ...args,
    ];
  }

  private filesVolume(run: Running): { volume: string } | { reason: string } {
    const volume = run.data?.files?.volume;
    if (!volume) return { reason: "the app has no files folder (data.stores.files)" };
    // Defence in depth: only ever the dev dataspace's volume.
    if (!isFilesVolume(volume) || isProdFilesVolume(volume)) return { reason: "this folder isn't the test copy's" };
    return { volume };
  }

  async listDataFiles(buildId: string, req: { path?: string }): Promise<StagingDataResult> {
    const run = this.tested(buildId);
    if (!run) return { ok: false, reason: NOT_STAGED_REASON };
    const capture = this.deps.cmd.capture;
    if (!capture) return { ok: false, reason: "list_data_files is not available on this server" };
    const v = this.filesVolume(run);
    if ("reason" in v) return { ok: false, reason: v.reason };
    const rel = dataPath(req.path ?? "");
    if (rel === null) return { ok: false, reason: "path must be relative to /data, without .. or odd characters" };
    const root = rel ? `/data/${rel}` : "/data";
    try {
      const { stdout } = await capture.call(
        this.deps.cmd,
        "docker",
        this.filesArgs(v.volume, "find", [root, "-mindepth", "1", "-maxdepth", String(DATA_FILES_DEPTH), "-printf", "%y\t%s\t%P\n"]),
        { timeoutMs: 30_000 },
      );
      const lines = stdout.split("\n").filter(Boolean);
      const files = lines.slice(0, DATA_FILES_MAX).map((l) => {
        const [type, size, ...rest] = l.split("\t");
        const path = rest.join("\t");
        return type === "d" ? { path: `${path}/` } : { path, bytes: Number(size) };
      });
      return {
        ok: true,
        text: JSON.stringify({
          root: root,
          files,
          ...(lines.length > DATA_FILES_MAX ? { truncated: true } : {}),
          ...(files.length === 0 ? { note: "empty" } : {}),
        }),
      };
    } catch (e) {
      const err = e as Error & { stderr?: string };
      return /No such file or directory/.test(`${err.stderr ?? ""}${err.message}`)
        ? { ok: false, reason: `no such folder: ${root}` }
        : { ok: false, reason: "couldn't list the files folder" };
    }
  }

  async readDataFile(buildId: string, req: { path: string }): Promise<StagingDataResult> {
    const run = this.tested(buildId);
    if (!run) return { ok: false, reason: NOT_STAGED_REASON };
    const capture = this.deps.cmd.capture;
    if (!capture) return { ok: false, reason: "read_data_file is not available on this server" };
    const v = this.filesVolume(run);
    if ("reason" in v) return { ok: false, reason: v.reason };
    const rel = dataPath(typeof req.path === "string" ? req.path : "");
    if (!rel) return { ok: false, reason: "path must name a file under /data, without .. or odd characters" };
    try {
      const { stdout } = await capture.call(
        this.deps.cmd,
        "docker",
        this.filesArgs(v.volume, "head", ["-c", String(DATA_FILE_READ_BYTES + 1), `/data/${rel}`]),
        { timeoutMs: 30_000 },
      );
      const truncated = Buffer.byteLength(stdout, "utf8") > DATA_FILE_READ_BYTES || stdout.length > DATA_FILE_READ_BYTES;
      const binary = /[\u0000\uFFFD]/.test(stdout);
      return {
        ok: true,
        text: binary
          ? JSON.stringify({ path: `/data/${rel}`, binary: true, note: "not text; its contents aren't shown" })
          : JSON.stringify({ path: `/data/${rel}`, content: stdout.slice(0, DATA_FILE_READ_BYTES), ...(truncated ? { truncated: true } : {}) }),
      };
    } catch (e) {
      const err = e as Error & { stderr?: string };
      return /No such file|Is a directory/.test(`${err.stderr ?? ""}${err.message}`)
        ? { ok: false, reason: `no such file: /data/${rel}` }
        : { ok: false, reason: "couldn't read the file" };
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
      "x-flagship-visitor": "member",
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

/**
 * The data tools of one build for a BuildToolHost. Refuses once the build is
 * sealed (the host refuses first; this is the second wall), and when the
 * staging host has no data tools.
 */
export function stagingDataHooks(
  staging: StagingHost | null | undefined,
  buildId: string,
  sealed: () => boolean = () => false,
): BuildToolDataHooks {
  const guard = async (
    fn: ((buildId: string, req: never) => Promise<StagingDataResult>) | undefined,
    req: unknown,
  ): Promise<StagingDataResult> => {
    if (sealed()) return { ok: false, reason: "this build is closed" };
    if (!fn) return { ok: false, reason: "this tool is not available on this server" };
    return fn.call(staging, buildId, req as never);
  };
  return {
    queryDb: (req) => guard(staging?.queryDb, req),
    listTables: (req) => guard(staging?.listTables, req),
    listDataFiles: (req) => guard(staging?.listDataFiles, req),
    readDataFile: (req) => guard(staging?.readDataFile, req),
  };
}

/** A path under /data: "" for the root, else clean relative segments; null when unsafe. */
function dataPath(raw: string): string | null {
  const p = raw.trim().replace(/^\/?data(\/|$)/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return "";
  if (p.length > 512 || !DATA_PATH_RE.test(p)) return null;
  if (p.split("/").some((seg) => seg === "." || seg === ".." || seg.startsWith("-"))) return null;
  return p;
}

/** Tag a failure the box caused that the stage didn't tag itself (docker, disk, registry). */
function withEnvironment(r: StageResult): StageResult {
  if (r.ok || r.environment) return r;
  const environment = classifyEnvironmentFailure(r.reason);
  return environment ? { ...r, environment } : r;
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

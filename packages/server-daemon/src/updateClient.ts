/**
 * Subscriber-side update puller. Periodically pulls a git bundle from
 * the canonical-home daemon's `/.flagship/update` endpoint, verifies
 * lineage coherence, applies migrations, and restarts the container.
 *
 * Pull cadence is the daemon scheduler's concern (every 6h with jitter
 * is the design default) — this module exposes a single `pullOne` that
 * the scheduler calls per app per tick. `pullOne` is idempotent: if the
 * upstream hasn't advanced, it's a no-op.
 *
 * Lineage anchor: the earliest commit hash this box ever pulled for the
 * app. Recorded at install time. Verified on every subsequent pull —
 * if `lineageAnchor` is not reachable from the upstream tip, the
 * canonical home has been replaced (force-push, repo rewrite, creator
 * pointed the URL at a different repo). The pull halts and a phone
 * alert fires; the user picks "stay frozen" or "fresh install."
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readdirSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signUpdatePull,
  type Bytes,
  type Keypair,
  type UpdatePullRequest,
} from "@flagship/protocol";

const execFileP = promisify(execFile);

export type UpdatePolicy = "auto" | "manual" | "frozen";

/**
 * Per-app state persisted on disk by the daemon. Read on boot, written
 * after each successful pull / migration. The store is injected so we
 * don't dictate the on-disk layout (production: per-app JSON file under
 * `/var/flagship/data/app-state/<appId>.json`).
 */
export interface AppPullState {
  canonicalUrl: string;
  lineageAnchor: string;
  currentTip: string;
  /** Filename of the last applied migration, or "" if none yet. */
  lastAppliedMigration: string;
  updatePolicy: UpdatePolicy;
  /** Filled when a pending update is awaiting phone approval. */
  pendingPullCommit?: string;
}

export interface AppPullStateStore {
  get(appId: string): Promise<AppPullState | null>;
  put(appId: string, state: AppPullState): Promise<void>;
  /** List all appIds with persisted pull state (for the scheduler). */
  list?(): Promise<string[]>;
  /** Drop the entry — called on uninstall. Idempotent. */
  delete?(appId: string): Promise<void>;
}

export type PhoneUpdateAlert =
  | {
      kind: "lineage-break";
      appId: string;
      canonicalUrl: string;
      lineageAnchor: string;
      upstreamTip: string;
    }
  | {
      kind: "manual-pending";
      appId: string;
      fromCommit: string;
      toCommit: string;
    }
  | {
      kind: "migration-failed";
      appId: string;
      migrationFile: string;
      reason: string;
    };

export interface UpdateClientDeps {
  /** This box's server identity keypair. Pulls are signed with this. */
  identity: Keypair;
  /** This box's FQDN (e.g. `home.bob.flagship.services`) — sent as `pullerServerId`. */
  pullerServerId: string;
  /** Per-app on-disk pull state. */
  state: AppPullStateStore;
  /**
   * Absolute path to the per-app working-tree clone, e.g.
   * `/var/flagship/data/app-clones/<appId>/`. Container's bind-mount
   * source. Created on first install.
   */
  appWorkingDir: (appId: string) => string;
  /**
   * HTTP client. Defaults to global fetch; override in tests.
   * The body returned must allow `arrayBuffer()`.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Apply a single migration file. Caller decides what `.sql` / `.ts`
   * means — typically: SQL → run via per-app PG role; TS → spawn `tsx`.
   * Throws on failure.
   */
  runMigration: (args: {
    appId: string;
    absPath: string;
    filename: string;
  }) => Promise<void>;
  /** Restart the running container after migrations succeed. */
  restartContainer: (appId: string) => Promise<void>;
  /**
   * Surface an event to the phone (e.g. via the orders/state queue).
   * Synchronous — the phone alert mechanism is fire-and-forget.
   */
  emitPhoneAlert: (alert: PhoneUpdateAlert) => void;
  gitBinary?: string;
  now?: () => number;
}

export type PullResult =
  | { kind: "no-op"; reason: "frozen-policy" | "no-canonical-state" | "already-current" }
  | { kind: "applied"; from: string; to: string; migrationsApplied: string[] }
  | { kind: "halted-lineage-break"; lineageAnchor: string; upstreamTip: string }
  | { kind: "halted-manual-pending"; from: string; to: string }
  | { kind: "halted-migration-failed"; failingFile: string; reason: string }
  | { kind: "error"; reason: string };

export class UpdateClient {
  private readonly gitBinary: string;
  private readonly now: () => number;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly deps: UpdateClientDeps) {
    this.gitBinary = deps.gitBinary ?? "git";
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetch ?? ((u, i) => fetch(u, i));
  }

  /**
   * Pull updates for one app. Idempotent.
   *
   * If the manifest declares `frozen`, returns no-op. If the manifest
   * declares `manual`, fetches the bundle and stages an incoming-main
   * branch but does not advance the working tree; emits a phone alert.
   * If `auto`, advances + runs migrations + restarts.
   */
  async pullOne(args: { appId: string }): Promise<PullResult> {
    const state = await this.deps.state.get(args.appId);
    if (!state) {
      return { kind: "no-op", reason: "no-canonical-state" };
    }
    if (state.updatePolicy === "frozen") {
      return { kind: "no-op", reason: "frozen-policy" };
    }

    const workDir = this.deps.appWorkingDir(args.appId);
    if (!existsSync(workDir)) {
      return { kind: "error", reason: `working dir ${workDir} missing` };
    }

    const [creator, slug] = parseAppId(args.appId);

    // Build, sign, send the pull envelope.
    const pull: UpdatePullRequest = {
      pullerServerId: this.deps.pullerServerId,
      creator,
      slug,
      since: state.currentTip,
      issuedAt: this.now(),
    };
    const sig = signUpdatePull(pull, this.deps.identity);

    const url = `https://${state.canonicalUrl}/.flagship/update`;
    const headers = new Headers();
    headers.set("x-flagship-update-pull", JSON.stringify(pull));
    headers.set(
      "authorization",
      `Flagship-Identity ${bytesToHex(this.deps.identity.publicKey)} ${bytesToHex(sig)}`,
    );

    let res: Response;
    try {
      res = await this.fetcher(url, { method: "GET", headers });
    } catch (e) {
      return { kind: "error", reason: `fetch failed: ${(e as Error).message}` };
    }
    if (res.status === 304) {
      return { kind: "no-op", reason: "already-current" };
    }
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      return { kind: "error", reason: `home returned ${res.status}: ${text.slice(0, 200)}` };
    }

    const bundleBytes = Buffer.from(await res.arrayBuffer());
    if (bundleBytes.length === 0) {
      return { kind: "no-op", reason: "already-current" };
    }

    // Stage the bundle in a temp file, fetch it into a synthetic ref.
    const tmp = await mkdtemp(join(tmpdir(), "flagship-pull-"));
    const bundlePath = join(tmp, "incoming.bundle");
    try {
      await writeFile(bundlePath, bundleBytes);
      // `git fetch <bundle> main:incoming-main` writes a local ref pointing at
      // the bundle's main tip.
      await this.git(workDir, ["fetch", bundlePath, "main:incoming-main"]);
      const upstreamTip = (await this.git(workDir, ["rev-parse", "incoming-main"])).stdout.trim();

      if (upstreamTip === state.currentTip) {
        return { kind: "no-op", reason: "already-current" };
      }

      // Lineage check: is our anchor reachable from the upstream tip?
      const isAncestor = await this.isAncestor(workDir, state.lineageAnchor, upstreamTip);
      if (!isAncestor) {
        // Don't merge; surface to phone.
        const alert: PhoneUpdateAlert = {
          kind: "lineage-break",
          appId: args.appId,
          canonicalUrl: state.canonicalUrl,
          lineageAnchor: state.lineageAnchor,
          upstreamTip,
        };
        this.deps.emitPhoneAlert(alert);
        return {
          kind: "halted-lineage-break",
          lineageAnchor: state.lineageAnchor,
          upstreamTip,
        };
      }

      if (state.updatePolicy === "manual") {
        // Stage but don't merge. Record the pending tip; the phone-side
        // approval flow will call `applyPending` to commit.
        const next: AppPullState = { ...state, pendingPullCommit: upstreamTip };
        await this.deps.state.put(args.appId, next);
        const alert: PhoneUpdateAlert = {
          kind: "manual-pending",
          appId: args.appId,
          fromCommit: state.currentTip,
          toCommit: upstreamTip,
        };
        this.deps.emitPhoneAlert(alert);
        return { kind: "halted-manual-pending", from: state.currentTip, to: upstreamTip };
      }

      // Auto: advance the working tree, then run any new migrations.
      return await this.advanceAndMigrate({
        appId: args.appId,
        workDir,
        state,
        toCommit: upstreamTip,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Phone-approved completion of a manual pull. Idempotent.
   */
  async applyPending(args: { appId: string }): Promise<PullResult> {
    const state = await this.deps.state.get(args.appId);
    if (!state) return { kind: "error", reason: "no state" };
    if (!state.pendingPullCommit) return { kind: "no-op", reason: "already-current" };
    const workDir = this.deps.appWorkingDir(args.appId);
    return await this.advanceAndMigrate({
      appId: args.appId,
      workDir,
      state,
      toCommit: state.pendingPullCommit,
    });
  }

  private async advanceAndMigrate(args: {
    appId: string;
    workDir: string;
    state: AppPullState;
    toCommit: string;
  }): Promise<PullResult> {
    const { workDir, state, toCommit, appId } = args;
    // Discover migrations to apply: any file under migrations/ in the
    // upstream tree whose name (lex-sorted) is greater than
    // state.lastAppliedMigration. We read the migration list from the
    // upstream commit so we don't depend on already-merging.
    const migrationsToRun = await this.listPendingMigrations({
      workDir,
      atCommit: toCommit,
      lastApplied: state.lastAppliedMigration,
    });

    // Fast-forward main to toCommit (creates main on first pull).
    const hasMain = await this.refExists(workDir, "main");
    if (hasMain) {
      await this.git(workDir, ["update-ref", "refs/heads/main", toCommit]);
    } else {
      await this.git(workDir, ["update-ref", "refs/heads/main", toCommit]);
    }
    // Check out main so the working tree reflects the new code (the
    // container reads files via the bind-mounted working tree).
    await this.git(workDir, ["checkout", "main"]);
    await this.git(workDir, ["reset", "--hard", "main"]);

    const applied: string[] = [];
    for (const m of migrationsToRun) {
      const absPath = join(workDir, "migrations", m);
      try {
        await this.deps.runMigration({ appId, absPath, filename: m });
      } catch (e) {
        const reason = (e as Error).message;
        // Halt; don't restart container; surface to phone.
        this.deps.emitPhoneAlert({
          kind: "migration-failed",
          appId,
          migrationFile: m,
          reason,
        });
        return { kind: "halted-migration-failed", failingFile: m, reason };
      }
      applied.push(m);
    }

    const last = applied.length > 0 ? applied[applied.length - 1]! : state.lastAppliedMigration;
    const next: AppPullState = {
      ...state,
      currentTip: toCommit,
      lastAppliedMigration: last,
      pendingPullCommit: undefined,
    };
    await this.deps.state.put(appId, next);
    await this.deps.restartContainer(appId);
    return {
      kind: "applied",
      from: state.currentTip,
      to: toCommit,
      migrationsApplied: applied,
    };
  }

  private async listPendingMigrations(args: {
    workDir: string;
    atCommit: string;
    lastApplied: string;
  }): Promise<string[]> {
    // Read tree at the commit. `git ls-tree -r --name-only <commit> migrations/`
    // returns every file under migrations/ at that commit. Sort lex,
    // filter > lastApplied.
    let output: string;
    try {
      const r = await this.git(args.workDir, [
        "ls-tree",
        "-r",
        "--name-only",
        args.atCommit,
        "migrations/",
      ]);
      output = r.stdout;
    } catch {
      return [];
    }
    const files = output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("migrations/") && l !== "migrations/")
      .map((l) => l.slice("migrations/".length))
      .filter((name) => /^[0-9]+_/.test(name));
    files.sort();
    return files.filter((f) => f > args.lastApplied);
  }

  private async isAncestor(workDir: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      // exit 0 → is ancestor; exit 1 → not; exit other → error.
      await this.git(workDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  private async refExists(workDir: string, ref: string): Promise<boolean> {
    try {
      await this.git(workDir, ["rev-parse", "--verify", `refs/heads/${ref}`]);
      return true;
    } catch {
      return false;
    }
  }

  private git(workDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP(this.gitBinary, ["-C", workDir, ...args], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// JSON-file state store (production default)
// ──────────────────────────────────────────────────────────────────────

export class FileAppPullStateStore implements AppPullStateStore {
  constructor(private readonly dir: string) {}

  private path(appId: string): string {
    return join(this.dir, `${appId}.json`);
  }

  async get(appId: string): Promise<AppPullState | null> {
    try {
      const buf = await readFile(this.path(appId), "utf8");
      return JSON.parse(buf) as AppPullState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async put(appId: string, state: AppPullState): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(appId)}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    // atomic replace
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.path(appId));
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  }

  async delete(appId: string): Promise<void> {
    await rm(this.path(appId), { force: true });
  }
}

/**
 * In-memory store for tests and ephemeral test daemons. Production uses
 * `FileAppPullStateStore`. Implements `list` + `delete` so the scheduler
 * + AppPlatform.uninstall can find/clean entries.
 */
export class InMemoryAppPullStateStore implements AppPullStateStore {
  private readonly byApp = new Map<string, AppPullState>();

  async get(appId: string): Promise<AppPullState | null> {
    return this.byApp.get(appId) ?? null;
  }

  async put(appId: string, state: AppPullState): Promise<void> {
    this.byApp.set(appId, state);
  }

  async list(): Promise<string[]> {
    return [...this.byApp.keys()];
  }

  async delete(appId: string): Promise<void> {
    this.byApp.delete(appId);
  }
}

// ──────────────────────────────────────────────────────────────────────

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function parseAppId(appId: string): [string, string] {
  const i = appId.indexOf("--");
  if (i < 0) throw new Error(`appId ${appId} is not in <creator>--<slug> form`);
  return [appId.slice(0, i), appId.slice(i + 2)];
}

// Used in tests; export so they can scan migrations directly.
export function listMigrationsOnDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9]+_/.test(f))
    .sort();
}


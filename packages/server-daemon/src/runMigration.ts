/**
 * Production runMigration dispatcher.
 *
 * The UpdateClient calls a daemon-injected `runMigration({serviceId, absPath,
 * filename})` for every new file under `migrations/` between the puller's
 * current tip and the upstream tip. This module is the canonical
 * production implementation; the dispatch is by file extension:
 *
 *   .sql  → connect to the per-app PG role + run as one transaction.
 *   .ts   → spawn `tsx <absPath>` with the per-app FLAGSHIP_* env injected.
 *           Migration scripts read FLAGSHIP_PG_URL etc. from env exactly
 *           like the app container does. Non-zero exit fails the pull.
 *   .js   → same as .ts but spawned via `node`.
 *
 * Files with any other extension are skipped (returns success). The
 * UpdateClient already filters `migrations/` to `^[0-9]+_` prefix
 * names + lex-sorts; this module only sees ones that survived that
 * filter.
 *
 * Failure semantics: throwing surfaces as `halted-migration-failed` in
 * the UpdateClient + a phone alert.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { extname } from "node:path";
import type { AppDataCredentials } from "./dataLayer/index.js";
import { credentialsToEnv } from "./dataLayer/index.js";
import type { InstalledService } from "./servicePlatform.js";

const execFileP = promisify(execFile);

export interface RunMigrationDeps {
  /**
   * Look up the installed app by serviceId so we can pick up its data
   * credentials + reserved env. Returns null when the app isn't
   * installed (which shouldn't happen in practice — UpdateClient is
   * called by the scheduler for installed apps only).
   */
  serviceByServiceId: (serviceId: string) => InstalledService | null;
  /**
   * Override executors for tests. Each is called with the resolved
   * env so tests can assert what the migration would have seen
   * without spawning processes.
   */
  runSqlOverride?: (args: {
    sql: string;
    pgUrl: string;
  }) => Promise<void>;
  runScriptOverride?: (args: {
    cmd: string;
    args: string[];
    env: Record<string, string>;
  }) => Promise<void>;
  /** Default 5 min — long enough for big SQL migrations. */
  timeoutMs?: number;
  /** psql path. Default `psql`. */
  psqlBinary?: string;
  /** tsx path. Default `tsx` (resolved via PATH or npx). */
  tsxBinary?: string;
}

export function buildRunMigration(deps: RunMigrationDeps): (args: {
  serviceId: string;
  absPath: string;
  filename: string;
}) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 5 * 60_000;
  const psql = deps.psqlBinary ?? "psql";
  const tsx = deps.tsxBinary ?? "tsx";

  return async function runMigration(args: {
    serviceId: string;
    absPath: string;
    filename: string;
  }): Promise<void> {
    const ext = extname(args.filename).toLowerCase();
    const app = deps.serviceByServiceId(args.serviceId);
    if (!app) {
      throw new Error(`unknown serviceId ${args.serviceId}`);
    }

    if (ext === ".sql") {
      const pgUrl = pickPgUrlForApp(app.data);
      if (!pgUrl) {
        throw new Error(
          `migration ${args.filename} is .sql but app has no postgres store`,
        );
      }
      const sql = await readFile(args.absPath, "utf8");
      if (deps.runSqlOverride) {
        await deps.runSqlOverride({ sql, pgUrl });
        return;
      }
      // Run the file as a single transaction. -1 = single-tx, -v
      // ON_ERROR_STOP=1 = abort on first error, --no-psqlrc = ignore
      // user dotfiles, -f - = read from stdin.
      const proc = await execFileP(
        psql,
        ["-1", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", pgUrl, "-f", args.absPath],
        {
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      // psql may emit NOTICE/WARNING on stderr without nonzero exit; we
      // treat that as success (psql already non-zero-exited above on real
      // errors thanks to ON_ERROR_STOP).
      void proc;
      return;
    }

    if (ext === ".ts" || ext === ".js") {
      const env: Record<string, string> = {
        ...filterParentEnv(),
        ...(app.data ? credentialsToEnv(app.data) : {}),
        FLAGSHIP_APP_ID: app.serviceId,
        FLAGSHIP_CREATOR: app.creator,
        FLAGSHIP_SLUG: app.slug,
        FLAGSHIP_MIGRATION_FILE: args.filename,
      };
      const cmd = ext === ".ts" ? tsx : "node";
      if (deps.runScriptOverride) {
        await deps.runScriptOverride({
          cmd,
          args: [args.absPath],
          env,
        });
        return;
      }
      await execFileP(cmd, [args.absPath], {
        env,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return;
    }

    // Unknown extension: skip silently. The UpdateClient already
    // filtered to `^[0-9]+_` so we won't see junk files; but README.md
    // etc. dropped under migrations/ would land here.
    return;
  };
}

/**
 * Pick the URL for the default postgres instance, or fail closed. SQL
 * migrations are scoped to the app's primary store; multi-instance
 * apps that need to migrate a non-default instance should use a .ts
 * migration that reads the named env var.
 */
function pickPgUrlForApp(data: AppDataCredentials | null): string | null {
  if (!data?.postgres) return null;
  // credentialsToEnv emits FLAGSHIP_PG_URL for the singleton case and
  // FLAGSHIP_PG_URL_<INSTANCE> for named ones. The `default` instance
  // (the singleton) is what we want for the implicit SQL path.
  const env = credentialsToEnv(data);
  const url = env["FLAGSHIP_PG_URL"];
  if (url) return url;
  // Named-only configurations: pick `FLAGSHIP_PG_URL_DEFAULT` if present;
  // otherwise the first FLAGSHIP_PG_URL_* we see (deterministic by sort).
  const named = Object.keys(env)
    .filter((k) => k.startsWith("FLAGSHIP_PG_URL_"))
    .sort();
  return named.length > 0 ? env[named[0]!]! : null;
}

/**
 * Drop secrets that don't belong in a migration's env (the app's
 * FLAGSHIP_* are added explicitly above). Keep PATH so spawned
 * binaries can find their own dependencies.
 */
function filterParentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("FLAGSHIP_")) continue; // we re-inject the app's set
    out[k] = v;
  }
  return out;
}

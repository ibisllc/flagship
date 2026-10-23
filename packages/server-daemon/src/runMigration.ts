/**
 * Production runMigration dispatcher.
 *
 * The UpdateClient calls a daemon-injected `runMigration({serviceId, absPath,
 * filename})` for every new file under `migrations/` between the puller's
 * current tip and the upstream tip. This module is the canonical
 * production implementation; the dispatch is by file extension:
 *
 *   .sql  → run as the per-app PG role in a one-shot sandbox container, as one transaction.
 *   .ts/.js → refused. A creator's script would run as the host daemon;
 *           until a one-shot sandbox exists (SEC-MIG-002) it never runs.
 *
 * Files with any other extension are skipped (returns success). The
 * UpdateClient already filters `migrations/` to `^[0-9]+_` prefix
 * names + lex-sorts; this module only sees ones that survived that
 * filter.
 *
 * Failure semantics: throwing surfaces as `halted-migration-failed` in
 * the UpdateClient + a phone alert.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AppDataCredentials } from "./dataLayer/index.js";
import { credentialsToEnv } from "./dataLayer/index.js";
import type { InstalledService } from "./servicePlatform.js";
import { HOST_SCRIPT_MIGRATION_REFUSAL, isHostScriptMigration } from "./updateClient.js";

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
}

export function buildRunMigration(deps: RunMigrationDeps): (args: {
  serviceId: string;
  absPath: string;
  filename: string;
}) => Promise<void> {
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
      // Never on the host: a creator's SQL runs only in the one-shot sandbox (migrationSandbox.ts).
      if (!deps.runSqlOverride) {
        throw new Error("this server has no migration sandbox, so the migration was not run");
      }
      await deps.runSqlOverride({ sql, pgUrl });
      return;
    }

    if (isHostScriptMigration(args.filename)) {
      throw new Error(HOST_SCRIPT_MIGRATION_REFUSAL);
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
export function pickPgUrlForApp(data: AppDataCredentials | null): string | null {
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

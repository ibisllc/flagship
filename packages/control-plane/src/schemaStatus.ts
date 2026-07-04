import type { SchemaVersionStorage } from "@flagship/storage";
import type { HandlerResponse } from "./types.js";

/**
 * Migration-ledger visibility (OPS-2).
 *
 * The `.com` D1 migration path is manual + out-of-band (one `wrangler d1
 * execute --file` per file), so prod D1 silently drifts from the repo's
 * migration set. The `schema_version` ledger (migration 0049) records
 * which migrations an operator has applied; this handler reads the ledger
 * back and diffs it against the repo's KNOWN migration set so drift is
 * visible at a glance from `GET /api/admin/schema-status`.
 *
 * This is a READ/visibility tool, not an auto-migrator. Recording happens
 * out-of-band (the operator runs the migrations and then stamps the ledger,
 * either manually or via the admin POST stamp endpoint).
 *
 * The known set is embedded here (the Worker has no filesystem). It MUST
 * stay in lockstep with packages/storage/migrations/*.sql — a unit test
 * (tests/schemaStatus.test.ts) asserts this constant equals the actual
 * on-disk filenames, so a new migration that forgets to update the list
 * fails CI rather than silently under-reporting drift.
 */
export const KNOWN_MIGRATIONS: readonly string[] = [
  "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008",
  "0009", "0010", "0011", "0012", "0013", "0014", "0015", "0016",
  "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024",
  "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032",
  "0033", "0034", "0035", "0036", "0037", "0038", "0039", "0040",
  "0041", "0042", "0043", "0044", "0045", "0046", "0047", "0048",
  "0049", "0050", "0051", "0052", "0053", "0054", "0055", "0056",
  "0057", "0058", "0059", "0060", "0061", "0062", "0063", "0064",
  "0065", "0066", "0067",
];

export interface SchemaStatusDeps {
  schemaVersion: SchemaVersionStorage;
  /** Override the known set (tests). Defaults to KNOWN_MIGRATIONS. */
  known?: readonly string[];
}

export interface SchemaStatusBody {
  /** The repo's known migration version ids (ascending). */
  known: string[];
  /** Versions recorded in the ledger as applied (with timestamps). */
  applied: { version: string; appliedAt: number }[];
  /** Known migrations with NO ledger row — the drift the operator must close. */
  missing: string[];
  /** Ledger rows for versions NOT in the repo's known set (ahead of repo / typo). */
  unknown: string[];
  /** Convenience: true iff every known migration is recorded and nothing is unknown. */
  inSync: boolean;
}

/**
 * GET /api/admin/schema-status — diff the ledger against the known set.
 * Admin-gated at the route layer (FLAGSHIP_ADMIN_SECRET).
 */
export async function handleSchemaStatus(
  deps: SchemaStatusDeps,
): Promise<HandlerResponse<SchemaStatusBody>> {
  const known = [...(deps.known ?? KNOWN_MIGRATIONS)].sort((a, b) =>
    a.localeCompare(b),
  );
  const appliedRows = await deps.schemaVersion.list();
  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const knownSet = new Set(known);

  const missing = known.filter((v) => !appliedSet.has(v));
  const unknown = appliedRows
    .map((r) => r.version)
    .filter((v) => !knownSet.has(v))
    .sort((a, b) => a.localeCompare(b));

  return {
    status: 200,
    body: {
      known,
      applied: appliedRows.map((r) => ({
        version: r.version,
        appliedAt: r.appliedAt,
      })),
      missing,
      unknown,
      inSync: missing.length === 0 && unknown.length === 0,
    },
  };
}

export interface SchemaStampDeps {
  schemaVersion: SchemaVersionStorage;
  now: () => number;
}

/**
 * POST /api/admin/schema-version/:version — admin-gated ledger backfill.
 * Stamps a single version as applied so an operator can reconcile a DB
 * that was migrated before the ledger existed. Idempotent: stamping an
 * already-recorded version is a no-op (original appliedAt preserved).
 */
export async function handleStampSchemaVersion(
  deps: SchemaStampDeps,
  version: string,
): Promise<HandlerResponse<{ version: string; recorded: boolean; alreadyPresent: boolean }>> {
  const v = version.trim();
  if (!/^\d{3,}$/.test(v)) {
    return {
      status: 400,
      body: { version, recorded: false, alreadyPresent: false },
    };
  }
  const inserted = await deps.schemaVersion.record(v, deps.now());
  return {
    status: 200,
    body: { version: v, recorded: inserted, alreadyPresent: !inserted },
  };
}

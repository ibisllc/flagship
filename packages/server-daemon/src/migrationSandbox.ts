/**
 * Where an app's SQL migration runs (SECURITY-HARDENING-PLAN.md 10.1, SEC-MIG-002).
 *
 * A creator's migration is attacker-reachable input. It used to run in the daemon's own process
 * with every timeout lifted. Now it runs in a one-shot container: gVisor, the app's own
 * unprivileged identity, a read-only image with a small tmpfs, no mounts of any kind (the SQL
 * arrives on stdin), no capabilities, bounded memory/CPU/processes, the staging bridge (no
 * internet), and ONLY the app's own database role. The daemon's environment is not inherited:
 * the credentials reach the container through the docker client's private environment, never the
 * argument list. Statement, lock and wall-clock time are bounded, output is capped and redacted.
 *
 * Authorization is the database role's, not a parse of the SQL: the role cannot create
 * extensions, roles or databases, and cannot see sibling schemas (dataLayer/provisioner.ts).
 */
import { randomBytes } from "node:crypto";
import { assertNoHostPathInDockerArgs, ensureDockerNetwork, type CommandRunner } from "./serviceRunner.js";
import { GVISOR_RUNTIME } from "./appSandbox/gvisor.js";

/** The data layer's own Postgres image: already on every box, carries psql. Pinned by digest. */
export const MIGRATION_PSQL_IMAGE =
  "pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0";

/** The bridge with no route to the internet; data stores answer over the host-gateway alias. */
export const MIGRATION_NETWORK = "flagship-staging";
export const DATA_HOST_ALIAS = "host.flagship.internal";

export interface MigrationLimits {
  memory: string;
  cpus: string;
  pidsLimit: number;
  tmpfsSize: string;
  /** Per-statement ceiling inside the database. */
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionMs: number;
  /** Wall clock for the whole container; it is killed past this. */
  wallClockMs: number;
  /** Most output kept (the tail), in bytes. */
  outputBytes: number;
}

export const DEFAULT_MIGRATION_LIMITS: MigrationLimits = {
  memory: "256m",
  cpus: "1.0",
  pidsLimit: 256,
  tmpfsSize: "32m",
  statementTimeoutMs: 5 * 60_000,
  lockTimeoutMs: 10_000,
  idleInTransactionMs: 30_000,
  wallClockMs: 10 * 60_000,
  outputBytes: 16 * 1024,
};

export interface MigrationTarget {
  /** The app's own role and database (opaque names from dataLayer/naming.ts). */
  user: string;
  password: string;
  database: string;
  port: number;
}

export interface SandboxPlan {
  /** Arguments after `docker`. */
  args: string[];
  /** The docker client's whole environment: where the secrets travel, not argv. */
  env: Record<string, string>;
  containerName: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** The `docker run` for one migration. Pure. */
export function buildSandboxPlan(args: {
  target: MigrationTarget;
  appUid?: number;
  limits?: Partial<MigrationLimits>;
  image?: string;
  containerName?: string;
  /** Minimal PATH for the docker client itself. */
  clientPath?: string;
}): SandboxPlan {
  const l = { ...DEFAULT_MIGRATION_LIMITS, ...(args.limits ?? {}) };
  const t = args.target;
  if (!NAME_RE.test(t.user) || !NAME_RE.test(t.database)) throw new Error("migration target has an unsafe role or database name");
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new Error("migration target has a bad port");
  const uid = args.appUid ?? 10001;
  const name = args.containerName ?? `flagship-migrate-${randomBytes(6).toString("hex")}`;
  const pgOptions = `-c statement_timeout=${l.statementTimeoutMs} -c lock_timeout=${l.lockTimeoutMs} -c idle_in_transaction_session_timeout=${l.idleInTransactionMs}`;
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--name", name,
    `--runtime=${GVISOR_RUNTIME}`,
    `--network=${MIGRATION_NETWORK}`,
    "--add-host", `${DATA_HOST_ALIAS}:host-gateway`,
    "--user", `${uid}:${uid}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory", l.memory,
    "--cpus", l.cpus,
    "--pids-limit", String(l.pidsLimit),
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=${l.tmpfsSize}`,
    // Values come from the docker client's own environment (`-e NAME` with no value), so they are
    // never on a command line another process on the box could read.
    "-e", "PGPASSWORD",
    "-e", "PGOPTIONS",
    "--entrypoint", "psql",
    args.image ?? MIGRATION_PSQL_IMAGE,
    "-h", DATA_HOST_ALIAS,
    "-p", String(t.port),
    "-U", t.user,
    "-d", t.database,
    "-1",
    // `--set`, not `-v`: the docker guard refuses any `-v` as a possible host mount.
    "--set=ON_ERROR_STOP=1",
    "--no-psqlrc",
    "-f", "-",
  ];
  assertNoHostPathInDockerArgs(dockerArgs);
  return {
    args: dockerArgs,
    env: { PATH: args.clientPath ?? "/usr/local/bin:/usr/bin:/bin", PGPASSWORD: t.password, PGOPTIONS: pgOptions },
    containerName: name,
  };
}

/** Keep the tail of `text`, within `max` bytes, with every secret replaced. */
export function boundedRedacted(text: string, max: number, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("«redacted»");
  const buf = Buffer.from(out, "utf8");
  if (buf.length <= max) return out;
  return `…${buf.subarray(buf.length - max).toString("utf8")}`;
}

export class MigrationFailedError extends Error {
  constructor(
    message: string,
    readonly kind: "failed" | "timed-out" | "unavailable",
  ) {
    super(message);
    this.name = "MigrationFailedError";
  }
}

export interface RunSandboxedSqlOptions {
  cmd: CommandRunner;
  target: MigrationTarget;
  sql: string;
  limits?: Partial<MigrationLimits>;
  appUid?: number;
  image?: string;
}

/**
 * Run `sql` as the app's role in the sandbox. Resolves on success; throws `MigrationFailedError`
 * with bounded, redacted output otherwise. Past the wall clock the container is killed by name.
 */
export async function runSandboxedSql(o: RunSandboxedSqlOptions): Promise<void> {
  if (!o.cmd.capture) throw new MigrationFailedError("this box cannot run a migration sandbox", "unavailable");
  const l = { ...DEFAULT_MIGRATION_LIMITS, ...(o.limits ?? {}) };
  const plan = buildSandboxPlan({ target: o.target, ...(o.appUid !== undefined ? { appUid: o.appUid } : {}), limits: l, ...(o.image ? { image: o.image } : {}) });
  const secrets = [o.target.password, encodeURIComponent(o.target.password)];
  // The no-internet bridge normally exists from boot; make sure of it (a duplicate create is harmless).
  await ensureDockerNetwork(o.cmd, MIGRATION_NETWORK);
  try {
    await o.cmd.capture("docker", plan.args, { timeoutMs: l.wallClockMs, input: o.sql, env: plan.env });
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const timedOut = /timed out/i.test(err.message);
    if (timedOut) {
      // The client was killed; the container may live on. Stop it by name.
      await o.cmd.run("docker", ["kill", plan.containerName], { timeoutMs: 15_000 }).catch(() => {});
    }
    const detail = boundedRedacted(err.stderr?.trim() || err.message, l.outputBytes, secrets);
    throw new MigrationFailedError(timedOut ? `the migration ran past ${Math.round(l.wallClockMs / 1000)} s and was stopped` : `the migration failed: ${detail}`, timedOut ? "timed-out" : "failed");
  }
}

/** Parse the opaque role/database/port out of an app's credential URL (the host is replaced by the alias). */
export function targetFromPgUrl(pgUrl: string): MigrationTarget {
  const u = new URL(pgUrl);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    port: Number(u.port || 5432),
  };
}

/**
 * The runner every creator-supplied or generated SQL goes through: `(pgUrl, sql)` in, one sandboxed
 * container out. There is no fallback to running it on the host; with no sandbox the migration fails.
 */
export function sandboxedRunSql(cmd: CommandRunner, limits?: Partial<MigrationLimits>): (a: { pgUrl: string; sql: string }) => Promise<void> {
  return (a) => runSandboxedSql({ cmd, target: targetFromPgUrl(a.pgUrl), sql: a.sql, ...(limits ? { limits } : {}) });
}

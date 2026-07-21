#!/usr/bin/env node
/**
 * sample-user — the one supported demo-account provisioner.
 *
 * Thin HTTP wrapper around the Worker's `/api/dev/sample-user/*` admin
 * endpoints. As of W11 (2026-05-21), the laptop no longer needs
 * `HCLOUD_TOKEN` or an SSH key — the Worker handles ALL Hetzner
 * operations via cloud-init `user_data` (no SSH required). The only
 * remaining laptop secret is `FLAGSHIP_ADMIN_SECRET`; replacing that
 * with a YubiKey-signed envelope is tracked separately.
 *
 * Subcommands:
 *   create <username> --account-name "<name>" [--idempotency-key <key>]
 *   cleanup <username> [--idempotency-key <key>]
 *   list
 *   status <username>
 *   help
 *
 * Env:
 *   FLAGSHIP_ADMIN_SECRET   required for all subcommands (admin bearer).
 *   FLAGSHIP_BASE_URL       defaults to https://flagshipserver.com.
 *
 * `create` makes one idempotent request. The Worker owns identity issuance,
 * provider provisioning, and retries; this CLI only polls honest status.
 *
 * Exit codes:
 *   0  success
 *   1  generic failure (network, malformed args, partial-rollback)
 *   2  admin auth failure
 *   3  Worker upstream failure (5xx / Hetzner returned via the Worker)
 *   4  D1 conflict (real-account username clash)
 */

import { fileURLToPath } from "node:url";

/* ─────────────────────── arg parsing ────────────────────────────────── */

const SUBCOMMANDS = new Set([
  "create",
  "cleanup",
  "list",
  "status",
  "help",
]);

export function parseArgs(argv) {
  if (argv.length === 0) return { command: "help", username: null, flags: {} };
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    return { command: "help", username: null, flags: {} };
  }
  if (!SUBCOMMANDS.has(first)) {
    throw new Error(`unknown subcommand: ${first}`);
  }
  const command = first;
  const flags = {};
  if (command === "list" || command === "help") {
    if (argv.length > 1) throw new Error(`${command} takes no arguments`);
    return { command, username: null, flags: {} };
  }
  if (command === "status") {
    const u = argv[1];
    if (!u || u.startsWith("--")) {
      throw new Error(`${command} requires a <username>`);
    }
    if (argv.length > 2) throw new Error(`${command} takes only <username>`);
    return { command, username: u, flags: {} };
  }
  if (command === "cleanup") {
    const u = argv[1];
    if (!u || u.startsWith("--")) {
      throw new Error("cleanup requires a <username>");
    }
    let i = 2;
    while (i < argv.length) {
      const tok = argv[i];
      if (!tok.startsWith("--")) {
        throw new Error(`unexpected positional argument: ${tok}`);
      }
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`flag --${key} requires a value`);
      }
      if (key !== "idempotency-key") throw new Error(`unknown flag: --${key}`);
      flags.idempotencyKey = next;
      i += 2;
    }
    return { command, username: u, flags };
  }
  // `create` takes <username> + named flags.
  const u = argv[1];
  if (!u || u.startsWith("--")) {
    throw new Error("create requires a <username>");
  }
  const username = u;
  let i = 2;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${tok}`);
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`flag --${key} requires a value`);
    }
    if (key === "account-name") flags.accountName = next;
    else if (key === "idempotency-key") flags.idempotencyKey = next;
    else if (key === "region") flags.region = next;
    else if (key === "size") flags.size = next;
    else {
      throw new Error(`unknown flag: --${key}`);
    }
    i += 2;
  }
  if (!flags.accountName) throw new Error("create requires --account-name <name>");
  return { command, username, flags };
}

/* ─────────────────────── env + paths ────────────────────────────────── */

/**
 * Resolve env defaults + check the subset that's required for `command`.
 * Returns `{ env, missing }`; the caller maps `missing` to a fail-closed
 * exit + clear message. Pure (env is passed in explicitly).
 *
 * W11 CHANGE: HCLOUD_TOKEN and DEMO_SSH_KEY_PATH are NO LONGER read.
 * The Worker handles Hetzner end-to-end; the laptop only needs the
 * admin bearer.
 */
export function resolveEnv(command, processEnv) {
  const baseUrl = processEnv.FLAGSHIP_BASE_URL || "https://flagshipserver.com";
  const adminSecret = processEnv.FLAGSHIP_ADMIN_SECRET || null;
  const missing = [];
  if (!adminSecret) missing.push({ name: "FLAGSHIP_ADMIN_SECRET", code: 2 });
  return {
    env: { baseUrl, adminSecret },
    missing,
  };
}

/** Build the absolute admin URL for a path under the base. */
export function adminUrl(baseUrl, path) {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${b}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Map an HTTP error response to the right exit code. */
export function exitCodeForHttp(status) {
  if (status === 401 || status === 403) return 2;
  if (status === 409) return 4;
  if (status === 502 || status === 503 || status === 504) return 3;
  return 1;
}

/* ─────────────────────── fetch helpers (testable) ───────────────────── */

export async function adminFetch(fetchFn, url, init, adminSecret) {
  const headers = {
    ...(init?.headers || {}),
    "content-type": "application/json",
    // The Worker's authorizeAdmin (packages/control-plane/src/admin.ts)
    // reads `x-admin-secret`. Match the Worker contract exactly.
    "x-admin-secret": adminSecret,
  };
  const res = await fetchFn(url, { ...init, headers });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text.slice(0, 200) };
    }
  }
  return { status: res.status, json };
}

/* ─────────────────────── subcommand: list ───────────────────────────── */

export async function runList(deps) {
  const { fetchFn, env, stderr, stdout } = deps;
  stderr.write("[list] fetching demo users…\n");
  const r = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, "/api/dev/sample-user"),
    { method: "GET" },
    env.adminSecret,
  );
  if (r.status !== 200) {
    stderr.write(`[list] failed: HTTP ${r.status}\n`);
    return exitCodeForHttp(r.status);
  }
  stdout.write(JSON.stringify(r.json ?? {}) + "\n");
  return 0;
}

/* ─────────────────────── subcommand: status ─────────────────────────── */

export async function runStatus(deps, username) {
  const { fetchFn, env, stderr, stdout } = deps;
  stderr.write(`[status] fetching ${username}…\n`);
  const r = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, `/api/dev/sample-user/${encodeURIComponent(username)}`),
    { method: "GET" },
    env.adminSecret,
  );
  if (r.status === 404) {
    stderr.write(`[status] no such demo user: ${username}\n`);
    return 1;
  }
  if (r.status !== 200) {
    stderr.write(`[status] failed: HTTP ${r.status}\n`);
    return exitCodeForHttp(r.status);
  }
  stdout.write(JSON.stringify(r.json ?? {}) + "\n");
  return 0;
}

/* ─────────────────────── subcommand: cleanup ────────────────────────── */

export async function runCleanup(deps, username, flags = {}) {
  const { fetchFn, env, stderr, stdout } = deps;
  stderr.write(`[cleanup] resolving and tearing down ${username}…\n`);
  const r = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, "/api/dev/sample-user/cleanup"),
    { method: "POST", body: JSON.stringify({
      username,
      idempotencyKey: flags.idempotencyKey ?? `sample-user-create:${username}`,
    }) },
    env.adminSecret,
  );
  if (r.status !== 200) {
    stderr.write(`[cleanup] failed: HTTP ${r.status}\n`);
    return exitCodeForHttp(r.status);
  }
  stdout.write(JSON.stringify(r.json ?? {}) + "\n");
  return 0;
}

/* ─────────────────────── subcommand: create ─────────────────────────── */

/** One idempotent creation request followed by read-only status polling. */
export async function runCreate(deps, username, flags) {
  const { fetchFn, env, stderr, stdout, now } = deps;
  const accountName = flags.accountName;
  const idempotencyKey = flags.idempotencyKey ?? `sample-user-create:${username}`;
  const region = flags.region ?? "fsn1";
  const size = flags.size ?? "cpx11";
  stderr.write(`[create] starting at ${new Date(now()).toISOString()}\n`);
  stderr.write("[create] requesting atomic identity + provisioning…\n");
  const created = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, "/api/dev/sample-user/create"),
    {
      method: "POST",
      body: JSON.stringify({ username, accountName, idempotencyKey, region, size }),
    },
    env.adminSecret,
  );
  if (created.status !== 200 && created.status !== 202) {
    stderr.write(`[create] request failed: HTTP ${created.status} ${JSON.stringify(created.json)}\n`);
    return exitCodeForHttp(created.status);
  }
  stderr.write(`[create] Worker state=${created.json?.state ?? "?"}; polling…\n`);
  const timeoutMs = (deps.pollTimeoutMs ?? 30 * 60_000);
  const intervalMs = (deps.pollIntervalMs ?? 30_000);
  const pollResult = await deps.pollUntilReady({
    fetchFn,
    env,
    stderr,
    username,
    timeoutMs,
    intervalMs,
    now,
  });
  if (!pollResult.ready) {
    stderr.write(`[create] polling timed out: ${pollResult.reason}\n`);
    return 1;
  }
  stdout.write(
    JSON.stringify({
      username,
      ready: true,
      activeServerId: pollResult.activeServerId,
    }) + "\n",
  );
  return 0;
}

/**
 * Default polling implementation. Tests pass a stub; the live wiring
 * loops on GET /api/dev/sample-user/<u> until state is `ready`.
 */
export async function pollUntilReady({
  fetchFn,
  env,
  stderr,
  username,
  timeoutMs,
  intervalMs,
  now,
}) {
  const t0 = now();
  let last = 0;
  while (now() - t0 < timeoutMs) {
    const r = await adminFetch(
      fetchFn,
      adminUrl(env.baseUrl, `/api/dev/sample-user/${encodeURIComponent(username)}`),
      { method: "GET" },
      env.adminSecret,
    );
    if (r.status === 200) {
      const j = r.json ?? {};
      if (j.state === "ready") {
        return { ready: true, activeServerId: j.activeServerId };
      }
      if (j.state === "failed") {
        return { ready: false, reason: "Worker declared state=failed" };
      }
      // Heartbeat every 60s so the operator sees progress vs a frozen CLI.
      if (now() - last > 60_000) {
        stderr.write(
          `[create] ${Math.floor((now() - t0) / 1000)}s — state=${j.state} phase=${j.provisionPhase ?? "pending"}\n`,
        );
        last = now();
      }
    } else if (r.status >= 500) {
      stderr.write(`[create] poll got HTTP ${r.status}; retrying…\n`);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, intervalMs),
    );
  }
  return { ready: false, reason: `timed out after ${timeoutMs / 60_000} min` };
}

/* ─────────────────────── usage / help ───────────────────────────────── */

export const USAGE = [
  "sample-user — operator CLI for Flagship demo accounts",
  "",
  "USAGE:",
  "  node scripts/sample-user.mjs create <username> --account-name \"<name>\" [--idempotency-key <key>] [--region fsn1] [--size cpx11]",
  "  node scripts/sample-user.mjs cleanup <username> [--idempotency-key <key>]",
  "  node scripts/sample-user.mjs list",
  "  node scripts/sample-user.mjs status <username>",
  "",
  "ENV:",
  "  FLAGSHIP_ADMIN_SECRET   required for all subcommands (admin bearer)",
  "  FLAGSHIP_BASE_URL       default https://flagshipserver.com",
  "",
  "  As of W11, HCLOUD_TOKEN and DEMO_SSH_KEY_PATH are NO LONGER READ",
  "  by the CLI — the Worker handles all Hetzner operations via",
  "  cloud-init user_data (no SSH from the laptop).",
  "",
  "EXIT CODES:",
  "  0 success / 1 generic / 2 admin auth / 3 Worker upstream / 4 D1 conflict",
].join("\n");

/* ─────────────────────── main (testable) ────────────────────────────── */

export async function main(argv, deps) {
  const stderr = deps.stderr;
  const stdout = deps.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    stderr.write(USAGE + "\n");
    return 1;
  }
  if (parsed.command === "help") {
    stdout.write(USAGE + "\n");
    return 0;
  }
  const { env, missing } = resolveEnv(parsed.command, deps.processEnv);
  if (missing.length > 0) {
    for (const m of missing) {
      stderr.write(
        `fail-closed: env "${m.name}" is required for "${parsed.command}". Set it and re-run.\n`,
      );
    }
    return Math.max(...missing.map((m) => m.code));
  }
  const subDeps = { ...deps, env, stderr, stdout };
  switch (parsed.command) {
    case "list":
      return runList(subDeps);
    case "status":
      return runStatus(subDeps, parsed.username);
    case "cleanup":
      return runCleanup(subDeps, parsed.username, parsed.flags);
    case "create":
      return runCreate(subDeps, parsed.username, parsed.flags);
    default:
      stderr.write(`error: unhandled subcommand ${parsed.command}\n`);
      return 1;
  }
}

/* ─────────────────────── real-I/O wiring (not run in tests) ─────────── */

export function makeLiveDeps() {
  return {
    processEnv: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
    fetchFn: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    pollUntilReady,
  };
}

const entry = process.argv[1] ?? "";
const here = fileURLToPath(import.meta.url);
if (entry === here || entry.endsWith("/sample-user.mjs")) {
  const deps = makeLiveDeps();
  main(process.argv.slice(2), deps)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}

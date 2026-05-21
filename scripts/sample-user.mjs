#!/usr/bin/env node
/**
 * sample-user — W11 operator CLI.
 *
 * Thin HTTP wrapper around the Worker's `/api/dev/sample-user/*` admin
 * endpoints. As of W11 (2026-05-21), the laptop no longer needs
 * `HCLOUD_TOKEN` or an SSH key — the Worker handles ALL Hetzner
 * operations via cloud-init `user_data` (no SSH required). The only
 * remaining laptop secret is `FLAGSHIP_ADMIN_SECRET`; replacing that
 * with a YubiKey-signed envelope is tracked separately.
 *
 * Subcommands:
 *   create <username> --display "<name>" [--region fsn1] [--size cpx11] [--ttl-idle 30]
 *   delete <username>
 *   list
 *   status <username>
 *   grant-device <username> <label> --scopes <comma-list>
 *   help
 *
 * Env:
 *   FLAGSHIP_ADMIN_SECRET   required for all subcommands (admin bearer).
 *   FLAGSHIP_BASE_URL       defaults to https://flagshipserver.com.
 *
 * The W11 `create` flow is a 4-step orchestration over 3 admin
 * endpoints + a polling loop:
 *
 *   1. POST /api/dev/sample-user/create            (reserve D1 row)
 *   2. POST /api/dev/sample-user/admin-claim-and-issue
 *                                                   (mint AuthCode +
 *                                                    InstallBlob +
 *                                                    primary grant)
 *   3. POST /api/dev/sample-user/<u>/admin-snapshot-now
 *                                                   (Worker streams the
 *                                                    personalized ISO,
 *                                                    provisions the
 *                                                    Hetzner VPS with
 *                                                    cloud-init
 *                                                    user_data)
 *   4. Poll GET /api/dev/sample-user/<u> until state='none' AND
 *      snapshotId !== null (the cron snapshotted + destroyed the temp
 *      VPS).
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
  "delete",
  "list",
  "status",
  "grant-device",
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
  if (command === "delete" || command === "status") {
    const u = argv[1];
    if (!u || u.startsWith("--")) {
      throw new Error(`${command} requires a <username>`);
    }
    if (argv.length > 2) throw new Error(`${command} takes only <username>`);
    return { command, username: u, flags: {} };
  }
  if (command === "grant-device") {
    const u = argv[1];
    if (!u || u.startsWith("--")) {
      throw new Error("grant-device requires a <username>");
    }
    const label = argv[2];
    if (!label || label.startsWith("--")) {
      throw new Error("grant-device requires a <device-label>");
    }
    let i = 3;
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
      if (key === "scopes") {
        const list = next.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length === 0) {
          throw new Error("--scopes must be a non-empty comma-separated list");
        }
        flags.scopes = list;
      } else {
        throw new Error(`unknown flag: --${key}`);
      }
      i += 2;
    }
    if (!flags.scopes) {
      throw new Error("grant-device requires --scopes <comma-list>");
    }
    return { command, username: u, deviceLabel: label, flags };
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
    if (key === "display") flags.display = next;
    else if (key === "region") flags.region = next;
    else if (key === "size") flags.size = next;
    else if (key === "ttl-idle") {
      const n = parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("--ttl-idle must be a positive integer (minutes)");
      }
      flags.ttlIdleMinutes = n;
    } else {
      throw new Error(`unknown flag: --${key}`);
    }
    i += 2;
  }
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

/* ─────────────────────── subcommand: delete ─────────────────────────── */

export async function runDelete(deps, username) {
  const { fetchFn, env, stderr, stdout } = deps;
  stderr.write(`[delete] tearing down ${username}…\n`);
  const r = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, "/api/dev/sample-user/delete"),
    { method: "POST", body: JSON.stringify({ username }) },
    env.adminSecret,
  );
  if (r.status !== 200) {
    stderr.write(`[delete] failed: HTTP ${r.status}\n`);
    return exitCodeForHttp(r.status);
  }
  stdout.write(JSON.stringify(r.json ?? {}) + "\n");
  return 0;
}

/* ─────────────────────── subcommand: create (W11) ───────────────────── */

/**
 * W11 `create`. Four-step orchestration where the Worker does all the
 * heavy lifting — the laptop just sequences the admin POSTs and polls
 * for completion.
 *
 *   1. POST /api/dev/sample-user/create               (reserve row)
 *   2. POST /api/dev/sample-user/admin-claim-and-issue
 *                                                      (claim + mint)
 *   3. POST /api/dev/sample-user/<u>/admin-snapshot-now
 *                                                      (Worker
 *                                                       personalize+R2+
 *                                                       Hetzner)
 *   4. Poll GET /api/dev/sample-user/<u> until state=='none' AND
 *      snapshotId set (the cron finalized the snapshot + destroyed
 *      the temp VPS).
 *
 * Heavy DI for tests — every fetch + poll function is overridable.
 */
export async function runCreate(deps, username, flags) {
  const { fetchFn, env, stderr, stdout, now } = deps;
  const display = flags.display ?? username;
  const region = flags.region ?? "fsn1";
  const size = flags.size ?? "cpx11";
  const ttlIdleMinutes = flags.ttlIdleMinutes ?? 30;
  stderr.write(`[create] starting at ${new Date(now()).toISOString()}\n`);

  // 1. Reserve / re-attach the D1 row.
  stderr.write("[create] reserving D1 row…\n");
  const reserve = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, "/api/dev/sample-user/create"),
    {
      method: "POST",
      body: JSON.stringify({ username, display, region, size, ttlIdleMinutes }),
    },
    env.adminSecret,
  );
  if (reserve.status === 200 && reserve.json?.reused) {
    stderr.write(
      `[create] row already exists for ${username}; re-running flow\n`,
    );
  } else if (reserve.status !== 200) {
    stderr.write(
      `[create] reserve failed: HTTP ${reserve.status} ${JSON.stringify(reserve.json)}\n`,
    );
    return exitCodeForHttp(reserve.status);
  } else {
    stderr.write("[create] row inserted (state=none)\n");
  }

  // 2. Claim username + mint AuthCode + InstallBlob.
  stderr.write("[create] claiming + issuing real install ticket via .com…\n");
  const issued = await adminFetch(
    fetchFn,
    adminUrl(env.baseUrl, "/api/dev/sample-user/admin-claim-and-issue"),
    {
      method: "POST",
      body: JSON.stringify({ username, serverName: "home" }),
    },
    env.adminSecret,
  );
  if (issued.status !== 200) {
    stderr.write(
      `[create] admin-claim-and-issue failed: HTTP ${issued.status} ${JSON.stringify(issued.json)}\n`,
    );
    return exitCodeForHttp(issued.status);
  }
  stderr.write(
    `[create] ticket minted (code=${typeof issued.json?.code === "string" ? issued.json.code : "?"})\n`,
  );

  // 3. Kick off Worker-side provisioning (cloud-init user_data; no
  //    laptop SSH; no laptop HCLOUD_TOKEN).
  stderr.write(
    "[create] kicking off Worker-side provisioning (admin-snapshot-now)…\n",
  );
  const provision = await adminFetch(
    fetchFn,
    adminUrl(
      env.baseUrl,
      `/api/dev/sample-user/${encodeURIComponent(username)}/admin-snapshot-now`,
    ),
    { method: "POST", body: JSON.stringify({ region, size }) },
    env.adminSecret,
  );
  if (provision.status !== 200 && provision.status !== 202) {
    stderr.write(
      `[create] admin-snapshot-now failed: HTTP ${provision.status} ${JSON.stringify(provision.json)}\n`,
    );
    return exitCodeForHttp(provision.status);
  }
  stderr.write(
    `[create] Worker accepted provisioning request (state=${provision.json?.state ?? "?"}; activeServerId=${provision.json?.activeServerId ?? "?"})\n`,
  );

  // 4. Poll until the cron finalizes (state=none + snapshotId set).
  //    Default 30-minute timeout — Alpine boot + LUKS + register + ACME
  //    + snapshot create can run 15-20 min in the worst case.
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
      snapshotId: pollResult.snapshotId,
      isoR2Key: pollResult.isoR2Key,
    }) + "\n",
  );
  return 0;
}

/**
 * Default polling implementation. Tests pass a stub; the live wiring
 * loops on GET /api/dev/sample-user/<u> until state matches "ready"
 * (state=none with snapshotId set) OR the timeout fires.
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
      if (j.state === "none" && j.snapshotId) {
        return { ready: true, snapshotId: j.snapshotId, isoR2Key: j.isoR2Key };
      }
      if (j.state === "failed") {
        return { ready: false, reason: "Worker declared state=failed" };
      }
      // Heartbeat every 60s so the operator sees progress vs a frozen CLI.
      if (now() - last > 60_000) {
        stderr.write(
          `[create] ${Math.floor((now() - t0) / 1000)}s — state=${j.state} snapshotId=${j.snapshotId ?? "null"}\n`,
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

/* ─────────────────────── subcommand: grant-device ───────────────────── */

export async function runGrantDevice(deps, username, deviceLabel, scopes) {
  const { fetchFn, env, stderr, stdout } = deps;
  stderr.write(
    `[grant-device] minting grant for ${username}.${deviceLabel} (scopes: ${scopes.join(",")})…\n`,
  );
  const r = await adminFetch(
    fetchFn,
    adminUrl(
      env.baseUrl,
      `/api/dev/sample-user/${encodeURIComponent(username)}/admin-mint-device-grant`,
    ),
    {
      method: "POST",
      body: JSON.stringify({ deviceLabel, scopes }),
    },
    env.adminSecret,
  );
  if (r.status !== 200) {
    const errMsg =
      typeof r.json?.error === "string" ? r.json.error : `HTTP ${r.status}`;
    stderr.write(`[grant-device] failed: ${errMsg}\n`);
    return exitCodeForHttp(r.status);
  }
  stdout.write(JSON.stringify(r.json ?? {}) + "\n");
  stderr.write(
    `[grant-device] Granted ${deviceLabel} device with scopes: ${scopes.join(", ")}\n`,
  );
  return 0;
}

/* ─────────────────────── usage / help ───────────────────────────────── */

export const USAGE = [
  "sample-user — operator CLI for Flagship demo users (W11)",
  "",
  "USAGE:",
  "  node scripts/sample-user.mjs create <username> --display \"<name>\" [--region fsn1] [--size cpx11] [--ttl-idle 30]",
  "  node scripts/sample-user.mjs delete <username>",
  "  node scripts/sample-user.mjs list",
  "  node scripts/sample-user.mjs status <username>",
  "  node scripts/sample-user.mjs grant-device <username> <device-label> --scopes <comma-list>",
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
    case "delete":
      return runDelete(subDeps, parsed.username);
    case "create":
      return runCreate(subDeps, parsed.username, parsed.flags);
    case "grant-device":
      return runGrantDevice(
        subDeps,
        parsed.username,
        parsed.deviceLabel,
        parsed.flags.scopes,
      );
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

#!/usr/bin/env node
/**
 * sample-user — Plan-A Phase E operator CLI.
 *
 * Wraps the Worker's `/api/dev/sample-user/*` admin endpoints and
 * drives the operator-side ISO build, R2 upload, rescue-mode-dd
 * initial install, and Hetzner snapshot creation. See
 * `docs/sample-user-vps-plan.md` Phase E + `docs/sample-users.md` §14
 * + Appendix C for the full contract.
 *
 * Subcommands:
 *   create <username> --display "<name>" [--region fsn1] [--size cx22] [--ttl-idle 30]
 *   delete <username>
 *   list
 *   status <username>
 *   help
 *
 * Env (per §14.1):
 *   - HCLOUD_TOKEN          (required for create/delete — touches Hetzner)
 *   - FLAGSHIP_ADMIN_SECRET (required for all subcommands — admin bearer)
 *   - FLAGSHIP_BASE_URL     (default: https://flagshipserver.com)
 *   - DEMO_SSH_KEY_PATH     (default: ~/.ssh/flagship-demo-ssh)
 *
 * Exit codes (per §14.2):
 *   0  success
 *   1  generic failure (network, malformed args, partial-rollback)
 *   2  admin auth failure
 *   3  Hetzner API failure
 *   4  D1 conflict (real-account username clash)
 *
 * Output: per-step lines on stderr (`[create] uploading ISO…`); final
 * machine-readable JSON line on stdout.
 *
 * Pure helpers (parseArgs, env validation, URL builders, the orchestrator
 * factory) are exported and unit-tested in `scripts/sample-user.test.ts`.
 * The real-I/O wiring at the bottom only runs when this file is invoked
 * as the entry point.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/* ─────────────────────── arg parsing ────────────────────────────────── */

const SUBCOMMANDS = new Set(["create", "delete", "list", "status", "help"]);

/**
 * Pure arg parser. Throws on malformed input. Returns:
 *   { command, username?, flags: { display?, region?, size?, ttlIdleMinutes? } }
 */
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
  // `list` + `help` take no positional, no flags.
  if (command === "list" || command === "help") {
    if (argv.length > 1) throw new Error(`${command} takes no arguments`);
    return { command, username: null, flags: {} };
  }
  // `delete`/`status` take ONE positional: the username.
  if (command === "delete" || command === "status") {
    const u = argv[1];
    if (!u || u.startsWith("--")) {
      throw new Error(`${command} requires a <username>`);
    }
    if (argv.length > 2) throw new Error(`${command} takes only <username>`);
    return { command, username: u, flags: {} };
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
 */
export function resolveEnv(command, processEnv) {
  const baseUrl = processEnv.FLAGSHIP_BASE_URL || "https://flagshipserver.com";
  const adminSecret = processEnv.FLAGSHIP_ADMIN_SECRET || null;
  const hcloudToken = processEnv.HCLOUD_TOKEN || null;
  const sshKeyPath =
    processEnv.DEMO_SSH_KEY_PATH || join(processEnv.HOME || "/", ".ssh/flagship-demo-ssh");
  const missing = [];
  // All subcommands need admin auth (the live admin endpoints are bearer-gated).
  if (!adminSecret) missing.push({ name: "FLAGSHIP_ADMIN_SECRET", code: 2 });
  // Only Hetzner-touching subcommands need HCLOUD_TOKEN.
  if ((command === "create" || command === "delete") && !hcloudToken) {
    missing.push({ name: "HCLOUD_TOKEN", code: 3 });
  }
  return {
    env: { baseUrl, adminSecret, hcloudToken, sshKeyPath },
    missing,
  };
}

/** Build the absolute admin URL for a path under the base. */
export function adminUrl(baseUrl, path) {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${b}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Map an HTTP error response to the right exit code per §14.2. */
export function exitCodeForHttp(status) {
  if (status === 401 || status === 403) return 2;
  if (status === 409) return 4;
  if (status === 502 || status === 503 || status === 504) return 3;
  return 1;
}

/* ─────────────────────── fetch helpers (testable) ───────────────────── */

/**
 * Thin wrapper around `fetch` that adds the admin bearer + content-type
 * and reads the JSON body. Returns `{ status, json }`. Never throws on
 * 4xx/5xx — the caller decides how to react.
 */
export async function adminFetch(fetchFn, url, init, adminSecret) {
  const headers = {
    ...(init?.headers || {}),
    "content-type": "application/json",
    // The Worker's authorizeAdmin (packages/control-plane/src/admin.ts)
    // reads `x-admin-secret` — NOT `authorization: Bearer`. Match the
    // Worker contract exactly.
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

/* ─────────────────────── ISO build / sha8 ───────────────────────────── */

/**
 * Compute the 8-hex-char content sha used in the R2 object key. Pure;
 * uses `node:crypto`. The caller passes the file path; this helper
 * streams the bytes so a 600 MB ISO never lands in memory.
 */
export async function isoSha8(path, createHashFn) {
  // Lazy import keeps the test surface clean.
  const { createReadStream } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const hash = (createHashFn ?? createHash)("sha256");
  await new Promise((res, rej) => {
    const s = createReadStream(path);
    s.on("data", (c) => hash.update(c));
    s.on("error", rej);
    s.on("end", res);
  });
  return hash.digest("hex").slice(0, 8);
}

/** R2 object key per §5.1: `demo-isos/<username>-<sha8>.iso`. */
export function r2KeyFor(username, sha8) {
  return `demo-isos/${username}-${sha8}.iso`;
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

/* ─────────────────────── subcommand: create ─────────────────────────── */

/**
 * Orchestrator for `create`. Heavily dependency-injected so the test
 * suite can drive every step without touching Hetzner / R2 / disk.
 *
 * deps shape:
 *   - fetchFn(url, init)                   → admin endpoint calls
 *   - env { baseUrl, adminSecret, hcloudToken, sshKeyPath }
 *   - stderr / stdout                      → output streams
 *   - now()                                → for log timestamps
 *   - buildIso({ username, serverName })   → { isoPath } (real-I/O step)
 *   - uploadIso({ isoPath, key })          → { presignedUrl } (R2 upload)
 *   - provisionTempVps({ presignedUrl, ... }) → { serverId, ipv4 }
 *   - awaitDaemonReady({ serverId, fqdn }) → resolves when ACME green
 *   - snapshot({ serverId, description })  → { snapshotId }
 *   - destroyVps(serverId)                 → idempotent teardown
 *   - sha8For(isoPath)                     → 8-hex string
 *
 * The orchestrator never calls Hetzner / R2 / wrangler / ssh / dd
 * itself — it only sequences the steps the caller injects. That's what
 * makes the test suite work without real cloud creds.
 */
export async function runCreate(deps, username, flags) {
  const { fetchFn, env, stderr, stdout, now } = deps;
  const display = flags.display ?? username;
  const region = flags.region ?? "fsn1";
  const size = flags.size ?? "cx22";
  const ttlIdleMinutes = flags.ttlIdleMinutes ?? 30;
  stderr.write(`[create] starting at ${new Date(now()).toISOString()}\n`);

  // 1. POST /api/dev/sample-user/create — reserve the row + username.
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
      `[create] row already exists for ${username}; re-running snapshot flow\n`,
    );
  } else if (reserve.status !== 200) {
    stderr.write(
      `[create] reserve failed: HTTP ${reserve.status} ${JSON.stringify(reserve.json)}\n`,
    );
    return exitCodeForHttp(reserve.status);
  } else {
    stderr.write("[create] row inserted (state=none)\n");
  }

  // 2. Build the personalized ISO locally.
  stderr.write("[create] building personalized ISO…\n");
  const { isoPath } = await deps.buildIso({ username, serverName: "home" });
  const sha8 = await deps.sha8For(isoPath);
  const key = r2KeyFor(username, sha8);
  stderr.write(`[create] ISO sha8=${sha8}; key=${key}\n`);

  // 3. Upload to R2 + mint a 1h presigned URL for the rescue VPS.
  stderr.write(`[create] uploading ISO to r2://${key}…\n`);
  const { presignedUrl } = await deps.uploadIso({ isoPath, key });

  // 4. Provision temp VPS + rescue+dd. Track the serverId so we can
  //    guarantee destruction in `finally` even on a mid-stream failure.
  let serverId = null;
  let snapshotId = null;
  try {
    stderr.write(`[create] provisioning temp Hetzner ${size} in ${region}…\n`);
    const prov = await deps.provisionTempVps({
      presignedUrl,
      region,
      size,
      label: `flagship-demo-${username}`,
    });
    serverId = prov.serverId;
    stderr.write(`[create] temp server id=${serverId}; awaiting daemon + ACME…\n`);

    const fqdn = `home.${username}.flagship.services`;
    await deps.awaitDaemonReady({ serverId, fqdn });
    stderr.write("[create] daemon registered + green padlock\n");

    stderr.write("[create] snapshotting…\n");
    const snap = await deps.snapshot({
      serverId,
      description: `flagship-demo-${username}`,
    });
    snapshotId = snap.snapshotId;
    stderr.write(`[create] snapshot id=${snapshotId} (available)\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderr.write(`[create] FAILED: ${msg}\n`);
    if (serverId) {
      stderr.write(`[create] rollback: destroying temp server ${serverId}\n`);
      try {
        await deps.destroyVps(serverId);
      } catch (e2) {
        stderr.write(
          `[create] rollback destroy ALSO failed: ${e2 instanceof Error ? e2.message : String(e2)}\n`,
        );
        return 1;
      }
    }
    // Hetzner step failed cleanly → exit 3 (per §14.2).
    return 3;
  }

  // 5. Destroy the temp server (snapshot is the artifact we keep).
  stderr.write(`[create] destroying temp server ${serverId}\n`);
  try {
    await deps.destroyVps(serverId);
  } catch (e) {
    stderr.write(
      `[create] WARN: temp server destroy failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    // Don't abort — the snapshot exists; the operator can `hcloud
    // server delete` manually. Continue to persist the snapshot id
    // so the demo user is at least usable.
  }

  // 6. POST /install-complete — persist snapshot_id + iso_r2_key.
  stderr.write("[create] persisting snapshot_id via /install-complete\n");
  const persist = await adminFetch(
    fetchFn,
    adminUrl(
      env.baseUrl,
      `/api/dev/sample-user/${encodeURIComponent(username)}/install-complete`,
    ),
    {
      method: "POST",
      body: JSON.stringify({ snapshot_id: snapshotId, iso_r2_key: key }),
    },
    env.adminSecret,
  );
  if (persist.status !== 200) {
    stderr.write(
      `[create] WARN: install-complete failed: HTTP ${persist.status} ${JSON.stringify(persist.json)}\n`,
    );
    // The snapshot exists but isn't recorded; the operator can re-run
    // `create` and the idempotent check will short-circuit at step 1.
    return exitCodeForHttp(persist.status);
  }

  // Final machine-readable line for piping.
  stdout.write(
    JSON.stringify({ username, ready: true, snapshotId, isoR2Key: key }) + "\n",
  );
  return 0;
}

/* ─────────────────────── usage / help ───────────────────────────────── */

export const USAGE = [
  "sample-user — operator CLI for Flagship demo users (Plan A Phase E)",
  "",
  "USAGE:",
  "  node scripts/sample-user.mjs create <username> --display \"<name>\" [--region fsn1] [--size cx22] [--ttl-idle 30]",
  "  node scripts/sample-user.mjs delete <username>",
  "  node scripts/sample-user.mjs list",
  "  node scripts/sample-user.mjs status <username>",
  "",
  "ENV:",
  "  HCLOUD_TOKEN          required for create/delete (touches Hetzner)",
  "  FLAGSHIP_ADMIN_SECRET required for all subcommands (admin bearer)",
  "  FLAGSHIP_BASE_URL     default https://flagshipserver.com",
  "  DEMO_SSH_KEY_PATH     default ~/.ssh/flagship-demo-ssh",
  "",
  "EXIT CODES:",
  "  0 success / 1 generic / 2 admin auth / 3 Hetzner / 4 D1 conflict",
].join("\n");

/* ─────────────────────── main (testable) ────────────────────────────── */

/**
 * Pure-ish entry point: pass argv + processEnv + DI shims; returns the
 * exit code. The real-I/O wiring lives below in the if-main block.
 */
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
    // --help is informational: print to stdout, exit 0, NO env checks.
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
    // Worst (highest-priority) code wins: 3 > 2.
    return Math.max(...missing.map((m) => m.code));
  }
  const subDeps = {
    ...deps,
    env,
    stderr,
    stdout,
  };
  switch (parsed.command) {
    case "list":
      return runList(subDeps);
    case "status":
      return runStatus(subDeps, parsed.username);
    case "delete":
      return runDelete(subDeps, parsed.username);
    case "create":
      return runCreate(subDeps, parsed.username, parsed.flags);
    default:
      stderr.write(`error: unhandled subcommand ${parsed.command}\n`);
      return 1;
  }
}

/* ─────────────────────── real-I/O wiring (not run in tests) ─────────── */

/**
 * Construct the live deps used when this file is invoked as the
 * entry-point. Each step shells out to existing tooling (the Phase A
 * harness + the iso-personalizer CLI + wrangler) so this CLI stays a
 * thin orchestrator.
 */
export function makeLiveDeps(env) {
  return {
    processEnv: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
    // Use the global fetch (Node 18+ ships it natively). All admin
    // endpoint calls (create / install-complete / delete / list /
    // status) flow through adminFetch + this fetchFn.
    fetchFn: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sha8For: (p) => isoSha8(p),
    buildIso: async ({ username, serverName }) => {
      const here = dirname(fileURLToPath(import.meta.url));
      const cli = resolve(
        here,
        "..",
        "packages",
        "iso-personalizer",
        "bin",
        "personalize-iso.mjs",
      );
      const baseIso = resolve(
        here,
        "..",
        "apps",
        "web",
        "public",
        "build",
        "iso",
        "flagship-base-alpine-3.21.0-x86_64.iso",
      );
      if (!existsSync(baseIso)) {
        // Auto-fetch the base ISO from .com (one-time bootstrap; ~600 MB).
        // The ISO is served by the Worker out of the `flagship-iso` R2
        // bucket; SHA256 is recorded in apps/com/wrangler.toml as
        // BASE_ISO_SHA256 (same file, same bytes; we verify after
        // download).
        const url = process.env.FLAGSHIP_BASE_ISO_URL ||
          "https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso";
        const expectedSha = process.env.FLAGSHIP_BASE_ISO_SHA256 ||
          "faafc1b9f868c47c99733c2c6d453e8202d93f9b36df6d6b653eb774914736b2";
        process.stderr.write(`[create] base ISO not present — fetching ${url}…\n`);
        const { mkdirSync, createWriteStream } = await import("node:fs");
        const { pipeline } = await import("node:stream/promises");
        const { Readable } = await import("node:stream");
        mkdirSync(dirname(baseIso), { recursive: true });
        const res = await fetch(url);
        if (!res.ok || !res.body) {
          throw new Error(`base ISO download failed: HTTP ${res.status}`);
        }
        const tmp = baseIso + ".part";
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
        // Verify sha256 BEFORE renaming into place so a corrupted/partial
        // download never gets cached.
        const { createHash } = await import("node:crypto");
        const { createReadStream, renameSync, unlinkSync } = await import("node:fs");
        const h = createHash("sha256");
        await pipeline(createReadStream(tmp), h);
        const got = h.digest("hex");
        if (got !== expectedSha) {
          unlinkSync(tmp);
          throw new Error(
            `base ISO sha256 mismatch: expected ${expectedSha}, got ${got}`,
          );
        }
        renameSync(tmp, baseIso);
        process.stderr.write(`[create] base ISO cached at ${baseIso}\n`);
      }
      const workDir = mkdtempSync(join(tmpdir(), `flagship-demo-${username}-`));
      const outIso = join(workDir, `flagship-demo-${username}.iso`);
      await runChild("node", [
        cli,
        "--base-iso",
        baseIso,
        "--output",
        outIso,
        "--username",
        username,
        "--server-name",
        serverName,
      ]);
      return { isoPath: outIso };
    },
    uploadIso: async ({ isoPath, key }) => {
      const bucket = "flagship-iso-temp";
      await runChild("npx", [
        "wrangler",
        "r2",
        "object",
        "put",
        `${bucket}/${key}`,
        "--file",
        isoPath,
        "--remote",
      ]);
      // Wrangler 4.x does NOT ship an `r2 object presign` subcommand
      // (only get/put/delete on r2 object; presign is only available
      // via the S3 API + R2 access keys, which would need extra setup).
      // Cheapest path: enable public dev-url on the bucket
      // (`wrangler r2 bucket dev-url enable flagship-iso-temp`) and
      // construct the URL ourselves. Bucket has zero PII in it (only
      // ephemeral install ISOs we delete on teardown), so dev-url is
      // acceptable; the ISO objects sit there for ≤1h between upload
      // and rescue-VPS wget.
      const base =
        process.env.FLAGSHIP_R2_TEMP_PUBLIC_BASE ||
        "https://pub-260717b8631044a0bcee80ce0de8f7f9.r2.dev";
      const url = `${base.replace(/\/+$/, "")}/${key}`;
      return { presignedUrl: url };
    },
    // Live wiring of the three Hetzner steps. Built once per CLI
    // invocation and lazily cached so the test path (which stubs
    // these out entirely via deps overrides) doesn't pay the import
    // cost.
    provisionTempVps: makeLiveProvisionTempVps(env),
    awaitDaemonReady: makeLiveAwaitDaemonReady(env),
    snapshot: makeLiveSnapshot(env),
    destroyVps: makeLiveDestroyVps(env),
    env,
  };
}

/**
 * Lazy-build a HetznerProvider on first use. The harness's compiled
 * dist is co-located at tools/vps-e2e/dist/providers/hetzner.js. We
 * import once, cache, and reuse.
 *
 * The provider needs the local SSH key on disk (path passed into the
 * constructor) AND a Hetzner-side SSH key id (uploaded idempotently
 * via `ensureSshKey`). The first create-sample-user run produces the
 * numeric id; subsequent runs reuse it via cache.
 */
let _cachedProvider = null;
async function getHetznerProvider(env) {
  if (_cachedProvider) return _cachedProvider;
  const { readFileSync } = await import("node:fs");
  // resolveEnv emits sshKeyPath (resolved from $DEMO_SSH_KEY_PATH or
  // defaulted to $HOME/.ssh/flagship-demo-ssh).
  const sshKeyPath = env.sshKeyPath;
  const pubKeyPath = `${sshKeyPath}.pub`;
  if (!existsSync(sshKeyPath) || !existsSync(pubKeyPath)) {
    throw new Error(
      `SSH key pair not found at ${sshKeyPath}{,.pub} — generate with: ` +
        `ssh-keygen -t ed25519 -f ${sshKeyPath} -N "" -C "flagship-demo"`,
    );
  }
  const pubKey = readFileSync(pubKeyPath, "utf8");
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled by Phase A's tsc -b; if it's missing we tell the operator
  // exactly how to fix it.
  const providerModulePath = resolve(
    here,
    "..",
    "tools",
    "vps-e2e",
    "dist",
    "providers",
    "hetzner.js",
  );
  if (!existsSync(providerModulePath)) {
    throw new Error(
      `tools/vps-e2e/dist not built — run \`npx tsc -b tools/vps-e2e\` first`,
    );
  }
  const { HetznerProvider } = await import(providerModulePath);
  const provider = new HetznerProvider({
    token: env.hcloudToken,
    sshKeyPath,
  });
  await provider.ensureSshKey(pubKey);
  _cachedProvider = provider;
  return provider;
}

function makeLiveProvisionTempVps(env) {
  return async ({ presignedUrl, region, size, label }) => {
    const provider = await getHetznerProvider(env);
    const instance = await provider.provision({
      iso: presignedUrl,
      region,
      size,
      label,
    });
    // Wait for the dd-reboot cycle to complete — the box reboots once
    // into the freshly-written disk, then `install.sh` runs.
    await provider.awaitBoot(instance.id);
    return { serverId: instance.id, ipv4: instance.ip };
  };
}

/**
 * Poll the live .com for daemon registration. The daemon registers
 * itself in `install_events` after a successful first boot; we poll
 * `/api/install-events/<fqdn>` and treat any `registered` event after
 * `since` as success.
 *
 * Timeout: 12 minutes (Alpine boot + LUKS + register + ACME).
 */
function makeLiveAwaitDaemonReady(env) {
  return async ({ serverId, fqdn }) => {
    const since = Date.now();
    const url = `${env.baseUrl}/api/install-events/${encodeURIComponent(fqdn)}`;
    const deadline = since + 12 * 60_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${env.adminSecret}` },
        });
        if (res.ok) {
          const j = await res.json();
          const events = Array.isArray(j?.events) ? j.events : [];
          const registered = events.find(
            (e) => e?.event === "registered" && Number(e?.timestamp) >= since,
          );
          if (registered) {
            // Also probe the green padlock — confirms ACME finished.
            try {
              const probe = await fetch(`https://${fqdn}/`, {
                method: "HEAD",
                redirect: "manual",
              });
              if (probe.status > 0) return;
            } catch {
              // ACME may not be ready yet; loop.
            }
          }
        }
      } catch {
        // Transient .com / DNS failures; loop.
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(
      `daemon at ${fqdn} did not register + serve TLS within 12 minutes (serverId=${serverId})`,
    );
  };
}

function makeLiveSnapshot(env) {
  return async ({ serverId, description }) => {
    const provider = await getHetznerProvider(env);
    const { snapshotId } = await provider.snapshot(serverId, description);
    return { snapshotId };
  };
}

function makeLiveDestroyVps(env) {
  return async ({ serverId }) => {
    const provider = await getHetznerProvider(env);
    await provider.destroy(serverId);
  };
}

function runChild(cmd, args, { capture = false } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (c) => (stdout += c.toString("utf8")));
      child.stderr?.on("data", (c) => (stderr += c.toString("utf8")));
    }
    child.on("error", rej);
    child.on("exit", (code) => {
      if (code === 0) res({ stdout, stderr });
      else rej(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.slice(0, 240)}`));
    });
  });
}

// `if-main` guard so importing this module from the test file is a
// pure import (no process.exit, no side effects).
const entry = process.argv[1] ?? "";
const here = fileURLToPath(import.meta.url);
if (entry === here || entry.endsWith("/sample-user.mjs")) {
  // Defer the env-shaped deps to main(); we build live deps with a
  // best-effort env so --help / arg errors STILL work without secrets.
  const { env } = resolveEnv("help", process.env);
  const deps = {
    ...makeLiveDeps(env),
    processEnv: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
  };
  main(process.argv.slice(2), deps)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}

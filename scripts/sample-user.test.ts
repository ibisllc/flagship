/**
 * Pure-logic tests for scripts/sample-user.mjs (Plan A Phase E). The
 * real Hetzner / R2 / wrangler shell-outs are NOT exercised; the arg
 * parser, env-validation, URL builders, and the dependency-injected
 * orchestrator (with stubbed `fetch` + stubbed step deps) ARE.
 *
 * The orchestrator tests cover the explicit acceptance points from
 * `docs/sample-user-vps-plan.md` Phase E:
 *
 *   - `--help` works without env vars (parser-only).
 *   - `create` with missing FLAGSHIP_ADMIN_SECRET → exit 2.
 *   - `create` with missing HCLOUD_TOKEN → exit 3.
 *   - happy-path `create` orchestrates the 6 steps in order + posts
 *     the final `/install-complete` with `snapshot_id` + `iso_r2_key`.
 *   - partial-failure rollback: if the snapshot step fails, the temp
 *     VPS is destroyed AND the CLI prints a clean error AND exit 3.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — .mjs sibling, no types
import {
  parseArgs,
  resolveEnv,
  adminUrl,
  exitCodeForHttp,
  r2KeyFor,
  USAGE,
  runCreate,
  runList,
  runStatus,
  runDelete,
  runGrantDevice,
  main,
} from "./sample-user.mjs";

/* ─────────────────────── arg parser ──────────────────────────────────── */

describe("parseArgs", () => {
  it("returns help for empty argv and for --help / -h", () => {
    expect(parseArgs([])).toEqual({ command: "help", username: null, flags: {} });
    expect(parseArgs(["--help"])).toEqual({ command: "help", username: null, flags: {} });
    expect(parseArgs(["-h"])).toEqual({ command: "help", username: null, flags: {} });
    expect(parseArgs(["help"])).toEqual({ command: "help", username: null, flags: {} });
  });
  it("parses `list` with no positional or flags", () => {
    expect(parseArgs(["list"])).toEqual({ command: "list", username: null, flags: {} });
    expect(() => parseArgs(["list", "extra"])).toThrow(/takes no arguments/);
  });
  it("parses `delete <user>` and `status <user>`", () => {
    expect(parseArgs(["delete", "demo-alice"]).command).toBe("delete");
    expect(parseArgs(["delete", "demo-alice"]).username).toBe("demo-alice");
    expect(parseArgs(["status", "demo-alice"]).username).toBe("demo-alice");
    expect(() => parseArgs(["delete"])).toThrow(/requires a <username>/);
    expect(() => parseArgs(["status"])).toThrow(/requires a <username>/);
  });
  it("parses `create <user> --display … --region … --size … --ttl-idle …`", () => {
    const a = parseArgs([
      "create",
      "demo-alice",
      "--display",
      "Demo Alice",
      "--region",
      "fsn1",
      "--size",
      "cpx11",
      "--ttl-idle",
      "30",
    ]);
    expect(a.command).toBe("create");
    expect(a.username).toBe("demo-alice");
    expect(a.flags.display).toBe("Demo Alice");
    expect(a.flags.region).toBe("fsn1");
    expect(a.flags.size).toBe("cpx11");
    expect(a.flags.ttlIdleMinutes).toBe(30);
  });
  it("rejects malformed args deterministically", () => {
    expect(() => parseArgs(["unknown"])).toThrow(/unknown subcommand/);
    expect(() => parseArgs(["create"])).toThrow(/requires a <username>/);
    expect(() => parseArgs(["create", "u", "--display"])).toThrow(
      /requires a value/,
    );
    expect(() => parseArgs(["create", "u", "--frobnicate", "y"])).toThrow(
      /unknown flag/,
    );
    expect(() => parseArgs(["create", "u", "--ttl-idle", "0"])).toThrow(
      /positive integer/,
    );
  });
  it("parses `grant-device <user> <label> --scopes a,b,c`", () => {
    const a = parseArgs([
      "grant-device",
      "demo-alice",
      "reviewer",
      "--scopes",
      "browse",
    ]);
    expect(a.command).toBe("grant-device");
    expect(a.username).toBe("demo-alice");
    expect(a.deviceLabel).toBe("reviewer");
    expect(a.flags.scopes).toEqual(["browse"]);

    const b = parseArgs([
      "grant-device",
      "demo-alice",
      "work-laptop",
      "--scopes",
      "browse,install-service,vibe-code",
    ]);
    expect(b.flags.scopes).toEqual([
      "browse",
      "install-service",
      "vibe-code",
    ]);
  });
  it("`grant-device` trims whitespace and rejects empty / missing --scopes", () => {
    const a = parseArgs([
      "grant-device",
      "demo-alice",
      "reviewer",
      "--scopes",
      " browse , install-service ",
    ]);
    expect(a.flags.scopes).toEqual(["browse", "install-service"]);

    expect(() => parseArgs(["grant-device"])).toThrow(/requires a <username>/);
    expect(() => parseArgs(["grant-device", "demo-alice"])).toThrow(
      /requires a <device-label>/,
    );
    expect(() =>
      parseArgs(["grant-device", "demo-alice", "reviewer"]),
    ).toThrow(/requires --scopes/);
    expect(() =>
      parseArgs([
        "grant-device",
        "demo-alice",
        "reviewer",
        "--scopes",
        ",,",
      ]),
    ).toThrow(/non-empty comma-separated list/);
    expect(() =>
      parseArgs([
        "grant-device",
        "demo-alice",
        "reviewer",
        "--unknown",
        "x",
      ]),
    ).toThrow(/unknown flag/);
  });
});

/* ─────────────────────── env resolution ──────────────────────────────── */

describe("resolveEnv", () => {
  it("defaults FLAGSHIP_BASE_URL + DEMO_SSH_KEY_PATH", () => {
    const { env, missing } = resolveEnv("help", {
      FLAGSHIP_ADMIN_SECRET: "sek",
      HOME: "/Users/op",
    });
    expect(env.baseUrl).toBe("https://flagshipserver.com");
    expect(env.sshKeyPath).toBe("/Users/op/.ssh/flagship-demo-ssh");
    expect(missing).toEqual([]);
  });
  it("requires FLAGSHIP_ADMIN_SECRET for every subcommand → exit 2", () => {
    const r = resolveEnv("list", {});
    expect(r.missing.map((m: { name: string }) => m.name)).toContain(
      "FLAGSHIP_ADMIN_SECRET",
    );
    expect(r.missing[0].code).toBe(2);
  });
  it("requires HCLOUD_TOKEN for create/delete → exit 3 (not for list/status)", () => {
    const create = resolveEnv("create", { FLAGSHIP_ADMIN_SECRET: "x" });
    expect(create.missing.map((m: { name: string }) => m.name)).toEqual([
      "HCLOUD_TOKEN",
    ]);
    expect(create.missing[0].code).toBe(3);

    const del = resolveEnv("delete", { FLAGSHIP_ADMIN_SECRET: "x" });
    expect(del.missing.map((m: { name: string }) => m.name)).toEqual([
      "HCLOUD_TOKEN",
    ]);

    const list = resolveEnv("list", { FLAGSHIP_ADMIN_SECRET: "x" });
    expect(list.missing).toEqual([]);
    const status = resolveEnv("status", { FLAGSHIP_ADMIN_SECRET: "x" });
    expect(status.missing).toEqual([]);
    // grant-device is a pure-Worker call (no Hetzner side-effect) so
    // it must NOT demand HCLOUD_TOKEN.
    const grant = resolveEnv("grant-device", { FLAGSHIP_ADMIN_SECRET: "x" });
    expect(grant.missing).toEqual([]);
  });
  it("FLAGSHIP_BASE_URL override is honored", () => {
    const { env } = resolveEnv("list", {
      FLAGSHIP_ADMIN_SECRET: "x",
      FLAGSHIP_BASE_URL: "http://localhost:8787",
    });
    expect(env.baseUrl).toBe("http://localhost:8787");
  });
});

/* ─────────────────────── small helpers ───────────────────────────────── */

describe("adminUrl + r2KeyFor + exitCodeForHttp", () => {
  it("joins base + path with one slash", () => {
    expect(adminUrl("https://flagshipserver.com", "/api/dev/sample-user/create"))
      .toBe("https://flagshipserver.com/api/dev/sample-user/create");
    expect(adminUrl("https://flagshipserver.com/", "/api/x")).toBe(
      "https://flagshipserver.com/api/x",
    );
  });
  it("r2KeyFor formats per §5.1", () => {
    expect(r2KeyFor("demo-alice", "deadbeef")).toBe(
      "demo-isos/demo-alice-deadbeef.iso",
    );
  });
  it("maps HTTP status to exit codes per §14.2", () => {
    expect(exitCodeForHttp(200)).toBe(1); // not a happy-path call
    expect(exitCodeForHttp(401)).toBe(2);
    expect(exitCodeForHttp(403)).toBe(2);
    expect(exitCodeForHttp(409)).toBe(4);
    expect(exitCodeForHttp(502)).toBe(3);
    expect(exitCodeForHttp(503)).toBe(3);
    expect(exitCodeForHttp(504)).toBe(3);
    expect(exitCodeForHttp(500)).toBe(1);
  });
});

/* ─────────────────────── stream + fetch helpers ──────────────────────── */

interface CapturedStream {
  data: string;
  write(s: string): void;
}
function captureStream(): CapturedStream {
  const c = { data: "", write(s: string) { c.data += s; } };
  return c;
}

interface FetchCall {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}
function stubFetch(scripted: Array<{ status: number; body: unknown }>): {
  fn: (url: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: (init?.method as string) ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const r = scripted[i++];
    if (!r) throw new Error(`stub fetch ran out of responses at call ${i}`);
    const text = JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
    } as Response;
  };
  return { fn, calls };
}

const ENV_OK = {
  baseUrl: "https://flagshipserver.com",
  adminSecret: "admin-sek",
  hcloudToken: "hcloud-tok",
  sshKeyPath: "/tmp/key",
};

/* ─────────────────────── list / status / delete ──────────────────────── */

describe("runList / runStatus / runDelete", () => {
  it("list → GET /api/dev/sample-user + emits the JSON", async () => {
    const { fn, calls } = stubFetch([{ status: 200, body: { demoUsers: [] } }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runList({ fetchFn: fn, env: ENV_OK, stderr, stdout });
    expect(code).toBe(0);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user",
    );
    // The Worker reads x-admin-secret (packages/control-plane/src/admin.ts),
    // NOT Authorization: Bearer. Match the Worker contract.
    expect(calls[0].headers["x-admin-secret"]).toBe("admin-sek");
    expect(JSON.parse(stdout.data)).toEqual({ demoUsers: [] });
  });
  it("status → GET /api/dev/sample-user/{u}; 404 emits exit 1", async () => {
    const { fn, calls } = stubFetch([{ status: 404, body: { error: "no such" } }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runStatus(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demo-alice",
    );
    expect(code).toBe(1);
    expect(calls[0].url).toContain("/api/dev/sample-user/demo-alice");
    expect(stderr.data).toContain("no such demo user");
  });
  it("delete → POST /api/dev/sample-user/delete with the username", async () => {
    const { fn, calls } = stubFetch([
      { status: 200, body: { deleted: true, username: "demo-alice" } },
    ]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runDelete(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demo-alice",
    );
    expect(code).toBe(0);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/delete",
    );
    expect(JSON.parse(calls[0].body!)).toEqual({ username: "demo-alice" });
    expect(JSON.parse(stdout.data)).toEqual({
      deleted: true,
      username: "demo-alice",
    });
  });
  it("admin endpoints map 403 → exit 2", async () => {
    const { fn } = stubFetch([{ status: 403, body: { error: "nope" } }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runList({ fetchFn: fn, env: ENV_OK, stderr, stdout });
    expect(code).toBe(2);
  });
});

/* ─────────────────────── create — happy + rollback paths ─────────────── */

describe("runCreate — orchestration", () => {
  // Default issued-ticket envelope returned by the Worker's
  // /api/dev/sample-user/admin-claim-and-issue endpoint. Shape matches
  // packages/control-plane/src/demoUsersAdmin.ts:handleAdminClaimAndIssue.
  const DEFAULT_TICKET = {
    code: "AAAA-BBBB-CCCC",
    blob: {
      version: 1,
      serverDomain: "home.demo-alice.flagship.services",
      username: "demo-alice",
      serverName: "home",
      authCode: { serial: "deadbeef".repeat(4) },
      issuedAt: 1,
      expiresAt: 86_400_001,
    },
    blobSignature: "ff".repeat(64),
    primaryGrant: {
      grantId: "00000000-0000-4000-8000-000000000001",
      username: "demo-alice",
      deviceLabel: "primary",
      devicePubKey: "ab".repeat(32),
      scopes: ["browse", "install-service"],
      issuedAt: 1,
      expiresAt: 86_400_001,
      signature: "ee".repeat(64),
    },
  };

  // Track the full step ordering via a journal the stubbed deps append
  // to. The journal is asserted at the end so we can be precise about
  // which step ran after which.
  function makeCreateDeps(opts: {
    reserveStatus?: number;
    reserveBody?: unknown;
    issueStatus?: number;
    issueBody?: unknown;
    persistStatus?: number;
    persistBody?: unknown;
    snapshotFails?: boolean;
    journal: string[];
    capturedBuildIso?: { args: unknown[] };
    capturedPersonalize?: { argv: string[]; blobPath: string; blob: unknown };
  }) {
    const reserveStatus = opts.reserveStatus ?? 200;
    const reserveBody = opts.reserveBody ?? {
      username: "demo-alice",
      state: "none",
      createdAt: 1,
    };
    const issueStatus = opts.issueStatus ?? 200;
    const issueBody = opts.issueBody ?? DEFAULT_TICKET;
    const persistStatus = opts.persistStatus ?? 200;
    const persistBody = opts.persistBody ?? {
      username: "demo-alice",
      snapshotId: "snap-7",
      ready: true,
    };
    // Order matches the runCreate sequence:
    //   1) POST /create (reserve)
    //   2) POST /admin-claim-and-issue (real-ticket)
    //   3) POST /<u>/install-complete (persist snapshot)
    const scripted = [
      { status: reserveStatus, body: reserveBody },
      { status: issueStatus, body: issueBody },
      { status: persistStatus, body: persistBody },
    ];
    const { fn, calls } = stubFetch(scripted);
    const stderr = captureStream();
    const stdout = captureStream();
    const deps = {
      fetchFn: fn,
      env: ENV_OK,
      stderr,
      stdout,
      now: () => 0,
      buildIso: async (a: {
        username: string;
        serverName: string;
        blob: unknown;
        blobSignature: string;
      }) => {
        if (opts.capturedBuildIso) opts.capturedBuildIso.args.push(a);
        // Mirror the live wiring's contract: refuse to build without
        // a real blob envelope, AND write a temp blob.json that the
        // (stubbed) personalize-iso could read via --blob-json. The
        // test assertion below reads this file back from disk.
        if (!a.blob || typeof a.blobSignature !== "string") {
          throw new Error("buildIso: missing blob/blobSignature");
        }
        if (opts.capturedPersonalize) {
          const workDir = mkdtempSync(
            join(tmpdir(), `flagship-test-${a.username}-`),
          );
          const blobJsonPath = join(workDir, "blob.json");
          writeFileSync(
            blobJsonPath,
            JSON.stringify({ blob: a.blob, blobSignature: a.blobSignature }),
          );
          opts.capturedPersonalize.argv = [
            "--base-iso",
            "/dev/null",
            "--output",
            `/tmp/${a.username}.iso`,
            "--blob-json",
            blobJsonPath,
          ];
          opts.capturedPersonalize.blobPath = blobJsonPath;
          opts.capturedPersonalize.blob = JSON.parse(
            readFileSync(blobJsonPath, "utf8"),
          );
        }
        opts.journal.push("buildIso");
        return { isoPath: "/tmp/demo-alice.iso" };
      },
      sha8For: async () => {
        opts.journal.push("sha8");
        return "deadbeef";
      },
      uploadIso: async (a: { key: string }) => {
        opts.journal.push(`uploadIso:${a.key}`);
        return { presignedUrl: "https://r2.example/demo-alice?sig=…" };
      },
      provisionTempVps: async (a: { presignedUrl: string }) => {
        opts.journal.push(`provisionTempVps:${a.presignedUrl.includes("?sig")}`);
        return { serverId: "srv-1", ipv4: "1.2.3.4" };
      },
      awaitDaemonReady: async (a: { fqdn: string }) => {
        opts.journal.push(`awaitDaemonReady:${a.fqdn}`);
      },
      snapshot: async () => {
        opts.journal.push("snapshot");
        if (opts.snapshotFails) {
          throw new Error("hetzner snapshot poll exhausted");
        }
        return { snapshotId: "snap-7" };
      },
      destroyVps: async (id: string) => {
        opts.journal.push(`destroyVps:${id}`);
      },
    };
    return { deps, calls, stderr, stdout };
  }

  it("happy path runs all 7 steps in order + posts /install-complete", async () => {
    const journal: string[] = [];
    const capturedBuildIso = { args: [] as unknown[] };
    const { deps, calls, stderr, stdout } = makeCreateDeps({
      journal,
      capturedBuildIso,
    });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(0);
    expect(journal).toEqual([
      "buildIso",
      "sha8",
      "uploadIso:demo-isos/demo-alice-deadbeef.iso",
      "provisionTempVps:true",
      "awaitDaemonReady:home.demo-alice.flagship.services",
      "snapshot",
      "destroyVps:srv-1",
    ]);
    // 3 admin calls: reserve + admin-claim-and-issue + install-complete.
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/create",
    );
    expect(JSON.parse(calls[0].body!)).toEqual({
      username: "demo-alice",
      display: "Demo Alice",
      region: "ash",
      size: "cpx11",
      ttlIdleMinutes: 30,
    });
    expect(calls[1].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/admin-claim-and-issue",
    );
    expect(JSON.parse(calls[1].body!)).toEqual({
      username: "demo-alice",
      serverName: "home",
    });
    expect(calls[2].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/demo-alice/install-complete",
    );
    expect(JSON.parse(calls[2].body!)).toEqual({
      snapshot_id: "snap-7",
      iso_r2_key: "demo-isos/demo-alice-deadbeef.iso",
    });
    // buildIso received the issued blob + signature verbatim.
    expect(capturedBuildIso.args).toHaveLength(1);
    const buildArg = capturedBuildIso.args[0] as {
      blob: { username: string };
      blobSignature: string;
    };
    expect(buildArg.blob.username).toBe("demo-alice");
    expect(buildArg.blobSignature).toBe(DEFAULT_TICKET.blobSignature);
    // Final stdout JSON for piping.
    expect(JSON.parse(stdout.data)).toEqual({
      username: "demo-alice",
      ready: true,
      snapshotId: "snap-7",
      isoR2Key: "demo-isos/demo-alice-deadbeef.iso",
    });
    expect(stderr.data).toContain("[create] starting at");
    expect(stderr.data).toContain("[create] snapshotting…");
    expect(stderr.data).toContain(
      "[create] claiming + issuing real install ticket via .com…",
    );
  });

  it("personalize-iso invocation uses --blob-json and NOT --seed-hex", async () => {
    const journal: string[] = [];
    const capturedPersonalize = {
      argv: [] as string[],
      blobPath: "",
      blob: undefined as unknown,
    };
    const { deps } = makeCreateDeps({ journal, capturedPersonalize });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(0);
    // The argv we'd hand to `personalize-iso` includes --blob-json and
    // explicitly NOT --seed-hex / --username / --server-name (those
    // belong to the deprecated synthesizeBlob path).
    expect(capturedPersonalize.argv).toContain("--blob-json");
    expect(capturedPersonalize.argv).not.toContain("--seed-hex");
    expect(capturedPersonalize.argv).not.toContain("--username");
    expect(capturedPersonalize.argv).not.toContain("--server-name");
    // The blob.json file on disk has the {blob, blobSignature} shape
    // the iso-personalizer CLI consumes (re-read after write).
    const onDisk = capturedPersonalize.blob as {
      blob: { username: string };
      blobSignature: string;
    };
    expect(onDisk.blob.username).toBe("demo-alice");
    expect(onDisk.blobSignature).toBe(DEFAULT_TICKET.blobSignature);
  });

  it("admin-claim-and-issue 5xx → exits before touching Hetzner", async () => {
    const journal: string[] = [];
    const { deps, stderr } = makeCreateDeps({
      journal,
      issueStatus: 503,
      issueBody: { error: "demo backend down" },
    });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(3); // 503 → exit 3 per §14.2
    // None of the I/O-side steps should have run.
    expect(journal).toEqual([]);
    expect(stderr.data).toContain("admin-claim-and-issue failed");
  });

  it("admin-claim-and-issue returns malformed body → exit 1", async () => {
    const journal: string[] = [];
    const { deps, stderr } = makeCreateDeps({
      journal,
      issueBody: { code: "X", primaryGrant: {} },
    });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(1);
    expect(journal).toEqual([]);
    expect(stderr.data).toContain("malformed body");
  });

  it("snapshot failure rolls back the temp server AND exits 3", async () => {
    const journal: string[] = [];
    const { deps, stderr } = makeCreateDeps({ journal, snapshotFails: true });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(3);
    // The rollback destroy MUST have run after the snapshot failure.
    expect(journal).toContain("snapshot");
    expect(journal[journal.length - 1]).toBe("destroyVps:srv-1");
    expect(stderr.data).toContain("[create] FAILED:");
    expect(stderr.data).toContain("rollback: destroying temp server srv-1");
  });

  it("D1 conflict on reserve → exit 4", async () => {
    const journal: string[] = [];
    const { deps } = makeCreateDeps({
      journal,
      reserveStatus: 409,
      reserveBody: { error: "username already claimed by a real account" },
    });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(4);
    // Nothing past the reserve should have run.
    expect(journal).toEqual([]);
  });

  it("admin auth failure on reserve → exit 2", async () => {
    const journal: string[] = [];
    const { deps } = makeCreateDeps({
      journal,
      reserveStatus: 403,
      reserveBody: { error: "admin auth required" },
    });
    const code = await runCreate(deps, "demo-alice", { display: "Demo Alice" });
    expect(code).toBe(2);
    expect(journal).toEqual([]);
  });
});

/* ─────────────────────── grant-device ─────────────────────────────────── */

describe("runGrantDevice", () => {
  it("POSTs /admin-mint-device-grant with deviceLabel+scopes and prints JSON", async () => {
    const responseBody = {
      grant: {
        grantId: "00000000-0000-4000-8000-000000000099",
        username: "demo-alice",
        deviceLabel: "reviewer",
        devicePubKey: "cc".repeat(32),
        scopes: ["browse"],
        issuedAt: 1,
        expiresAt: 90 * 24 * 3_600_000 + 1,
      },
      signature: "aa".repeat(64),
      devicePubHex: "cc".repeat(32),
    };
    const { fn, calls } = stubFetch([{ status: 200, body: responseBody }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demo-alice",
      "reviewer",
      ["browse"],
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/demo-alice/admin-mint-device-grant",
    );
    expect(JSON.parse(calls[0].body!)).toEqual({
      deviceLabel: "reviewer",
      scopes: ["browse"],
    });
    // Bearer-equivalent header from adminFetch.
    expect(calls[0].headers["x-admin-secret"]).toBe("admin-sek");
    // Machine-readable response on stdout.
    expect(JSON.parse(stdout.data)).toEqual(responseBody);
    // Human summary on stderr.
    expect(stderr.data).toContain(
      "Granted reviewer device with scopes: browse",
    );
  });

  it("URL-encodes the username path segment", async () => {
    const { fn, calls } = stubFetch([
      { status: 200, body: { grant: {}, signature: "x", devicePubHex: "y" } },
    ]);
    const stderr = captureStream();
    const stdout = captureStream();
    await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "weird user",
      "reviewer",
      ["browse"],
    );
    expect(calls[0].url).toContain(
      "/api/dev/sample-user/weird%20user/admin-mint-device-grant",
    );
  });

  it("multiple scopes are forwarded verbatim", async () => {
    const { fn, calls } = stubFetch([
      { status: 200, body: { grant: {}, signature: "x", devicePubHex: "y" } },
    ]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demo-alice",
      "work-laptop",
      ["browse", "install-service", "vibe-code"],
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0].body!)).toEqual({
      deviceLabel: "work-laptop",
      scopes: ["browse", "install-service", "vibe-code"],
    });
    expect(stderr.data).toContain(
      "Granted work-laptop device with scopes: browse, install-service, vibe-code",
    );
  });

  it("Worker rejection (400) surfaces the error message AND exits 1", async () => {
    const { fn } = stubFetch([
      {
        status: 400,
        body: {
          error: "scopes must be a non-empty array of known DeviceScope strings",
        },
      },
    ]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demo-alice",
      "reviewer",
      ["bogus-scope"],
    );
    expect(code).toBe(1);
    expect(stderr.data).toContain(
      "scopes must be a non-empty array of known DeviceScope strings",
    );
    // No JSON on stdout when the call failed — keep the pipe contract clean.
    expect(stdout.data).toBe("");
  });

  it("admin-auth failure (403) → exit 2", async () => {
    const { fn } = stubFetch([{ status: 403, body: { error: "no admin" } }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demo-alice",
      "reviewer",
      ["browse"],
    );
    expect(code).toBe(2);
    expect(stderr.data).toContain("no admin");
  });

  it("404 demo user → exit 1 with a clear message", async () => {
    const { fn } = stubFetch([
      { status: 404, body: { error: "demo user does not exist" } },
    ]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "ghost-alice",
      "reviewer",
      ["browse"],
    );
    expect(code).toBe(1);
    expect(stderr.data).toContain("demo user does not exist");
  });
});

/* ─────────────────────── main() end-to-end exit-code contracts ───────── */

describe("main() — env-gate + exit-code contracts", () => {
  function callMain(argv: string[], processEnv: Record<string, string>) {
    const stderr = captureStream();
    const stdout = captureStream();
    return {
      stderr,
      stdout,
      run: () =>
        main(argv, {
          processEnv,
          stderr,
          stdout,
          now: () => 0,
          fetchFn: vi.fn(),
          sha8For: vi.fn(),
          buildIso: vi.fn(),
          uploadIso: vi.fn(),
          provisionTempVps: vi.fn(),
          awaitDaemonReady: vi.fn(),
          snapshot: vi.fn(),
          destroyVps: vi.fn(),
        }),
    };
  }

  it("--help prints usage and exits 0 with NO env vars set", async () => {
    const { stdout, run } = callMain(["--help"], {});
    const code = await run();
    expect(code).toBe(0);
    expect(stdout.data).toContain("sample-user — operator CLI");
    expect(stdout.data).toContain("create <username>");
    expect(stdout.data).toContain(
      "grant-device <username> <device-label>",
    );
  });
  it("USAGE constant is the same string that --help prints", () => {
    expect(USAGE).toContain("create <username>");
    expect(USAGE).toContain("FLAGSHIP_ADMIN_SECRET");
    expect(USAGE).toContain("grant-device <username> <device-label>");
  });
  it("`grant-device` flows through main() with admin-secret only (no HCLOUD_TOKEN)", async () => {
    // grant-device is a pure-Worker call. main() must NOT demand
    // HCLOUD_TOKEN; the run reaches runGrantDevice and POSTs via the
    // injected fetchFn.
    const stderr = captureStream();
    const stdout = captureStream();
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            grant: {
              grantId: "g1",
              username: "demo-alice",
              deviceLabel: "reviewer",
              devicePubKey: "cc".repeat(32),
              scopes: ["browse"],
              issuedAt: 1,
              expiresAt: 2,
            },
            signature: "aa".repeat(64),
            devicePubHex: "cc".repeat(32),
          }),
      }) as Response,
    );
    const code = await main(
      [
        "grant-device",
        "demo-alice",
        "reviewer",
        "--scopes",
        "browse",
      ],
      {
        processEnv: { FLAGSHIP_ADMIN_SECRET: "sek" },
        stderr,
        stdout,
        now: () => 0,
        fetchFn,
        sha8For: vi.fn(),
        buildIso: vi.fn(),
        uploadIso: vi.fn(),
        provisionTempVps: vi.fn(),
        awaitDaemonReady: vi.fn(),
        snapshot: vi.fn(),
        destroyVps: vi.fn(),
      },
    );
    expect(code).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = (fetchFn.mock.calls[0] as unknown[])[0] as string;
    expect(url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/demo-alice/admin-mint-device-grant",
    );
    expect(stderr.data).toContain(
      "Granted reviewer device with scopes: browse",
    );
  });
  it("`create` with NO env → exit 3 (HCLOUD_TOKEN beats FLAGSHIP_ADMIN_SECRET)", async () => {
    const { stderr, run } = callMain(
      ["create", "demo-alice", "--display", "Demo Alice"],
      {},
    );
    const code = await run();
    // Both are missing; the highest-priority code (3 = Hetzner) wins.
    expect(code).toBe(3);
    expect(stderr.data).toContain('env "FLAGSHIP_ADMIN_SECRET" is required');
    expect(stderr.data).toContain('env "HCLOUD_TOKEN" is required');
  });
  it("`create` with HCLOUD_TOKEN set but admin secret missing → exit 2", async () => {
    const { stderr, run } = callMain(
      ["create", "demo-alice", "--display", "Demo Alice"],
      { HCLOUD_TOKEN: "tok" },
    );
    const code = await run();
    expect(code).toBe(2);
    expect(stderr.data).toContain('env "FLAGSHIP_ADMIN_SECRET" is required');
  });
  it("`create` with admin secret set but HCLOUD_TOKEN missing → exit 3", async () => {
    const { stderr, run } = callMain(
      ["create", "demo-alice", "--display", "Demo Alice"],
      { FLAGSHIP_ADMIN_SECRET: "sek" },
    );
    const code = await run();
    expect(code).toBe(3);
    expect(stderr.data).toContain('env "HCLOUD_TOKEN" is required');
  });
  it("`list` with no FLAGSHIP_ADMIN_SECRET → exit 2 (no HCLOUD_TOKEN needed)", async () => {
    const { stderr, run } = callMain(["list"], {});
    const code = await run();
    expect(code).toBe(2);
    expect(stderr.data).toContain('env "FLAGSHIP_ADMIN_SECRET" is required');
    expect(stderr.data).not.toContain('env "HCLOUD_TOKEN" is required');
  });
  it("malformed args print usage and exit 1", async () => {
    const { stderr, run } = callMain(["wat"], {});
    const code = await run();
    expect(code).toBe(1);
    expect(stderr.data).toContain("unknown subcommand");
    expect(stderr.data).toContain("USAGE:");
  });
});

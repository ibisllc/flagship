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
  // Track the full step ordering via a journal the stubbed deps append
  // to. The journal is asserted at the end so we can be precise about
  // which step ran after which.
  function makeCreateDeps(opts: {
    reserveStatus?: number;
    reserveBody?: unknown;
    persistStatus?: number;
    persistBody?: unknown;
    snapshotFails?: boolean;
    journal: string[];
  }) {
    const reserveStatus = opts.reserveStatus ?? 200;
    const reserveBody = opts.reserveBody ?? {
      username: "demo-alice",
      state: "none",
      createdAt: 1,
    };
    const persistStatus = opts.persistStatus ?? 200;
    const persistBody = opts.persistBody ?? {
      username: "demo-alice",
      snapshotId: "snap-7",
      ready: true,
    };
    const scripted = [
      { status: reserveStatus, body: reserveBody },
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
      buildIso: async () => {
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

  it("happy path runs all 6 steps in order + posts /install-complete", async () => {
    const journal: string[] = [];
    const { deps, calls, stderr, stdout } = makeCreateDeps({ journal });
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
    // 2 admin calls: reserve + install-complete.
    expect(calls).toHaveLength(2);
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
      "https://flagshipserver.com/api/dev/sample-user/demo-alice/install-complete",
    );
    expect(JSON.parse(calls[1].body!)).toEqual({
      snapshot_id: "snap-7",
      iso_r2_key: "demo-isos/demo-alice-deadbeef.iso",
    });
    // Final stdout JSON for piping.
    expect(JSON.parse(stdout.data)).toEqual({
      username: "demo-alice",
      ready: true,
      snapshotId: "snap-7",
      isoR2Key: "demo-isos/demo-alice-deadbeef.iso",
    });
    expect(stderr.data).toContain("[create] starting at");
    expect(stderr.data).toContain("[create] snapshotting…");
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
  });
  it("USAGE constant is the same string that --help prints", () => {
    expect(USAGE).toContain("create <username>");
    expect(USAGE).toContain("FLAGSHIP_ADMIN_SECRET");
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

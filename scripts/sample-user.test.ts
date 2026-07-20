/**
 * Pure-logic tests for scripts/sample-user.mjs (W11).
 *
 * As of W11 the laptop never touches Hetzner; the CLI is a thin HTTP
 * wrapper around 3 admin endpoints + a polling loop. Tests cover:
 *
 *   - arg parsing (unchanged from Phase E)
 *   - env resolution: only FLAGSHIP_ADMIN_SECRET is required;
 *     HCLOUD_TOKEN + DEMO_SSH_KEY_PATH are NO LONGER read
 *   - runCreate orchestrates the 4-step flow correctly with
 *     mocked HTTP (reserve → claim → admin-cloud-init-now → poll)
 *   - polling completes when the cron stamps snapshot_id
 *   - rollback on the Worker rejecting admin-cloud-init-now
 */
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — .mjs sibling, no types
import {
  parseArgs,
  normalizeDemoUsername,
  resolveEnv,
  adminUrl,
  exitCodeForHttp,
  USAGE,
  runCreate,
  runList,
  runStatus,
  runDelete,
  runGrantDevice,
  pollUntilReady,
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
    expect(parseArgs(["delete", "demoalice"]).command).toBe("delete");
    expect(parseArgs(["delete", "demoalice"]).username).toBe("demoalice");
    expect(parseArgs(["status", "demoalice"]).username).toBe("demoalice");
    expect(() => parseArgs(["delete"])).toThrow(/requires a <username>/);
    expect(() => parseArgs(["status"])).toThrow(/requires a <username>/);
  });
  it("parses `create <user> --display … --region … --size … --ttl-idle …`", () => {
    const a = parseArgs([
      "create",
      "demoalice",
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
    expect(a.username).toBe("demoalice");
    expect(a.flags.display).toBe("Demo Alice");
    expect(a.flags.region).toBe("fsn1");
    expect(a.flags.size).toBe("cpx11");
    expect(a.flags.ttlIdleMinutes).toBe(30);
  });
  it("uses the canonical word-word username grammar for create", () => {
    expect(normalizeDemoUsername("OpenAI-Build")).toBe("openai-build");
    expect(parseArgs(["create", "OpenAI-Build"]).username).toBe("openai-build");
    for (const invalid of ["ab", "-openai", "openai-", "openai--build", "a".repeat(31), "support"]) {
      expect(() => normalizeDemoUsername(invalid)).toThrow();
    }
  });
  it("rejects malformed args deterministically", () => {
    expect(() => parseArgs(["unknown"])).toThrow(/unknown subcommand/);
    expect(() => parseArgs(["create"])).toThrow(/requires a <username>/);
    expect(() => parseArgs(["create", "user", "--display"])).toThrow(
      /requires a value/,
    );
    expect(() => parseArgs(["create", "user", "--frobnicate", "y"])).toThrow(
      /unknown flag/,
    );
    expect(() => parseArgs(["create", "user", "--ttl-idle", "0"])).toThrow(
      /positive integer/,
    );
  });
  it("parses `grant-device <user> <label> --scopes a,b,c`", () => {
    const a = parseArgs([
      "grant-device",
      "demoalice",
      "reviewer",
      "--scopes",
      "browse",
    ]);
    expect(a.command).toBe("grant-device");
    expect(a.username).toBe("demoalice");
    expect(a.deviceLabel).toBe("reviewer");
    expect(a.flags.scopes).toEqual(["browse"]);
  });
  it("`grant-device` trims whitespace and rejects empty / missing --scopes", () => {
    expect(() => parseArgs(["grant-device"])).toThrow(/requires a <username>/);
    expect(() => parseArgs(["grant-device", "demoalice"])).toThrow(
      /requires a <device-label>/,
    );
    expect(() =>
      parseArgs(["grant-device", "demoalice", "reviewer"]),
    ).toThrow(/requires --scopes/);
  });
});

/* ─────────────────────── env resolution (W11) ────────────────────────── */

describe("resolveEnv (W11 — laptop secrets stripped)", () => {
  it("defaults FLAGSHIP_BASE_URL and only requires FLAGSHIP_ADMIN_SECRET", () => {
    const { env, missing } = resolveEnv("help", {
      FLAGSHIP_ADMIN_SECRET: "sek",
    });
    expect(env.baseUrl).toBe("https://flagshipserver.com");
    expect(missing).toEqual([]);
  });
  it("requires FLAGSHIP_ADMIN_SECRET for every subcommand → exit 2", () => {
    for (const cmd of ["list", "status", "create", "delete", "grant-device"]) {
      const r = resolveEnv(cmd, {});
      expect(r.missing.map((m: { name: string }) => m.name)).toEqual([
        "FLAGSHIP_ADMIN_SECRET",
      ]);
      expect(r.missing[0].code).toBe(2);
    }
  });
  it("W11 — NEVER reads HCLOUD_TOKEN or DEMO_SSH_KEY_PATH", () => {
    // Even if the operator's env has these set from the pre-W11 days,
    // the new resolveEnv MUST NOT incorporate them into env nor add
    // them to `missing`.
    const fullEnv = {
      FLAGSHIP_ADMIN_SECRET: "sek",
      HCLOUD_TOKEN: "leftover-hcloud-token",
      DEMO_SSH_KEY_PATH: "/Users/op/.ssh/should-not-be-read",
      HOME: "/Users/op",
    };
    for (const cmd of ["list", "status", "create", "delete", "grant-device"]) {
      const { env, missing } = resolveEnv(cmd, fullEnv);
      expect(missing).toEqual([]);
      expect((env as Record<string, unknown>).hcloudToken).toBeUndefined();
      expect((env as Record<string, unknown>).sshKeyPath).toBeUndefined();
    }
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

describe("adminUrl + exitCodeForHttp", () => {
  it("joins base + path with one slash", () => {
    expect(adminUrl("https://flagshipserver.com", "/api/dev/sample-user/create"))
      .toBe("https://flagshipserver.com/api/dev/sample-user/create");
    expect(adminUrl("https://flagshipserver.com/", "/api/x")).toBe(
      "https://flagshipserver.com/api/x",
    );
  });
  it("maps HTTP status to exit codes", () => {
    expect(exitCodeForHttp(200)).toBe(1);
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
    expect(calls[0].headers["x-admin-secret"]).toBe("admin-sek");
    expect(JSON.parse(stdout.data)).toEqual({ demoUsers: [] });
  });
  it("status → GET /api/dev/sample-user/{u}; 404 emits exit 1", async () => {
    const { fn, calls } = stubFetch([{ status: 404, body: { error: "no such" } }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runStatus(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demoalice",
    );
    expect(code).toBe(1);
    expect(calls[0].url).toContain("/api/dev/sample-user/demoalice");
    expect(stderr.data).toContain("no such demo user");
  });
  it("delete → POST /api/dev/sample-user/delete with the username", async () => {
    const { fn, calls } = stubFetch([
      { status: 200, body: { deleted: true, username: "demoalice" } },
    ]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runDelete(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demoalice",
    );
    expect(code).toBe(0);
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body!)).toEqual({ username: "demoalice" });
  });
});

/* ─────────────────────── create — W11 orchestration ──────────────────── */

describe("runCreate — W11 4-step orchestration", () => {
  function makeDeps(opts: {
    reserveStatus?: number;
    issueStatus?: number;
    provisionStatus?: number;
    provisionBody?: unknown;
    journal: string[];
    pollResult?: {
      ready: boolean;
      snapshotId?: string;
      isoR2Key?: string;
      reason?: string;
    };
  }) {
    const reserveStatus = opts.reserveStatus ?? 200;
    const issueStatus = opts.issueStatus ?? 200;
    const provisionStatus = opts.provisionStatus ?? 202;
    const provisionBody = opts.provisionBody ?? {
      state: "provisioning",
      activeServerId: "srv-1",
      isoR2Key: "demo-isos/demoalice-aabbccdd.iso",
    };
    const scripted = [
      { status: reserveStatus, body: { username: "demoalice", state: "none", createdAt: 1 } },
      {
        status: issueStatus,
        body: {
          code: "AAAA-BBBB-CCCC",
          blob: { version: 1, username: "demoalice" },
          blobSignature: "ff".repeat(64),
          primaryGrant: { grantId: "g-1" },
        },
      },
      { status: provisionStatus, body: provisionBody },
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
      pollUntilReady: async (args: {
        username: string;
        timeoutMs: number;
      }) => {
        opts.journal.push(`poll:${args.username}:${args.timeoutMs}`);
        return (
          opts.pollResult ?? {
            ready: true,
            snapshotId: "snap-7",
            isoR2Key: "demo-isos/demoalice-aabbccdd.iso",
          }
        );
      },
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
    };
    return { deps, calls, stderr, stdout };
  }

  it("happy path: runs 3 admin POSTs in order + polls until snapshot stamped", async () => {
    const journal: string[] = [];
    const { deps, calls, stderr, stdout } = makeDeps({ journal });
    const code = await runCreate(deps, "demoalice", { display: "Demo Alice" });
    expect(code).toBe(0);
    // 3 admin POSTs: create, claim, admin-cloud-init-now.
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/create",
    );
    expect(JSON.parse(calls[0].body!)).toEqual({
      username: "demoalice",
      display: "Demo Alice",
      region: "fsn1",
      size: "cpx11",
      ttlIdleMinutes: 30,
    });
    expect(calls[1].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/admin-claim-and-issue",
    );
    expect(JSON.parse(calls[1].body!)).toEqual({
      username: "demoalice",
      serverName: "home",
    });
    expect(calls[2].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/demoalice/admin-cloud-init-now",
    );
    expect(JSON.parse(calls[2].body!)).toEqual({
      region: "fsn1",
      size: "cpx11",
    });
    expect(journal).toEqual(["poll:demoalice:5000"]);
    expect(JSON.parse(stdout.data)).toEqual({
      username: "demoalice",
      ready: true,
      snapshotId: "snap-7",
      isoR2Key: "demo-isos/demoalice-aabbccdd.iso",
    });
    expect(stderr.data).toContain("Worker-side provisioning");
  });

  it("provisioning failure (503) → exit 3 BEFORE polling", async () => {
    const journal: string[] = [];
    const { deps } = makeDeps({
      journal,
      provisionStatus: 503,
      provisionBody: { error: "hetzner upstream rejected" },
    });
    const code = await runCreate(deps, "demoalice", { display: "Demo Alice" });
    expect(code).toBe(3);
    expect(journal).toEqual([]); // poll never ran
  });

  it("admin auth failure on reserve → exit 2", async () => {
    const journal: string[] = [];
    const { deps } = makeDeps({ journal, reserveStatus: 403 });
    const code = await runCreate(deps, "demoalice", { display: "Demo Alice" });
    expect(code).toBe(2);
    expect(journal).toEqual([]);
  });

  it("D1 conflict on reserve → exit 4", async () => {
    const journal: string[] = [];
    const { deps } = makeDeps({ journal, reserveStatus: 409 });
    const code = await runCreate(deps, "demoalice", { display: "Demo Alice" });
    expect(code).toBe(4);
    expect(journal).toEqual([]);
  });

  it("poll timeout → exit 1 with the reason on stderr", async () => {
    const journal: string[] = [];
    const { deps, stderr } = makeDeps({
      journal,
      pollResult: { ready: false, reason: "timed out after 0.08 min" },
    });
    const code = await runCreate(deps, "demoalice", { display: "Demo Alice" });
    expect(code).toBe(1);
    expect(stderr.data).toContain("polling timed out");
  });
});

/* ─────────────────────── pollUntilReady ──────────────────────────────── */

describe("pollUntilReady", () => {
  it("returns ready=true when the W13 direct server is up", async () => {
    const { fn } = stubFetch([
      {
        status: 200,
        body: {
          state: "up",
          snapshotId: null,
          activeServerId: "srv-w13",
          activeServerFqdn: "home.openai-build.flagship.services",
        },
      },
    ]);
    const r = await pollUntilReady({
      fetchFn: fn,
      env: ENV_OK,
      stderr: captureStream(),
      username: "openai-build",
      timeoutMs: 60_000,
      intervalMs: 0,
      now: () => 0,
    });
    expect(r).toMatchObject({
      ready: true,
      activeServerId: "srv-w13",
      activeServerFqdn: "home.openai-build.flagship.services",
    });
  });

  it("returns ready=true when state=none AND snapshotId is set", async () => {
    const { fn } = stubFetch([
      { status: 200, body: { state: "provisioning", snapshotId: null } },
      { status: 200, body: { state: "provisioning", snapshotId: null } },
      { status: 200, body: { state: "none", snapshotId: "snap-9", isoR2Key: "k" } },
    ]);
    let t = 0;
    const stderr = captureStream();
    const r = await pollUntilReady({
      fetchFn: fn,
      env: ENV_OK,
      stderr,
      username: "demoalice",
      timeoutMs: 60_000,
      intervalMs: 0,
      now: () => t++,
    });
    expect(r.ready).toBe(true);
    expect(r.snapshotId).toBe("snap-9");
  });

  it("returns ready=false on Worker-declared state=failed", async () => {
    const { fn } = stubFetch([
      { status: 200, body: { state: "failed", snapshotId: null } },
    ]);
    const stderr = captureStream();
    const r = await pollUntilReady({
      fetchFn: fn,
      env: ENV_OK,
      stderr,
      username: "demoalice",
      timeoutMs: 60_000,
      intervalMs: 0,
      now: () => 0,
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/state=failed/);
  });
});

/* ─────────────────────── grant-device ─────────────────────────────────── */

describe("runGrantDevice", () => {
  it("POSTs /admin-mint-device-grant with deviceLabel+scopes and prints JSON", async () => {
    const responseBody = {
      grant: { grantId: "g99", username: "demoalice", deviceLabel: "reviewer" },
      signature: "aa".repeat(64),
      devicePubHex: "cc".repeat(32),
    };
    const { fn, calls } = stubFetch([{ status: 200, body: responseBody }]);
    const stderr = captureStream();
    const stdout = captureStream();
    const code = await runGrantDevice(
      { fetchFn: fn, env: ENV_OK, stderr, stdout },
      "demoalice",
      "reviewer",
      ["browse"],
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://flagshipserver.com/api/dev/sample-user/demoalice/admin-mint-device-grant",
    );
    expect(JSON.parse(calls[0].body!)).toEqual({
      deviceLabel: "reviewer",
      scopes: ["browse"],
    });
    expect(JSON.parse(stdout.data)).toEqual(responseBody);
    expect(stderr.data).toContain(
      "Granted reviewer device with scopes: browse",
    );
  });
});

/* ─────────────────────── main() end-to-end exit-code contracts ───────── */

describe("main() — env-gate + exit-code contracts (W11)", () => {
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
          pollUntilReady: vi.fn(),
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

  it("USAGE constant documents the W11 env contract (admin-secret only)", () => {
    expect(USAGE).toContain("FLAGSHIP_ADMIN_SECRET");
    // W11 message: don't dangle deprecated env names as still-required.
    expect(USAGE).toContain("HCLOUD_TOKEN and DEMO_SSH_KEY_PATH are NO LONGER READ");
  });

  it("`create` with HCLOUD_TOKEN unset, DEMO_SSH_KEY_PATH unset, FLAGSHIP_ADMIN_SECRET set → orchestrates the 4-step flow", async () => {
    // Acceptance from the W11 task — explicitly proves the operator
    // can drive the CLI with ONLY FLAGSHIP_ADMIN_SECRET. The mocked
    // fetch returns the expected 3-call sequence; pollUntilReady is
    // mocked to return ready immediately.
    const stderr = captureStream();
    const stdout = captureStream();
    let i = 0;
    const scripted = [
      { status: 200, body: { username: "demoalice", state: "none" } },
      {
        status: 200,
        body: {
          code: "X",
          blob: { version: 1 },
          blobSignature: "ff".repeat(64),
          primaryGrant: { grantId: "g1" },
        },
      },
      { status: 202, body: { state: "provisioning", activeServerId: "srv-1" } },
    ];
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
      const r = scripted[i++];
      return {
        ok: r.status < 300,
        status: r.status,
        text: async () => JSON.stringify(r.body),
      } as Response;
    });
    const pollUntilReadyMock = vi.fn(async () => ({
      ready: true,
      snapshotId: "snap-7",
      isoR2Key: "k",
    }));
    const code = await main(
      ["create", "demoalice", "--display", "Demo Alice"],
      {
        processEnv: {
          // Acceptance-as-spec: only admin secret in the env. The
          // HCLOUD_TOKEN / DEMO_SSH_KEY_PATH names are intentionally
          // absent (the CLI must not require them).
          FLAGSHIP_ADMIN_SECRET: "x",
        },
        stderr,
        stdout,
        now: () => 0,
        fetchFn,
        pollUntilReady: pollUntilReadyMock,
      },
    );
    expect(code).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(pollUntilReadyMock).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toContain("/api/dev/sample-user/create");
    expect(calls[1].url).toContain("/admin-claim-and-issue");
    expect(calls[2].url).toContain("/demoalice/admin-cloud-init-now");
    const final = JSON.parse(stdout.data);
    expect(final).toEqual({
      username: "demoalice",
      ready: true,
      snapshotId: "snap-7",
      isoR2Key: "k",
    });
  });

  it("`create` with NO env → exit 2 (only admin secret required)", async () => {
    const { stderr, run } = callMain(
      ["create", "demoalice", "--display", "Demo Alice"],
      {},
    );
    const code = await run();
    expect(code).toBe(2);
    expect(stderr.data).toContain('env "FLAGSHIP_ADMIN_SECRET" is required');
    // Critically: NO "HCLOUD_TOKEN is required" line — the CLI
    // doesn't even look at that env any more.
    expect(stderr.data).not.toContain('"HCLOUD_TOKEN"');
  });

  it("`list` with no FLAGSHIP_ADMIN_SECRET → exit 2", async () => {
    const { stderr, run } = callMain(["list"], {});
    const code = await run();
    expect(code).toBe(2);
    expect(stderr.data).toContain('env "FLAGSHIP_ADMIN_SECRET" is required');
  });

  it("malformed args print usage and exit 1", async () => {
    const { stderr, run } = callMain(["wat"], {});
    const code = await run();
    expect(code).toBe(1);
    expect(stderr.data).toContain("unknown subcommand");
    expect(stderr.data).toContain("USAGE:");
  });
});

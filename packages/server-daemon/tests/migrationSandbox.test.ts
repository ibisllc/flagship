import { describe, expect, it } from "vitest";
import { boundedRedacted, buildSandboxPlan, MigrationFailedError, runSandboxedSql, targetFromPgUrl, MIGRATION_PSQL_IMAGE, DEFAULT_MIGRATION_LIMITS } from "../src/migrationSandbox.js";
import type { CommandRunner } from "../src/serviceRunner.js";
import { setSandboxNetworking } from "../src/egress/sandboxNetworking.js";

const target = { user: "r_abc123", password: "s3cret-pass-word", database: "d_abc123", port: 5432 };

describe("migration sandbox plan", () => {
  const plan = buildSandboxPlan({ target, containerName: "flagship-migrate-test" });
  const a = plan.args;

  it("runs under gVisor, as the app's identity, with nothing writable but a small tmpfs", () => {
    expect(a).toContain("--runtime=runsc");
    expect(a).toContain("--read-only");
    expect(a).toContain("--cap-drop=ALL");
    expect(a).toContain("--security-opt=no-new-privileges");
    expect(a[a.indexOf("--user") + 1]).toBe("10001:10001");
    expect(a[a.indexOf("--tmpfs") + 1]).toMatch(/^\/tmp:rw,noexec,nosuid,size=32m$/);
    expect(a).toContain("--pids-limit");
    expect(a[a.indexOf("--memory") + 1]).toBe(DEFAULT_MIGRATION_LIMITS.memory);
  });

  it("mounts nothing and reaches only the no-internet bridge plus the data host", () => {
    expect(a.some((x) => x === "-v" || x === "--volume" || x === "--mount" || x.startsWith("--mount="))).toBe(false);
    expect(a.join(" ")).not.toMatch(/\/var\/flagship|docker\.sock/);
    expect(a).toContain("--network=flagship-staging");
    expect(a[a.indexOf("--add-host") + 1]).toBe("host.flagship.internal:host-gateway");
    expect(a).not.toContain("--privileged");
    expect(a.join(" ")).not.toContain("--network=host");
  });

  it("reaches the data host through the staging bridge's gateway when the gateway enforces, not docker0's host-gateway", () => {
    setSandboxNetworking({ gateways: new Map([["flagship-staging", "172.19.0.1"]]), buildHosts: [] });
    try {
      const args = buildSandboxPlan({ target: { user: "u", password: "pw-pw-pw", database: "d", port: 5432 } }).args;
      expect(args[args.indexOf("--add-host") + 1]).toBe("host.flagship.internal:172.19.0.1");
    } finally {
      setSandboxNetworking(null);
    }
    const plain = buildSandboxPlan({ target: { user: "u", password: "pw-pw-pw", database: "d", port: 5432 } }).args;
    expect(plain[plain.indexOf("--add-host") + 1]).toBe("host.flagship.internal:host-gateway");
  });
  it("is pinned by digest and reads the SQL from stdin", () => {
    expect(MIGRATION_PSQL_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(a).toContain(MIGRATION_PSQL_IMAGE);
    expect(a.slice(-2)).toEqual(["-f", "-"]);
    expect(a).toContain("--set=ON_ERROR_STOP=1");
    expect(a).toContain("-1");
  });

  it("the password is never in the argument list; it travels in the client's own environment", () => {
    expect(a.join("\n")).not.toContain(target.password);
    expect(plan.env.PGPASSWORD).toBe(target.password);
    expect(Object.keys(plan.env).sort()).toEqual(["PATH", "PGOPTIONS", "PGPASSWORD"]); // no daemon environment
    expect(plan.env.PGOPTIONS).toMatch(/statement_timeout=300000.*lock_timeout=10000.*idle_in_transaction_session_timeout=30000/);
  });

  it("refuses an unsafe role, database or port", () => {
    expect(() => buildSandboxPlan({ target: { ...target, user: "x; DROP" } })).toThrow();
    expect(() => buildSandboxPlan({ target: { ...target, database: "a b" } })).toThrow();
    expect(() => buildSandboxPlan({ target: { ...target, port: 0 } })).toThrow();
  });
});

describe("running a migration", () => {
  const fake = (impl: (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>, killed: string[] = []): CommandRunner => ({
    run: async (_c, args) => void killed.push(args.join(" ")),
    capture: (c, args, opts) => impl(c, args, (opts ?? {}) as Record<string, unknown>),
  });

  it("sends the SQL on stdin with a wall-clock bound and the private environment", async () => {
    let seen: { args: string[]; opts: Record<string, unknown> } | null = null;
    await runSandboxedSql({ cmd: fake(async (_c, args, opts) => ((seen = { args, opts }), { stdout: "", stderr: "" })), target, sql: "CREATE TABLE t(i int);" });
    expect(seen!.opts.input).toBe("CREATE TABLE t(i int);");
    expect(seen!.opts.timeoutMs).toBe(DEFAULT_MIGRATION_LIMITS.wallClockMs);
    expect((seen!.opts.env as Record<string, string>).PGPASSWORD).toBe(target.password);
  });

  it("a failure carries bounded, redacted output and never the password", async () => {
    const noisy = `ERROR: relation exists\n${"x".repeat(100_000)}\npassword=${target.password}\nFATAL tail line`;
    const err = await runSandboxedSql({ cmd: fake(async () => { throw Object.assign(new Error("docker exited with code 3"), { stderr: noisy }); }), target, sql: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationFailedError);
    expect(err.kind).toBe("failed");
    expect(err.message).not.toContain(target.password);
    expect(err.message).toContain("FATAL tail line");
    expect(Buffer.byteLength(err.message)).toBeLessThan(DEFAULT_MIGRATION_LIMITS.outputBytes + 200);
  });

  it("a timeout stops the container by name and says so", async () => {
    const killed: string[] = [];
    const err = await runSandboxedSql({ cmd: fake(async () => { throw new Error("command timed out after 600000ms and was killed"); }, killed), target, sql: "select pg_sleep(9999)" }).catch((e) => e);
    expect(err.kind).toBe("timed-out");
    expect(killed.some((k) => /^kill flagship-migrate-[0-9a-f]{12}$/.test(k))).toBe(true);
  });

  const neverConnected = 'psql: error: connection to server at "host.flagship.internal" (10.89.2.1), port 15400 failed: server closed the connection unexpectedly';

  it("tries again when psql never reached the server, then succeeds", async () => {
    let calls = 0;
    await runSandboxedSql({
      cmd: fake(async () => {
        if (++calls < 3) throw Object.assign(new Error("docker exited with code 2"), { stderr: neverConnected });
        return { stdout: "", stderr: "" };
      }),
      target,
      sql: "x",
      connectRetryDelaysMs: [1, 1, 1],
    });
    expect(calls).toBe(3);
  });

  it("gives up after the last retry with psql's words", async () => {
    let calls = 0;
    const err = await runSandboxedSql({
      cmd: fake(async () => { calls++; throw Object.assign(new Error("docker exited with code 2"), { stderr: neverConnected }); }),
      target,
      sql: "x",
      connectRetryDelaysMs: [1, 1],
    }).catch((e) => e);
    expect(calls).toBe(3);
    expect(err.kind).toBe("failed");
    expect(err.message).toContain("server closed the connection unexpectedly");
  });

  it("never runs a migration twice once it reached the server", async () => {
    let calls = 0;
    const err = await runSandboxedSql({
      cmd: fake(async () => { calls++; throw Object.assign(new Error("docker exited with code 3"), { stderr: "psql:<stdin>:1: ERROR: server closed the connection unexpectedly" }); }),
      target,
      sql: "x",
      connectRetryDelaysMs: [1, 1],
    }).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.kind).toBe("failed");
  });

  it("a runner that cannot capture is reported unavailable, never run on the host", async () => {
    const err = await runSandboxedSql({ cmd: { run: async () => {} }, target, sql: "x" }).catch((e) => e);
    expect(err.kind).toBe("unavailable");
  });
});

describe("helpers", () => {
  it("parses the role, database and port out of the app's credential URL", () => {
    expect(targetFromPgUrl("postgresql://r_abc:p%40ss@host.flagship.internal:5432/d_abc")).toEqual({ user: "r_abc", password: "p@ss", database: "d_abc", port: 5432 });
  });
  it("redacts every secret form and keeps the tail", () => {
    expect(boundedRedacted("a p@ss b p%40ss", 100, ["p@ss", "p%40ss"])).toBe("a «redacted» b «redacted»");
    expect(boundedRedacted("0123456789", 4, [])).toBe("…6789");
  });
});

describe("a dedicated database on a box that dials containers directly", () => {
  it("runs as a member of the app on the apps network and reaches the instance through the gateway, with no socket and no extra privilege", () => {
    const plan = buildSandboxPlan({
      target: { user: "r", password: "p", database: "d", port: 15401 },
      member: { serviceId: "alice--shop", network: "flagship-apps", netArgs: ["--dns", "10.89.2.1", "--add-host", "host.flagship.internal:10.89.2.1"] },
    });
    expect(plan.containerName).toMatch(/^flagship-alice--shop\.migrate-[0-9a-f]{12}$/);
    expect(plan.args).toContain("--network=flagship-apps");
    expect(plan.args.join(" ")).not.toContain("type=volume");
    expect(plan.args.join(" ")).toContain("-h host.flagship.internal -p 15401");
    expect(plan.args).toContain("--cap-drop=ALL");
    expect(plan.args).toContain("--read-only");
  });
});

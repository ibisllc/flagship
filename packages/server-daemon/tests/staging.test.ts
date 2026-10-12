/**
 * The private staging copy an AI build runs on (docs/ai-privacy-and-staging.md
 * §2): neutral identity, placeholder owner env, a seeded dev dataspace, the
 * same container hardening as a live app, loopback only — and the box's
 * `check_app` / `get_logs` reach only it.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { UNFENCED_REASON, StagingRunner, STAGING_NETWORK } from "../src/buildmodes/staging.js";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
} from "../src/dataLayer/index.js";
import type { AppSpec, CommandRunner } from "../src/serviceRunner.js";

const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { image: "flagship/notes:0.1.0", port: 8080 },
  data: { stores: { postgres: true } },
  network: { subdomain: "notes" },
  access: { enabled: true, default_role: "member", public_routes: [] },
  migration: { verification: "standard" },
});
const MIGRATION = "CREATE TABLE notes (id SERIAL PRIMARY KEY, title TEXT NOT NULL);";
const FILES = {
  "flagship.app.json": MANIFEST,
  Dockerfile: "FROM node:20-alpine\nEXPOSE 8080",
  "migrations/0001_init.sql": MIGRATION,
};

function recordingCmd(logs = "listening on 8080") {
  const calls: string[][] = [];
  const cmd: CommandRunner = {
    run: async (c, args) => {
      calls.push([c, ...args]);
    },
    capture: async (c, args) => {
      calls.push([c, ...args]);
      return { stdout: args[0] === "logs" ? logs : "", stderr: "" };
    },
  };
  return { cmd, calls };
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function fakeApp(body: string) {
  const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { port, seen };
}

function setup(over: { startOk?: boolean; logs?: string; port?: number } = {}) {
  const { cmd, calls } = recordingCmd(over.logs);
  const postgres = new InMemoryPostgresAdmin();
  const provisioner = new DataProvisioner({
    postgres,
    objects: new InMemoryMinioAdmin(),
    kv: new InMemoryRedisAdmin(),
    endpoints: { postgresHost: "host.flagship.internal" },
  });
  const sql: Array<{ pgUrl: string; sql: string }> = [];
  const started: AppSpec[] = [];
  const workingDir = mkdtempSync(join(tmpdir(), "staging-"));
  const runner = new StagingRunner({
    cmd,
    workingDir,
    dataProvisioner: provisioner,
    runSql: async (a) => {
      sql.push(a);
    },
    startCheck: async (spec) => {
      started.push(spec);
      return over.startOk === false ? { ok: false, reason: "the app didn't start: it stopped (exit code 1)." } : { ok: true };
    },
    pickPort: () => over.port ?? 51234,
    now: () => 1700000000000,
  });
  return { runner, calls, postgres, sql, started, workingDir };
}

const runArgs = (calls: string[][]) => calls.find((c) => c[0] === "docker" && c[1] === "run")!;

describe("StagingRunner", () => {
  it("builds once and runs the copy hardened, on the staging network, with a neutral identity and dev data", async () => {
    const { runner, calls, postgres, sql, started, workingDir } = setup();
    const r = await runner.stage({
      buildId: "b1",
      files: FILES,
      slug: "notes",
      envNames: ["STRIPE_KEY", "FLAGSHIP_SNEAKY", "bad name"],
    });
    expect(r).toEqual({ ok: true, image: "flagship-stg-b1:1700000000000" });

    const builds = calls.filter((c) => c[1] === "build");
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain("flagship-stg-b1:1700000000000");
    expect(builds[0]!.at(-1)).toBe(join(workingDir, ".staging", "b1"));
    expect(calls.some((c) => c[1] === "network" && c[2] === "create" && c.includes(STAGING_NETWORK))).toBe(true);

    const run = runArgs(calls);
    const flag = (name: string) => run[run.indexOf(name) + 1];
    expect(flag("--name")).toBe("flagship-stg-b1");
    expect(flag("--network")).toBe("flagship-staging");
    expect(flag("-p")).toBe("127.0.0.1:51234:8080");
    expect(run).toEqual(expect.arrayContaining(["--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--pids-limit", "--memory"]));
    expect(flag("--tmpfs")).toMatch(/^\/tmp:rw/);
    expect(run.at(-1)).toBe("flagship-stg-b1:1700000000000");

    const env = Object.fromEntries(
      run.flatMap((a, i) => (run[i - 1] === "-e" ? [a.split(/=(.*)/s).slice(0, 2) as [string, string]] : [])),
    );
    expect(env).toMatchObject({
      FLAGSHIP_HOST: "app.example",
      FLAGSHIP_CREATOR: "owner",
      FLAGSHIP_APP_ID: "staging--notes",
      FLAGSHIP_SLUG: "notes",
      TZ: "UTC",
      LANG: "C.UTF-8",
      PORT: "8080",
      STRIPE_KEY: "staging-placeholder",
    });
    expect(env.FLAGSHIP_SNEAKY).toBeUndefined();
    expect(env.FLAGSHIP_APP_TOKEN).toBeUndefined();
    expect(env.FLAGSHIP_PG_DATABASE).toBe("__dev_owner_stg_b1");
    expect(env.FLAGSHIP_PG_URL).toContain("@host.flagship.internal:");
    expect([...postgres.databases.keys()]).toEqual(["__dev_owner_stg_b1"]);

    // Migrations then synthetic rows, as the dev store's own role.
    expect(sql[0]).toEqual({ pgUrl: env.FLAGSHIP_PG_URL, sql: MIGRATION });
    expect(sql[1]!.pgUrl).toBe(env.FLAGSHIP_PG_URL);
    expect(sql[1]!.sql).toMatch(/INSERT INTO "notes"/);
    expect(started[0]).toMatchObject({ serviceId: "stg-b1", port: 51234, containerPort: 8080 });

    expect(runner.staged("b1")).toMatchObject({ image: "flagship-stg-b1:1700000000000", slug: "notes" });
  });

  it("check_app reaches only the copy's loopback port, signed as a neutral owner, and returns the first 4 KB", async () => {
    const app = await fakeApp("x".repeat(6000));
    const { runner } = setup({ port: app.port });
    await runner.stage({ buildId: "b2", files: FILES, slug: "notes" });

    const r = await runner.checkApp("b2", { path: "/items?x=1", method: "post", body: '{"a":1}' });
    expect(r).toMatchObject({ ok: true, status: 201, contentType: "application/json", truncated: true });
    if (r.ok) expect(r.body.length).toBe(4096);

    const got = app.seen[0]!;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/items?x=1");
    expect(got.body).toBe('{"a":1}');
    expect(got.headers).toMatchObject({
      host: "app.example",
      "content-type": "application/json",
      "x-flagship-app-id": "staging--notes",
      "x-flagship-user": "staging-user",
      "x-flagship-role": "owner",
    });
    const pub = await runner.checkApp("b2", { path: "/.flagship/runtime-pubkey" });
    if (!pub.ok) throw new Error(pub.reason);
    const key = Buffer.from(JSON.parse(pub.body).injectorPubKeyHex, "hex");
    const msg = ["flagship/inject/v1", "staging--notes", "staging-user", "owner", got.headers["x-flagship-timestamp"]].join("|");
    expect(ed.verify(Buffer.from(String(got.headers["x-flagship-signature"]), "hex"), new TextEncoder().encode(msg), key)).toBe(true);
    expect(app.seen).toHaveLength(1);

    expect(await runner.checkApp("nope", { path: "/" })).toMatchObject({ ok: false });
    expect(await runner.checkApp("b2", { path: "http://evil.example/" })).toMatchObject({ ok: false });
  });

  it("logs come from the copy only, without timestamps; teardown removes it and its dev data but keeps the image", async () => {
    const { runner, calls, postgres } = setup({ logs: "listening on 8080" });
    expect(await runner.logs("b3")).toBeNull();
    await runner.stage({ buildId: "b3", files: FILES, slug: "notes" });
    expect(await runner.logs("b3")).toBe("listening on 8080");
    const logCall = calls.find((c) => c[1] === "logs")!;
    expect(logCall).toEqual(["docker", "logs", "--tail", "200", "flagship-stg-b3"]);
    expect(logCall).not.toContain("--timestamps");

    await runner.teardown("b3");
    expect(calls).toContainEqual(["docker", "rm", "-f", "flagship-stg-b3"]);
    expect(postgres.databases.size).toBe(0);
    expect(await runner.logs("b3")).toBeNull();
    expect(runner.staged("b3")?.image).toBe("flagship-stg-b3:1700000000000");
    runner.forget("b3");
    expect(runner.staged("b3")).toBeNull();
  });

  it("a copy that won't start is not staged, but its output stays readable to fix it", async () => {
    const { runner } = setup({ startOk: false, logs: "Error: Cannot find module 'express'" });
    const r = await runner.stage({ buildId: "b4", files: FILES, slug: "notes" });
    expect(r).toEqual({ ok: false, reason: "the app didn't start: it stopped (exit code 1)." });
    expect(runner.staged("b4")).toBeNull();
    expect(await runner.logs("b4")).toMatch(/Cannot find module/);
  });

  it("refuses data stores without a data layer, and a manifest that isn't valid", async () => {
    const { cmd } = recordingCmd();
    const runner = new StagingRunner({ cmd, workingDir: mkdtempSync(join(tmpdir(), "staging-")) });
    expect(await runner.stage({ buildId: "b5", files: FILES, slug: "notes" })).toEqual({
      ok: false,
      reason: "the app declares data stores, but this server has no data layer",
    });
    const bad = await runner.stage({ buildId: "b6", files: { "flagship.app.json": "{}" }, slug: "notes" });
    expect(bad.ok).toBe(false);
  });

  it("never builds or runs AI code while the network fence is down", async () => {
    const { cmd, calls } = recordingCmd();
    const runner = new StagingRunner({ cmd, workingDir: mkdtempSync(join(tmpdir(), "staging-")), fenced: () => false });
    expect(await runner.stage({ buildId: "b7", files: FILES, slug: "notes" })).toEqual({ ok: false, reason: UNFENCED_REASON });
    expect(calls.some((c) => c.includes("build") || c.includes("run"))).toBe(false);
  });
});

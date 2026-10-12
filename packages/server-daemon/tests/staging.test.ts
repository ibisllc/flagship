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
import {
  NOT_STAGED_REASON,
  STAGING_NETWORK,
  STAGING_QUERY_MAX_ROWS,
  StagingRunner,
  UNFENCED_REASON,
  stagingDataHooks,
} from "../src/buildmodes/staging.js";
import {
  DataProvisioner,
  InMemoryFilesAdmin,
  InMemoryPostgresAdmin,
  pgDatabase,
} from "../src/dataLayer/index.js";
import type { AppSpec, CommandRunner } from "../src/serviceRunner.js";
import { environmentFailure } from "../src/buildmodes/environmentFailure.js";
import { DataLayerUnavailableError } from "../src/dataLayer/stack.js";

const devDb = (buildId: string) => pgDatabase({ creator: "owner", slug: `stg-${buildId}`, space: "dev" }, "n".repeat(40));

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
    files: new InMemoryFilesAdmin(),
    nameKey: "n".repeat(40),
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
    expect(env.FLAGSHIP_PG_DATABASE).toBe(devDb("b1"));
    expect(env.FLAGSHIP_PG_URL).toContain("@host.flagship.internal:");
    expect([...postgres.databases.keys()]).toEqual([devDb("b1")]);

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

  it("an app with files gets its own DEV files volume at /data, removed with the copy", async () => {
    const { cmd, calls } = recordingCmd();
    const files = new InMemoryFilesAdmin();
    const runner = new StagingRunner({
      cmd,
      workingDir: mkdtempSync(join(tmpdir(), "staging-")),
      dataProvisioner: new DataProvisioner({ files }),
      runSql: async () => {},
      startCheck: async () => ({ ok: true }),
      pickPort: () => 51237,
      now: () => 1700000000000,
    });
    const manifest = { ...JSON.parse(MANIFEST), data: { stores: { files: true } } };
    const { "migrations/0001_init.sql": _migration, ...noMigrations } = FILES;
    void _migration;
    const r = await runner.stage({ buildId: "f1", files: { ...noMigrations, "flagship.app.json": JSON.stringify(manifest) }, slug: "notes" });
    expect(r.ok ? "ok" : (r as { reason?: string }).reason).toBe("ok");
    const volume = "flagship-files-dev--owner-stg-f1";
    expect([...files.volumes.keys()]).toEqual([volume]);
    expect(files.volumes.get(volume)!.labels["flagship.files"]).toBe("dev");
    const run = runArgs(calls);
    expect(run[run.indexOf("--mount") + 1]).toBe(`type=volume,src=${volume},dst=/data`);
    expect(run).toContain("FLAGSHIP_FILES_DIR=/data");
    expect(run).toContain("--read-only");
    await runner.teardown("f1");
    expect(files.volumes.size).toBe(0);
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
      environment: environmentFailure("data-layer"),
    });
    const bad = await runner.stage({ buildId: "b6", files: { "flagship.app.json": "{}" }, slug: "notes" });
    expect(bad.ok).toBe(false);
  });

  it("never builds or runs AI code while the network fence is down", async () => {
    const { cmd, calls } = recordingCmd();
    const runner = new StagingRunner({ cmd, workingDir: mkdtempSync(join(tmpdir(), "staging-")), fenced: () => false });
    expect(await runner.stage({ buildId: "b7", files: FILES, slug: "notes" })).toEqual({
      ok: false,
      reason: UNFENCED_REASON,
      environment: environmentFailure("fence"),
    });
    expect(calls.some((c) => c.includes("build") || c.includes("run"))).toBe(false);
  });
});

/** A docker whose `build` fails with `msg()`. */
function buildFails(msg: () => string): CommandRunner {
  const fail = (args: string[]) => {
    if (args[0] === "build") throw new Error(msg());
  };
  return {
    run: async (_c, args) => fail(args),
    capture: async (_c, args) => {
      fail(args);
      return { stdout: "", stderr: "" };
    },
  };
}

describe("StagingRunner: the box's own failures are never the app's", () => {
  function rig(over: { ready?: () => Promise<void>; startReason?: string; cmd?: CommandRunner } = {}) {
    const { cmd, calls } = recordingCmd();
    const provisioner = new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      files: new InMemoryFilesAdmin(),
      nameKey: "n".repeat(40),
      ...(over.ready ? { ready: over.ready } : {}),
    });
    const runner = new StagingRunner({
      cmd: over.cmd ?? cmd,
      workingDir: mkdtempSync(join(tmpdir(), "staging-")),
      dataProvisioner: provisioner,
      runSql: async () => {},
      startCheck: async () => (over.startReason ? { ok: false, reason: over.startReason } : { ok: true }),
      pickPort: () => 51235,
      now: () => 1700000000000,
      sleep: async () => {},
    });
    return { runner, calls };
  }

  it("a dev dataspace a crashed daemon left behind doesn't block the next copy", async () => {
    const postgres = new InMemoryPostgresAdmin();
    await postgres.createRoleAndDb({ db: devDb("e0"), role: devDb("e0"), password: "x" });
    const runner = new StagingRunner({
      cmd: recordingCmd().cmd,
      workingDir: mkdtempSync(join(tmpdir(), "staging-")),
      dataProvisioner: new DataProvisioner({ postgres, nameKey: "n".repeat(40) }),
      runSql: async () => {},
      pickPort: () => 51236,
      now: () => 1700000000000,
    });
    const r = await runner.stage({ buildId: "e0", files: FILES, slug: "notes" });
    expect(r.ok).toBe(true);
    expect(postgres.databases.has(devDb("e0"))).toBe(true);
  });

  it("a data layer that is down fails at once as an environment failure, with nothing started", async () => {
    const { runner, calls } = rig({
      ready: async () => {
        throw new DataLayerUnavailableError("down", "postgres missing");
      },
    });
    const r = await runner.stage({ buildId: "e1", files: FILES, slug: "notes" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^data provisioning failed: the data layer/);
    expect(r.environment).toEqual(environmentFailure("data-layer"));
    expect(r.environment!.ownerReason).toMatch(/database isn't running/);
    expect(calls.some((c) => c[1] === "run")).toBe(false);
  });

  it("a stack still starting says so", async () => {
    const { runner } = rig({
      ready: async () => {
        throw new DataLayerUnavailableError("starting");
      },
    });
    const r = await runner.stage({ buildId: "e2", files: FILES, slug: "notes" });
    expect(!r.ok && r.environment?.ownerReason).toMatch(/still starting/);
  });

  it("an app that can't reach its database is the app's problem only while the stores are up", async () => {
    let down = false;
    const { runner } = rig({
      ready: async () => {
        if (down) throw new DataLayerUnavailableError("down", "postgres exited");
      },
      startReason: "the app didn't start: Error: connect ECONNREFUSED 172.30.2.1:5432",
    });
    const up = await runner.stage({ buildId: "e3", files: FILES, slug: "notes" });
    expect(!up.ok && up.environment).toBeUndefined();
    down = true;
    // The stage's own provisioning now refuses first; either way it's the box's.
    const r = await runner.stage({ buildId: "e3", files: FILES, slug: "notes" });
    expect(!r.ok && r.environment?.kind).toBe("data-layer");
  });

  it("a docker daemon that's gone, or a full disk, is the box's", async () => {
    const failing = (msg: string) => buildFails(() => msg);
    const docker = await rig({
      cmd: failing("docker exited with code 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"),
    }).runner.stage({ buildId: "e4", files: FILES, slug: "notes" });
    expect(!docker.ok && docker.environment?.kind).toBe("docker");
    const disk = await rig({ cmd: failing("docker exited with code 1: write /var/lib/docker/tmp/x: no space left on device") }).runner.stage({
      buildId: "e5",
      files: FILES,
      slug: "notes",
    });
    expect(!disk.ok && disk.environment?.kind).toBe("disk");
  });

  it("a registry outage is retried once, then reported as the box's", async () => {
    let builds = 0;
    const cmd = buildFails(() => {
      builds++;
      return 'docker exited with code 1: Step 1/2 : FROM node:20-alpine\nGet "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)';
    });
    const r = await rig({ cmd }).runner.stage({ buildId: "e6", files: FILES, slug: "notes" });
    expect(builds).toBe(2);
    expect(!r.ok && r.environment?.kind).toBe("registry");
  });

  it("the app's own build failure stays the app's", async () => {
    const cmd = buildFails(
      () => "docker exited with code 1: npm ERR! missing script: build\nThe command '/bin/sh -c npm run build' returned a non-zero code: 1",
    );
    const r = await rig({ cmd }).runner.stage({ buildId: "e7", files: FILES, slug: "notes" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.environment).toBeUndefined();
  });
});

describe("StagingRunner: the AI's data tools see only the tested copy's sample data", () => {
  function dataRig(over: { startOk?: boolean; stores?: Record<string, unknown>; findOut?: string; headOut?: string } = {}) {
    const calls: string[][] = [];
    const cmd: CommandRunner = {
      run: async (c, args) => void calls.push([c, ...args]),
      capture: async (c, args) => {
        calls.push([c, ...args]);
        if (args.includes("find")) return { stdout: over.findOut ?? "d\t4096\tuploads\nf\t12\tuploads/a.txt\n", stderr: "" };
        if (args.includes("head")) return { stdout: over.headOut ?? "hello sample", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    };
    const queries: Array<Record<string, unknown>> = [];
    const runner = new StagingRunner({
      cmd,
      workingDir: mkdtempSync(join(tmpdir(), "staging-")),
      dataProvisioner: new DataProvisioner({
        postgres: new InMemoryPostgresAdmin(),
        files: new InMemoryFilesAdmin(),
        nameKey: "n".repeat(40),
        endpoints: { postgresHost: "host.flagship.internal" },
      }),
      runSql: async () => {},
      startCheck: async () => (over.startOk === false ? { ok: false, reason: "crashed" } : { ok: true }),
      pickPort: () => 51240,
      now: () => 1700000000000,
      sql: {
        query: async (a) => {
          queries.push({ ...a });
          return { command: "SELECT", columns: [{ name: "title", type: "text" }], rows: [["x".repeat(400)]], rowCount: 1, truncated: true };
        },
        listTables: async (a) => {
          queries.push({ op: "listTables", ...a });
          return [{ name: "notes", kind: "table", rows: 12, bytes: 8192, columns: [{ name: "id", type: "integer", nullable: false }] }];
        },
        tableRows: async () => {
          throw new Error("not for the AI");
        },
        exportCsv: async () => {
          throw new Error("not for the AI");
        },
      },
    });
    const manifest = { ...JSON.parse(MANIFEST), data: { stores: over.stores ?? { postgres: true, files: true } } };
    const files = { ...FILES, "flagship.app.json": JSON.stringify(manifest) };
    return { runner, calls, queries, files };
  }

  it("refuses before any deploy, and answers on a copy whose app didn't start (to debug it)", async () => {
    const { runner, files } = dataRig({ startOk: false });
    expect(await runner.queryDb("d1", { sql: "SELECT 1" })).toEqual({ ok: false, reason: NOT_STAGED_REASON });
    await runner.stage({ buildId: "d1", files, slug: "notes" });
    expect((await runner.queryDb("d1", { sql: "SELECT 1" })).ok).toBe(true);
    expect((await runner.listTables("d1", {})).ok).toBe(true);
  });

  it("query_db runs as the dev role on the dev database, capped at 200 rows, cells shortened", async () => {
    const { runner, queries, files } = dataRig();
    await runner.stage({ buildId: "d2", files, slug: "notes" });
    const r = await runner.queryDb("d2", { sql: "SELECT title FROM notes" });
    expect(r.ok).toBe(true);
    const q = queries[0]!;
    expect(String(q.pgUrl)).toContain(`/${devDb("d2")}`);
    expect(String(q.pgUrl)).toContain(`${devDb("d2")}:`);
    expect(q).toMatchObject({ readOnly: false, maxRows: STAGING_QUERY_MAX_ROWS, timeoutMs: 10_000 });
    const body = JSON.parse((r as { text: string }).text);
    expect(body.columns).toEqual(["title text"]);
    expect(body.rows[0][0]).toHaveLength(301);
    expect(body.truncated).toBe(true);
    expect(await runner.queryDb("d2", { sql: "SELECT 1", store: "levels" })).toMatchObject({ ok: false, reason: expect.stringMatching(/no store named/) });
    expect(await runner.queryDb("d2", { sql: " " })).toMatchObject({ ok: false });

    const t = await runner.listTables("d2", {});
    expect(JSON.parse((t as { text: string }).text)).toEqual({ tables: [{ name: "notes", rows: 12, columns: ["id integer not null"] }] });

    // Once the copy is gone, nothing answers.
    await runner.teardown("d2");
    expect(await runner.queryDb("d2", { sql: "SELECT 1" })).toEqual({ ok: false, reason: NOT_STAGED_REASON });
  });

  it("an app with several stores must name one", async () => {
    const { runner, files } = dataRig({ stores: { postgres: ["sprites", "levels"] } });
    await runner.stage({ buildId: "d3", files, slug: "notes" });
    expect(await runner.queryDb("d3", { sql: "SELECT 1" })).toMatchObject({ ok: false, reason: "say which store: sprites, levels" });
    expect((await runner.queryDb("d3", { sql: "SELECT 1", store: "levels" })).ok).toBe(true);
    expect(await runner.listDataFiles("d3", {})).toMatchObject({ ok: false, reason: expect.stringMatching(/no files folder/) });
  });

  it("list_data_files lists the DEV volume read-only from a container with no network", async () => {
    const { runner, calls, files } = dataRig();
    await runner.stage({ buildId: "d4", files, slug: "notes" });
    const r = await runner.listDataFiles("d4", { path: "/data/uploads/" });
    expect(JSON.parse((r as { text: string }).text)).toEqual({
      root: "/data/uploads",
      files: [{ path: "uploads/" }, { path: "uploads/a.txt", bytes: 12 }],
    });
    const run = calls.find((c) => c.includes("find"))!;
    const flag = (n: string) => run[run.indexOf(n) + 1];
    expect(flag("--network")).toBe("none");
    expect(flag("--mount")).toBe("type=volume,src=flagship-files-dev--owner-stg-d4,dst=/data,readonly");
    expect(run).toEqual(expect.arrayContaining(["--rm", "--read-only", "--cap-drop", "ALL", "no-new-privileges"]));
    expect(run.slice(run.indexOf("find"))).toContain("/data/uploads");
    for (const bad of ["../etc", "uploads/../../x", "-delete", "a\0b", "a;b"]) {
      expect(await runner.listDataFiles("d4", { path: bad }), bad).toMatchObject({ ok: false });
    }
  });

  it("read_data_file shows the start of a text file and never a binary one", async () => {
    const text = dataRig({ headOut: "hello sample" });
    await text.runner.stage({ buildId: "d5", files: text.files, slug: "notes" });
    expect(JSON.parse(((await text.runner.readDataFile("d5", { path: "uploads/a.txt" })) as { text: string }).text)).toEqual({
      path: "/data/uploads/a.txt",
      content: "hello sample",
    });
    const run = text.calls.find((c) => c.includes("head"))!;
    expect(run.slice(run.indexOf("head"))).toEqual(["head", expect.any(String), "-c", "16385", "/data/uploads/a.txt"]);
    expect(await text.runner.readDataFile("d5", { path: "" })).toMatchObject({ ok: false });

    const bin = dataRig({ headOut: "PNG\u0000\u0001" });
    await bin.runner.stage({ buildId: "d6", files: bin.files, slug: "notes" });
    expect(JSON.parse(((await bin.runner.readDataFile("d6", { path: "img.png" })) as { text: string }).text)).toMatchObject({ binary: true });
  });

  it("stagingDataHooks refuses once sealed and when staging has no data tools", async () => {
    const { runner, files } = dataRig();
    await runner.stage({ buildId: "d7", files, slug: "notes" });
    let sealed = false;
    const hooks = stagingDataHooks(runner, "d7", () => sealed);
    expect((await hooks.queryDb({ sql: "SELECT 1" })).ok).toBe(true);
    sealed = true;
    expect(await hooks.queryDb({ sql: "SELECT 1" })).toMatchObject({ ok: false, reason: expect.stringMatching(/closed/) });
    const none = stagingDataHooks({ ...runner, queryDb: undefined } as never, "d7");
    expect(await none.queryDb({ sql: "SELECT 1" })).toMatchObject({ ok: false });
  });
});

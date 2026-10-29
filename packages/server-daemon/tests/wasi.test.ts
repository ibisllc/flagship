/**
 * P04 WASI on the box (docs/wasi-apps.md): the worker's unit and its fences,
 * the config the Rust worker reads (checked against the real binary when it
 * is built), the runner's lifecycle, the capability broker's refusals, the
 * module store, the upload route and the deploy pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ed, signInstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import { GUEST_CONFIG, WASI_WORKER_BIN, wasiDropIn, wasiInstance, wasiTemplateUnit, wasiUnitName } from "../src/wasi/unit.js";
import { WasiRunner, wasiSecretEnv, wasiWorkerConfig, DEFAULT_WASI_RUN_LIMITS, type WasiAppSpec } from "../src/wasi/runner.js";
import { WasiCapabilityBroker, CapabilityDenied } from "../src/wasi/broker.js";
import { wasiHostCalls, publicOnlyLookup, type Fetcher } from "../src/wasi/hostCalls.js";
import { WasiModuleStore, moduleDigest } from "../src/wasi/moduleStore.js";
import { ensureWasiRuntime } from "../src/wasi/install.js";
import { RuntimeRouter } from "../src/appRuntimes.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { buildAppRuntimeHttp } from "../src/appRuntimeHttp.js";
import { buildAppImage, wasiModulePath } from "../src/buildmodes/deployArtifact.js";
import { parseAppManifest } from "../src/appModel.js";
import { BOX_CAPABILITIES_0_3 } from "@flagship/protocol";
import type { AppSpec, CommandRunner } from "../src/serviceRunner.js";
import type { HttpRequest } from "../src/runtime.js";

const REPO = resolve(__dirname, "../../..");
const FIXTURE = readFileSync(join(REPO, "rust/crates/flagship-wasi/tests/fixtures/sdk-wasi-fixture.wasm"));
const HOSTCALLS = readFileSync(join(REPO, "rust/crates/flagship-wasi/tests/fixtures/sdk-wasi-hostcalls.wasm"));
const WORKER_BIN = [join(REPO, "rust/target/debug/flagship-wasi-worker"), join(REPO, "rust/target/release/flagship-wasi-worker")].find((p) => existsSync(p));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wasi-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spec(over: Partial<WasiAppSpec> = {}, base: Partial<AppSpec> = {}): AppSpec {
  return {
    serviceId: "alice--notes",
    image: "app.wasm",
    port: 50123,
    containerPort: 8080,
    env: {
      FLAGSHIP_APP_ID: "alice--notes",
      FLAGSHIP_CREATOR: "alice",
      FLAGSHIP_SLUG: "notes",
      FLAGSHIP_HOST: "alice",
      PORT: "8080",
      FLAGSHIP_APP_TOKEN: "tok",
      FLAGSHIP_PG_URL: "postgresql://r:pw@host.flagship.internal:5432/d",
      FLAGSHIP_FILES_DIR: "/data",
      API_KEY: "owner-secret",
    },
    filesVolume: "flagship-files-alice--notes",
    wasi: {
      world: "http-proxy",
      moduleDigest: moduleDigest(FIXTURE),
      files: true,
      egressHosts: [],
      postgres: {},
      runLimits: DEFAULT_WASI_RUN_LIMITS,
      maxConcurrentRuns: 4,
      unit: { memoryMiB: 384, tasks: 64, cpuPercent: 100, restart: "on-failure" },
      ...over,
    },
    ...base,
  };
}

describe("the worker's unit", () => {
  it("fences every worker: own dynamic user, empty /var, loopback only, no capabilities", () => {
    const u = wasiTemplateUnit();
    for (const line of [
      "DynamicUser=yes",
      "User=fwasi-%i",
      "TemporaryFileSystem=/var:ro",
      "BindReadOnlyPaths=/var/lib/flagship-wasi/apps/%i:/var/app/pkg",
      "NoNewPrivileges=yes",
      "ProtectSystem=strict",
      "PrivateDevices=yes",
      "CapabilityBoundingSet=",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      "RestrictNamespaces=yes",
      "SystemCallFilter=@system-service",
      "MemorySwapMax=0",
    ]) {
      expect(u).toContain(`${line}\n`);
    }
    expect(u).toMatch(/InaccessiblePaths=.*-\/run\/flagship-daemon.*-\/run\/docker\.sock/);
    // Cranelift maps code it compiled: the one setting left off, on purpose.
    expect(u).not.toMatch(/MemoryDenyWriteExecute=yes/);
    expect(() => wasiTemplateUnit("/bad path")).toThrow();
  });

  it("names instances by a hash, short enough for a dynamic user", () => {
    expect(wasiInstance("alice--notes")).toMatch(/^[0-9a-f]{16}$/);
    expect(wasiUnitName("alice--notes")).toBe(`flagship-wasi@${wasiInstance("alice--notes")}.service`);
    expect(`fwasi-${wasiInstance("x--y")}`.length).toBeLessThanOrEqual(31);
    expect(wasiInstance("alice--notes")).not.toBe(wasiInstance("bob--notes"));
  });

  it("writes the app's limits, world and files folder into its drop-in", () => {
    const d = wasiDropIn({ world: "command", memoryMiB: 99999, tasks: 2, cpuPercent: 50, restart: "never", filesHostPath: "/var/lib/flagship-files/flagship-files-alice--notes/data" });
    expect(d).toContain(`ExecStart=${WASI_WORKER_BIN} run --config ${GUEST_CONFIG}\n`);
    expect(d).toContain("Restart=no\n");
    expect(d).toContain("MemoryMax=8192M\n");
    expect(d).toContain("TasksMax=8\n");
    expect(d).toContain("BindPaths=/var/lib/flagship-files/flagship-files-alice--notes/data:/var/app/data\n");
    expect(() => wasiDropIn({ world: "http-proxy", memoryMiB: 1, tasks: 1, cpuPercent: 1, restart: "always", filesHostPath: "/x y" })).toThrow();
  });
});

describe("the worker's config", () => {
  it("names the approved digest and the app, and keeps every secret off disk", () => {
    const c = wasiWorkerConfig(spec({ egressHosts: ["api.example.com"], postgres: { default: { url: "u", database: "d", role: "r" } } }));
    expect(c).toMatchObject({
      schema: "flagship/wasi-worker/v1",
      approvedDigest: moduleDigest(FIXTURE),
      listen: "127.0.0.1:50123",
      filesDir: "/var/app/data",
      capSocket: "/var/app/pkg/cap.sock",
      env: { FLAGSHIP_APP_ID: "alice--notes", FLAGSHIP_CREATOR: "alice", FLAGSHIP_SLUG: "notes", FLAGSHIP_HOST: "alice" },
      manifest: { appId: "alice--notes", world: "http-proxy", network: { egress: ["api.example.com"] }, data: { stores: { files: true, postgres: ["default"] } } },
    });
    const text = JSON.stringify(c);
    expect(text).not.toContain("owner-secret");
    expect(text).not.toContain("pw@");
    expect(text).not.toContain("tok");
    expect(wasiSecretEnv(spec())).toEqual({ API_KEY: "owner-secret" });
  });

  it.skipIf(!WORKER_BIN)("is what the Rust worker accepts (checked with the built binary)", async () => {
    const pkg = join(dir, "pkg");
    await mkdir(pkg);
    await writeFile(join(pkg, "module.wasm"), FIXTURE);
    const c = wasiWorkerConfig(spec());
    // The binary runs here, not in its namespace: point the guest paths at this folder.
    const local = { ...c, modulePath: join(pkg, "module.wasm"), filesDir: dir, capSocket: undefined };
    delete (local as { capSocket?: unknown }).capSocket;
    await writeFile(join(pkg, "worker.json"), JSON.stringify(local));
    const out = execFileSync(WORKER_BIN!, ["check", "--config", join(pkg, "worker.json")], { encoding: "utf8" });
    expect(JSON.parse(out)).toMatchObject({ ok: true, appId: "alice--notes", digest: moduleDigest(FIXTURE), world: "http-proxy" });
    // The hostcalls module needs its capabilities in the same config.
    await writeFile(join(pkg, "module.wasm"), HOSTCALLS);
    const hc = wasiWorkerConfig(spec({ moduleDigest: moduleDigest(HOSTCALLS), files: false }));
    await writeFile(join(pkg, "worker.json"), JSON.stringify({ ...hc, modulePath: join(pkg, "module.wasm"), capSocket: undefined }));
    expect(() => execFileSync(WORKER_BIN!, ["check", "--config", join(pkg, "worker.json")], { encoding: "utf8", stdio: "pipe" })).toThrow(/does not declare/);
    const ok = wasiWorkerConfig(spec({ moduleDigest: moduleDigest(HOSTCALLS), files: false, egressHosts: ["api.example.com"], postgres: { default: { url: "u", database: "d", role: "r" } } }));
    await writeFile(join(pkg, "worker.json"), JSON.stringify({ ...ok, modulePath: join(pkg, "module.wasm"), capSocket: undefined }));
    expect(JSON.parse(execFileSync(WORKER_BIN!, ["check", "--config", join(pkg, "worker.json")], { encoding: "utf8" })).ok).toBe(true);
  });
});

function fakeSystemd(states: Record<string, string> = {}) {
  const calls: string[] = [];
  const cmd: CommandRunner = {
    run: async (c, a) => void calls.push(`${c} ${a.join(" ")}`),
    capture: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "systemctl" && a[0] === "show") return { stdout: states[a[1]!] ?? "ActiveState=active\nResult=success\n", stderr: "" };
      if (c === "journalctl") return { stdout: "[wasi] serving\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  return { calls, cmd };
}

function runnerFor(cmd: CommandRunner, available = true) {
  const modules = new WasiModuleStore(join(dir, "modules"));
  const broker = new WasiCapabilityBroker({ hello: async () => ({}), httpFetch: async () => ({}), dbQuery: async () => ({}) });
  const runner = new WasiRunner({
    cmd,
    modules,
    broker,
    available: () => available,
    filesHostPath: async (v) => `/var/lib/flagship-files/${v}/data`,
    appsDir: join(dir, "apps"),
    dropInRoot: join(dir, "run"),
    answers: async () => true,
    sleep: async () => {},
    startTimeoutMs: 50,
  });
  return { runner, modules, broker };
}

describe("WASI lifecycle", () => {
  it("deploys: module and config in the app's folder, its socket, its drop-in, then the unit", async () => {
    const { calls, cmd } = fakeSystemd();
    const { runner, modules, broker } = runnerFor(cmd);
    await modules.put(FIXTURE);
    await runner.deploy(spec());
    const appDir = join(dir, "apps", wasiInstance("alice--notes"));
    expect(await readFile(join(appDir, "module.wasm"))).toEqual(FIXTURE);
    expect(JSON.parse(await readFile(join(appDir, "worker.json"), "utf8")).approvedDigest).toBe(moduleDigest(FIXTURE));
    expect(existsSync(join(appDir, "cap.sock"))).toBe(true);
    const unit = wasiUnitName("alice--notes");
    expect(await readFile(join(dir, "run", `${unit}.d`, "50-app.conf"), "utf8")).toContain("BindPaths=/var/lib/flagship-files/flagship-files-alice--notes/data:/var/app/data");
    expect(calls).toEqual([`systemctl stop ${unit}`, "systemctl daemon-reload", `systemctl reset-failed ${unit}`, `systemctl start --no-block ${unit}`]);
    expect(runner.context("alice--notes")?.secretEnv).toEqual({ API_KEY: "owner-secret" });
    expect(await runner.check(spec())).toEqual({ ok: true });
    // Freeze for a backup, thaw after.
    const thaw = await runner.freeze("alice--notes");
    await thaw!();
    expect(calls.slice(-2)).toEqual([`systemctl freeze ${unit}`, `systemctl thaw ${unit}`]);
    // Uninstall drops its folder, drop-in and socket.
    await runner.remove("alice--notes");
    expect(existsSync(appDir)).toBe(false);
    await broker.closeAll();
  });

  it("refuses to deploy a module the store doesn't hold, or on a box without the worker", async () => {
    const { cmd } = fakeSystemd();
    await expect(runnerFor(cmd).runner.deploy(spec())).rejects.toThrow();
    await expect(runnerFor(cmd, false).runner.deploy(spec())).rejects.toThrow(/cannot run WebAssembly apps/);
  });

  it("start check: a crashed worker fails with its last output; a command app passes when it finished cleanly", async () => {
    const unit = wasiUnitName("alice--notes");
    const { cmd } = fakeSystemd({ [unit]: "ActiveState=failed\nResult=exit-code\n" });
    const r = await runnerFor(cmd).runner.check(spec());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/didn't start.*serving/s);
    const done = fakeSystemd({ [unit]: "ActiveState=inactive\nResult=success\n" });
    expect(await runnerFor(done.cmd).runner.check(spec({ world: "command" }))).toEqual({ ok: true });
  });
});

async function ask(path: string, line: string): Promise<unknown> {
  return new Promise((res, rej) => {
    const s = connect(path, () => s.write(`${line}\n`));
    let buf = "";
    s.on("data", (d) => (buf += d.toString()));
    s.on("end", () => res(JSON.parse(buf)));
    s.on("error", rej);
  });
}

describe("the capability broker (host calls)", () => {
  const ctx = {
    secretEnv: { API_KEY: "s" },
    egressHosts: ["api.example.com", "denied.example.com", "new.example.com"],
    postgres: { default: { url: "postgresql://r:p@host.flagship.internal:15400/d", database: "d", role: "r" } },
  };
  const unmatched: string[] = [];
  const fetched: Parameters<Fetcher>[0][] = [];
  const handlers = wasiHostCalls({
    context: (id) => (id === "alice--notes" ? ctx : undefined),
    accessRules: () => [
      { action: "allow", target: "api.example.com" },
      { action: "deny", target: "denied.example.com" },
    ] as never,
    onUnmatched: (id, host) => unmatched.push(`${id} ${host}`),
    fetcher: async (a) => {
      fetched.push(a);
      return { status: 200, headers: { "content-type": "text/plain" }, body: "hi" };
    },
    pgConnect: async ({ pgUrl }) => ({
      query: async (cfg: { text: string; values?: unknown[] }) => ({ command: "SELECT", rowCount: 1, fields: [{ name: "n", dataTypeID: 23 }], rows: [{ n: 1, url: pgUrl, text: cfg.text, values: cfg.values }] }),
      end: async () => {},
    }) as never,
  });

  it("answers over the app's own socket: hello, an approved fetch, a query", async () => {
    const broker = new WasiCapabilityBroker(handlers);
    const sock = join(dir, "cap.sock");
    await broker.open("alice--notes", sock);
    expect(await ask(sock, JSON.stringify({ op: "hello" }))).toEqual({ ok: true, result: { env: { API_KEY: "s" } } });
    expect(await ask(sock, JSON.stringify({ op: "http_fetch", request: { method: "POST", url: "https://api.example.com/v1", headers: { "x-k": "1" }, body: "{}" } }))).toMatchObject({ ok: true, result: { status: 200, body: "hi" } });
    expect(fetched[0]!.url.toString()).toBe("https://api.example.com/v1");
    expect(fetched[0]!.headers).toEqual({ "x-k": "1" });
    const q = (await ask(sock, JSON.stringify({ op: "db_query", request: { sql: "select $1::int as n", params: [1] } }))) as { ok: boolean; result: { rows: Array<{ url: string; values: unknown[] }> } };
    expect(q.ok).toBe(true);
    // As the app's own role; the connector (realPgConnect) points it at where the endpoint table says the instance is.
    expect(q.result.rows[0]!.url).toContain("@host.flagship.internal:15400/d");
    expect(q.result.rows[0]!.values).toEqual([1]);
    expect(await ask(sock, "{not json")).toMatchObject({ ok: false, code: "failed" });
    expect(await ask(sock, JSON.stringify({ op: "spawn_shell" }))).toMatchObject({ ok: false, code: "denied" });
    await broker.closeAll();
    expect(existsSync(sock)).toBe(false);
  });

  it("refuses what the manifest doesn't declare or the owner hasn't allowed, and raises the access request", async () => {
    const broker = new WasiCapabilityBroker(handlers);
    const call = (op: string, request: unknown) => broker.answer("alice--notes", JSON.stringify({ op, request }));
    expect(await call("http_fetch", { url: "https://evil.example/" })).toMatchObject({ ok: false, code: "denied", error: expect.stringMatching(/not in this app's network.egress/) });
    expect(await call("http_fetch", { url: "https://denied.example.com/" })).toMatchObject({ ok: false, code: "denied", error: expect.stringMatching(/denies/) });
    expect(await call("http_fetch", { url: "https://new.example.com/" })).toMatchObject({ ok: false, code: "denied", error: expect.stringMatching(/not allowed new\.example\.com/) });
    expect(unmatched).toContain("alice--notes new.example.com");
    expect(await call("http_fetch", { url: "https://user:pw@api.example.com/" })).toMatchObject({ code: "denied" });
    expect(await call("http_fetch", { url: "file:///etc/passwd" })).toMatchObject({ code: "denied" });
    expect(await call("http_fetch", { url: "https://api.example.com/", headers: { Host: "x" } })).toMatchObject({ code: "denied" });
    expect(await call("http_fetch", { url: "https://api.example.com/", headers: { "X-Flagship-User": "admin" } })).toMatchObject({ code: "denied" });
    expect(await call("http_fetch", { method: "CONNECT", url: "https://api.example.com/" })).toMatchObject({ code: "denied" });
    expect(await call("db_query", { sql: "COPY x TO STDOUT" })).toMatchObject({ code: "denied" });
    expect(await call("db_query", { sql: "select 1", store: "other" })).toMatchObject({ code: "denied" });
    // Another app (no context here) gets nothing.
    expect(await broker.answer("bob--x", JSON.stringify({ op: "hello" }))).toMatchObject({ ok: false, code: "denied" });
    expect(new CapabilityDenied("x")).toBeInstanceOf(Error);
  });

  it("never resolves an approved name to a private address", async () => {
    const err = await new Promise<Error | null>((res) => publicOnlyLookup("localhost", {}, (e) => res(e)));
    expect(err?.message).toMatch(/private address/);
  });
});

describe("module store, upload and install", () => {
  it("stores core modules by digest and refuses anything else", async () => {
    const s = new WasiModuleStore(join(dir, "m"));
    const d = await s.put(FIXTURE);
    expect(d).toBe(moduleDigest(FIXTURE));
    expect(await s.has(d)).toBe(true);
    expect(await s.read(d)).toEqual(FIXTURE);
    await expect(s.put(Buffer.from("not wasm at all"))).rejects.toThrow(/core module/);
    await expect(s.put(Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]))).rejects.toThrow(/core module/);
    await writeFile(s.path(d), Buffer.from("tampered"));
    await expect(s.read(d)).rejects.toThrow(/does not match/);
    expect(await s.sweep(new Set())).toEqual([d]);
  });

  it("the owner uploads a module; only an owner session may", async () => {
    const modules = new WasiModuleStore(join(dir, "m"));
    let allow = true;
    const handle = buildAppRuntimeHttp({
      gate: { check: () => (allow ? null : { status: 401, headers: {}, body: "no" }) },
      modules,
      wasi: () => ({ available: true }),
      platform: () => null,
      router: new RuntimeRouter(fakeSystemd().cmd),
      cmd: fakeSystemd().cmd,
    });
    const req = (path: string, method: string, body = Buffer.alloc(0)) => ({ path, method, headers: {}, body }) as unknown as HttpRequest;
    const up = await handle(req("/api/wasi/modules", "POST", FIXTURE));
    expect(up!.status).toBe(200);
    expect(JSON.parse(String(up!.body))).toEqual({ digest: moduleDigest(FIXTURE) });
    expect((await handle(req("/api/wasi/modules", "POST", Buffer.from("x"))))!.status).toBe(400);
    expect(JSON.parse(String((await handle(req("/api/wasi/status", "GET")))!.body))).toEqual({ available: true, worlds: ["command", "http-proxy"] });
    allow = false;
    expect((await handle(req("/api/wasi/modules", "POST", FIXTURE)))!.status).toBe(401);
    expect(await handle(req("/api/other", "GET"))).toBeNull();
  });

  it("an install must name the module's digest, and only a box with the worker admits it", () => {
    const m = (digest?: string) =>
      JSON.stringify({
        schema_version: 2,
        name: "notes",
        version: "1.0.0",
        runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080, ...(digest ? { digest } : {}) },
        data: { stores: { files: true } },
        network: { subdomain: "notes" },
        access: { enabled: true, default_role: "viewer" },
        migration: { portable: true, verification: "standard" },
      });
    const wasiBox = { ...BOX_CAPABILITIES_0_3, wasiWorlds: ["command" as const, "http-proxy" as const] };
    expect(parseAppManifest(m(moduleDigest(FIXTURE)), BOX_CAPABILITIES_0_3)).toMatchObject({ ok: false, errors: [expect.stringMatching(/WebAssembly/)] });
    expect(parseAppManifest(m(), wasiBox)).toMatchObject({ ok: false, errors: [expect.stringMatching(/digest/)] });
    const ok = parseAppManifest(m(moduleDigest(FIXTURE)), wasiBox);
    expect(ok.ok && ok.app.wasi).toEqual({ module: "app.wasm", world: "http-proxy", digest: moduleDigest(FIXTURE) });
  });

  it("a deploy of a WASI app's files stores its module and names the digest", async () => {
    const modules = new WasiModuleStore(join(dir, "m"));
    const files = { "flagship.app.json": JSON.stringify({ runtime: { kind: "wasi", module: "dist/app.wasm" } }) };
    expect(wasiModulePath(files["flagship.app.json"])).toBe("dist/app.wasm");
    expect(wasiModulePath(JSON.stringify({ runtime: { kind: "wasi", module: "../x.wasm" } }))).toBe("");
    expect(wasiModulePath(JSON.stringify({ runtime: { image: "x" } }))).toBeNull();
    const built = await buildAppImage(fakeSystemd().cmd, { contextDir: join(dir, "ctx"), files, binaries: { "dist/app.wasm": FIXTURE }, image: "unused", wasiModules: modules });
    expect(built).toEqual({ ok: true, wasiDigest: moduleDigest(FIXTURE) });
    const missing = await buildAppImage(fakeSystemd().cmd, { contextDir: join(dir, "ctx2"), files, image: "unused", wasiModules: modules });
    expect(missing).toMatchObject({ ok: false, reason: expect.stringMatching(/wasm32-wasip1/) });
  });
});

describe("a WASI app through ServicePlatform", () => {
  function key(): Keypair {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  }

  it("installs, updates to a new module and uninstalls, without a container", async () => {
    const { calls, cmd } = fakeSystemd();
    const { runner, modules, broker } = runnerFor(cmd);
    await modules.put(FIXTURE);
    await modules.put(HOSTCALLS);
    const router = new RuntimeRouter(cmd);
    router.setWasiRunner(runner);
    const irk = key();
    const p = new ServicePlatform({
      host: { username: "alice", irkPub: irk.publicKey },
      swk: swkOps(new Uint8Array(32).fill(3)),
      appRunner: router,
      dataProvisioner: null,
      runtimeCapabilities: () => router.capabilities(true),
      startCheck: router.startCheck(undefined),
      onAppForgotten: (id) => router.forget(id),
    });
    const manifest = (digest: string, version = "1.0.0") =>
      JSON.stringify({
        schema_version: 2,
        name: "notes",
        version,
        runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080, digest },
        data: {},
        network: { subdomain: "notes" },
        access: { enabled: true, default_role: "viewer" },
        migration: { portable: true, verification: "standard" },
        resources: { memoryMiB: 32 },
      });
    const sign = (manifestJson: string) => {
      const request = { serverId: "home.alice.flagship.services", creator: "alice", slug: "notes", manifestJson, addOwnerToMembership: false, issuedAt: Date.now() };
      return { request, signature: signInstallService(request, irk), verify: () => true };
    };
    const r = await p.install(sign(manifest(moduleDigest(FIXTURE))));
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(router.kindOf("alice--notes")).toBe("wasi");
    const cfg = JSON.parse(await readFile(join(dir, "apps", wasiInstance("alice--notes"), "worker.json"), "utf8"));
    expect(cfg.manifest.limits.memoryMiB).toBe(32);
    expect(calls.some((c) => c.startsWith("docker"))).toBe(false);
    const up = await p.redeploy(sign(manifest(moduleDigest(HOSTCALLS), "2.0.0")));
    expect(up.ok, up.ok ? "" : up.reason).toBe(true);
    expect(p.byServiceId("alice--notes")!.app!.wasi!.digest).toBe(moduleDigest(HOSTCALLS));
    await (p as unknown as { destroyApp(id: string, app: unknown, slug: string): Promise<unknown> }).destroyApp("alice--notes", p.byServiceId("alice--notes"), "notes");
    expect(existsSync(join(dir, "apps", wasiInstance("alice--notes")))).toBe(false);
    await broker.closeAll();
  });
});

describe("installing the worker", () => {
  it("installs only the binary the release pins, with its unit", async () => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, "installer/rust"), { recursive: true });
    const bin = Buffer.from("worker-binary");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(bin).digest("hex");
    await writeFile(join(repo, "installer/rust/flagship-wasi-worker"), bin);
    const written = new Map<string, string | Buffer>();
    const ran: string[] = [];
    const deps = {
      repoPath: repo,
      run: async (c: string, a: string[]) => void ran.push(`${c} ${a.join(" ")}`),
      hasSystemd: () => true,
      write: async (p: string, d: string | Buffer) => void written.set(p, d),
      mkdirp: async () => {},
      binPath: join(dir, "bin/flagship-wasi-worker"),
      unitPath: join(dir, "flagship-wasi@.service"),
    };
    expect(await ensureWasiRuntime(deps)).toEqual({ available: false, reason: "this release carries no WebAssembly worker" });
    await writeFile(join(repo, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-wasi-worker": "0".repeat(64) } }));
    expect(await ensureWasiRuntime(deps)).toMatchObject({ available: false, reason: expect.stringMatching(/does not match its pin/) });
    await writeFile(join(repo, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-wasi-worker": sha } }));
    expect(await ensureWasiRuntime(deps)).toEqual({ available: true, sha256: sha, changed: true });
    expect(written.get(deps.binPath)).toEqual(bin);
    expect(String(written.get(deps.unitPath))).toContain(`ExecStart=${deps.binPath} serve`);
    expect(ran).toEqual(["systemctl daemon-reload"]);
    expect(await ensureWasiRuntime({ ...deps, hasSystemd: () => false })).toEqual({ available: false, reason: "this server has no systemd" });
  });
});

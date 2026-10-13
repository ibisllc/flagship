import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIRK, deriveSWK, ed, type Keypair } from "@flagship/protocol";
import { buildAppStatusReader, parseDockerPs, runStateOf } from "../src/appStatus.js";
import { ServiceActivity, buildActivityResolver } from "../src/serviceActivity.js";
import { buildScreensHttp, type ScreensHttpDeps } from "../src/screens/screensHttp.js";
import type { AppSummary } from "../src/screens/types.js";
import type { HttpRequest } from "../src/runtime.js";
import { AppMembership } from "../src/membership.js";
import { ServicePlatform, type InstalledService } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { VibeCodeSessionRegistry } from "../src/llm/vibeCodeSession.js";
import { buildDeploySession } from "../src/llm/deploySession.js";
import { buildArtifactPipeline } from "../src/buildmodes/deployArtifact.js";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { BUILD_TOOL_NAMES, BUILD_TOOL_SPECS } from "../src/buildmodes/buildToolHost.js";
import { swkOps } from "./helpers/keyCustody.js";
import { FakeStaging } from "./helpers/fakeStaging.js";

const FQDN = "home.alice.flagship.services";
const OK = { "x-flagship-session": "tok" };

function req(path: string, headers: Record<string, string> = OK): HttpRequest {
  return { method: "GET", path, headers, body: Buffer.alloc(0) };
}

const gate = {
  has: (t: string) => t === "tok",
  check: (r: HttpRequest) =>
    r.headers["x-flagship-session"] === "tok"
      ? null
      : { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unauthorized" }) },
} as unknown as ScreensHttpDeps["gate"];

function membership(): AppMembership {
  const umk = { seed: new Uint8Array(32).fill(7) };
  const irk = deriveIRK(umk);
  return new AppMembership("notes", "alice", irk.publicKey, swkOps(deriveSWK(umk, "srv-1")));
}

function app(slug: string): InstalledService {
  return {
    creator: "alice",
    slug,
    serviceId: `alice--${slug}`,
    manifest: {
      schema_version: 1,
      name: slug,
      version: "0.1.0",
      runtime: { image: "img:1", port: 8080 },
      data: {},
      network: { subdomain: slug },
      access: { enabled: true, default_role: "owner" },
      migration: { verification: "standard" },
    } as unknown as InstalledService["manifest"],
    urlLabel: slug,
    membership: membership(),
    containerPort: 8080,
    data: null,
    installedAt: 1_000,
  };
}

function platformOf(apps: InstalledService[]) {
  return {
    list: () => apps,
    byServiceId: (id: string) => apps.find((a) => a.serviceId === id),
    byLabel: (l: string) => apps.find((a) => a.urlLabel === l),
  } as unknown as ScreensHttpDeps["servicePlatform"];
}

/** A `docker ps` that answers with `rows`, counting its calls. */
function dockerPs(rows: string[] | (() => Promise<string>)) {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const cmd: CommandRunner = {
    run: async () => {},
    capture: async (_c, args, opts) => {
      calls.push({ args, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      const stdout = typeof rows === "function" ? await rows() : rows.join("\n") + "\n";
      return { stdout, stderr: "" };
    },
  };
  return { cmd, calls };
}

const name = (id: string) => `flagship-${id}`;

async function list(deps: Partial<ScreensHttpDeps>): Promise<AppSummary[]> {
  const handle = buildScreensHttp({
    gate,
    serverFqdn: FQDN,
    username: "alice",
    daemonVersion: "t",
    startedAt: 0,
    ...deps,
  });
  const r = await handle(req("/api/screens/apps-list"));
  expect(r?.status).toBe(200);
  return (JSON.parse(r!.body as string) as { apps: AppSummary[] }).apps;
}

describe("status pill — docker states", () => {
  it("maps docker states to running / starting / stopped", () => {
    expect(runStateOf("running", "Up 3 minutes")).toBe("running");
    expect(runStateOf("running", "Up 3 minutes (healthy)")).toBe("running");
    expect(runStateOf("running", "Up 3 minutes (unhealthy)")).toBe("running");
    expect(runStateOf("running", "Up 2 seconds (health: starting)")).toBe("starting");
    expect(runStateOf("restarting", "Restarting (1) 4 seconds ago")).toBe("starting");
    for (const s of ["exited", "created", "paused", "dead", "removing"]) expect(runStateOf(s, "")).toBe("stopped");
  });

  it("parses docker ps rows, including a leading slash and several names", () => {
    const m = parseDockerPs("flagship-alice--a\trunning\tUp 1 hour\n/flagship-alice--b,other\texited\tExited (1) 2 minutes ago\n\n");
    expect(m.get("flagship-alice--a")).toBe("running");
    expect(m.get("flagship-alice--b")).toBe("stopped");
    expect(m.get("other")).toBe("stopped");
  });
});

describe("status pill — one docker call per request", () => {
  it("reads every app with one docker ps, bounded by a timeout, and caches it ~2 s", async () => {
    let t = 0;
    const { cmd, calls } = dockerPs([
      "flagship-alice--a\trunning\tUp 1 hour",
      "flagship-alice--b\trestarting\tRestarting (1) 1 second ago",
      "flagship-alice--c\trunning\tUp 1 second (health: starting)",
      "flagship-stg-abc\trunning\tUp 1 minute",
    ]);
    const reader = buildAppStatusReader({ cmd, containerName: name, now: () => t });
    const ids = ["alice--a", "alice--b", "alice--c", "alice--d"];
    const first = await reader.statuses(ids);
    expect(Object.fromEntries(first)).toEqual({
      "alice--a": "running",
      "alice--b": "starting",
      "alice--c": "starting",
      "alice--d": "stopped",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["ps", "-a"]);
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(2000);
    t = 1500;
    await reader.statuses(ids);
    expect(calls).toHaveLength(1);
    t = 2500;
    await reader.statuses(ids);
    expect(calls).toHaveLength(2);
  });

  it("shares one call between requests that arrive while it runs", async () => {
    let release!: () => void;
    const gateP = new Promise<void>((r) => (release = r));
    const { cmd, calls } = dockerPs(async () => {
      await gateP;
      return "flagship-alice--a\trunning\tUp\n";
    });
    const reader = buildAppStatusReader({ cmd, containerName: name });
    const a = reader.statuses(["alice--a"]);
    const b = reader.statuses(["alice--a"]);
    release();
    expect((await a).get("alice--a")).toBe("running");
    expect((await b).get("alice--a")).toBe("running");
    expect(calls).toHaveLength(1);
  });

  it("apps-list asks docker once for many apps", async () => {
    const apps = Array.from({ length: 12 }, (_, i) => app(`app${i}`));
    const { cmd, calls } = dockerPs(apps.map((a, i) => `${name(a.serviceId)}\t${i % 2 ? "exited" : "running"}\tx`));
    const out = await list({
      servicePlatform: platformOf(apps),
      appStatus: buildAppStatusReader({ cmd, containerName: name }),
    });
    expect(calls).toHaveLength(1);
    expect(out.map((a) => a.status)).toEqual(apps.map((_, i) => (i % 2 ? "stopped" : "running")));
  });

  it("Docker down (error or timeout) → every app is unknown", async () => {
    const down: CommandRunner = {
      run: async () => {},
      capture: async () => {
        throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
      },
    };
    const out = await list({
      servicePlatform: platformOf([app("a"), app("b")]),
      appStatus: buildAppStatusReader({ cmd: down, containerName: name }),
    });
    expect(out.map((a) => a.status)).toEqual(["unknown", "unknown"]);

    const hung: CommandRunner = {
      run: async () => {},
      capture: async (_c, _a, opts) => {
        await new Promise((r) => setTimeout(r, opts?.timeoutMs ?? 0));
        throw new Error(`command timed out after ${opts?.timeoutMs}ms and was killed`);
      },
    };
    const reader = buildAppStatusReader({ cmd: hung, containerName: name, timeoutMs: 20 });
    expect(Object.fromEntries(await reader.statuses(["alice--a"]))).toEqual({ "alice--a": "unknown" });
    const noCapture = buildAppStatusReader({ cmd: { run: async () => {} }, containerName: name });
    expect((await noCapture.statuses(["alice--a"])).get("alice--a")).toBe("unknown");
  });

  it("no status source wired → unknown, and app-detail carries the same status", async () => {
    expect((await list({ servicePlatform: platformOf([app("a")]) }))[0]!.status).toBe("unknown");
    const { cmd } = dockerPs(["flagship-alice--a\trunning\tUp"]);
    const handle = buildScreensHttp({
      gate,
      serverFqdn: FQDN,
      username: "alice",
      daemonVersion: "t",
      startedAt: 0,
      servicePlatform: platformOf([app("a")]),
      appStatus: buildAppStatusReader({ cmd, containerName: name }),
      appActivity: buildActivityResolver({ chats: () => [{ editsServiceId: "alice--a", status: "streaming" }] }),
    });
    const r = await handle(req("/api/screens/app-detail/alice--a"));
    const body = JSON.parse(r!.body as string) as { app: AppSummary };
    expect(body.app.status).toBe("running");
    expect(body.app.activity).toEqual({ kind: "editing" });
  });
});

describe("status pill — activity", () => {
  it("deploying while a deploy of the app runs, then nothing", async () => {
    const activity = new ServiceActivity();
    const resolve = buildActivityResolver({ tracker: activity });
    let finish!: () => void;
    const running = activity.deploying("alice--a", () => new Promise<void>((r) => (finish = r)));
    const during = await list({ servicePlatform: platformOf([app("a"), app("b")]), appActivity: resolve });
    expect(during[0]!.activity).toEqual({ kind: "deploying" });
    expect(during[1]!.activity).toBeUndefined();
    finish();
    await running;
    const after = await list({ servicePlatform: platformOf([app("a")]), appActivity: resolve });
    expect(after[0]).not.toHaveProperty("activity");
  });

  it("a failed deploy still clears it, and nested funnels count once each", async () => {
    const activity = new ServiceActivity();
    await expect(activity.deploying("x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(activity.isDeploying("x")).toBe(false);
    await activity.deploying("x", async () => {
      await activity.deploying("x", async () => {});
      expect(activity.isDeploying("x")).toBe(true);
    });
    expect(activity.isDeploying("x")).toBe(false);
  });

  it("ServicePlatform marks an install and a redeploy as deploying while they run", async () => {
    const irk: Keypair = (() => {
      const p = new Uint8Array(32).fill(3);
      return { privateKey: p, publicKey: ed.getPublicKey(p) };
    })();
    const activity = new ServiceActivity();
    const seen: boolean[] = [];
    const cmd: CommandRunner = {
      run: async (_c, args) => {
        if (args[0] === "run") seen.push(activity.isDeploying("alice--notes"));
      },
      capture: async () => ({ stdout: "", stderr: "" }),
    };
    const swk = new Uint8Array(32).fill(5);
    const platform = new ServicePlatform({
      host: { username: "alice", irkPub: irk.publicKey },
      swk: swkOps(swk),
      appRunner: new AppRunner(cmd),
      dataProvisioner: null,
      activity,
    });
    const request = {
      serverId: FQDN,
      creator: "alice",
      slug: "notes",
      manifestJson: JSON.stringify({
        schema_version: 1,
        name: "notes",
        version: "0.1.0",
        runtime: { image: "nginx:1.27", port: 80 },
        data: {},
        network: { subdomain: "notes" },
        access: { enabled: true, default_role: "viewer" },
        migration: { portable: true, verification: "standard" },
      }),
      addOwnerToMembership: true,
      issuedAt: Date.now(),
    };
    const sig = new Uint8Array(64);
    expect((await platform.install({ request, signature: sig, verify: () => true })).ok).toBe(true);
    expect((await platform.redeploy({ request, signature: sig, verify: () => true })).ok).toBe(true);
    expect(seen).toEqual([true, true]);
    expect(activity.isDeploying("alice--notes")).toBe(false);
  });

  const EDIT_FILES = {
    "flagship.app.json": JSON.stringify({ schema_version: 1, name: "notes", runtime: { base: "static", image: "x", port: 8080 } }),
    Dockerfile: "FROM node:20-alpine\nEXPOSE 8080\n",
  };
  const editedPlatform = (onRedeploy: () => void) =>
    ({
      byServiceId: (id: string) =>
        id === "alice--notes" ? { serviceId: id, creator: "alice", slug: "notes", urlLabel: "notes" } : undefined,
      byLabel: () => undefined,
      redeploy: async () => {
        onRedeploy();
        return { ok: true, app: {}, addedStores: [] };
      },
    }) as unknown as ServicePlatform;

  it("an AI chat's edit is deploying from its build to going live", async () => {
    const activity = new ServiceActivity();
    const seen: string[] = [];
    const cmd: CommandRunner = {
      run: async () => {},
      capture: async (_c, args) => {
        if (args[0] === "build") seen.push(`build:${activity.isDeploying("alice--notes")}`);
        return { stdout: "", stderr: "" };
      },
    };
    const deploy = buildDeploySession({
      servicePlatform: editedPlatform(() => seen.push(`live:${activity.isDeploying("alice--notes")}`)),
      signer: { signInstallService: () => new Uint8Array(64) },
      hostUsername: "alice",
      workingDir: mkdtempSync(join(tmpdir(), "pill-chat-")),
      cmd,
      activity,
    });
    const session = new VibeCodeSessionRegistry().create({
      username: "alice",
      serverFqdn: FQDN,
      name: "notes",
      editsServiceId: "alice--notes",
      files: EDIT_FILES,
    });
    const r = await deploy(session);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["build:true", "live:true"]);
    expect(activity.isDeploying("alice--notes")).toBe(false);
  });

  it("an IDE / git build's edit is deploying while it builds and goes live", async () => {
    const activity = new ServiceActivity();
    const seen: string[] = [];
    const cmd: CommandRunner = {
      run: async () => {},
      capture: async (_c, args) => {
        if (args[0] === "build") seen.push(`build:${activity.isDeploying("alice--notes")}`);
        return { stdout: "", stderr: "" };
      },
    };
    const pipeline = buildArtifactPipeline({
      servicePlatform: editedPlatform(() => seen.push(`live:${activity.isDeploying("alice--notes")}`)),
      signer: { signInstallService: () => new Uint8Array(64) },
      hostUsername: "alice",
      workingDir: mkdtempSync(join(tmpdir(), "pill-build-")),
      cmd,
      activity,
    });
    expect((await pipeline.deploy({ files: EDIT_FILES, serverFqdn: FQDN, editsServiceId: "alice--notes" })).ok).toBe(true);
    expect((await pipeline.install({ files: EDIT_FILES, serverFqdn: FQDN, editsServiceId: "alice--notes", image: "img:t" })).ok).toBe(true);
    expect(seen).toEqual(["build:true", "live:true", "live:true"]);
    expect(activity.isDeploying("alice--notes")).toBe(false);
  });

  it("copying: a copy still arriving keeps its progress and says copying", async () => {
    const row: AppSummary = {
      serviceId: "alice--c",
      creator: "alice",
      slug: "c",
      name: "C",
      urlLabel: "c",
      url: `https://c.${FQDN}`,
      status: "unknown",
      installedAt: 1,
      copying: { state: "copying", progress: 0.4 },
    };
    const out = await list({
      servicePlatform: platformOf([app("a")]),
      appCopy: { handle: async () => null, inProgress: () => [row] },
      appActivity: buildActivityResolver({}),
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ serviceId: "alice--c", copying: { state: "copying", progress: 0.4 }, activity: { kind: "copying" } });
    expect(out[0]).not.toHaveProperty("activity");
  });

  it("editing: an open AI chat on the app (not a finished, failed or cancelled one)", async () => {
    const registry = new VibeCodeSessionRegistry();
    const s = registry.create({ username: "alice", serverFqdn: FQDN, name: "a", editsServiceId: "alice--a", files: {} });
    registry.create({ username: "alice", serverFqdn: FQDN, name: "fresh" }); // a new app: no row to mark
    const resolve = buildActivityResolver({ chats: () => registry.list() });
    const apps = platformOf([app("a"), app("b")]);
    const kinds = async () => (await list({ servicePlatform: apps, appActivity: resolve })).map((a) => a.activity?.kind ?? null);
    expect(await kinds()).toEqual(["editing", null]);
    s.markDeploying("staging");
    expect(await kinds()).toEqual(["editing", null]);
    s.fail("nope");
    expect(await kinds()).toEqual([null, null]);
    expect(Object.fromEntries(resolve(["alice--a"]))).toEqual({});
    for (const status of ["deployed", "cancelled"]) {
      const r = buildActivityResolver({ chats: () => [{ editsServiceId: "alice--a", status }] });
      expect(r(["alice--a"]).size).toBe(0);
    }
  });

  it("editing: an open IDE build on the app until it's sealed", async () => {
    const { o } = orchestrator();
    const { buildId } = (await o.createMcp({ editServiceId: "alice--a" })) as { buildId: string };
    const resolve = buildActivityResolver({ builds: () => o.editingServiceIds() });
    expect(Object.fromEntries(resolve(["alice--a", "alice--b"]))).toEqual({ "alice--a": "editing" });
    await o.seal(buildId);
    expect(resolve(["alice--a"]).size).toBe(0);
  });

  it("deploying wins over editing", () => {
    const activity = new ServiceActivity();
    const resolve = buildActivityResolver({
      tracker: activity,
      chats: () => [{ editsServiceId: "alice--a", status: "deploying" }],
      builds: () => ["alice--b"],
    });
    let done!: () => void;
    void activity.deploying("alice--a", () => new Promise<void>((r) => (done = r)));
    expect(Object.fromEntries(resolve(["alice--a", "alice--b"]))).toEqual({ "alice--a": "deploying", "alice--b": "editing" });
    done();
  });
});

function orchestrator() {
  const journal = new InMemoryBuildJournal();
  const o = new BuildOrchestrator({
    journal,
    gitImporter: new GitImporter({ cmd: { run: async () => {} }, workingDir: mkdtempSync(join(tmpdir(), "pill-git-")), journal }),
    mcpKeys: new InMemoryMcpKeyStore(),
    serverFqdn: FQDN,
    mcpBaseUrl: `https://${FQDN}`,
    staging: new FakeStaging(),
    editableService: async (id) => ({ ok: true, serviceId: id, slug: id.split("--")[1]!, files: { "a.txt": "a" }, bytes: 1 }),
    deployArtifact: async () => ({ ok: true, serviceId: "alice--a", url: "https://a", image: "img" }),
  });
  return { o };
}

describe("status pill — the AI-facing surface is unchanged", () => {
  it("the build tools are the same set, and none speaks of status or activity", () => {
    expect([...BUILD_TOOL_NAMES]).toEqual([
      "get_contract",
      "list_files",
      "read_file",
      "write_file",
      "delete_file",
      "validate",
      "request_env_var",
      "get_journal",
      "deploy",
      "check_app",
      "get_logs",
      "query_db",
      "list_tables",
      "list_data_files",
      "read_data_file",
      "finish",
    ]);
    const specs = JSON.stringify(BUILD_TOOL_SPECS);
    expect(specs).not.toMatch(/activity|"status"|deploying|editing|copying/i);
  });

  it("an IDE build sees the same tools and files whether or not the app is deploying or being edited", async () => {
    const { o } = orchestrator();
    const { connection } = (await o.createMcp({ editServiceId: "alice--a" })) as { connection: { key: string } };
    const ask = async (method: string, params?: unknown) =>
      JSON.stringify((await o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) })).response);
    const before = [await ask("tools/list"), await ask("tools/call", { name: "list_files", arguments: {} })];
    const activity = new ServiceActivity();
    let done!: () => void;
    const p = activity.deploying("alice--a", () => new Promise<void>((r) => (done = r)));
    const during = [await ask("tools/list"), await ask("tools/call", { name: "list_files", arguments: {} })];
    done();
    await p;
    expect(during).toEqual(before);
    for (const text of during) expect(text).not.toMatch(/"activity"|running|stopped|deploying|editing/);
  });

  it("the status and activity are only on the owner's paired-session screens", async () => {
    const handle = buildScreensHttp({
      gate,
      serverFqdn: FQDN,
      username: "alice",
      daemonVersion: "t",
      startedAt: 0,
      servicePlatform: platformOf([app("a")]),
      appActivity: buildActivityResolver({ builds: () => ["alice--a"] }),
    });
    const r = await handle(req("/api/screens/apps-list", { authorization: "Bearer fmcp_somekey" }));
    expect(r?.status).toBe(401);
  });
});

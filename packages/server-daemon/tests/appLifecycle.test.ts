import { describe, expect, it } from "vitest";
import { deriveIRK, deriveSWK, type AppManifest } from "@flagship/protocol";
import { AppRunner, type CommandRunner } from "../src/appRunner.js";
import { AppMembership } from "../src/membership.js";
import { BootCoordinator } from "../src/bootCoordinator.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext, type DeployedApp } from "../src/httpApi.js";

const umk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(umk);
const swk = deriveSWK(umk, "srv-1");

class RecordingRunner implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  captures: { cmd: string; args: string[] }[] = [];
  async run(cmd: string, args: string[]): Promise<void> {
    this.calls.push({ cmd, args });
  }
  async capture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.captures.push({ cmd, args });
    return { stdout: "starting...\nlistening on 8080\n", stderr: "" };
  }
}

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    schema_version: 1,
    name: "habit-tracker",
    version: "0.1.0",
    runtime: { image: "ghcr.io/x/habit:0.1", port: 8080, env: { NODE_ENV: "production" } },
    data: { path: "/data" },
    network: { subdomain: "habits" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    ...over,
  };
}

function makeCtx(extra: { runner?: CommandRunner; preDeployed?: DeployedApp[] } = {}) {
  const apps = new Map<string, AppMembership>();
  apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
  const sessions = new Map<string, Uint8Array>([["phone-token", ownerIrk.publicKey]]);
  const injectors = new Map<string, IdentityInjector>();
  const deployedApps = new Map<string, DeployedApp>();
  for (const d of extra.preDeployed ?? []) deployedApps.set(d.manifest.name, d);
  const ctx: DaemonContext = {
    serverId: "srv-1",
    userId: "harry",
    bootCoordinator: new BootCoordinator("srv-1", ownerIrk.publicKey),
    apps,
    resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
    injectors,
    appRunner: new AppRunner(extra.runner ?? new RecordingRunner()),
    deployedApps,
  };
  return { ctx, deployedApps };
}

describe("daemon HTTP — POST /apps (deploy)", () => {
  it("deploys a valid manifest, records the entry, returns 200", async () => {
    const rec = new RecordingRunner();
    const { ctx, deployedApps } = makeCtx({ runner: rec });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "POST",
      url: "/apps",
      payload: { sessionToken: "phone-token", manifest: manifest(), source: "git@abc123" },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).appId).toBe("habit-tracker");
    expect(deployedApps.get("habit-tracker")?.source).toBe("git@abc123");
    const dockerRun = rec.calls.find((c) => c.args[0] === "run")!;
    expect(dockerRun.args).toContain("ghcr.io/x/habit:0.1");
    expect(dockerRun.args).toContain("flagship-habit-tracker");
    expect(dockerRun.args).toContain("NODE_ENV=production");
  });

  it("rejects unauthenticated callers with 401 (manifest never reaches the runner)", async () => {
    const rec = new RecordingRunner();
    const { ctx } = makeCtx({ runner: rec });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "POST",
      url: "/apps",
      payload: { manifest: manifest() },
    });
    expect(r.statusCode).toBe(401);
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects an invalid manifest with 400 + per-field errors", async () => {
    const rec = new RecordingRunner();
    const { ctx } = makeCtx({ runner: rec });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "POST",
      url: "/apps",
      payload: {
        sessionToken: "phone-token",
        manifest: { ...manifest(), access: { enabled: false } },
      },
    });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.details.join(" ")).toMatch(/access\.enabled/);
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects re-deploy of an already-deployed app id with 409 (use restart)", async () => {
    const { ctx } = makeCtx({
      preDeployed: [{ manifest: manifest(), deployedAt: 1 }],
    });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "POST",
      url: "/apps",
      payload: { sessionToken: "phone-token", manifest: manifest() },
    });
    expect(r.statusCode).toBe(409);
  });
});

describe("daemon HTTP — DELETE /apps/:id and POST /restart", () => {
  it("DELETE stops the container and removes the deploy record", async () => {
    const rec = new RecordingRunner();
    const { ctx, deployedApps } = makeCtx({
      runner: rec,
      preDeployed: [{ manifest: manifest(), deployedAt: 1 }],
    });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "DELETE",
      url: "/apps/habit-tracker",
      payload: { sessionToken: "phone-token" },
    });
    expect(r.statusCode).toBe(200);
    expect(deployedApps.has("habit-tracker")).toBe(false);
    const verbs = rec.calls.map((c) => c.args[0]);
    expect(verbs).toContain("stop");
    expect(verbs).toContain("rm");
  });

  it("DELETE on an unknown app returns 404", async () => {
    const { ctx } = makeCtx();
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "DELETE",
      url: "/apps/ghost",
      payload: { sessionToken: "phone-token" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("POST /restart re-deploys with the existing manifest's image", async () => {
    const rec = new RecordingRunner();
    const { ctx } = makeCtx({
      runner: rec,
      preDeployed: [{ manifest: manifest({ runtime: { image: "img:v2", port: 8080 } }), deployedAt: 1 }],
    });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "POST",
      url: "/apps/habit-tracker/restart",
      payload: { sessionToken: "phone-token" },
    });
    expect(r.statusCode).toBe(200);
    const runCall = rec.calls.find((c) => c.args[0] === "run")!;
    expect(runCall.args).toContain("img:v2");
  });
});

describe("daemon HTTP — GET /apps and /apps/:id/logs", () => {
  it("GET /apps lists deployed apps with metadata", async () => {
    const { ctx } = makeCtx({
      preDeployed: [{ manifest: manifest(), deployedAt: 100 }],
    });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({ method: "GET", url: "/apps?sessionToken=phone-token" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0].name).toBe("habit-tracker");
    expect(body.apps[0].subdomain).toBe("habits");
  });

  it("GET /apps/:id/logs returns captured stdout and clamps tail to [1, 5000]", async () => {
    const rec = new RecordingRunner();
    const { ctx } = makeCtx({
      runner: rec,
      preDeployed: [{ manifest: manifest(), deployedAt: 1 }],
    });
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({
      method: "GET",
      url: "/apps/habit-tracker/logs?sessionToken=phone-token&tail=999999",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.tail).toBe(200); // out-of-bound → default
    expect(body.stdout).toContain("listening on 8080");
  });
});

describe("daemon HTTP — graceful 503 when subsystems missing", () => {
  it("/apps endpoints return 503 when appRunner is undefined", async () => {
    const apps = new Map<string, AppMembership>();
    const ctx: DaemonContext = {
      serverId: "srv-1",
      userId: "harry",
      bootCoordinator: new BootCoordinator("srv-1", ownerIrk.publicKey),
      apps,
      resolveSession: () => null,
      injectors: new Map(),
    };
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({ method: "POST", url: "/apps", payload: { manifest: manifest() } });
    expect(r.statusCode).toBe(503);
  });
});

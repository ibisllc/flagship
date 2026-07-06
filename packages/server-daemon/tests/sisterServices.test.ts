import { swkOps } from "./helpers/keyCustody.js";
import { describe, expect, it } from "vitest";
import { deriveIRK, deriveSWK, type AppManifest } from "@flagship/protocol";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { AppMembership } from "../src/membership.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext, type DeployedApp } from "../src/httpApi.js";

const umk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(umk);
const swk = swkOps(deriveSWK(umk, "srv-1"));

class RecordingRunner implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  async run(cmd: string, args: string[]): Promise<void> {
    this.calls.push({ cmd, args });
  }
}

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    schema_version: 1,
    name: over.name ?? "habit-tracker",
    version: "0.1.0",
    runtime: { image: "img:1", port: 8080 },
    data: { stores: {} },
    network: { subdomain: over.network?.subdomain ?? over.name ?? "habit-tracker" },
    migration: { verification: "standard" },
    ...over,
    access: { enabled: true, default_role: "viewer", ...(over.access ?? {}) },
  };
}

function makeCtx() {
  const apps = new Map<string, AppMembership>();
  apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
  const sessions = new Map<string, Uint8Array>([["phone-token", ownerIrk.publicKey]]);
  const deployedApps = new Map<string, DeployedApp>();
  const ctx: DaemonContext = {
    serverId: "srv-1",
    userId: "harry",
    apps,
    resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
    injectors: new Map<string, IdentityInjector>(),
    appRunner: new AppRunner(new RecordingRunner()),
    deployedApps,
  };
  return { ctx, deployedApps };
}

async function deploy(http: ReturnType<typeof buildDaemonHttp>, m: AppManifest) {
  const r = await http.inject({
    method: "POST",
    url: "/apps",
    payload: { sessionToken: "phone-token", manifest: m },
  });
  expect(r.statusCode).toBe(200);
}

function getPeersToken(deployedApps: Map<string, DeployedApp>, serviceId: string): string {
  const t = deployedApps.get(serviceId)?.peersToken;
  if (!t) throw new Error(`no peersToken for ${serviceId}`);
  return t;
}

describe("sister-app capability — /.flagship/peers/:targetAppId/installed", () => {
  it("returns installed:true only when the target lists the querier in queryable_by", async () => {
    const { ctx, deployedApps } = makeCtx();
    const http = buildDaemonHttp(ctx);

    // habits is queryable by pomodoro
    await deploy(
      http,
      manifest({
        name: "habits",
        access: {
          enabled: true,
          default_role: "viewer",
          queryable_by: ["pomodoro"],
        },
      }),
    );
    await deploy(http, manifest({ name: "pomodoro" }));

    const pomodoroToken = getPeersToken(deployedApps, "pomodoro");

    const ok = await http.inject({
      method: "GET",
      url: "/.flagship/peers/habits/installed",
      headers: { authorization: `Bearer ${pomodoroToken}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body);
    expect(body.installed).toBe(true);
    expect(body.subdomain).toBe("habits");
  });

  it("returns installed:false when the target exists but did NOT allowlist the querier (no fingerprinting)", async () => {
    const { ctx, deployedApps } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http, manifest({ name: "diary" })); // no queryable_by
    await deploy(http, manifest({ name: "pomodoro" }));

    const r = await http.inject({
      method: "GET",
      url: "/.flagship/peers/diary/installed",
      headers: { authorization: `Bearer ${getPeersToken(deployedApps, "pomodoro")}` },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).installed).toBe(false);
  });

  it("returns installed:false when the target doesn't exist (same response as not-allowlisted)", async () => {
    const { ctx, deployedApps } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http, manifest({ name: "pomodoro" }));

    const r = await http.inject({
      method: "GET",
      url: "/.flagship/peers/ghost/installed",
      headers: { authorization: `Bearer ${getPeersToken(deployedApps, "pomodoro")}` },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).installed).toBe(false);
  });

  it("rejects requests without a Bearer token", async () => {
    const { ctx } = makeCtx();
    const http = buildDaemonHttp(ctx);
    const r = await http.inject({
      method: "GET",
      url: "/.flagship/peers/anything/installed",
    });
    expect(r.statusCode).toBe(401);
  });

  it("rejects requests carrying an unknown peers token", async () => {
    const { ctx } = makeCtx();
    const http = buildDaemonHttp(ctx);
    const r = await http.inject({
      method: "GET",
      url: "/.flagship/peers/anything/installed",
      headers: { authorization: "Bearer made-up-token" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("each deployed app gets a fresh, unique FLAGSHIP_PEERS_TOKEN injected as env", async () => {
    const rec = new RecordingRunner();
    const apps = new Map<string, AppMembership>();
    apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
    const sessions = new Map<string, Uint8Array>([["phone-token", ownerIrk.publicKey]]);
    const deployedApps = new Map<string, DeployedApp>();
    const ctx: DaemonContext = {
      serverId: "srv-1",
      userId: "harry",
      apps,
      resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
      injectors: new Map<string, IdentityInjector>(),
      appRunner: new AppRunner(rec),
      deployedApps,
    };
    const http = buildDaemonHttp(ctx);
    await deploy(http, manifest({ name: "a" }));
    await deploy(http, manifest({ name: "b" }));

    const tokens: string[] = [];
    for (const c of rec.calls) {
      for (let i = 0; i < c.args.length - 1; i++) {
        const v = c.args[i + 1] ?? "";
        if (c.args[i] === "-e" && v.startsWith("FLAGSHIP_PEERS_TOKEN=")) {
          tokens.push(v.slice("FLAGSHIP_PEERS_TOKEN=".length));
        }
      }
    }
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[0]!.length).toBeGreaterThan(20);
  });
});

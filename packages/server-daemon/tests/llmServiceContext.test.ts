import { describe, expect, it } from "vitest";
import { deriveIRK, deriveSWK, type AppManifest } from "@flagship/protocol";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { AppMembership } from "../src/membership.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext, type DeployedApp } from "../src/httpApi.js";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
} from "../src/dataLayer/index.js";
import { buildLlmAppContext } from "../src/llmServiceContext.js";

const umk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(umk);
const swk = deriveSWK(umk, "srv-1");

class NopRunner implements CommandRunner {
  async run(): Promise<void> {}
}

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    schema_version: 1,
    name: "habit-tracker",
    version: "0.1.0",
    description: "Track habits",
    runtime: { image: "img:1", port: 8080 },
    data: { stores: { postgres: true } },
    network: { subdomain: "habits" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    ...over,
  };
}

describe("buildLlmAppContext", () => {
  it("renders a markdown blob with the app id, env-var names, and identity contract", async () => {
    const deployed = new Map<string, { manifest: AppManifest }>();
    deployed.set("habit-tracker", { manifest: manifest() });
    const ctx = await buildLlmAppContext({
      manifest: manifest(),
      deployedApps: deployed,
      revealCredentials: false,
    });
    expect(ctx.markdown).toContain("# Flagship app context — `habit-tracker`");
    expect(ctx.markdown).toContain("X-Flagship-User");
    expect(ctx.markdown).toContain("FLAGSHIP_PEERS_TOKEN");
  });

  it("prependFlagshipSystemPrompt inserts the context markdown as the first system message", async () => {
    const { prependFlagshipSystemPrompt } = await import("../src/llmServiceContext.js");
    const deployed = new Map<string, { manifest: AppManifest }>();
    deployed.set("habit-tracker", { manifest: manifest() });
    const ctx = await buildLlmAppContext({
      manifest: manifest(),
      deployedApps: deployed,
      revealCredentials: false,
    });
    const req = {
      model: "claude-3-5-sonnet",
      messages: [
        { role: "user" as const, content: "Add a /streak endpoint." },
      ],
    };
    const augmented = prependFlagshipSystemPrompt(req, ctx);
    expect(augmented.messages).toHaveLength(2);
    expect(augmented.messages[0].role).toBe("system");
    expect(augmented.messages[0].content).toContain("Flagship app context");
    expect(augmented.messages[0].content).toContain("`_<creator>_<slug>`");
    expect(augmented.messages[1]).toEqual(req.messages[0]);
    // Original request unchanged (immutability)
    expect(req.messages).toHaveLength(1);
  });

  it("explicitly documents the host-independent data-identity convention so vibe-coded apps stay portable", async () => {
    const deployed = new Map<string, { manifest: AppManifest }>();
    deployed.set("habit-tracker", { manifest: manifest() });
    const ctx = await buildLlmAppContext({
      manifest: manifest(),
      deployedApps: deployed,
      revealCredentials: false,
    });
    expect(ctx.markdown).toContain("Data identity (host-independent)");
    expect(ctx.markdown).toContain("`_<creator>_<slug>`");
    expect(ctx.markdown).toContain("`<creator>:<slug>:`");
    expect(ctx.markdown).toContain("`<creator>-<slug>`");
    // The hard rules now flag transferability concerns explicitly.
    expect(ctx.markdown).toContain("break on transfer between users");
    expect(ctx.markdown).toContain("`migrations/NNNN_*.sql|.ts`");
  });

  it("hides credential URLs by default and reveals them only when reveal=true", async () => {
    const provisioner = new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      objects: new InMemoryMinioAdmin(),
      kv: new InMemoryRedisAdmin(),
      generateSecret: () => "supersecret",
    });
    const creds = await provisioner.provisionApp({
      creator: "harry",
      slug: "habit-tracker",
      stores: { postgres: true },
    });
    const deployed = new Map<string, { manifest: AppManifest }>();
    deployed.set("habit-tracker", { manifest: manifest() });

    const hidden = await buildLlmAppContext({
      manifest: manifest(),
      credentials: creds,
      deployedApps: deployed,
      dataProvisioner: provisioner,
      revealCredentials: false,
    });
    expect(hidden.markdown).not.toContain("supersecret");

    const revealed = await buildLlmAppContext({
      manifest: manifest(),
      credentials: creds,
      deployedApps: deployed,
      dataProvisioner: provisioner,
      revealCredentials: true,
    });
    // The encoded password appears in the connection URL when revealed.
    expect(revealed.markdown).toContain("supersecret");
  });

  it("surfaces multi-store Postgres env vars + the FLAGSHIP_PG_STORES list", async () => {
    const provisioner = new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      objects: new InMemoryMinioAdmin(),
      kv: new InMemoryRedisAdmin(),
      generateSecret: () => "x",
    });
    const creds = await provisioner.provisionApp({
      creator: "harry",
      slug: "habits",
      stores: { postgres: ["main", "analytics"] },
    });
    const m = manifest({ data: { stores: { postgres: ["main", "analytics"] } } });
    const deployed = new Map<string, { manifest: AppManifest }>();
    deployed.set("habit-tracker", { manifest: m });
    const ctx = await buildLlmAppContext({
      manifest: m,
      credentials: creds,
      deployedApps: deployed,
      dataProvisioner: provisioner,
      revealCredentials: false,
    });
    const names = ctx.envVars.map((v) => v.name);
    expect(names).toContain("FLAGSHIP_PG_STORES");
    expect(names).toContain("FLAGSHIP_PG_URL_MAIN");
    expect(names).toContain("FLAGSHIP_PG_URL_ANALYTICS");
    expect(names).not.toContain("FLAGSHIP_PG_URL"); // no singleton var when multi
  });

  it("only lists sister apps that explicitly include the querier in queryable_by", async () => {
    const me = manifest({ name: "habit-tracker" });
    const friendly = manifest({
      name: "pomodoro-timer",
      access: {
        enabled: true,
        default_role: "viewer",
        queryable_by: ["habit-tracker"],
      },
    });
    const stranger = manifest({
      name: "diary",
      access: { enabled: true, default_role: "viewer" }, // no queryable_by
    });
    const deployed = new Map<string, { manifest: AppManifest }>();
    deployed.set("habit-tracker", { manifest: me });
    deployed.set("pomodoro-timer", { manifest: friendly });
    deployed.set("diary", { manifest: stranger });

    const ctx = await buildLlmAppContext({
      manifest: me,
      deployedApps: deployed,
      revealCredentials: false,
    });
    const sisterIds = ctx.sisterApps.map((s) => s.serviceId);
    expect(sisterIds).toContain("pomodoro-timer");
    expect(sisterIds).not.toContain("diary");
  });
});

describe("daemon HTTP — GET /apps/:serviceId/llm-context", () => {
  function makeCtx() {
    const apps = new Map<string, AppMembership>();
    apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
    const sessions = new Map<string, Uint8Array>([["phone-token", ownerIrk.publicKey]]);
    const deployedApps = new Map<string, DeployedApp>();
    deployedApps.set("habit-tracker", { manifest: manifest(), deployedAt: 1 });
    const ctx: DaemonContext = {
      serverId: "srv-1",
      userId: "harry",
      apps,
      resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
      injectors: new Map<string, IdentityInjector>(),
      appRunner: new AppRunner(new NopRunner()),
      deployedApps,
    };
    return ctx;
  }

  it("returns the markdown + envVars surface for a deployed app", async () => {
    const http = buildDaemonHttp(makeCtx());
    const r = await http.inject({
      method: "GET",
      url: "/apps/habit-tracker/llm-context?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.serviceId).toBe("habit-tracker");
    expect(body.markdown).toContain("Flagship app context");
    expect(Array.isArray(body.envVars)).toBe(true);
  });

  it("rejects unauthenticated callers", async () => {
    const http = buildDaemonHttp(makeCtx());
    const r = await http.inject({ method: "GET", url: "/apps/habit-tracker/llm-context" });
    expect(r.statusCode).toBe(401);
  });

  it("returns 404 for unknown apps", async () => {
    const http = buildDaemonHttp(makeCtx());
    const r = await http.inject({
      method: "GET",
      url: "/apps/ghost/llm-context?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(404);
  });
});

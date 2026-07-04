import { swkOps } from "./helpers/keyCustody.js";
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

const umk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(umk);
const swk = swkOps(deriveSWK(umk, "srv-1"));

class NopRunner implements CommandRunner {
  async run(): Promise<void> {}
}

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    schema_version: 1,
    name: "habit-tracker",
    version: "0.1.0",
    runtime: { image: "x", port: 8080 },
    data: { stores: { postgres: true, objects: true, kv: true } },
    network: { subdomain: "habits" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    ...over,
  };
}

function makeCtx() {
  const apps = new Map<string, AppMembership>();
  apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
  const sessions = new Map<string, Uint8Array>([["phone-token", ownerIrk.publicKey]]);
  const pg = new InMemoryPostgresAdmin();
  const objects = new InMemoryMinioAdmin();
  const kv = new InMemoryRedisAdmin();
  const ctx: DaemonContext = {
    serverId: "srv-1",
    userId: "harry",
    apps,
    resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
    injectors: new Map<string, IdentityInjector>(),
    appRunner: new AppRunner(new NopRunner()),
    deployedApps: new Map<string, DeployedApp>(),
    dataProvisioner: new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "secret",
    }),
  };
  return { ctx, pg, objects, kv };
}

async function deploy(http: ReturnType<typeof buildDaemonHttp>) {
  const r = await http.inject({
    method: "POST",
    url: "/apps",
    payload: { sessionToken: "phone-token", manifest: manifest() },
  });
  expect(r.statusCode).toBe(200);
}

describe("/data dashboard endpoints", () => {
  it("/data/postgres/:serviceId/tables lists tables", async () => {
    const { ctx, pg } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http);
    pg.databases.get("_harry_habit_tracker")!.tables.set("habits", []);
    const r = await http.inject({
      method: "GET",
      url: "/data/postgres/habit-tracker/tables?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.database).toBe("_harry_habit_tracker");
    expect(body.tables).toEqual(["habits"]);
  });

  it("/data/postgres/:serviceId/query clamps `max` to [1, 1000]", async () => {
    const { ctx, pg } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http);
    pg.databases.get("_harry_habit_tracker")!.tables.set("habits", [
      [{ id: 1 }],
      [{ id: 2 }],
    ]);
    const tooHigh = await http.inject({
      method: "GET",
      url: "/data/postgres/habit-tracker/query?sessionToken=phone-token&sql=SELECT%20*%20FROM%20habits&max=99999",
    });
    expect(tooHigh.statusCode).toBe(200);
    expect(JSON.parse(tooHigh.body).max).toBe(1000);
  });

  it("/data/objects/:serviceId/list returns objects with size", async () => {
    const { ctx, objects } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http);
    objects.buckets.get("harry-habit-tracker")!.objects.set("a/b.txt", new Uint8Array(42));
    const r = await http.inject({
      method: "GET",
      url: "/data/objects/habit-tracker/list?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.bucket).toBe("harry-habit-tracker");
    expect(body.objects).toEqual([{ key: "a/b.txt", size: 42 }]);
  });

  it("/data/kv/:serviceId/keys filters by the per-app prefix", async () => {
    const { ctx, kv } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http);
    kv.data.set("harry:habit-tracker:foo", "1");
    kv.data.set("other:bar:baz", "2"); // should not appear
    const r = await http.inject({
      method: "GET",
      url: "/data/kv/habit-tracker/keys?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).keys).toEqual(["harry:habit-tracker:foo"]);
  });

  it("rejects unauthenticated callers across every dashboard route", async () => {
    const { ctx } = makeCtx();
    const http = buildDaemonHttp(ctx);
    await deploy(http);
    const urls = [
      "/data/postgres/habit-tracker/tables",
      "/data/postgres/habit-tracker/query?sql=SELECT+1",
      "/data/objects/habit-tracker/list",
      "/data/kv/habit-tracker/keys",
    ];
    for (const u of urls) {
      const r = await http.inject({ method: "GET", url: u });
      expect(r.statusCode).toBe(401);
    }
  });

  it("returns 404 when the app exists but doesn't use the requested store", async () => {
    const { ctx } = makeCtx();
    // deploy an app that opts out of objects + kv
    const http = buildDaemonHttp(ctx);
    const r = await http.inject({
      method: "POST",
      url: "/apps",
      payload: {
        sessionToken: "phone-token",
        manifest: manifest({ data: { stores: { postgres: true } } }),
      },
    });
    expect(r.statusCode).toBe(200);

    const objects = await http.inject({
      method: "GET",
      url: "/data/objects/habit-tracker/list?sessionToken=phone-token",
    });
    expect(objects.statusCode).toBe(404);

    const kv = await http.inject({
      method: "GET",
      url: "/data/kv/habit-tracker/keys?sessionToken=phone-token",
    });
    expect(kv.statusCode).toBe(404);
  });
});

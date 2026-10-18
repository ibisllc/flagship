import { describe, expect, it } from "vitest";
import { handleGymTeardown, type GymCloudClient } from "../src/gymCloud.js";
import { createUpCloudClient, parseUpCloudLabels } from "../src/upcloud.js";

const GYM_A = "00000000-0000-4000-8000-00000000000a";
const GYM_B = "00000000-0000-4000-8000-00000000000b";
const PROD = "00000000-0000-4000-8000-0000000000ff";

function fakeCloud(): GymCloudClient & { destroyed: string[] } {
  const labels: Record<string, Record<string, string>> = {
    [GYM_A]: { "flagship-env": "gym", "flagship-demo": "a" },
    [GYM_B]: { "flagship-env": "gym", "flagship-demo": "b" },
    [PROD]: { "flagship-demo": "playstore" },
  };
  const destroyed: string[] = [];
  return {
    destroyed,
    async listServersByLabel(key, value) {
      return Object.entries(labels)
        .filter(([, l]) => l[key] === value)
        .map(([serverId, l]) => ({ serverId, title: `t-${serverId.slice(-2)}`, state: "started", labels: l }));
    },
    async getServerLabels(id) {
      return labels[id] ?? null;
    },
    async destroyServer(id) {
      destroyed.push(id);
    },
  };
}

const deps = (cloud: GymCloudClient, deleteDns?: (n: string, t: string) => Promise<number>) => ({
  cloud,
  label: { key: "flagship-env", value: "gym" },
  servicesApex: "gym.flagship.services",
  ...(deleteDns ? { deleteDns } : {}),
});

describe("handleGymTeardown", () => {
  it("all: destroys every gym-labelled server and nothing else", async () => {
    const cloud = fakeCloud();
    const r = await handleGymTeardown(deps(cloud), { all: true });
    expect(r.status).toBe(200);
    expect(cloud.destroyed.sort()).toEqual([GYM_A, GYM_B]);
  });

  it("refuses a server that lacks the gym label", async () => {
    const cloud = fakeCloud();
    const r = await handleGymTeardown(deps(cloud), { serverIds: [PROD, GYM_A] });
    expect(cloud.destroyed).toEqual([GYM_A]);
    expect(r.body.refused).toEqual([PROD]);
  });

  it("dryRun lists without destroying", async () => {
    const cloud = fakeCloud();
    const r = await handleGymTeardown(deps(cloud), { all: true, dryRun: true });
    expect(cloud.destroyed).toEqual([]);
    expect((r.body.servers as unknown[]).length).toBe(2);
  });

  it("reaps the named boxes' and users' records, never prod or the gym apex", async () => {
    const cloud = fakeCloud();
    const records = [
      { id: "1", name: "home2.gx1.gym.flagship.services", type: "A" },
      { id: "2", name: "*.home2.gx1.gym.flagship.services", type: "AAAA" },
      { id: "3", name: "gx2.gym.flagship.services", type: "CAA" },
      { id: "4", name: "*.home.gx2.gym.flagship.services", type: "A" },
      { id: "5", name: "home.alice.flagship.services", type: "A" },
      { id: "6", name: "*.gym.flagship.services", type: "A" },
      { id: "7", name: "gym.flagship.services", type: "A" },
      { id: "8", name: "home.gx3.gym.flagship.services", type: "A" },
    ];
    const deleted: string[] = [];
    const dns = {
      listAll: async () => records,
      deleteById: async (id: string) => {
        deleted.push(id);
        return true;
      },
    };
    const r = await handleGymTeardown({ ...deps(cloud), dns }, { serverDomains: ["home2.gx1.gym.flagship.services"], usernames: ["gx2"] });
    expect(r.status).toBe(200);
    expect(deleted.sort()).toEqual(["1", "2", "3", "4"]);
    deleted.length = 0;
    await handleGymTeardown({ ...deps(cloud), dns }, { all: true });
    expect(deleted.sort()).toEqual(["1", "2", "3", "4", "8"]);
    const bad = await handleGymTeardown(deps(cloud), { serverDomains: ["home.x.flagship.services"] });
    expect(bad.status).toBe(400);
  });
});

describe("handleGymTeardown under load", () => {
  it("retries a destroy the provider refused, and reports one that keeps failing", async () => {
    const cloud = fakeCloud();
    let calls = 0;
    const flaky: GymCloudClient = {
      ...cloud,
      async destroyServer(id) {
        calls++;
        if (id === GYM_A && calls <= 2) throw new Error("UpCloud GET /server → HTTP 401 AUTHENTICATION_FAILED");
        if (id === GYM_B) throw new Error("still failing");
        await cloud.destroyServer(id);
      },
    };
    const r = await handleGymTeardown({ ...deps(flaky), pause: async () => {} }, { serverIds: [GYM_A, GYM_B] });
    expect(r.body.destroyed).toEqual([GYM_A]);
    expect((r.body.failed as Array<{ serverId: string }>).map((f) => f.serverId)).toEqual([GYM_B]);
    expect(r.status).toBe(502);
  });

  it("retries a DNS delete once and reports the zone's size", async () => {
    const cloud = fakeCloud();
    const records = [
      { id: "1", name: "home.gx1.gym.flagship.services", type: "A" },
      { id: "2", name: "home.alice.flagship.services", type: "A" },
    ];
    let tries = 0;
    const dns = {
      listAll: async () => records,
      deleteById: async () => {
        tries++;
        if (tries === 1) throw new Error("429");
        return true;
      },
    };
    const dry = await handleGymTeardown({ ...deps(cloud), dns, pause: async () => {} }, { all: true, dryRun: true });
    expect(dry.body.zoneRecords).toBe(2);
    expect(dry.body.dnsWouldDelete).toBe(1);
    // A dry run names the records, so a live check can read an account's set.
    expect(dry.body.dnsRecords).toEqual([{ type: "A", name: "home.gx1.gym.flagship.services" }]);
    const r = await handleGymTeardown({ ...deps(cloud), dns, pause: async () => {} }, { usernames: ["gx1"] });
    expect(r.body.dnsDeleted).toBe(1);
    expect(r.body.dnsFailed).toEqual([]);
    expect(r.body.zoneRecords).toBe(2);
  });
});

describe("UpCloud extra labels", () => {
  it("parses k=v pairs and drops malformed ones", () => {
    expect(parseUpCloudLabels("flagship-env=gym, bad pair ,x=y")).toEqual({ "flagship-env": "gym", x: "y" });
    expect(parseUpCloudLabels(undefined)).toEqual({});
  });

  it("adds the extra labels to created servers", async () => {
    let sent: { server: { labels: { label: unknown[] } } } | null = null;
    const client = createUpCloudClient({
      token: "t",
      template: "01000000-0000-4000-8000-000020070100",
      extraLabels: { "flagship-env": "gym" },
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ server: { uuid: GYM_A } }), { status: 202 });
      },
    });
    await client.createServerWithUserData({
      name: "flagship-gym-x-1",
      location: "de-fra1",
      serverType: "STARTER-4xCPU-8GB",
      userData: "#cloud-config",
      username: "x",
    });
    expect(sent!.server.labels.label).toEqual([
      { key: "flagship-demo", value: "x" },
      { key: "flagship-env", value: "gym" },
    ]);
  });
});

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

  it("deletes DNS only for names under the gym apex", async () => {
    const cloud = fakeCloud();
    const names: string[] = [];
    const r = await handleGymTeardown(
      deps(cloud, async (n, t) => {
        names.push(`${t} ${n}`);
        return 1;
      }),
      { serverDomains: ["home2.gx1.gym.flagship.services"] },
    );
    expect(r.status).toBe(200);
    expect(names).toContain("A *.home2.gx1.gym.flagship.services");
    const bad = await handleGymTeardown(deps(cloud), { serverDomains: ["home.x.flagship.services"] });
    expect(bad.status).toBe(400);
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

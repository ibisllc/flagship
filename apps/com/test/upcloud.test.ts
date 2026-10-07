// Unit tests for the Worker-side UpCloud client and demo cloud selection.
// No real UpCloud/Hetzner calls — `fetch` is injected.

import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/hetzner.js";
import { createUpCloudClient, isUpCloudServerId, UpCloudClientError } from "../src/upcloud.js";
import {
  createDemoCreateSettings,
  createDemoServerRouter,
  demoCloudProvider,
  demoCreateMissingConfig,
  hasAnyDemoCloudToken,
} from "../src/demoCloud.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  responder: (call: CapturedCall) => { status: number; body: unknown },
): { fn: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: FetchLike = async (input, init) => {
    const call: CapturedCall = {
      url: input,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const { status, body } = responder(call);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fn, calls };
}

const UUID = "00798b85-efdc-41ca-8021-f6ef457b8531";
const TEMPLATE = "01000000-0000-4000-8000-000020070100";

function serverBody(state: string) {
  return {
    server: {
      uuid: UUID,
      title: "flagship-demo-openai-build-1a2b3c4d",
      state,
      ip_addresses: {
        ip_address: [
          { access: "utility", family: "IPv4", address: "10.0.0.5" },
          { access: "public", family: "IPv4", address: "94.237.1.2" },
        ],
      },
    },
  };
}

describe("UpCloud client", () => {
  it("creates by cloning the template with cloud-init user_data, metadata and the demo label", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 202, body: serverBody("maintenance") }));
    const client = createUpCloudClient({ token: "ucat_test", template: TEMPLATE, fetch: fn });
    const result = await client.createServerWithUserData({
      name: "flagship-demo-openai-build-1a2b3c4d",
      location: "de-fra1",
      serverType: "PLAN-A",
      image: "debian-12",
      userData: "#cloud-config\nruncmd: []\n",
      username: "OpenAI-Build",
    });
    expect(result).toEqual({ serverId: UUID, ipv4: "94.237.1.2" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.upcloud.com/1.3/server");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe("Bearer ucat_test");
    const server = (call!.body as { server: Record<string, unknown> }).server;
    expect(server).toMatchObject({
      zone: "de-fra1",
      plan: "PLAN-A",
      title: "flagship-demo-openai-build-1a2b3c4d",
      hostname: "flagship-demo-openai-build-1a2b3c4d",
      metadata: "yes",
      user_data: "#cloud-config\nruncmd: []\n",
      labels: { label: [{ key: "flagship-demo", value: "openai-build" }] },
    });
    const disk = (server.storage_devices as { storage_device: Array<Record<string, unknown>> }).storage_device[0];
    expect(disk).toMatchObject({ action: "clone", storage: TEMPLATE, size: 20, tier: "standard" });
  });

  it("prefers an explicit template UUID passed as the image", async () => {
    const other = "01000000-0000-4000-8000-000099999999";
    const { fn, calls } = fakeFetch(() => ({ status: 202, body: serverBody("maintenance") }));
    const client = createUpCloudClient({ token: "t", template: TEMPLATE, storageGb: 30, fetch: fn });
    await client.createServerWithUserData({
      name: "n", location: "de-fra1", serverType: "P", image: other, userData: "x", username: "u",
    });
    const disk = (calls[0]!.body as { server: { storage_devices: { storage_device: Array<Record<string, unknown>> } } })
      .server.storage_devices.storage_device[0];
    expect(disk).toMatchObject({ storage: other, size: 30 });
  });

  it("adds a debug SSH key only when one is configured", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 202, body: serverBody("maintenance") }));
    const args = { name: "n", location: "de-fra1", serverType: "P", userData: "x", username: "u" };
    await createUpCloudClient({ token: "t", template: TEMPLATE, fetch: fn }).createServerWithUserData(args);
    await createUpCloudClient({ token: "t", template: TEMPLATE, sshPublicKey: "ssh-ed25519 AAAA k", fetch: fn })
      .createServerWithUserData(args);
    const servers = calls.map((c) => (c.body as { server: Record<string, unknown> }).server);
    expect(servers[0]).not.toHaveProperty("login_user");
    expect(servers[1]!.login_user).toEqual({ create_password: "no", ssh_keys: { ssh_key: ["ssh-ed25519 AAAA k"] } });
  });

  it("finds a demo server by its label and exact title", async () => {
    const { fn, calls } = fakeFetch((call) => call.url.includes("?label=")
      ? { status: 200, body: { servers: { server: [
        { uuid: "11111111-1111-4111-8111-111111111111", title: "flagship-demo-openai-build-ffffffff" },
        { uuid: UUID, title: "flagship-demo-openai-build-1a2b3c4d" },
      ] } } }
      : { status: 200, body: serverBody("started") });
    const client = createUpCloudClient({ token: "t", fetch: fn });
    expect(await client.findServerByName("flagship-demo-openai-build-1a2b3c4d"))
      .toEqual({ serverId: UUID, ipv4: "94.237.1.2" });
    expect(calls[0]!.url).toBe("https://api.upcloud.com/1.3/server?label=flagship-demo%3Dopenai-build");
    expect(await client.findServerByName("flagship-demo-openai-build-00000000")).toBeNull();
  });

  it("maps UpCloud states onto the poller's vocabulary", async () => {
    for (const [state, mapped] of [["started", "running"], ["stopped", "off"], ["maintenance", "initializing"], ["error", "unknown"]]) {
      const { fn } = fakeFetch(() => ({ status: 200, body: serverBody(state!) }));
      const client = createUpCloudClient({ token: "t", fetch: fn });
      expect(await client.getServerStatus(UUID)).toEqual({ status: mapped, ipv4: "94.237.1.2" });
    }
  });

  it("destroys by stopping, waiting for stopped, then deleting server + storage", async () => {
    let state = "started";
    const { fn, calls } = fakeFetch((call) => {
      if (call.method === "POST") { state = "stopped"; return { status: 202, body: {} }; }
      if (call.method === "DELETE") return { status: 204, body: "" };
      return { status: 200, body: serverBody(state) };
    });
    const client = createUpCloudClient({ token: "t", fetch: fn, sleep: async () => undefined });
    await client.destroyServer(UUID);
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.upcloud.com/1.3", "")}`)).toEqual([
      `GET /server/${UUID}`,
      `POST /server/${UUID}/stop`,
      `GET /server/${UUID}`,
      `DELETE /server/${UUID}?storages=1&backups=delete`,
    ]);
    expect(calls[1]!.body).toEqual({ stop_server: { stop_type: "hard", timeout: "60" } });
  });

  it("treats an already-gone server as destroyed and surfaces other errors", async () => {
    const gone = createUpCloudClient({ token: "t", fetch: fakeFetch(() => ({ status: 404, body: {} })).fn });
    await expect(gone.destroyServer(UUID)).resolves.toBeUndefined();
    const broken = createUpCloudClient({ token: "t", fetch: fakeFetch(() => ({ status: 500, body: "boom" })).fn });
    await expect(broken.getServerStatus(UUID)).rejects.toBeInstanceOf(UpCloudClientError);
  });

  it("gives up when the server never stops", async () => {
    const { fn } = fakeFetch((call) => call.method === "POST"
      ? { status: 202, body: {} }
      : { status: 200, body: serverBody("started") });
    const client = createUpCloudClient({ token: "t", fetch: fn, sleep: async () => undefined, stopPollAttempts: 3 });
    await expect(client.destroyServer(UUID)).rejects.toThrow("did not stop in time");
  });
});

describe("demo cloud selection", () => {
  it("defaults to Hetzner so an unset variable changes nothing", () => {
    expect(demoCloudProvider({})).toBe("hetzner");
    expect(demoCloudProvider({ DEMO_CLOUD_PROVIDER: "bogus" })).toBe("hetzner");
    expect(demoCloudProvider({ DEMO_CLOUD_PROVIDER: " UpCloud " })).toBe("upcloud");
    const settings = createDemoCreateSettings({ HCLOUD_TOKEN: "h" });
    expect(settings).toMatchObject({
      provider: "hetzner", defaultRegion: "fsn1", defaultSize: "cpx11",
      fallbackServerTypes: ["cx23", "cpx21", "cpx22"],
    });
    expect(settings.image).toBeUndefined();
  });

  it("names exactly what UpCloud creation is missing", () => {
    expect(demoCreateMissingConfig({})).toBe("HCLOUD_TOKEN");
    expect(demoCreateMissingConfig({ DEMO_CLOUD_PROVIDER: "upcloud", HCLOUD_TOKEN: "h" }))
      .toBe("UPCLOUD_TOKEN + UPCLOUD_PLAN + UPCLOUD_TEMPLATE");
    expect(demoCreateMissingConfig({
      DEMO_CLOUD_PROVIDER: "upcloud", UPCLOUD_TOKEN: "u", UPCLOUD_PLAN: "P", UPCLOUD_TEMPLATE: TEMPLATE,
    })).toBeNull();
    expect(() => createDemoCreateSettings({ DEMO_CLOUD_PROVIDER: "upcloud" })).toThrow("UPCLOUD_TOKEN");
  });

  it("carries zone, plan and template through the demo row fields", () => {
    const settings = createDemoCreateSettings({
      DEMO_CLOUD_PROVIDER: "upcloud", UPCLOUD_TOKEN: "u", UPCLOUD_PLAN: "PLAN-A", UPCLOUD_TEMPLATE: TEMPLATE,
    });
    expect(settings).toMatchObject({ provider: "upcloud", defaultRegion: "de-fra1", defaultSize: "PLAN-A", image: TEMPLATE });
    expect(settings.fallbackServerTypes).toBeUndefined();
    expect(createDemoCreateSettings({
      DEMO_CLOUD_PROVIDER: "upcloud", UPCLOUD_TOKEN: "u", UPCLOUD_PLAN: "P", UPCLOUD_TEMPLATE: TEMPLATE, UPCLOUD_ZONE: "fi-hel1",
    }).defaultRegion).toBe("fi-hel1");
  });

  it("routes existing servers by id shape, whichever provider is selected", async () => {
    expect(isUpCloudServerId(UUID)).toBe(true);
    expect(isUpCloudServerId("153813669")).toBe(false);
    const fetchFn = vi.fn<FetchLike>(async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.startsWith("https://api.upcloud.com")
        ? serverBody("started")
        : { server: { status: "running", public_net: { ipv4: { ip: "5.6.7.8" } } } }),
    }));
    const router = createDemoServerRouter(
      { DEMO_CLOUD_PROVIDER: "upcloud", HCLOUD_TOKEN: "h", UPCLOUD_TOKEN: "u" },
      fetchFn,
    );
    expect(await router.getServerStatus("153813669")).toEqual({ status: "running", ipv4: "5.6.7.8" });
    expect(fetchFn.mock.calls[0]![0]).toBe("https://api.hetzner.cloud/v1/servers/153813669");
    expect(await router.getServerStatus(UUID)).toEqual({ status: "running", ipv4: "94.237.1.2" });
    expect(fetchFn.mock.calls[1]![0]).toBe(`https://api.upcloud.com/1.3/server/${UUID}`);
  });

  it("fails clearly when the routed provider has no token", async () => {
    const router = createDemoServerRouter({ UPCLOUD_TOKEN: "u" });
    await expect(router.destroyServer("153813669")).rejects.toThrow("HCLOUD_TOKEN is not configured");
    expect(hasAnyDemoCloudToken({ UPCLOUD_TOKEN: "u" })).toBe(true);
    expect(hasAnyDemoCloudToken({})).toBe(false);
  });
});

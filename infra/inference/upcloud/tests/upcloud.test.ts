// The UpCloud inference provisioner: config checks, cloud-init rendering,
// the firewall, and the API calls create/teardown make. `fetch` is faked;
// nothing reaches UpCloud.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error JavaScript CLI intentionally has no declaration file.
import { firewallRules, loadConfig, readSecrets, renderCloudInit, serverCreateBody, validateConfig, vllmArgs } from "../lib.mjs";
// @ts-expect-error JavaScript CLI intentionally has no declaration file.
import { parseArgs, run } from "../provision.mjs";
// @ts-expect-error JavaScript CLI intentionally has no declaration file.
import { teardown } from "../teardown.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const config = loadConfig(join(HERE, "config.json"));
const secrets = { apiKey: "k".repeat(48), tunnelToken: "t".repeat(64) };
const UUID = "00798b85-efdc-41ca-8021-f6ef457b8531";

interface Call { url: string; method: string; body: unknown }

function fakeUpCloud(routes: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = async (url: string, init: { method: string; body?: string }) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = routes(call);
    return { status: r.status, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) };
  };
  return { fn, calls };
}

function lines() {
  const out: string[] = [];
  return { out, push: (s: string) => void out.push(s) };
}

describe("config", () => {
  it("ships a config that validates and pins the image and the weights", () => {
    expect(config.vllm.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(config.vllm.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(config.cloudflared.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ships presets that all validate and render", () => {
    const dir = join(HERE, "presets");
    const names = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    expect(names.length).toBeGreaterThan(0);
    for (const f of names) {
      const preset = loadConfig(join(dir, f));
      expect(renderCloudInit(preset, secrets)).toContain(preset.vllm.revision);
    }
  });

  it("quotes the chat-template default as one systemd argument", () => {
    const rendered = renderCloudInit(config, secrets);
    expect(rendered).toContain(`--default-chat-template-kwargs '{"enable_thinking":false}'`);
    expect(() => validateConfig({ ...config, vllm: { ...config.vllm, defaultChatTemplateKwargs: { x: "it's" } } }))
      .toThrow(/defaultChatTemplateKwargs/);
  });

  it("refuses an unpinned image or model", () => {
    expect(() => validateConfig({ ...config, vllm: { ...config.vllm, imageDigest: "latest" } })).toThrow(/imageDigest/);
    expect(() => validateConfig({ ...config, vllm: { ...config.vllm, revision: "main" } })).toThrow(/revision/);
    expect(() => validateConfig({ ...config, vllm: { ...config.vllm, extraArgs: ["--x; rm -rf /"] } })).toThrow(/extraArgs/);
  });
});

describe("cloud-init", () => {
  const rendered = renderCloudInit(config, secrets);

  it("fills every placeholder and keeps vLLM private, keyed and quiet", () => {
    expect(rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(rendered.startsWith("#cloud-config\n")).toBe(true);
    expect(rendered).toContain(`VLLM_API_KEY=${secrets.apiKey}`);
    expect(rendered).toContain(`TUNNEL_TOKEN=${secrets.tunnelToken}`);
    expect(rendered).toContain(`${config.vllm.image}@${config.vllm.imageDigest}`);
    const args = vllmArgs(config);
    expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
    expect(args).toContain("--enable-prefix-caching");
    expect(args).toContain("--disable-uvicorn-access-log");
    expect(args).toEqual(expect.arrayContaining(["--tool-call-parser", config.vllm.toolCallParser, "--revision", config.vllm.revision]));
    expect(args.join(" ")).not.toContain("--enable-log-requests");
    expect(args.join(" ")).not.toContain("--api-key"); // from the 0600 env file, not the process list
    expect(rendered).toContain("Storage=volatile");
    expect(rendered).toContain("VLLM_NO_USAGE_STATS=1");
  });

  it("refuses an unknown placeholder and a secret that could break the YAML", () => {
    expect(() => renderCloudInit(config, secrets, "x: {{NOPE}}")).toThrow(/NOPE/);
    expect(() => readSecrets({ VLLM_API_KEY: "a".repeat(30) + "\nevil: 1", CF_TUNNEL_TOKEN: "t".repeat(40) })).toThrow(/VLLM_API_KEY/);
    expect(() => readSecrets({ VLLM_API_KEY: "a".repeat(30) })).toThrow(/CF_TUNNEL_TOKEN/);
  });

  it("stays within UpCloud's user_data size", () => {
    expect(Buffer.byteLength(rendered)).toBeLessThan(32 * 1024);
  });
});

describe("firewall", () => {
  const rules = firewallRules();
  it("ends in a bare default drop and opens no listening port", () => {
    expect(rules.at(-1)).toEqual({ direction: "in", action: "drop" });
    for (const r of rules.slice(0, -1)) {
      expect(r.direction).toBe("in");
      expect(r.destination_port_start).toBeUndefined(); // replies are matched by SOURCE port only
    }
    expect(rules.some((r: { source_port_start?: string }) => r.source_port_start === "22")).toBe(false);
  });
});

describe("provision", () => {
  it("defaults to a dry run that redacts secrets", async () => {
    const o = lines();
    const code = await run(parseArgs([]), {
      env: { VLLM_API_KEY: secrets.apiKey, CF_TUNNEL_TOKEN: secrets.tunnelToken },
      out: o.push,
      config,
    });
    expect(code).toBe(0);
    const text = o.out.join("\n");
    expect(text).toContain('"plan": "' + config.plan + '"');
    expect(text).not.toContain(secrets.apiKey);
    expect(text).not.toContain(secrets.tunnelToken);
    expect(text).toContain("<redacted>");
  });

  it("won't create or stop without --yes", async () => {
    await expect(run(parseArgs(["create"]), { env: {}, out: () => {}, config })).rejects.toThrow(/--yes/);
    await expect(run(parseArgs(["stop"]), { env: {}, out: () => {}, config })).rejects.toThrow(/--yes/);
  });

  it("creates once with the firewall on, then applies the rules", async () => {
    const api = fakeUpCloud((c) => {
      if (c.method === "GET" && c.url.includes("/server?label=")) return { status: 200, body: { servers: { server: [] } } };
      if (c.method === "GET" && c.url.endsWith("/storage/template")) {
        return { status: 200, body: { storages: { storage: [{ uuid: "01000000-0000-4000-8000-000030240200", title: config.templateTitle }] } } };
      }
      if (c.method === "POST" && c.url.endsWith("/server")) return { status: 202, body: { server: { uuid: UUID, state: "maintenance" } } };
      if (c.method === "PUT" && c.url.endsWith(`/server/${UUID}/firewall_rule`)) return { status: 204 };
      return { status: 500, body: { error: c.url } };
    });
    const o = lines();
    const code = await run(parseArgs(["create", "--yes"]), {
      env: { UPCLOUD_TOKEN: "ucat_test", VLLM_API_KEY: secrets.apiKey, CF_TUNNEL_TOKEN: secrets.tunnelToken },
      out: o.push,
      fetch: api.fn,
      sleep: async () => {},
      config: { ...config, template: undefined },
    });
    expect(code).toBe(0);
    const create = api.calls.find((c) => c.method === "POST")!.body as { server: Record<string, unknown> };
    expect(create.server).toMatchObject({ plan: config.plan, zone: config.zone, firewall: "on", metadata: "yes" });
    expect(create.server.login_user).toEqual({ create_password: "no" });
    expect(String(create.server.user_data)).toContain(`TUNNEL_TOKEN=${secrets.tunnelToken}`);
    const fw = api.calls.find((c) => c.method === "PUT")!.body as { firewall_rules: { firewall_rule: unknown[] } };
    expect(fw.firewall_rules.firewall_rule).toEqual(firewallRules());
    expect(o.out.join("\n")).not.toContain(secrets.apiKey);
  });

  it("doesn't create a second server", async () => {
    const api = fakeUpCloud((c) =>
      c.method === "GET"
        ? { status: 200, body: { servers: { server: [{ uuid: UUID, title: config.name, state: "started" }] } } }
        : { status: 500 });
    const o = lines();
    await run(parseArgs(["create", "--yes"]), {
      env: { UPCLOUD_TOKEN: "ucat_test", VLLM_API_KEY: secrets.apiKey, CF_TUNNEL_TOKEN: secrets.tunnelToken },
      out: o.push, fetch: api.fn, config,
    });
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(o.out[0]).toContain("already exists");
  });
});

describe("teardown", () => {
  it("hard-stops, waits, then deletes the server with its storage and backups", async () => {
    let state = "started";
    const api = fakeUpCloud((c) => {
      if (c.method === "GET" && c.url.includes("/server?label=")) {
        return { status: 200, body: { servers: { server: [{ uuid: UUID, title: config.name, state }] } } };
      }
      if (c.method === "GET") return { status: 200, body: { server: { uuid: UUID, state } } };
      if (c.method === "POST" && c.url.endsWith("/stop")) {
        state = "stopped";
        return { status: 202 };
      }
      if (c.method === "DELETE") return { status: 204 };
      return { status: 500 };
    });
    const code = await teardown({ yes: true }, { env: { UPCLOUD_TOKEN: "ucat_test" }, out: () => {}, fetch: api.fn, sleep: async () => {}, config });
    expect(code).toBe(0);
    const del = api.calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe(`https://api.upcloud.com/1.3/server/${UUID}?storages=1&backups=delete`);
  });

  it("needs --yes", async () => {
    await expect(teardown({ yes: false }, { env: {}, out: () => {}, config })).rejects.toThrow(/--yes/);
  });
});

describe("RunPod pod image", () => {
  const vllmDir = join(HERE, "..", "vllm");
  const code = (f: string) =>
    readFileSync(join(vllmDir, f), "utf8").split("\n").filter((l: string) => !l.trim().startsWith("#")).join("\n");

  it("serves the same pinned model with the same flags as UpCloud", () => {
    const launch = code("launch.sh");
    for (const v of [config.vllm.model, config.vllm.revision, config.vllm.servedModelName]) expect(launch).toContain(v);
    for (const a of vllmArgs(config).filter((x: string) => x.startsWith("--") && !["--model", "--revision", "--served-model-name", "--host", "--max-model-len", "--gpu-memory-utilization", "--max-num-seqs"].includes(x))) {
      expect(launch).toContain(a);
    }
    expect(launch).toContain(`--tool-call-parser ${config.vllm.toolCallParser}`);
    expect(launch).not.toContain("--enable-log-requests");
    expect(launch).not.toContain("--disable-log-requests");
    expect(code("Dockerfile")).toContain(`vllm/vllm-openai@${config.vllm.imageDigest}`);
  });
});

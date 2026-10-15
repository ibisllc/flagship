import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accessListFromEgressHosts, parseAccessList } from "@flagship/protocol";
import { EgressGateway } from "../../src/egress/gateway.js";
import { sandboxGateway, sandboxRunArgs, setSandboxNetworking } from "../../src/egress/sandboxNetworking.js";
import type { CommandRunner } from "../../src/serviceRunner.js";

const NETS: Record<string, { subnet: string; gw: string; bridge: string; internal: boolean }> = {
  "flagship-build": { subnet: "172.24.0.0/16", gw: "172.24.0.1", bridge: "fs-build", internal: true },
  "flagship-staging": { subnet: "172.21.0.0/16", gw: "172.21.0.1", bridge: "fs-staging", internal: false },
  "flagship-apps": { subnet: "172.22.0.0/16", gw: "172.22.0.1", bridge: "fs-apps", internal: false },
};

function fakeDocker(apps: () => Record<string, string>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const inspect = (name: string) => {
    const n = NETS[name]!;
    const containers = name === "flagship-apps" ? Object.fromEntries(Object.entries(apps()).map(([ip, cname], i) => [`c${i}`, { Name: cname, IPv4Address: `${ip}/16` }])) : {};
    return JSON.stringify({ Id: `${name}-id-0000000`, Name: name, Internal: n.internal, Options: { "com.docker.network.bridge.name": n.bridge }, IPAM: { Config: [{ Subnet: n.subnet, Gateway: n.gw }] }, Containers: containers });
  };
  return {
    calls,
    async run(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
    },
    async capture(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "docker" && args[0] === "network" && args[1] === "inspect") return { stdout: inspect(args[2]!), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
}

afterEach(() => setSandboxNetworking(null));

const rulesOf = (approved: Record<string, string[]>) => (id: string) => parseAccessList(accessListFromEgressHosts(approved[id] ?? [])).rules;

describe("EgressGateway", () => {
  it("enforces, publishes the gateway IPs, and learns new app containers on a miss", async () => {
    let apps: Record<string, string> = { "172.22.0.2": "flagship-harry-weather" };
    const approved: Record<string, string[]> = { "harry-weather": ["api.github.com"], "harry-notes": ["api.github.com"] };
    const cmd = fakeDocker(() => apps);
    let t = 10_000;
    const gw = new EgressGateway({ cmd, accessRules: rulesOf(approved), rulesDir: mkdtempSync(join(tmpdir(), "gw-")), log: () => {}, now: () => t });
    expect((await gw.start()).enforced).toBe(true);
    try {
      expect(cmd.calls.some((c) => c.startsWith("iptables-restore -w --noflush"))).toBe(true);
      expect(sandboxGateway("flagship-apps")).toBe("172.22.0.1");
      expect(sandboxGateway("flagship-build")).toBe("172.24.0.1");
      expect(gw.dnsServerFor("apps")).toBe("172.22.0.1");
      // gVisor never reaches docker's 127.0.0.11, so apps get a resolv.conf naming the gateway.
      const runArgs = sandboxRunArgs("flagship-apps", "host.flagship.internal")!;
      const mount = runArgs[runArgs.indexOf("--mount") + 1]!;
      expect(mount).toMatch(/^type=bind,src=.*\/flagship-resolv-flagship-apps\.conf,dst=\/etc\/resolv\.conf,readonly$/);
      expect(readFileSync(/src=([^,]+)/.exec(mount)![1]!, "utf8")).toBe("nameserver 172.22.0.1\noptions ndots:0\n");

      expect(await gw.allowSync("172.22.0.2", "api.github.com")).toBe(true);
      expect(await gw.allowSync("172.24.0.5", "registry.npmjs.org")).toBe(true);
      expect(await gw.allowSync("172.21.0.5", "registry.npmjs.org")).toBe(false);

      apps = { ...apps, "172.22.0.3": "flagship-harry-notes" };
      t += 5000;
      expect(await gw.allowSync("172.22.0.3", "api.github.com")).toBe(true);
    } finally {
      await gw.stop();
    }
    expect(sandboxGateway("flagship-apps")).toBeNull();
  });

  it("recheck cuts connections an approval no longer covers; an IP handed to another app loses the old app's access", async () => {
    let apps: Record<string, string> = { "172.22.0.2": "flagship-harry-weather" };
    const approved: Record<string, string[]> = { "harry-weather": ["api.github.com"] };
    const gw = new EgressGateway({ cmd: fakeDocker(() => apps), accessRules: rulesOf(approved), rulesDir: mkdtempSync(join(tmpdir(), "gw-")), log: () => {} });
    await gw.start();
    try {
      const closed: string[] = [];
      const deps = (gw as unknown as { proxyDeps(): { track: (c: { src: string; host: string; close: () => void }) => () => void } }).proxyDeps();
      deps.track({ src: "172.22.0.2", host: "api.github.com", close: () => closed.push("a") });
      expect(gw.recheck()).toBe(0);
      approved["harry-weather"] = [];
      expect(gw.recheck()).toBe(1);
      expect(closed).toEqual(["a"]);

      approved["harry-weather"] = ["api.github.com"];
      deps.track({ src: "172.22.0.2", host: "api.github.com", close: () => closed.push("b") });
      apps = { "172.22.0.2": "flagship-harry-notes" };
      await gw.refreshApps();
      expect(closed).toEqual(["a", "b"]);
      expect(await gw.allowSync("172.22.0.2", "api.github.com")).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("tells the caller about a default deny, never an explicit one", async () => {
    const apps: Record<string, string> = { "172.22.0.2": "flagship-harry-weather" };
    const lists: Record<string, string> = { "harry-weather": "deny ads.example.com\nallow api.github.com\n" };
    const seen: string[] = [];
    const gw = new EgressGateway({
      cmd: fakeDocker(() => apps),
      accessRules: (id) => parseAccessList(lists[id] ?? "").rules,
      onUnmatched: (id, host) => seen.push(`${id} ${host}`),
      rulesDir: mkdtempSync(join(tmpdir(), "gw-")),
      log: () => {},
    });
    await gw.start();
    try {
      const deps = (gw as unknown as { proxyDeps(): { onDenied: (s: string, h: string | null, k: string) => void } }).proxyDeps();
      expect(await gw.allowSync("172.22.0.2", "api.github.com")).toBe(true);
      expect(await gw.allowSync("172.22.0.2", "ads.example.com")).toBe(false);
      deps.onDenied("172.22.0.2", "ads.example.com", "dns");
      expect(seen).toEqual([]);
      deps.onDenied("172.22.0.2", "Weather.Example.ORG.", "tls");
      deps.onDenied("172.22.0.2", null, "tls");
      deps.onDenied("172.24.0.5", "example.org", "dns");
      expect(seen).toEqual(["harry-weather weather.example.org"]);
      lists["harry-weather"] = "allow all\n";
      deps.onDenied("172.22.0.2", "weather.example.org", "dns");
      expect(seen).toHaveLength(1);
    } finally {
      await gw.stop();
    }
  });

  it("reports not enforced when docker networks can't be made, and touches nothing", async () => {
    const cmd: CommandRunner = {
      async run() {
        throw new Error("Cannot connect to the Docker daemon");
      },
      async capture() {
        throw new Error("Cannot connect to the Docker daemon");
      },
    };
    const gw = new EgressGateway({ cmd, accessRules: () => [], log: () => {} });
    const s = await gw.start();
    expect(s.enforced).toBe(false);
    expect(s.reason).toMatch(/could not be created/);
    expect(sandboxGateway("flagship-apps")).toBeNull();
    expect(gw.dnsServerFor("apps")).toBeNull();
  });
});

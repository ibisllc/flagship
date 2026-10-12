import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressGateway } from "../../src/egress/gateway.js";
import { sandboxGateway, setSandboxNetworking } from "../../src/egress/sandboxNetworking.js";
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

describe("EgressGateway", () => {
  it("enforces, publishes the gateway IPs, and learns new app containers on a miss", async () => {
    let apps: Record<string, string> = { "172.22.0.2": "flagship-harry-weather" };
    const approved: Record<string, string[]> = { "harry-weather": ["api.github.com"], "harry-notes": ["api.github.com"] };
    const cmd = fakeDocker(() => apps);
    let t = 10_000;
    const gw = new EgressGateway({ cmd, approvedHosts: (id) => approved[id] ?? [], rulesDir: mkdtempSync(join(tmpdir(), "gw-")), log: () => {}, now: () => t });
    expect((await gw.start()).enforced).toBe(true);
    try {
      expect(cmd.calls.some((c) => c.startsWith("iptables-restore -w --noflush"))).toBe(true);
      expect(sandboxGateway("flagship-apps")).toBe("172.22.0.1");
      expect(sandboxGateway("flagship-build")).toBe("172.24.0.1");
      expect(gw.dnsServerFor("apps")).toBe("172.22.0.1");

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
    const gw = new EgressGateway({ cmd: fakeDocker(() => apps), approvedHosts: (id) => approved[id] ?? [], rulesDir: mkdtempSync(join(tmpdir(), "gw-")), log: () => {} });
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

  it("reports not enforced when docker networks can't be made, and touches nothing", async () => {
    const cmd: CommandRunner = {
      async run() {
        throw new Error("Cannot connect to the Docker daemon");
      },
      async capture() {
        throw new Error("Cannot connect to the Docker daemon");
      },
    };
    const gw = new EgressGateway({ cmd, approvedHosts: () => [], log: () => {} });
    const s = await gw.start();
    expect(s.enforced).toBe(false);
    expect(s.reason).toMatch(/could not be created/);
    expect(sandboxGateway("flagship-apps")).toBeNull();
    expect(gw.dnsServerFor("apps")).toBeNull();
  });
});

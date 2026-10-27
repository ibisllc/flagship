import { afterEach, describe, expect, it } from "vitest";
import { endpoints } from "../src/endpoints.js";
import { setActiveEngine } from "../src/engine/engine.js";
import { AppRunner, resetAddressPools, type CommandRunner } from "../src/serviceRunner.js";

/** An engine that remembers what was run and answers `inspect` for the one container it "started". */
function fakeEngine(opts: { podman: boolean; ipOverride?: string; labelOverride?: string; running?: boolean }) {
  const runs: string[][] = [];
  let started = 0;
  const cmd: CommandRunner = {
    async run(_c, args) {
      if (args[0] === "run") {
        runs.push(args);
        started++;
      }
    },
    async capture(_c, args) {
      if (args[0] === "network") {
        return {
          stdout: JSON.stringify([{ name: "flagship-apps", id: "n1", network_interface: "fs-apps", subnets: [{ subnet: "10.89.1.0/24", gateway: "10.89.1.1" }], options: { mode: "unmanaged" }, containers: {} }]),
          stderr: "",
        };
      }
      if (args[0] === "inspect") {
        const run = runs[runs.length - 1]!;
        const ip = run[run.indexOf("--ip") + 1];
        const labels = Object.fromEntries(
          run.flatMap((a, i) => (a === "--label" ? [run[i + 1]!.split("=") as [string, string]] : [])),
        );
        const net = opts.podman ? { "flagship-apps": { IPAddress: opts.ipOverride ?? ip } } : { "flagship-apps": { IPAddress: "10.89.1.9" } };
        return {
          stdout: JSON.stringify({
            Id: `cid${started}`,
            State: { Running: opts.running ?? true, StartedAt: `2026-10-27T10:00:0${started}Z` },
            Config: { Labels: { ...labels, ...(opts.labelOverride ? { "flagship.service": opts.labelOverride } : {}) } },
            NetworkSettings: { Networks: net },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  };
  return { cmd, runs };
}

const spec = { serviceId: "svc1", image: "img@sha256:aa", port: 41001, containerPort: 8080 };
const key = { serviceId: "svc1", env: "live" as const, component: "main", role: "http" as const };

afterEach(() => {
  resetAddressPools();
  setActiveEngine("docker");
  endpoints.invalidate("svc1");
});

describe("AppRunner on Podman: no published port, a direct endpoint", () => {
  it("runs the container at the address its service owns, with no -p, and publishes the verified endpoint", async () => {
    setActiveEngine("podman");
    const { cmd, runs } = fakeEngine({ podman: true });
    await new AppRunner(cmd).deploy(spec);
    const args = runs[0]!;
    expect(args).not.toContain("-p");
    expect(args[args.indexOf("--ip") + 1]).toBe("10.89.1.2");
    expect(args.join(" ")).toMatch(/--label flagship\.service=svc1 --label flagship\.generation=\d+/);
    const ep = endpoints.lookup(key)!;
    expect(ep.host).toBe("10.89.1.2");
    expect(ep.port).toBe(8080);
    expect(ep.incarnation).toBe("cid1:2026-10-27T10:00:01Z");
  });

  it("a redeploy keeps the service's address and drops the old connections", async () => {
    setActiveEngine("podman");
    const { cmd, runs } = fakeEngine({ podman: true });
    const runner = new AppRunner(cmd);
    await runner.deploy(spec);
    const lease = endpoints.acquire(key)!;
    const ws = { destroyed: false, destroy() { this.destroyed = true; } };
    lease.bind(ws);
    await runner.deploy(spec);
    expect(ws.destroyed).toBe(true);
    expect(lease.current()).toBe(false);
    expect(runs[1]![runs[1]!.indexOf("--ip") + 1]).toBe(runs[0]![runs[0]!.indexOf("--ip") + 1]);
    expect(endpoints.acquire(key)!.endpoint.incarnation).toBe("cid2:2026-10-27T10:00:02Z");
  });

  it("two services get two addresses", async () => {
    setActiveEngine("podman");
    const { cmd, runs } = fakeEngine({ podman: true });
    const runner = new AppRunner(cmd);
    await runner.deploy(spec);
    await runner.deploy({ ...spec, serviceId: "svc2", port: 41002 });
    expect(runs[0]![runs[0]!.indexOf("--ip") + 1]).not.toBe(runs[1]![runs[1]!.indexOf("--ip") + 1]);
    endpoints.invalidate("svc2");
  });

  it("refuses to route to a container at another address, or labelled for another service", async () => {
    setActiveEngine("podman");
    await expect(new AppRunner(fakeEngine({ podman: true, ipOverride: "10.89.1.77" }).cmd).deploy(spec)).rejects.toThrow(/not at the address assigned/);
    expect(endpoints.lookup(key)).toBeNull();
    await expect(new AppRunner(fakeEngine({ podman: true, labelOverride: "someone-else" }).cmd).deploy(spec)).rejects.toThrow(/not labelled for this service/);
    expect(endpoints.lookup(key)).toBeNull();
  });

  it("leaves a container that is not running to the start check, and publishes nothing", async () => {
    setActiveEngine("podman");
    await new AppRunner(fakeEngine({ podman: true, running: false }).cmd).deploy(spec);
    expect(endpoints.lookup(key)).toBeNull();
  });

  it("stop closes the connections first", async () => {
    setActiveEngine("podman");
    const runner = new AppRunner(fakeEngine({ podman: true }).cmd);
    await runner.deploy(spec);
    const lease = endpoints.acquire(key)!;
    await runner.stop("svc1");
    expect(lease.current()).toBe(false);
    expect(endpoints.acquire(key)).toBeNull();
  });
});

describe("AppRunner on Docker: the loopback publish is kept, through the same table", () => {
  it("publishes -p and resolves to the loopback port", async () => {
    setActiveEngine("docker");
    const { cmd, runs } = fakeEngine({ podman: false });
    await new AppRunner(cmd).deploy(spec);
    expect(runs[0]).toContain("-p");
    expect(runs[0]).not.toContain("--ip");
    expect(endpoints.lookup(key)).toMatchObject({ host: "127.0.0.1", port: 41001 });
  });
});

describe("an app group's members each have an entry and an address", () => {
  const member = (component: string, port: number) => ({ ...spec, component, port, containerName: `flagship-svc1.${component}` });
  const keyOf = (component: string) => ({ ...key, component });

  it("deploying one member leaves the others published, with a different address each", async () => {
    setActiveEngine("podman");
    const { cmd, runs } = fakeEngine({ podman: true });
    const runner = new AppRunner(cmd);
    await runner.deploy(member("worker", 41010));
    const lease = endpoints.acquire(keyOf("worker"))!;
    await runner.deploy(member("web", 41011));
    expect(lease.current()).toBe(true);
    expect(endpoints.lookup(keyOf("web"))!.host).not.toBe(endpoints.lookup(keyOf("worker"))!.host);
    expect(runs.map((r) => r[r.indexOf("--ip") + 1])).toEqual(["10.89.1.2", "10.89.1.3"]);
    // Removing the service frees every component's address.
    await runner.releaseAddress("svc1");
    endpoints.invalidate("svc1");
  });
});

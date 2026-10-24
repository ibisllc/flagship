import { describe, expect, it } from "vitest";
import { EngineTranslationError, engineArgv, newBoxArchV2Config, parseArchV2Config } from "../src/engine/engine.js";
import { networkCreateArgs, parseNetworkInspect } from "../src/egress/networks.js";
import { hooksFor, renderIccTable } from "../src/egress/firewall.js";
import { podmanRuntimeConf } from "../src/appSandbox/gvisor.js";
import { EGRESS_NETWORKS } from "../src/egress/policy.js";

describe("the box switch", () => {
  it("leaves an existing box (no file, a damaged file) on the old path", () => {
    expect(parseArchV2Config(null)).toEqual({ version: 1, rust: "off", engine: "docker" });
    expect(parseArchV2Config("{not json")).toEqual({ version: 1, rust: "off", engine: "docker" });
    expect(parseArchV2Config('{"rust":"yes","engine":"containerd"}')).toEqual({ version: 1, rust: "off", engine: "docker" });
  });
  it("turns both on for a new box", () => {
    const c = newBoxArchV2Config(new Date(0));
    expect(parseArchV2Config(JSON.stringify(c))).toEqual({ version: 1, rust: "on", engine: "podman", source: "new-box", setAt: "1970-01-01T00:00:00.000Z" });
  });
});

describe("engineArgv", () => {
  it("leaves Docker and every other program alone", () => {
    expect(engineArgv("docker", ["ps"], "docker")).toEqual(["docker", ["ps"]]);
    expect(engineArgv("systemctl", ["restart", "x"], "podman")).toEqual(["systemctl", ["restart", "x"]]);
  });
  it("runs the app lifecycle argv unchanged under Podman", () => {
    const run = ["run", "-d", "--name", "flagship-a--b", "--runtime=runsc", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--add-host", "host.flagship.internal:host-gateway", "img"];
    expect(engineArgv("docker", run, "podman")).toEqual(["podman", run]);
    for (const sub of ["save", "load", "exec", "pause", "logs", "build", "compose", "volume", "image"]) {
      expect(engineArgv("docker", [sub, "x"], "podman")[0]).toBe("podman");
    }
  });
  it("translates the info and version formats the daemon asks for", () => {
    expect(engineArgv("docker", ["info", "--format", "{{.ServerVersion}}"], "podman")).toEqual(["podman", ["info", "--format", "{{.Version.Version}}"]]);
    expect(engineArgv("docker", ["info", "--format", "{{.CgroupDriver}}"], "podman")[1][2]).toBe("{{.Host.CgroupManager}}");
    expect(engineArgv("docker", ["version", "--format", "{{.Server.Version}}"], "podman")[1][2]).toBe("{{.Client.Version}}");
    expect(() => engineArgv("docker", ["info", "--format", "{{json .Runtimes}}"], "podman")).toThrow(EngineTranslationError);
  });
  it("maps the sandbox bridges' name and isolation to Podman's own flags", () => {
    const spec = EGRESS_NETWORKS.find((n) => n.kind === "build")!;
    const [cmd, args] = engineArgv("docker", networkCreateArgs(spec.network, spec), "podman");
    expect(cmd).toBe("podman");
    expect(args).toEqual(["network", "create", "--disable-dns", "--driver", "bridge", "--internal", "--interface-name", "fs-build", "--label", "flagship.icc=false", "flagship-build"]);
  });
  it("refuses forms with no Podman meaning instead of guessing", () => {
    expect(() => engineArgv("docker", ["swarm", "init"], "podman")).toThrow(/no translation/);
    expect(() => engineArgv("docker", ["network", "create", "-o", "com.docker.network.driver.mtu=1400", "n"], "podman")).toThrow(/no translation/);
  });
});

describe("Podman networks", () => {
  it("reads netavark's inspect shape, isolation from the label", () => {
    const n = parseNetworkInspect(
      JSON.stringify([
        {
          name: "flagship-apps",
          id: "abc123",
          network_interface: "fs-apps",
          internal: false,
          labels: { "flagship.icc": "false" },
          subnets: [{ subnet: "10.89.0.0/24", gateway: "10.89.0.1" }],
          containers: { c1: { name: "flagship-a--b", interfaces: { eth0: { subnets: [{ ipnet: "10.89.0.5/24" }] } } } },
        },
      ]),
    );
    expect(n).toEqual({
      id: "abc123",
      name: "flagship-apps",
      bridge: "fs-apps",
      internal: false,
      icc: false,
      subnets: ["10.89.0.0/24"],
      gateways: ["10.89.0.1"],
      containers: [{ name: "flagship-a--b", ipv4: "10.89.0.5" }],
    });
  });
  it("still reads Docker's shape", () => {
    const n = parseNetworkInspect(JSON.stringify({ Id: "d1", Name: "flagship-apps", Options: { "com.docker.network.bridge.name": "fs-apps", "com.docker.network.bridge.enable_icc": "false" } }));
    expect(n?.bridge).toBe("fs-apps");
    expect(n?.icc).toBe(false);
  });
});

describe("firewall under Podman", () => {
  it("hangs the forward chain off FORWARD (there is no DOCKER-USER)", () => {
    expect(hooksFor("docker").some((h) => h.parent === "DOCKER-USER")).toBe(true);
    expect(hooksFor("podman").some((h) => h.parent === "DOCKER-USER")).toBe(false);
    expect(hooksFor("podman").filter((h) => h.parent === "FORWARD").length).toBe(2);
  });
  it("drops port-to-port frames on each sandbox bridge, replacing the table atomically", () => {
    const t = renderIccTable([
      { kind: "apps", bridge: "fs-apps" },
      { kind: "build", bridge: "fs-build" },
    ]);
    expect(t).toContain("delete table bridge flagship_icc");
    expect(t).toContain('meta ibrname "fs-apps" meta obrname "fs-apps" counter drop');
    expect(t).toContain('meta ibrname "fs-build" meta obrname "fs-build" counter drop');
    expect(() => renderIccTable([{ kind: "apps", bridge: 'x"; flush ruleset' }])).toThrow();
  });
});

describe("gVisor under Podman", () => {
  it("registers runsc by path in a containers.conf drop-in", () => {
    expect(podmanRuntimeConf("/usr/local/lib/flagship-gvisor/20260921.0/runsc")).toContain('runsc = ["/usr/local/lib/flagship-gvisor/20260921.0/runsc"]');
    expect(() => podmanRuntimeConf('/x"]\n[engine]')).toThrow();
  });
});

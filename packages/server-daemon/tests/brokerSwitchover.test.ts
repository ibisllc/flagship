/**
 * The daemon gives up root on an architecture v2 box with the Rust broker as its privileged helper
 * (SEC-DAEMON-001 carried into the Rust stack): which helper it picks, how the switch goes, the
 * broker unit and its TS privd fallback, keyd and broker admitting the daemon's uid, the Rust
 * units kept current without root, and the switch back to flagship-privd when the Rust path is
 * turned off. Also: the broker translates docker to Podman exactly as the daemon does.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrivdServer, SETUP_STEPS, dockerExec, dockerFileExec, iccTable, podmanArgv, type Exec, type RunResult } from "@flagship/privd";
import { dockerBuildArgs } from "../src/serviceRunner.js";
import { filesArchiveDockerArgs, filesSizeDockerArgs } from "../src/volumeDump.js";
import { PRIVD_DAEMON_DROPIN_PATH, PRIVD_UNIT_PATH, daemonPrivdDropIn, privdUnit } from "@flagship/privd/unit";
import { privilegedHelperFor, rustStackAsRoot } from "../src/archV2Boot.js";
import { engineArgv } from "../src/engine/engine.js";
import { renderIccTable } from "../src/egress/firewall.js";
import { networkCreateArgs } from "../src/egress/networks.js";
import { EGRESS_NETWORKS } from "../src/egress/policy.js";
import { UNPRIVILEGED_ENV, routePrivileged } from "../src/privileged.js";
import { BROKER_HELPER, installPrivd } from "../src/privdInstall.js";
import { installRustStack } from "../src/rustStack/install.js";
import { STEPS } from "../src/setup.js";
import { BROKER_UNIT_PATH, BROKER_V1_SOCKET, CORE_UNIT_PATH, KEYD_RUST_DROPIN_PATH, brokerServiceUnit, rustSelectScript } from "../src/rustStack/units.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("which helper the daemon hands host operations to", () => {
  const on = { version: 1 as const, rust: "on" as const, engine: "podman" as const };
  it("is the Rust broker only when the switch is on and its units are in", () => {
    for (const action of ["installed", "unchanged", "restarted"] as const) expect(privilegedHelperFor({ config: on, rust: { action, restarted: [] } })).toBe("broker");
    expect(privilegedHelperFor({ config: on, rust: { action: "skipped", reason: "no pins" } })).toBe("privd");
    expect(privilegedHelperFor({ config: on, rust: { action: "failed", reason: "x" } })).toBe("privd");
    expect(privilegedHelperFor({ config: { ...on, rust: "off" }, rust: { action: "unchanged", restarted: [] } })).toBe("privd");
  });
});

describe("installPrivd with the Rust broker", () => {
  const base = (over: Partial<Parameters<typeof installPrivd>[0]> = {}, files: Record<string, string> = {}) => {
    const written = new Map<string, string>();
    const runs: string[] = [];
    let handedOver = false;
    const o: Parameters<typeof installPrivd>[0] = {
      repoPath: "/opt/flagship",
      helper: "broker",
      hasSystemd: () => true,
      fileExists: () => true,
      read: async (p) => files[p] ?? written.get(p) ?? null,
      write: async (p, c) => void written.set(p, c),
      run: async (c, a) => void runs.push(`${c} ${a.join(" ")}`),
      handOver: async () => {
        handedOver = true;
      },
      ...over,
    };
    return { o, written, runs, handedOver: () => handedOver };
  };

  it("switches onto the broker's v1 socket once it answers, without a flagship-privd unit", async () => {
    let asked = "";
    const up = base({ brokerAnswers: async (s) => ((asked = s), true) }, { "/run/flagship-rust/keyd.choice": "rust\n" });
    expect(await installPrivd(up.o)).toBe("switched");
    expect(asked).toBe(BROKER_V1_SOCKET);
    expect([...up.written.keys()]).toEqual([PRIVD_DAEMON_DROPIN_PATH]);
    expect(up.written.get(PRIVD_DAEMON_DROPIN_PATH)).toBe(daemonPrivdDropIn(BROKER_HELPER));
    expect(up.written.get(PRIVD_DAEMON_DROPIN_PATH)).toMatch(/^Environment=FLAGSHIP_PRIVD_SOCKET=\/run\/flagship-broker\/privd\.sock$/m);
    expect(up.written.get(PRIVD_DAEMON_DROPIN_PATH)).toMatch(/^Wants=flagship-broker\.service$/m);
    expect(up.handedOver()).toBe(true);
    // The account first; the broker restarted so it admits the new uid; keyd too, last.
    expect(up.runs[0]).toMatch(/^sh -c getent group flagship/);
    expect(up.runs).toContain("systemctl restart flagship-broker.service");
    expect(up.runs.at(-1)).toBe("systemctl restart --no-block flagship-keyd.service");
    expect(up.runs.some((r) => r.includes("flagship-privd"))).toBe(false);
  });

  it("stays root while the broker does not answer, and retires a flagship-privd that was there", async () => {
    const down = base({ brokerAnswers: async () => false }, { [PRIVD_UNIT_PATH]: "old" });
    expect(await installPrivd(down.o)).toBe("failed");
    expect(down.written.size).toBe(0);
    expect(down.handedOver()).toBe(false);
    expect(down.runs).toContain("systemctl disable --now flagship-privd.service");
  });

  it("leaves keyd alone when it runs the TS keyd (it admits by group)", async () => {
    const up = base({ brokerAnswers: async () => true }, { "/run/flagship-rust/keyd.choice": "ts\n" });
    expect(await installPrivd(up.o)).toBe("switched");
    expect(up.runs.some((r) => r.includes("flagship-keyd"))).toBe(false);
  });
});

describe("the broker unit", () => {
  const u = brokerServiceUnit({ privdEntry: "/opt/flagship/packages/privd/dist/main.js" });
  it("falls back to the TS privd on the same v1 socket and group", () => {
    expect(u).toMatch(/^ExecStart=\/usr\/local\/sbin\/flagship-rust-exec broker serve -- \/usr\/local\/bin\/node \/opt\/flagship\/packages\/privd\/dist\/main\.js --socket \/run\/flagship-broker\/privd\.sock --audit \/var\/lib\/flagship-broker\/audit\.log --socket-group flagship$/m);
    expect(u).toMatch(/^Before=flagship-daemon\.service flagship-core\.service$/m);
  });
  it("is hardened like privd's unit, with no namespace that would hide its mounts or firewall from the host", () => {
    for (const k of ["NoNewPrivileges=yes", "RestrictRealtime=yes", "LockPersonality=yes", "SystemCallArchitectures=native", "LimitCORE=0", "UMask=0022"]) expect(u).toContain(`\n${k}\n`);
    for (const ns of ["PrivateNetwork", "PrivateTmp", "ProtectSystem", "ProtectHome", "ProtectKernelModules", "ProtectKernelLogs", "ProtectClock", "ReadWritePaths", "PrivateDevices", "RestrictSUIDSGID", "RestrictAddressFamilies", "MemoryDenyWriteExecute"]) {
      expect(u).not.toMatch(new RegExp(`^${ns}=`, "m"));
    }
    // privd's own unit, for comparison: the same rules.
    const p = privdUnit();
    for (const k of ["NoNewPrivileges=yes", "RestrictRealtime=yes", "LockPersonality=yes", "SystemCallArchitectures=native", "LimitCORE=0", "UMask=0022"]) expect(p).toContain(`\n${k}\n`);
  });
  it("refuses an unsafe path in its command line", () => {
    expect(() => brokerServiceUnit({ privdEntry: "/x; rm -rf /" })).toThrow();
  });
});

describe("the selector admits the daemon's account", () => {
  function selectBroker(withEngine: string | null) {
    const root = mkdtempSync(join(tmpdir(), "broker-select-"));
    dirs.push(root);
    const release = join(root, "release");
    mkdirSync(join(release, "installer/rust"), { recursive: true });
    const body = "#!/bin/bash\nexit 0\n";
    writeFileSync(join(release, "installer/rust/flagship-broker"), body);
    chmodSync(join(release, "installer/rust/flagship-broker"), 0o755);
    writeFileSync(join(release, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-broker": createHash("sha256").update(body).digest("hex") } }));
    writeFileSync(join(root, "arch-v2.json"), JSON.stringify({ version: 1, rust: "on", engine: "podman" }));
    if (withEngine) writeFileSync(join(root, "engine-active"), withEngine);
    const paths = { releasePath: release, configPath: join(root, "arch-v2.json"), engineActivePath: join(root, "engine-active"), stateDir: join(root, "state"), runDir: join(root, "run") };
    writeFileSync(join(root, "select.sh"), rustSelectScript(paths));
    spawnSync("bash", [join(root, "select.sh"), "select", "broker"], { encoding: "utf8" });
    return { env: readFileSync(join(paths.runDir, "broker.env"), "utf8"), paths };
  }
  it("hands the broker the engine record to follow, root's uid and (where it exists) the daemon's", () => {
    const { env, paths } = selectBroker("podman\n");
    expect(env).toMatch(/^FLAGSHIP_BROKER_ENGINE=podman$/m);
    expect(env).toContain(`FLAGSHIP_BROKER_ENGINE_FILE=${paths.engineActivePath}\n`);
    expect(env).toMatch(/^FLAGSHIP_BROKER_V1_UIDS=0(,\d+)?$/m);
  });
  it("lists the daemon's uid for keyd and the broker in the script itself", () => {
    const s = rustSelectScript();
    expect(s).toContain('daemon_uid=$(id -u flagship 2>/dev/null || true)');
    expect(s).toContain('echo "FLAGSHIP_KEYD_ALLOW_UIDS=0${daemon_uid:+,$daemon_uid}"');
    expect(s).toContain('echo "FLAGSHIP_BROKER_V1_UIDS=0${daemon_uid:+,$daemon_uid}"');
    expect(s).toContain('getent group flagship >/dev/null && echo "FLAGSHIP_BROKER_V1_GROUP=flagship"');
  });
});

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const runs: string[] = [];
  return {
    files,
    runs,
    deps: {
      run: async (cmd: string, args: string[]) => void runs.push(`${cmd} ${args.join(" ")}`),
      hasSystemd: () => true,
      fileExists: (p: string) => files.has(p),
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      remove: async (p: string) => void files.delete(p),
      runDir: "/run/flagship-rust",
      stateDir: "/var/lib/flagship-rust",
    },
  };
}
const PIN = "a".repeat(64);
const pins = JSON.stringify({ binaries: { "flagship-keyd": PIN, "flagship-broker": PIN, "flagship-core": PIN } });

describe("installRustStack for the switch-over", () => {
  it("makes the daemon's account before the broker first selects, and restarts the broker last", async () => {
    const w = fakeFs({ "/opt/flagship/installer/rust/PINS.json": pins, "/etc/systemd/system/flagship-keyd.service": "unit" });
    await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: { version: 1, rust: "on", engine: "podman" } });
    const account = w.runs.findIndex((r) => r.startsWith("sh -c id flagship"));
    const enable = w.runs.indexOf("systemctl enable flagship-broker.service flagship-core.service");
    expect(account).toBeGreaterThanOrEqual(0);
    expect(account).toBeLessThan(enable);
    const restarts = w.runs.filter((r) => r.startsWith("systemctl restart"));
    expect(restarts).toEqual(["systemctl restart --no-block flagship-core.service", "systemctl restart --no-block flagship-keyd.service", "systemctl restart --no-block flagship-broker.service"]);
    expect(w.files.get(BROKER_UNIT_PATH)).toBe(brokerServiceUnit({ privdEntry: "/opt/flagship/packages/privd/dist/main.js" }));
  });

  it("gives an unprivileged daemon flagship-privd back before the broker goes, when the switch is turned off", async () => {
    const w = fakeFs({ [KEYD_RUST_DROPIN_PATH]: "x", [BROKER_UNIT_PATH]: "x", [CORE_UNIT_PATH]: "x", [PRIVD_DAEMON_DROPIN_PATH]: daemonPrivdDropIn(BROKER_HELPER) });
    const r = await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: { version: 1, rust: "off", engine: "docker" } });
    expect(r.action).toBe("removed");
    expect(w.files.get(PRIVD_DAEMON_DROPIN_PATH)).toBe(daemonPrivdDropIn());
    expect(w.files.get(PRIVD_UNIT_PATH)).toBe(privdUnit("/opt/flagship/packages/privd/dist/main.js"));
    const at = (s: string) => w.runs.indexOf(s);
    expect(at("systemctl enable --now flagship-privd.service")).toBeGreaterThanOrEqual(0);
    expect(at("systemctl enable --now flagship-privd.service")).toBeLessThan(at("systemctl disable flagship-core.service flagship-broker.service"));
    expect(w.runs.at(-2)).toBe("systemctl restart --no-block flagship-daemon.service");
    expect(w.runs.at(-1)).toBe("systemctl stop --no-block flagship-core.service flagship-broker.service");
    expect(w.files.has(BROKER_UNIT_PATH)).toBe(false);
  });
});

describe("the Rust units without root", () => {
  let dir: string;
  const ran: Exec[] = [];
  let server: PrivdServer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rust-root-"));
    server = new PrivdServer({
      socketPath: join(dir, "p.sock"),
      run: async (e): Promise<RunResult> => {
        ran.push(e);
        return { code: 0, stdout: `[rust-path] log\n${JSON.stringify({ action: "restarted", restarted: ["broker"] })}\n`, stderr: "", timedOut: false };
      },
    });
    await server.start();
    process.env.FLAGSHIP_PRIVD_SOCKET = join(dir, "p.sock");
  });
  afterAll(async () => {
    delete process.env.FLAGSHIP_PRIVD_SOCKET;
    delete process.env[UNPRIVILEGED_ENV];
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("are one of the release's root steps, named the same in the broker and in setup.js", () => {
    expect(Object.keys(STEPS).sort()).toEqual([...SETUP_STEPS].sort());
    expect(SETUP_STEPS).toContain("rust-stack");
  });

  it("are kept current by the release's own rust-stack step, run by the helper", async () => {
    expect(await rustStackAsRoot({})).toEqual({ action: "restarted", restarted: ["broker"] });
    expect(ran.at(-1)?.args).toEqual(["/opt/flagship/packages/server-daemon/dist/setup.js", "rust-stack"]);
  });

  it("route the Podman bridge commands to the helper and keep the read-only one local", async () => {
    process.env[UNPRIVILEGED_ENV] = "1";
    if (process.getuid?.() === 0) return;
    ran.length = 0;
    await routePrivileged("ip", ["link", "add", "fs-apps", "type", "bridge"]);
    await routePrivileged("sysctl", ["-q", "-w", "net.ipv6.conf.fs-apps.disable_ipv6=1"]);
    await routePrivileged("du", ["-sk", "/var/lib/containers/storage/volumes/flagship-files-a/_data"]);
    expect(await routePrivileged("ip", ["-o", "addr", "show", "dev", "fs-apps"])).toBeNull();
    await expect(routePrivileged("ip", ["link", "del", "eth0"])).rejects.toMatchObject({ code: "forbidden" });
    expect(ran.map((e) => e.file)).toEqual(["/usr/sbin/ip", "/usr/sbin/sysctl", "/usr/bin/du"]);
  });
});

describe("the broker translates as the daemon does", () => {
  it("maps every docker form the daemon sends to the same Podman argv", () => {
    const forms: string[][] = [
      ["ps", "-a"], ["run", "--rm", "--network", "flagship-apps", "img"], ["version", "--format", "{{.Server.Version}}"], ["info", "--format", "{{.ServerVersion}}"], ["info", "--format", "{{.CgroupDriver}}"],
      ["info"], ["volume", "ls"], ["image", "inspect", "x"], ["network", "inspect", "x"], ["network", "rm", "x"], ["build", "-t", "x", "/var/flagship/data/app-clones/a"], ["save", "x"], ["load", "-q"],
      ["exec", "flagship-postgres", "psql"], ["compose", "-f", "/opt/flagship/installer/data-services/docker-compose.yml", "up", "-d"],
      ...EGRESS_NETWORKS.map((n) => networkCreateArgs(n.network, n)), networkCreateArgs("plain"),
    ];
    for (const f of forms) expect(podmanArgv(f), f.join(" ")).toEqual(engineArgv("docker", f, "podman")[1]);
    for (const f of [["system", "df"], ["info", "--format", "{{json .}}"], ["network", "create", "-o", "x=y", "n"]]) {
      expect(() => podmanArgv(f)).toThrow(/has no translation/);
      expect(() => engineArgv("docker", f, "podman")).toThrow(/has no translation/);
    }
  });

  it("passes what the daemon really runs under Podman too", () => {
    const vol = "flagship-files-alice--chess";
    for (const argv of [filesArchiveDockerArgs(vol, "dump"), filesArchiveDockerArgs(vol, "restore"), filesSizeDockerArgs(vol), ...EGRESS_NETWORKS.map((n) => networkCreateArgs(n.network, n))]) {
      expect(dockerExec({ argv }, "podman").file).toBe("/usr/bin/podman");
    }
    expect(dockerFileExec({ argv: filesArchiveDockerArgs(vol, "dump"), stdoutPath: "/var/flagship/data/_dumps/x.tar.partial" }, "podman").file).toBe("/usr/bin/podman");
    const build = dockerBuildArgs("flagship-app:1", "/var/flagship/data/app-clones/alice--chess", { network: "flagship-build", memory: "2g", cpus: "2", pidsLimit: 256 } as Parameters<typeof dockerBuildArgs>[2]);
    expect(dockerExec({ argv: build }, "podman").args).toEqual(build);
  });

  it("renders the bridge isolation table the daemon would", () => {
    const bridges = EGRESS_NETWORKS.map((n) => ({ kind: n.kind, bridge: n.bridge }));
    expect(iccTable(bridges.map((b) => b.bridge))).toBe(renderIccTable(bridges));
  });
});

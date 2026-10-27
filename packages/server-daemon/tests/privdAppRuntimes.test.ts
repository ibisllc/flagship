/**
 * What the daemon sends the broker for WASI apps and dedicated databases (milestone 7) once it runs
 * without root: each form passes the broker's policy as the daemon writes it, and the broker renders
 * a WASI drop-in byte for byte as the daemon does as root.
 */
import { describe, expect, it } from "vitest";
import { DEDICATED_PG_IMAGE as BROKER_PG_IMAGE, PrivdError, dockerExec, hostExec, renderWasiDropIn, systemctlExec, wasiUnitExec } from "@flagship/privd";
import { DEDICATED_PG_IMAGE, dedicatedContainer, dedicatedKey, dedicatedRunArgs, dedicatedSocketVolume, DEFAULT_DEDICATED_LIMITS } from "../src/dataLayer/dedicated.js";
import { buildSandboxPlan } from "../src/migrationSandbox.js";
import { WASI_WORKER_BIN, wasiDropIn, wasiDropInLimits, wasiInstance, wasiUnitName, type WasiDropIn } from "../src/wasi/unit.js";
import { STEPS } from "../src/setup.js";

const KEY = dedicatedKey("alice", "notes");
const pgArgs = (sandbox: string[]) =>
  dedicatedRunArgs({ key: KEY, port: 41234, adminPassword: "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", limits: DEFAULT_DEDICATED_LIMITS, sandbox, network: "flagship-apps" });

describe("a dedicated database through the broker", () => {
  it("is the broker's pinned image", () => expect(BROKER_PG_IMAGE).toBe(DEDICATED_PG_IMAGE));

  it("runs as the daemon writes it, under gVisor, on both engines", () => {
    for (const engine of ["docker", "podman"] as const) expect(() => dockerExec({ argv: pgArgs(["--runtime=runsc"]) }, engine)).not.toThrow();
    expect(() => dockerExec({ argv: pgArgs([]) })).toThrow(PrivdError);
    expect(() => dockerExec({ argv: pgArgs(["--runtime=runc"]) })).toThrow(PrivdError);
    expect(() => dockerExec({ argv: ["exec", dedicatedContainer(KEY), "pg_isready", "-q", "-h", "127.0.0.1", "-U", "flagship_admin"] })).not.toThrow();
    expect(() => dockerExec({ argv: ["volume", "rm", dedicatedSocketVolume(KEY)] })).not.toThrow();
  });

  it("may carry its own address and endpoint labels (Podman, endpoints.ts) and nothing else", () => {
    const withIdentity = dedicatedRunArgs({ key: KEY, port: 41234, adminPassword: "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", limits: DEFAULT_DEDICATED_LIMITS, sandbox: ["--runtime=runsc"], network: "flagship-apps", address: "10.89.1.2", generation: 1793112048092 });
    expect(withIdentity).not.toContain("-p");
    for (const engine of ["docker", "podman"] as const) expect(() => dockerExec({ argv: withIdentity }, engine)).not.toThrow();
    const swap = (from: string, to: string) => withIdentity.map((a) => (a === from ? to : a));
    expect(() => dockerExec({ argv: swap(`flagship.service=pgd-${KEY}`, "flagship.service=pgd-fedcba9876543210fedcba98") })).toThrow(PrivdError);
    expect(() => dockerExec({ argv: swap("10.89.1.2", "not-an-ip") })).toThrow(PrivdError);
  });

  it("its migration sandbox reaches the database's socket read-only", () => {
    const plan = buildSandboxPlan({ target: { user: "u", password: "p", database: "d", port: 5432 }, socketVolume: dedicatedSocketVolume(KEY) });
    expect(() => dockerExec({ argv: plan.args })).not.toThrow();
    expect(() => dockerExec({ argv: buildSandboxPlan({ target: { user: "u", password: "p", database: "d", port: 5432 } }).args })).not.toThrow();
  });

  it("its quota image is allocated up front through the broker", () => {
    const img = `/var/lib/flagship-files/flagship-pgdata-${KEY}.img`;
    expect(hostExec({ file: "fallocate", argv: ["-l", String(512 * 1024 * 1024), img] }, () => "").args).toEqual(["-l", "536870912", img]);
  });
});

describe("a WASI app's worker through the broker", () => {
  const sid = "alice--notes";
  const unit = wasiUnitName(sid);

  it("lets the daemon run, read and freeze its unit and nothing else", () => {
    for (const argv of [["stop", unit], ["reset-failed", unit], ["start", "--no-block", unit], ["show", unit, "--property=ActiveState,Result"], ["freeze", unit], ["thaw", unit], ["daemon-reload"]]) {
      expect(() => systemctlExec({ argv }), argv.join(" ")).not.toThrow();
    }
    for (const argv of [["enable", unit], ["restart", unit], ["freeze", "docker.service"], ["start", unit.replace(".service", ".socket")]]) expect(() => systemctlExec({ argv }), argv.join(" ")).toThrow(PrivdError);
  });

  it("renders the drop-in from typed fields exactly as the daemon would", () => {
    const cases: WasiDropIn[] = [
      { world: "http-proxy", memoryMiB: 384, tasks: 64, cpuPercent: 50, restart: "on-failure" },
      { world: "command", memoryMiB: 4224, tasks: 256, cpuPercent: 100, restart: "never", filesHostPath: "/var/lib/flagship-files/flagship-files-alice--notes/data" },
      { world: "http-proxy", memoryMiB: 99999, tasks: 1, cpuPercent: 0.5, restart: "always", filesHostPath: "/var/lib/docker/volumes/flagship-files-alice--notes/_data" },
    ];
    for (const d of cases) {
      const fields = { world: d.world, restart: d.restart, ...wasiDropInLimits(d), ...(d.filesHostPath ? { filesPath: d.filesHostPath } : {}) };
      expect(renderWasiDropIn(fields)).toBe(wasiDropIn({ ...d, bin: WASI_WORKER_BIN }));
      const e = wasiUnitExec({ action: "write", instance: wasiInstance(sid), ...fields });
      expect(e.input).toBe(wasiDropIn(d));
      expect(e.args.at(-1)).toBe(`/run/systemd/system/${unit}.d/50-app.conf`);
    }
  });

  it("the worker and its template come from the release's own root step", () => expect(Object.keys(STEPS)).toContain("wasi-runtime"));
});

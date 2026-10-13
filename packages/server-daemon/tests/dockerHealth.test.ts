import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerAnswers, wakeDocker } from "../src/dockerHealth.js";
import type { CommandRunner } from "../src/serviceRunner.js";

const SYSTEMD = [
  "docker.service: Main process exited, code=exited, status=1/FAILURE",
  "docker.service: Failed with result 'exit-code'.",
  "Failed to start docker.service - Docker Application Container Engine.",
  "docker.service: Scheduled restart job, restart counter is at 4.",
  "docker.service: Start request repeated too quickly.",
];
const CORRUPT_DB =
  'failed to start daemon: Error initializing network controller: error obtaining controller instance: failed to get bridge network configurations from store: error while populating kmap: invalid database';

function box(o: { up?: boolean; journal: string[]; startsWhen?: (starts: number) => boolean; containerd?: string }) {
  let up = o.up ?? false;
  let starts = 0;
  const calls: string[] = [];
  const cmd: Required<CommandRunner> = {
    run: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "systemctl" && a[0] === "start") {
        starts++;
        up = o.startsWhen ? o.startsWhen(starts) : false;
      }
    },
    capture: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "docker" && a[0] === "info") return { stdout: up ? "26.1.5\n" : "\n", stderr: "" };
      if (c === "systemctl" && a[0] === "show" && a[1] === "docker.service") {
        return { stdout: "ActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainStatus=1\nNRestarts=4\n", stderr: "" };
      }
      if (c === "systemctl" && a[0] === "show") return { stdout: `ActiveState=${o.containerd ?? "active"}\n`, stderr: "" };
      if (c === "journalctl") return { stdout: `${o.journal.join("\n")}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  return { cmd, calls, starts: () => starts };
}

let t = 0;
const fast = { sleep: async () => void (t += 2_000), now: () => t, waitMs: 6_000 };

describe("waking dockerd", () => {
  it("leaves a running dockerd alone", async () => {
    const b = box({ up: true, journal: [] });
    expect(await wakeDocker({ cmd: b.cmd, ...fast })).toEqual({ ok: true });
    expect(b.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  it("counts an empty version as down (docker info --format exits 0 without dockerd)", async () => {
    expect(await dockerAnswers(box({ journal: [] }).cmd)).toBe(false);
  });

  it("resets a unit systemd gave up on and starts it, containerd first", async () => {
    const b = box({ journal: [], startsWhen: () => true });
    expect(await wakeDocker({ cmd: b.cmd, ...fast })).toEqual({ ok: true });
    expect(b.calls).toContain("systemctl reset-failed docker.service docker.socket containerd.service");
    expect(b.calls).toContain("systemctl start --no-block containerd.service docker.socket docker.service");
  });

  it("repairs a corrupt network database by moving it aside, never deleting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docker-"));
    const db = join(dir, "network", "files", "local-kv.db");
    await mkdir(join(dir, "network", "files"), { recursive: true });
    await writeFile(db, "garbage");
    const b = box({ journal: ['time="x" level=info msg="Starting up"', CORRUPT_DB, ...SYSTEMD], startsWhen: (n) => n >= 2 });
    const h = await wakeDocker({ cmd: b.cmd, ...fast, networkDb: db });
    expect(h).toEqual({ ok: true, repaired: expect.stringMatching(/^Docker's network database was damaged; it was moved aside \(.*local-kv\.db\.broken-\d+\) and rebuilt$/) });
    expect(await readdir(join(dir, "network", "files"))).toEqual([expect.stringMatching(/^local-kv\.db\.broken-\d+$/)]);
  });

  it("reports dockerd's own error, not systemd's lines, when it can't be fixed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docker-"));
    const b = box({
      journal: ['time="x" level=info msg="Starting up"', 'time="x" level=error msg="failed to mount overlay: no such device" storage-driver=overlay2', "failed to start daemon: error initializing graphdriver: driver not supported: overlay2", ...SYSTEMD],
    });
    const h = await wakeDocker({ cmd: b.cmd, ...fast, networkDb: join(dir, "local-kv.db") });
    expect(h.ok).toBe(false);
    if (h.ok) return;
    expect(h.reason).toBe(
      'Docker isn\'t running on this server (docker.service is failed/failed, result exit-code, exit 1, restarted 4 times). dockerd said: time="x" level=error msg="failed to mount overlay: no such device" storage-driver=overlay2 | failed to start daemon: error initializing graphdriver: driver not supported: overlay2',
    );
    expect(h.reason).not.toMatch(/Start request repeated/);
  });

  it("names containerd when it's the one down", async () => {
    const b = box({ journal: ["containerd: failed to load plugin io.containerd.snapshotter.v1.overlayfs"], containerd: "failed" });
    const h = await wakeDocker({ cmd: b.cmd, ...fast });
    expect(h.ok === false && h.reason).toMatch(/containerd is failed/);
  });

  const LIBSYSTEMD = "/usr/sbin/dockerd: symbol lookup error: /lib/aarch64-linux-gnu/libsystemd.so.0: undefined symbol: , version GLIBC_2.17";
  const CNI =
    'time="2026-10-12T17:59:48.665403033Z" level=error msg="failed to load cni during init, please check CRI plugin status before setting up network for pods" error="cni config load failed: no network config found in /etc/cni/net.d: cni plugin not initialized: failed to load cni config"';

  it("reinstalls damaged system packages when dockerd can't load a library", async () => {
    const b = box({ journal: [LIBSYSTEMD, ...SYSTEMD], startsWhen: (n) => n >= 2 });
    const asked: string[] = [];
    const h = await wakeDocker({ cmd: b.cmd, ...fast, repairSystem: async () => (asked.push("repair"), { ok: true, packages: ["libsystemd0"] }) });
    expect(asked).toEqual(["repair"]);
    expect(h).toEqual({ ok: true, repaired: "Damaged system files were reinstalled (libsystemd0)" });
  });

  it("says why when the damage can't be repaired, without containerd's CNI noise", async () => {
    const b = box({ journal: [LIBSYSTEMD, ...SYSTEMD], containerd: "inactive" });
    const cmd = { ...b.cmd, capture: async (c: string, a: string[]) => (c === "journalctl" && a[1] === "containerd.service" ? { stdout: `${CNI}\n`, stderr: "" } : b.cmd.capture(c, a)) };
    const h = await wakeDocker({ cmd, ...fast, repairSystem: async () => ({ ok: false, packages: ["libsystemd0"], reason: "damaged system packages couldn't be downloaded to repair them (libsystemd0 257.9-1)" }) });
    expect(h.ok === false && h.reason).toBe(
      `Docker isn't running on this server (docker.service is failed/failed, result exit-code, exit 1, restarted 4 times; containerd is inactive). dockerd said: ${LIBSYSTEMD}. Damaged system packages couldn't be downloaded to repair them (libsystemd0 257.9-1)`,
    );
  });

  it("says why systemctl couldn't report the unit", async () => {
    const b = box({ journal: [] });
    const cmd = {
      ...b.cmd,
      capture: async (c: string, a: string[]) => {
        if (c === "systemctl") throw Object.assign(new Error("systemctl exited with code 1: Failed to connect to bus: No such file or directory"), { stdout: "" });
        return b.cmd.capture(c, a);
      },
    };
    const h = await wakeDocker({ cmd, ...fast });
    expect(h.ok === false && h.reason).toMatch(/^Docker isn't running on this server \(docker\.service state unknown \(systemctl exited with code 1: Failed to connect to bus: No such file or directory\); containerd is unknown\)/);
  });

  it("runs one attempt at a time for everyone asking", async () => {
    const b = box({ journal: [], startsWhen: () => true });
    const [a, c] = await Promise.all([wakeDocker({ cmd: b.cmd, ...fast }), wakeDocker({ cmd: b.cmd, ...fast })]);
    expect(a).toEqual({ ok: true });
    expect(c).toEqual({ ok: true });
    expect(b.starts()).toBe(1);
  });
});

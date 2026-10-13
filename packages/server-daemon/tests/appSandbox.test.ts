import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GVISOR_RELEASE, GVISOR_SHA512, ensureGvisor, gvisorArch, gvisorUrl } from "../src/appSandbox/gvisor.js";
import { appSandboxRunArgs, appSandboxStatus, keepAppSandbox, resetAppSandbox, startAppSandbox } from "../src/appSandbox/state.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";

const TARBALL = Buffer.from("pretend gvisor bundle");
const readFileSyncSafe = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const SHA = createHash("sha512").update(TARBALL).digest("hex");

function rig(o: { probeFails?: boolean | ((daemonJson: string) => boolean); runtimes?: string; reloadFails?: boolean; driver?: string; daemonJson?: () => string } = {}) {
  const calls: string[] = [];
  let registered = false;
  const cmd: Required<CommandRunner> = {
    run: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "systemctl" && a[0] === "reload") {
        if (o.reloadFails) throw new Error("docker.service is not active");
        registered = true;
      }
    },
    capture: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (a[0] === "--version") return { stdout: `runsc version release-${GVISOR_RELEASE}\nspec: 1.1.0\n`, stderr: "" };
      if (c === "docker" && a[0] === "info" && a[2] === "{{.CgroupDriver}}") return { stdout: `${o.driver ?? "cgroupfs"}\n`, stderr: "" };
      if (c === "docker" && a[0] === "info") return { stdout: o.runtimes ?? (registered ? '{"runc":{},"runsc":{"path":"x"}}' : '{"runc":{}}'), stderr: "" };
      const fails = typeof o.probeFails === "function" ? o.probeFails(o.daemonJson?.() ?? "") : o.probeFails;
      if (c === "docker" && a[0] === "run" && fails) {
        throw Object.assign(new Error("exit 125"), { stderr: "docker: Error response from daemon: unknown or invalid runtime name: runsc\n" });
      }
      return { stdout: "", stderr: "" };
    },
  };
  let downloads = 0;
  const fetch = async (url: string) => {
    downloads++;
    expect(url).toBe(gvisorUrl("aarch64"));
    return new Response(TARBALL);
  };
  const extract = async (_t: string, dir: string) => {
    await writeFile(join(dir, "runsc"), "#!runsc");
    await mkdir(join(dir, "gvisor-bin"));
    await writeFile(join(dir, "gvisor-bin", "gvisor_sentry"), "sentry");
  };
  return { cmd, calls, fetch, extract, downloads: () => downloads, setRegistered: (v: boolean) => (registered = v) };
}

async function dirs() {
  const base = await mkdtemp(join(tmpdir(), "gvisor-"));
  return { base: join(base, "lib"), daemonJson: join(base, "etc", "daemon.json") };
}

afterEach(() => resetAppSandbox());

describe("installing gVisor", () => {
  it("pins one release, by checksum, for both processors", () => {
    expect(GVISOR_RELEASE).toMatch(/^\d{8}\.\d+$/);
    for (const s of Object.values(GVISOR_SHA512)) expect(s).toMatch(/^[0-9a-f]{128}$/);
    expect(gvisorArch("x64")).toBe("x86_64");
    expect(gvisorArch("arm64")).toBe("aarch64");
    expect(gvisorArch("ia32")).toBeNull();
  });

  it("downloads, checks, unpacks, registers with Docker (keeping its other settings) and proves a sandbox runs", async () => {
    const r = rig();
    const d = await dirs();
    await mkdir(join(d.daemonJson, ".."), { recursive: true });
    await writeFile(d.daemonJson, JSON.stringify({ "log-driver": "journald", runtimes: { other: { path: "/x" } } }));
    const res = await ensureGvisor({ cmd: r.cmd, probeImage: "helper@sha256:1", baseDir: d.base, daemonJson: d.daemonJson, arch: "aarch64", fetch: r.fetch, extract: r.extract, pinnedSha512: SHA, sleep: async () => {} });
    expect(res).toEqual({ ok: true, version: `runsc version release-${GVISOR_RELEASE}`, runscPath: join(d.base, GVISOR_RELEASE, "runsc") });
    const cfg = JSON.parse(await readFile(d.daemonJson, "utf8"));
    expect(cfg).toEqual({ "log-driver": "journald", runtimes: { other: { path: "/x" }, runsc: { path: join(d.base, GVISOR_RELEASE, "runsc") } } });
    expect(r.calls).toContain("systemctl reload docker");
    const probe = r.calls.find((c) => c.startsWith("docker run"))!;
    expect(probe).toContain("--runtime=runsc");
    expect(probe).toContain("--network=none");
    expect(probe).toContain("--cap-drop=ALL");
    expect(probe).toContain("--memory 64m");
    expect(await readFile(join(d.base, GVISOR_RELEASE, "gvisor-bin", "gvisor_sentry"), "utf8")).toBe("sentry");
    expect(await readdir(d.base)).toEqual([GVISOR_RELEASE]);
  });

  it("refuses a download that doesn't match the pinned checksum, installing nothing", async () => {
    const r = rig();
    const d = await dirs();
    const res = await ensureGvisor({ cmd: r.cmd, probeImage: "h", baseDir: d.base, daemonJson: d.daemonJson, arch: "aarch64", fetch: r.fetch, extract: r.extract, pinnedSha512: "0".repeat(128) });
    expect(res).toEqual({ ok: false, reason: "the gVisor download doesn't match the checksum this release pins" });
    expect(await readdir(d.base)).toEqual([]);
    await expect(readFile(d.daemonJson, "utf8")).rejects.toThrow();
    expect(r.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  it("uses what's installed on the next boot: no download, no reload", async () => {
    const r = rig();
    const d = await dirs();
    const opts = { cmd: r.cmd, probeImage: "h", baseDir: d.base, daemonJson: d.daemonJson, arch: "aarch64" as const, fetch: r.fetch, extract: r.extract, pinnedSha512: SHA, sleep: async () => {} };
    expect((await ensureGvisor(opts)).ok).toBe(true);
    r.calls.length = 0;
    expect((await ensureGvisor(opts)).ok).toBe(true);
    expect(r.downloads()).toBe(1);
    expect(r.calls).not.toContain("systemctl reload docker");
    // A runsc changed on disk since it was verified is replaced.
    await writeFile(join(d.base, GVISOR_RELEASE, "runsc"), "tampered");
    expect((await ensureGvisor(opts)).ok).toBe(true);
    expect(r.downloads()).toBe(2);
    expect(await readFile(join(d.base, GVISOR_RELEASE, "runsc"), "utf8")).toBe("#!runsc");
  });

  it("never overwrites a daemon.json it can't read", async () => {
    const r = rig();
    const d = await dirs();
    await mkdir(join(d.daemonJson, ".."), { recursive: true });
    await writeFile(d.daemonJson, "{ not json");
    const res = await ensureGvisor({ cmd: r.cmd, probeImage: "h", baseDir: d.base, daemonJson: d.daemonJson, arch: "aarch64", fetch: r.fetch, extract: r.extract, pinnedSha512: SHA });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't valid JSON/) });
    expect(await readFile(d.daemonJson, "utf8")).toBe("{ not json");
  });

  it("says why when a sandboxed container won't run", async () => {
    const r = rig({ probeFails: true });
    const d = await dirs();
    const res = await ensureGvisor({ cmd: r.cmd, probeImage: "h", baseDir: d.base, daemonJson: d.daemonJson, arch: "aarch64", fetch: r.fetch, extract: r.extract, pinnedSha512: SHA, sleep: async () => {} });
    expect(res).toEqual({ ok: false, reason: "gVisor couldn't run a container on this server: docker: Error response from daemon: unknown or invalid runtime name: runsc" });
  });

  it("tells runsc about systemd cgroups only when the plain setup can't run a limited container", async () => {
    const d = await dirs();
    const r = rig({ driver: "systemd", probeFails: (json) => !json.includes("--systemd-cgroup"), daemonJson: () => readFileSyncSafe(d.daemonJson) });
    const res = await ensureGvisor({ cmd: r.cmd, probeImage: "h", baseDir: d.base, daemonJson: d.daemonJson, arch: "aarch64", fetch: r.fetch, extract: r.extract, pinnedSha512: SHA, sleep: async () => {} });
    expect(res.ok).toBe(true);
    expect(JSON.parse(await readFile(d.daemonJson, "utf8")).runtimes.runsc).toEqual({ path: join(d.base, GVISOR_RELEASE, "runsc"), runtimeArgs: ["--systemd-cgroup"] });
    expect(r.calls.filter((c) => c === "systemctl reload docker")).toHaveLength(2);
    // With the cgroupfs driver there's nothing else to try.
    const d2 = await dirs();
    const r2 = rig({ driver: "cgroupfs", probeFails: true });
    expect((await ensureGvisor({ cmd: r2.cmd, probeImage: "h", baseDir: d2.base, daemonJson: d2.daemonJson, arch: "aarch64", fetch: r2.fetch, extract: r2.extract, pinnedSha512: SHA, sleep: async () => {} })).ok).toBe(false);
    expect(r2.calls.filter((c) => c === "systemctl reload docker")).toHaveLength(1);
  });

  it("isn't offered on a processor gVisor doesn't support", async () => {
    const r = rig();
    const d = await dirs();
    expect(await ensureGvisor({ cmd: r.cmd, probeImage: "h", baseDir: d.base, arch: null })).toMatchObject({ ok: false });
  });
});

describe("apps start only in their sandbox", () => {
  const recorder = () => {
    const runs: string[][] = [];
    const cmd: CommandRunner = { run: async (c, a) => void (c === "docker" && a[0] === "run" && runs.push(a)) };
    return { runs, runner: new AppRunner(cmd) };
  };

  it("adds nothing in a process that never set it up", async () => {
    const { runs, runner } = recorder();
    await runner.deploy({ serviceId: "harry--notes", image: "x:1" });
    expect(runs[0]).not.toContain("--runtime=runsc");
    expect(appSandboxStatus()).toEqual({ state: "off" });
  });

  it("waits for the setup, then runs every app container in gVisor", async () => {
    let done!: (r: { ok: true; version: string; runscPath: string }) => void;
    startAppSandbox(() => new Promise((res) => (done = res)));
    expect(appSandboxStatus()).toEqual({ state: "starting" });
    const { runs, runner } = recorder();
    const deploying = runner.deploy({ serviceId: "harry--notes", image: "x:1" });
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(0);
    done({ ok: true, version: "runsc 1", runscPath: "/r" });
    await deploying;
    expect(runs[0]).toContain("--runtime=runsc");
    expect(appSandboxStatus()).toEqual({ state: "ready", version: "runsc 1" });
  });

  it("starts no app when gVisor isn't usable, and says why", async () => {
    await startAppSandbox(async () => ({ ok: false, reason: "no network" }));
    const { runs, runner } = recorder();
    await expect(runner.deploy({ serviceId: "harry--notes", image: "x:1" })).rejects.toThrow(
      "apps can't start on this server without their sandbox: no network",
    );
    expect(runs).toHaveLength(0);
    expect(appSandboxStatus()).toEqual({ state: "unavailable", reason: "no network" });
  });

  it("keeps retrying and restarts the apps once it works", async () => {
    let tries = 0;
    let recovered = 0;
    const k = keepAppSandbox({
      setup: async () => (++tries < 3 ? { ok: false, reason: `try ${tries}` } : { ok: true, version: "v", runscPath: "/r" }),
      retryMs: 1,
      onRecovered: () => recovered++,
    });
    for (let i = 0; i < 50 && appSandboxStatus().state !== "ready"; i++) await new Promise((r) => setTimeout(r, 5));
    k.stop();
    expect(tries).toBe(3);
    expect(recovered).toBe(1);
    expect(await appSandboxRunArgs()).toEqual(["--runtime=runsc"]);
  });
});

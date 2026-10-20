/**
 * Files folders as real sized ext4 images (appQuota/loopVolumes.ts): an app
 * writer (uid 10001, like a runtime app) gets ENOSPC at the limit while the
 * box's disk is untouched, a lower limit holds through the ballast (root too), the
 * image grows online, the hard brake makes it read-only, and deleting files
 * gives the room back. With Docker, a real container on the volume too.
 *
 * Needs Linux, root, e2fsprogs and util-linux: FLAGSHIP_TEST_LOOP=1 (CI runs
 * it with sudo; skipped elsewhere, macOS included). FLAGSHIP_TEST_LOOP_DOCKER=1
 * adds the container checks.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FOLDER_FINGERPRINT_SCRIPT, LoopVolumes, MIN_IMAGE_BYTES } from "../src/appQuota/index.js";
import { realCommandRunner, type CommandRunner } from "../src/serviceRunner.js";

const RUN = process.platform === "linux" && process.env.FLAGSHIP_TEST_LOOP === "1" && process.getuid?.() === 0;
const DOCKER = RUN && process.env.FLAGSHIP_TEST_LOOP_DOCKER === "1";
const MiB = 1024 * 1024;
const VOL = "flagship-files-quotatest--notes";

/** Docker answered from memory when the test runs without it. */
function withFakeDocker(): CommandRunner {
  const volumes = new Map<string, string>();
  const capture: NonNullable<CommandRunner["capture"]> = async (cmd, args, opts) => {
    if (cmd !== "docker") return realCommandRunner.capture!(cmd, args, opts);
    const name = args.at(-1)!;
    if (args[0] === "volume" && args[1] === "inspect") {
      if (!volumes.has(name)) throw new Error(`no such volume: ${name}`);
      return { stdout: `${volumes.get(name)}\n`, stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "create") {
      volumes.set(name, args.find((a) => a.startsWith("device="))!.slice(7));
      return { stdout: name, stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") volumes.delete(name);
    if (args[0] === "volume" && args[1] === "ls") return { stdout: [...volumes.keys()].join("\n"), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run: async (c, a, o) => void (await capture(c, a, o)), capture };
}

/** Write `mib` MiB into `dir` as uid 10001; returns what dd said (ENOSPC shows here). */
function writeAsApp(dir: string, file: string, mib: number): { ok: boolean; out: string } {
  try {
    execFileSync(
      "setpriv",
      ["--reuid=10001", "--regid=10001", "--clear-groups", "dd", "if=/dev/zero", `of=${join(dir, file)}`, "bs=1M", `count=${mib}`, "conv=fsync"],
      { stdio: "pipe" },
    );
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: Buffer }).stderr ?? e) };
  }
}

describe.skipIf(!RUN)("files folders as sized disk images (real loop mounts)", () => {
  const root = RUN ? mkdtempSync("/var/tmp/flagship-quota-") : "";
  // A container reaches /data through its bind mount; this test writes by host path as uid 10001.
  if (RUN) chmodSync(root, 0o711);
  const runner = DOCKER ? realCommandRunner : withFakeDocker();
  const lv = new LoopVolumes(runner, { root, log: () => {} });
  const data = () => lv.dataPath(VOL);

  afterAll(async () => {
    await lv.remove(VOL).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  it("an app writer gets ENOSPC at the limit, and the box's disk is untouched", async () => {
    await lv.create(VOL, 96 * MiB, { "flagship.files": "prod" });
    const u = (await lv.usage(VOL))!;
    expect(u.sizeBytes).toBeGreaterThan(80 * MiB);
    expect(u.sizeBytes).toBeLessThanOrEqual(96 * MiB);
    const r = writeAsApp(data(), "big", 200);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/No space left on device/);
    const after = (await lv.usage(VOL))!;
    expect(after.availBytes).toBeLessThan(MiB);
    // Sparse: the image takes about what was written, not more.
    const allocated = Number(execFileSync("du", ["-k", lv.imagePath(VOL)]).toString().split(/\s+/)[0]) * 1024;
    expect(allocated).toBeLessThan(120 * MiB);
  });

  it("deleting files gives the room back (and to the box, through discard)", async () => {
    rmSync(join(data(), "big"));
    execFileSync("sync");
    expect(writeAsApp(data(), "small", 20).ok).toBe(true);
    rmSync(join(data(), "small"));
  });

  it("a lower limit holds through the ballast, for root writers too, and the app never sees it", async () => {
    await lv.applyLimit(VOL, { imageBytes: MIN_IMAGE_BYTES, limitBytes: 32 * MiB, freeze: false });
    const u = (await lv.usage(VOL))!;
    expect(u.availBytes).toBeLessThanOrEqual(32 * MiB);
    const r = writeAsApp(data(), "over", 40);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/No space left on device/);
    rmSync(join(data(), "over"), { force: true });
    expect(() =>
      execFileSync("dd", ["if=/dev/zero", `of=${join(data(), "root")}`, "bs=1M", "count=40", "conv=fsync"], { stdio: "pipe" }),
    ).toThrow(/No space left on device/);
    rmSync(join(data(), "root"), { force: true });
    expect(execFileSync("ls", ["-A", data()]).toString()).not.toMatch(/ballast/);
  });

  it("grows online without unmounting, and the app gets the room", async () => {
    await lv.applyLimit(VOL, { imageBytes: 256 * MiB, limitBytes: 256 * MiB, freeze: false });
    const u = (await lv.usage(VOL))!;
    expect(u.imageBytes).toBe(256 * MiB);
    expect(u.sizeBytes).toBeGreaterThan(200 * MiB);
    expect(writeAsApp(data(), "bigger", 150).ok).toBe(true);
    rmSync(join(data(), "bigger"));
  });

  it("the brake freezes it (ENOSPC) and the hard brake makes it read-only", async () => {
    await lv.applyLimit(VOL, { imageBytes: 256 * MiB, limitBytes: 256 * MiB, freeze: true });
    expect(writeAsApp(data(), "frozen", 8).out).toMatch(/No space left on device/);
    rmSync(join(data(), "frozen"), { force: true });
    await lv.setReadOnly(VOL, true);
    expect(writeAsApp(data(), "ro", 1).out).toMatch(/Read-only file system/);
    await lv.setReadOnly(VOL, false);
    await lv.applyLimit(VOL, { imageBytes: 256 * MiB, limitBytes: 256 * MiB, freeze: false });
    expect(writeAsApp(data(), "back", 8).ok).toBe(true);
  });

  it("is mounted again after a reboot, and nothing lands on the box's disk while it isn't", async () => {
    execFileSync("umount", [lv.mountPath(VOL)]);
    // Unmounted: the mount point is immutable and empty, so the bind target doesn't exist.
    expect(() => execFileSync("mkdir", [join(lv.mountPath(VOL), "data")], { stdio: "pipe" })).toThrow();
    expect(await lv.mountAll()).toBe(1);
    expect((await lv.usage(VOL))!.usedBytes).toBeGreaterThan(7 * MiB);
  });

  it.skipIf(!DOCKER)("a container on the volume gets ENOSPC at the limit", async () => {
    await lv.applyLimit(VOL, { imageBytes: 256 * MiB, limitBytes: 64 * MiB, freeze: false });
    let out = "";
    try {
      execFileSync(
        "docker",
        ["run", "--rm", "--user", "10001:10001", "--mount", `type=volume,src=${VOL},dst=/data`, "busybox:1.36", "dd", "if=/dev/zero", "of=/data/c", "bs=1M", "count=200"],
        { stdio: "pipe" },
      );
    } catch (e) {
      out = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(out).toMatch(/No space left on device/);
  });

  it("an image no volume or app owns is set aside after a day, and deleted a week later", async () => {
    const ORPH = "flagship-files-quotatest--orphan";
    await lv.create(ORPH, 64 * MiB);
    await runner.run("docker", ["volume", "rm", ORPH]);
    const day = 24 * 60 * 60_000;
    expect((await lv.sweepOrphans({ keep: new Set(), now: Date.now() })).setAside).toEqual([]);
    const r = await lv.sweepOrphans({ keep: new Set([VOL]), now: Date.now() + 2 * day });
    expect(r.setAside).toEqual([ORPH]);
    expect(await lv.isMounted(ORPH)).toBe(false);
    expect(await lv.listImages()).toEqual([VOL]);
    expect(readdirSync(join(root, "orphaned"))).toHaveLength(1);
    expect((await lv.sweepOrphans({ keep: new Set([VOL]), now: Date.now() + 10 * day })).deleted).toEqual([ORPH]);
    expect(readdirSync(join(root, "orphaned"))).toHaveLength(0);
  });

  it("the move's fingerprint tells a faithful copy from one with a file missing, changed or resized", () => {
    const fp = (d: string) => execFileSync("sh", ["-c", FOLDER_FINGERPRINT_SCRIPT, "_", d]).toString().trim();
    const a = mkdtempSync(join(tmpdir(), "fp-a-"));
    const b = mkdtempSync(join(tmpdir(), "fp-b-"));
    try {
      execFileSync("sh", ["-c", 'mkdir -p "$1/sub" && echo hello > "$1/sub/f" && echo x > "$1/g" && ln -s g "$1/link" && chmod 640 "$1/g"', "_", a]);
      execFileSync("cp", ["-a", "--", `${a}/.`, `${b}/`]);
      expect(fp(a)).toBe(fp(b));
      rmSync(join(b, "sub", "f"));
      expect(fp(a)).not.toBe(fp(b));
      execFileSync("cp", ["-a", "--", `${a}/sub/f`, `${b}/sub/f`]);
      expect(fp(a)).toBe(fp(b));
      execFileSync("sh", ["-c", 'echo more >> "$1/g"', "_", b]);
      expect(fp(a)).not.toBe(fp(b));
      execFileSync("cp", ["-a", "--", `${a}/g`, `${b}/g`]);
      execFileSync("chmod", ["600", join(b, "g")]);
      expect(fp(a)).not.toBe(fp(b));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("removing it deletes the image", async () => {
    await lv.remove(VOL);
    expect(await lv.listImages()).toEqual([]);
  });
});

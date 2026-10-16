/**
 * Files folders as sized disk images (appQuota/loopVolumes.ts), over a fake
 * host and a fake docker: what the box runs to make, mount, grow, shrink (by
 * reserved blocks), adopt and drop them. The real thing runs in
 * appQuotaLoop.integration.test.ts on Linux as root.
 */
import { describe, expect, it } from "vitest";
import { LoopVolumes, type LoopHost } from "../src/appQuota/loopVolumes.js";
import type { CommandRunner } from "../src/serviceRunner.js";
import { RealFilesAdmin } from "../src/dataLayer/realAdmins.js";

const ROOT = "/var/lib/flagship-files";
const VOL = "flagship-files-alice--notes";
const MiB = 1024 * 1024;

function world() {
  const files = new Map<string, number>(); // path -> size
  const dirs = new Set<string>();
  const mounts: Array<{ src: string; at: string; ro: boolean }> = [];
  const volumes = new Map<string, { device: string; mountpoint: string; labels: Record<string, string> }>();
  const users = new Map<string, string>();
  const calls: string[] = [];
  let loopN = 0;
  const statfs = new Map<string, { blocks: number; bfree: number; bavail: number; bsize: number }>();
  let dockerDown = false;
  const state = { failFallocateOver: Infinity, mtimes: new Map<string, number>(), failVolumeCreate: false };

  const host: LoopHost = {
    statfs: async (p) => statfs.get(p) ?? { blocks: 1000, bfree: 1000, bavail: 1000, bsize: 4096 },
    mounts: async () => mounts.map((m) => `${m.src} ${m.at} ext4 ${m.ro ? "ro" : "rw"},relatime 0 0`).join("\n"),
    exists: (p) => files.has(p) || dirs.has(p),
    fileSize: async (p) => files.get(p) ?? 0,
    mkdir: async (p) => {
      dirs.add(p);
    },
    createSparse: async (p, b) => {
      if (files.has(p)) throw new Error("exists");
      files.set(p, b);
    },
    growSparse: async (p, b) => {
      files.set(p, b);
    },
    chmod: async () => {},
    rm: async (p) => {
      files.delete(p);
    },
    rmdir: async (p) => {
      dirs.delete(p);
    },
    readdir: async (p) => [...new Set([...files.keys(), ...dirs].filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))],
    mtimeMs: async (p) => state.mtimes.get(p) ?? 0,
    rename: async (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    writeFile: async (p) => {
      files.set(p, 1);
    },
  };

  const capture = async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const out = (stdout: string) => ({ stdout, stderr: "" });
    if (cmd === "docker") {
      if (dockerDown) throw new Error("docker exited with code 1: Cannot connect to the Docker daemon");
      const [a, b] = args;
      if (a === "volume" && b === "inspect") {
        const name = args.at(-1)!;
        const v = volumes.get(name);
        if (!v) throw new Error(`docker exited with code 1: Error response from daemon: get ${name}: no such volume`);
        const fmt = args[3]!;
        if (fmt.includes("device")) return out(`${v.device || "<no value>"}\n`);
        if (fmt.includes("Mountpoint")) return out(`${v.mountpoint}\n`);
        return out(`${JSON.stringify(v.labels)}\n`);
      }
      if (a === "volume" && b === "create") {
        if (state.failVolumeCreate) throw new Error("docker exited with code 1: create failed");
        const name = args.at(-1)!;
        const dev = args.find((x) => x.startsWith("device="))?.slice(7) ?? "";
        const labels: Record<string, string> = {};
        args.forEach((x, i) => {
          if (x === "--label") {
            const [k, v] = args[i + 1]!.split("=");
            labels[k!] = v!;
          }
        });
        volumes.set(name, { device: dev, mountpoint: `/var/lib/docker/volumes/${name}/_data`, labels });
        return out(name);
      }
      if (a === "volume" && b === "rm") {
        volumes.delete(args.at(-1)!);
        return out("");
      }
      if (a === "volume" && b === "ls") return out([...volumes.keys()].join("\n"));
      if (a === "ps") return out(users.get(args.at(-1)!.slice("volume=".length)) ?? "");
    }
    if (cmd === "mount") {
      if (args[1]?.startsWith("remount")) {
        const m = mounts.find((x) => x.at === args[2]);
        if (m) m.ro = args[1].endsWith(",ro");
        return out("");
      }
      mounts.push({ src: `/dev/loop${loopN++}`, at: args[3]!, ro: false });
      return out("");
    }
    if (cmd === "umount") {
      const at = args.at(-1)!;
      const i = mounts.findIndex((m) => m.at === at);
      if (i >= 0) mounts.splice(i, 1);
      return out("");
    }
    if (cmd === "du") return out(`${(30 * MiB) / 1024}\t${args.at(-1)}\n`);
    if (cmd === "fallocate") {
      const len = Number(args[1]);
      if (len > state.failFallocateOver) throw new Error("fallocate: fallocate failed: No space left on device");
      files.set(args[2]!, len);
      return out("");
    }
    return out("");
  };
  const runner: CommandRunner = { run: async (c, a) => void (await capture(c, a)), capture };
  return {
    host,
    runner,
    calls,
    files,
    dirs,
    mounts,
    volumes,
    users,
    statfs,
    setDockerDown: (d: boolean) => (dockerDown = d),
    state,
    set failFallocateOver(n: number) {
      state.failFallocateOver = n;
    },
  };
}

describe("LoopVolumes", () => {
  it("makes a sparse ext4 image, mounts it, and binds the volume to its data folder", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 200 * MiB, { "flagship.files": "prod", "flagship.app": "alice--notes" });
    expect(w.files.get(`${ROOT}/${VOL}.img`)).toBe(200 * MiB);
    const img = `${ROOT}/${VOL}.img`;
    expect(w.calls).toContain(`mkfs.ext4 -q -F -b 4096 -T default -m 0 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard ${img}`);
    expect(w.calls).toContain(`chattr +i ${ROOT}/${VOL}`);
    expect(w.calls).toContain(`mount -o loop,nodev,nosuid,discard,noinit_itable ${img} ${ROOT}/${VOL}`);
    expect(w.volumes.get(VOL)).toEqual({
      device: `${ROOT}/${VOL}/data`,
      mountpoint: `/var/lib/docker/volumes/${VOL}/_data`,
      labels: { "flagship.files": "prod", "flagship.app": "alice--notes", "flagship.quota": "loop" },
    });
    expect(await lv.isQuotaBacked(VOL)).toBe(true);
    await expect(lv.create(VOL, MiB)).rejects.toThrow(/already exists/);
  });

  it("never makes an image under 64 MiB, and refuses names that aren't files volumes", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 1);
    expect(w.files.get(`${ROOT}/${VOL}.img`)).toBe(64 * MiB);
    await expect(lv.create("../etc", MiB)).rejects.toThrow(/not a files volume/);
  });

  it("removes the volume, unmounts, and deletes the image", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    await lv.remove(VOL);
    expect(w.volumes.has(VOL)).toBe(false);
    expect(w.mounts).toEqual([]);
    expect(w.files.size).toBe(0);
    expect(w.calls).toContain(`chattr -i ${ROOT}/${VOL}`);
    await lv.remove(VOL);
  });

  it("grows an image online and holds a lower limit with a ballast file outside data/", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    const ballast = `${ROOT}/${VOL}/.flagship-ballast`;
    w.statfs.set(`${ROOT}/${VOL}`, { blocks: 25_600, bfree: 20_000, bavail: 20_000, bsize: 4096 });
    await lv.applyLimit(VOL, { imageBytes: 400 * MiB, limitBytes: 400 * MiB, freeze: false });
    expect(w.files.get(`${ROOT}/${VOL}.img`)).toBe(400 * MiB);
    expect(w.calls).toContain("losetup -c /dev/loop0");
    expect(w.calls).toContain("resize2fs /dev/loop0");
    // The statfs above still says 100 MiB: a 400 MiB limit is above it, no ballast.
    expect(w.files.has(ballast)).toBe(false);
    w.calls.length = 0;
    await lv.applyLimit(VOL, { imageBytes: 64 * MiB, limitBytes: 80 * MiB, freeze: false });
    expect(w.calls).toEqual([`fallocate -l ${20 * MiB} ${ballast}`]);
    expect(w.files.get(ballast)).toBe(20 * MiB);
    // The ballast isn't the app's: usage leaves it out.
    expect((await lv.usage(VOL))?.usedBytes).toBe(5_600 * 4096 - 20 * MiB);
    w.calls.length = 0;
    await lv.applyLimit(VOL, { imageBytes: 64 * MiB, limitBytes: 80 * MiB, freeze: false });
    expect(w.calls).toEqual([]);
    // The brake: the ballast takes all that's free.
    await lv.applyLimit(VOL, { imageBytes: 64 * MiB, limitBytes: 80 * MiB, freeze: true });
    expect(w.files.get(ballast)).toBe(20 * MiB + 20_000 * 4096);
    // A higher limit shrinks it; no limit drops it.
    await lv.applyLimit(VOL, { imageBytes: 64 * MiB, limitBytes: 90 * MiB, freeze: false });
    expect(w.files.get(ballast)).toBe(10 * MiB);
    await lv.applyLimit(VOL, { imageBytes: 64 * MiB, limitBytes: null, freeze: false });
    expect(w.files.has(ballast)).toBe(false);
  });

  it("takes what's free when an app is already over a lower limit", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    w.failFallocateOver = 30 * MiB;
    w.statfs.set(`${ROOT}/${VOL}`, { blocks: 25_600, bfree: 2_560, bavail: 2_560, bsize: 4096 });
    await lv.applyLimit(VOL, { imageBytes: 64 * MiB, limitBytes: 10 * MiB, freeze: false });
    expect(w.files.get(`${ROOT}/${VOL}/.flagship-ballast`)).toBe(10 * MiB - 64 * 1024);
  });

  it("reports usage from statfs and goes read-only for the hard brake", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    expect(await lv.usage(VOL)).toBeNull();
    await lv.create(VOL, 100 * MiB);
    w.statfs.set(`${ROOT}/${VOL}`, { blocks: 1000, bfree: 400, bavail: 300, bsize: 4096 });
    expect(await lv.usage(VOL)).toMatchObject({ sizeBytes: 1000 * 4096, usedBytes: 600 * 4096, availBytes: 300 * 4096, readOnly: false });
    await lv.setReadOnly(VOL, true);
    expect(w.calls).toContain(`mount -o remount,ro ${ROOT}/${VOL}`);
    expect((await lv.usage(VOL))?.readOnly).toBe(true);
  });

  it("mounts an image again after a reboot before a container uses it", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    w.mounts.length = 0;
    expect(await lv.mountAll()).toBe(1);
    expect(await lv.isMounted(VOL)).toBe(true);
    w.mounts.length = 0;
    expect(await lv.prepare(VOL, MiB)).toBe("mounted");
    expect(await lv.isMounted(VOL)).toBe(true);
  });

  it("refuses to start an app whose image is gone (fail closed)", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    w.files.delete(`${ROOT}/${VOL}.img`);
    await expect(lv.prepare(VOL, MiB)).rejects.toThrow(/missing its disk image/);
  });

  it("moves an older plain volume into an image when nothing uses it, keeping its labels", async () => {
    const w = world();
    w.volumes.set(VOL, { device: "", mountpoint: `/var/lib/docker/volumes/${VOL}/_data`, labels: { "flagship.files": "prod" } });
    w.users.set(VOL, "abc123");
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    expect(await lv.prepare(VOL, 64 * MiB)).toBe("plain");
    expect(w.files.size).toBe(0);
    w.users.delete(VOL);
    expect(await lv.prepare(VOL, 64 * MiB)).toBe("adopted");
    // 30 MiB of data: the image is at least 1.1x that plus the 64 MiB floor.
    expect(w.files.get(`${ROOT}/${VOL}.img`)).toBeGreaterThanOrEqual(Math.ceil(30 * MiB * 1.1) + 64 * MiB);
    expect(w.calls).toContain(`cp -a -- /var/lib/docker/volumes/${VOL}/_data/. ${ROOT}/${VOL}/data/`);
    expect(w.volumes.get(VOL)).toMatchObject({ device: `${ROOT}/${VOL}/data`, labels: { "flagship.files": "prod", "flagship.quota": "loop" } });
    expect(await lv.prepare(VOL, 64 * MiB)).toBe("mounted");
    expect(await lv.prepare("flagship-files-bob--x", MiB)).toBe("absent");
  });

  it("never takes Docker being down for a missing volume", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    w.setDockerDown(true);
    await expect(lv.prepare(VOL, MiB)).rejects.toThrow(/Docker daemon/);
    expect(w.files.has(`${ROOT}/${VOL}.img`)).toBe(true);
  });

  it("binds an image again whose volume a cut-short move left missing, instead of an empty folder", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    w.volumes.delete(VOL);
    w.mounts.length = 0;
    expect(await lv.prepare(VOL, MiB)).toBe("mounted");
    expect(w.volumes.get(VOL)?.device).toBe(`${ROOT}/${VOL}/data`);
    expect(await lv.isMounted(VOL)).toBe(true);
  });

  it("keeps a plain volume as it is when moving it into an image fails", async () => {
    const w = world();
    w.volumes.set(VOL, { device: "", mountpoint: `/var/lib/docker/volumes/${VOL}/_data`, labels: {} });
    const failing: CommandRunner = {
      run: w.runner.run,
      capture: async (c, a, o) => {
        if (c === "mkfs.ext4") throw new Error("mkfs.ext4: no space");
        return w.runner.capture!(c, a, o);
      },
    };
    const lv = new LoopVolumes(failing, { host: w.host, log: () => {} });
    expect(await lv.prepare(VOL, 64 * MiB)).toBe("plain");
    expect(w.volumes.get(VOL)?.device).toBe("");
    expect(w.files.size).toBe(0);
  });

  it("drops every image for a wipe", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    await lv.create("flagship-devfiles-alice--notes", 100 * MiB);
    expect(await lv.listImages()).toEqual([VOL, "flagship-devfiles-alice--notes"]);
    expect(await lv.dropAll()).toEqual([]);
    expect(w.files.size).toBe(0);
    expect(w.mounts).toEqual([]);
  });

  it("is what RealFilesAdmin uses when the box has it", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    const admin = new RealFilesAdmin(w.runner, lv);
    await admin.createVolume({ volume: VOL, sizeBytes: 128 * MiB });
    expect(w.files.get(`${ROOT}/${VOL}.img`)).toBe(128 * MiB);
    w.statfs.set(`${ROOT}/${VOL}`, { blocks: 1000, bfree: 900, bavail: 900, bsize: 4096 });
    expect(await admin.volumeBytes(VOL)).toBe(100 * 4096);
    await admin.removeVolume(VOL);
    expect(w.files.size).toBe(0);
  });
});

describe("orphaned images", () => {
  const DAY = 24 * 60 * 60_000;
  const NOW = 100 * DAY;
  const IMG = `${ROOT}/${VOL}.img`;
  const OTHER = "flagship-files-bob--old";

  async function withOrphan() {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    await lv.create(VOL, 100 * MiB);
    await lv.create(OTHER, 100 * MiB);
    w.volumes.delete(VOL);
    w.state.mtimes.set(IMG, NOW - 2 * DAY);
    w.state.mtimes.set(`${ROOT}/${OTHER}.img`, NOW - 2 * DAY);
    return { w, lv };
  }

  it("mark an image while it's made, and clear the mark once its volume is bound", async () => {
    const w = world();
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    const marks: boolean[] = [];
    const run = w.runner.capture!;
    w.runner.capture = async (c, a, o) => {
      if (c === "docker" && a[1] === "create") marks.push(w.files.has(`${ROOT}/${VOL}.pending`));
      return run(c, a, o);
    };
    await lv.create(VOL, 100 * MiB);
    expect(marks).toEqual([true]);
    expect(w.files.has(`${ROOT}/${VOL}.pending`)).toBe(false);
  });

  it("a move cut short keeps its mark until prepare binds the image again", async () => {
    const w = world();
    w.volumes.set(VOL, { device: "", mountpoint: `/var/lib/docker/volumes/${VOL}/_data`, labels: {} });
    w.state.failVolumeCreate = true;
    const lv = new LoopVolumes(w.runner, { host: w.host, log: () => {} });
    // Starting now would let Docker make an empty volume of that name: the start fails instead.
    await expect(lv.prepare(VOL, 64 * MiB)).rejects.toThrow(/couldn.t finish moving/);
    // The old volume is gone, the copy is in the image, and the mark says a move is under way.
    expect(w.volumes.has(VOL)).toBe(false);
    expect(w.files.has(IMG)).toBe(true);
    expect(w.files.has(`${ROOT}/${VOL}.pending`)).toBe(true);
    w.state.mtimes.set(IMG, NOW - 2 * DAY);
    expect((await lv.sweepOrphans({ keep: new Set(), now: NOW })).setAside).toEqual([]);
    w.state.failVolumeCreate = false;
    expect(await lv.prepare(VOL, 64 * MiB)).toBe("mounted");
    expect(w.volumes.get(VOL)?.device).toBe(`${ROOT}/${VOL}/data`);
    expect(w.files.has(`${ROOT}/${VOL}.pending`)).toBe(false);
  });

  it("set aside an image with no volume, no app, no mark and a day old, without deleting it", async () => {
    const { w, lv } = await withOrphan();
    const r = await lv.sweepOrphans({ keep: new Set(), now: NOW });
    expect(r).toEqual({ setAside: [VOL], deleted: [] });
    expect(w.files.has(IMG)).toBe(false);
    expect(w.files.get(`${ROOT}/orphaned/${VOL}.${NOW}.img`)).toBe(100 * MiB);
    expect(await lv.isMounted(VOL)).toBe(false);
    expect(w.calls).toContain(`umount ${ROOT}/${VOL}`);
    // The one with a volume stays.
    expect(w.files.has(`${ROOT}/${OTHER}.img`)).toBe(true);
    expect(await lv.listImages()).toEqual([OTHER]);
  });

  it("leave an image an installed app names, a young one, and everything when Docker doesn't answer", async () => {
    const { w, lv } = await withOrphan();
    expect((await lv.sweepOrphans({ keep: new Set([VOL]), now: NOW })).setAside).toEqual([]);
    w.state.mtimes.set(IMG, NOW - DAY / 2);
    expect((await lv.sweepOrphans({ keep: new Set(), now: NOW })).setAside).toEqual([]);
    w.state.mtimes.set(IMG, NOW - 2 * DAY);
    w.setDockerDown(true);
    await expect(lv.sweepOrphans({ keep: new Set(), now: NOW })).rejects.toThrow(/Docker daemon/);
    expect(w.files.has(IMG)).toBe(true);
  });

  it("delete what was set aside only after a week", async () => {
    const { w, lv } = await withOrphan();
    await lv.sweepOrphans({ keep: new Set(), now: NOW });
    expect((await lv.sweepOrphans({ keep: new Set(), now: NOW + 6 * DAY })).deleted).toEqual([]);
    expect((await lv.sweepOrphans({ keep: new Set(), now: NOW + 7 * DAY })).deleted).toEqual([VOL]);
    expect([...w.files.keys()].some((f) => f.includes("/orphaned/"))).toBe(false);
  });

  it("self-delete drops set-aside images and marks too", async () => {
    const { w, lv } = await withOrphan();
    await lv.sweepOrphans({ keep: new Set(), now: NOW });
    w.files.set(`${ROOT}/${OTHER}.pending`, 1);
    expect(await lv.dropAll()).toEqual([]);
    expect(w.files.size).toBe(0);
  });
});

/**
 * Where per-app disk limits meet the rest of the box: a container never
 * mounts a files folder before its image is ready; a build is stopped when it
 * writes too much; a new folder is made at its limit; server-detail and
 * app-detail carry the numbers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildDiskWatcher } from "../src/appQuota/buildGuard.js";
import {
  AppRunner,
  realCommandRunner,
  runDockerBuild,
  setBuildDiskWatch,
  setFilesVolumeGuard,
  type CommandRunner,
} from "../src/serviceRunner.js";
import { DataProvisioner, InMemoryFilesAdmin } from "../src/dataLayer/index.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import type { HttpRequest } from "../src/runtime.js";

const VOL = "flagship-files-alice--notes";

afterEach(() => {
  setFilesVolumeGuard(null);
  setBuildDiskWatch(null);
});

describe("the files-volume guard", () => {
  it("runs before docker run, and a refusal keeps the container from starting", async () => {
    const order: string[] = [];
    const cmd: CommandRunner = { run: async (c, a) => void order.push(`${c} ${a[0]}`) };
    setFilesVolumeGuard(async (v) => void order.push(`guard ${v}`));
    const runner = new AppRunner(cmd);
    await runner.deploy({ serviceId: "alice-notes", image: "img:1", filesVolume: VOL });
    expect(order).toEqual([`guard ${VOL}`, "docker run"]);

    order.length = 0;
    setFilesVolumeGuard(async () => {
      throw new Error("this app's files folder is missing its disk image");
    });
    await expect(runner.deploy({ serviceId: "alice-notes", image: "img:1", filesVolume: VOL })).rejects.toThrow(/disk image/);
    expect(order).toEqual([]);
  });

  it("isn't asked for an app without a files folder", async () => {
    let asked = false;
    setFilesVolumeGuard(async () => void (asked = true));
    await new AppRunner({ run: async () => {} }).deploy({ serviceId: "alice-notes", image: "img:1" });
    expect(asked).toBe(false);
  });
});

describe("a build's disk limit", () => {
  it("stops the build with the owner's sentence once it has written too much", async () => {
    const MiB = 1024 * 1024;
    let used = 10 * MiB;
    const watch = buildDiskWatcher({
      disk: async () => ({ totalBytes: 1000 * MiB, availBytes: 1000 * MiB - used }),
      quotaBytes: 100 * MiB,
      intervalMs: 5,
    });
    setBuildDiskWatch(watch);
    const cmd: CommandRunner = {
      run: async () => {},
      capture: (_c, _a, opts) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => (used = 200 * MiB), 20);
          opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("docker was killed by SIGKILL"), { stdout: "", stderr: "" })));
        }),
    };
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "quota-build-"));
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    await expect(runDockerBuild(cmd, "img:1", dir)).rejects.toThrow("the build wrote more than 100 MB to the server's disk, so it was stopped");
  });

  it("stops a build when the disk reaches the brake", async () => {
    const reasons: string[] = [];
    let avail = 500;
    const stop = buildDiskWatcher({ disk: async () => ({ totalBytes: 1000, availBytes: avail }), intervalMs: 5 })((r) => reasons.push(r));
    await new Promise((r) => setTimeout(r, 15));
    avail = 80;
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(reasons).toEqual(["the server's disk is nearly full, so the build was stopped"]);
  });

  it("an aborted signal kills a real child", async () => {
    const ac = new AbortController();
    const p = realCommandRunner.capture!("sleep", ["5"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/killed by SIGKILL/);
  });
});

describe("a new files folder", () => {
  it("is made at the size the quota manager says (a staging copy gets its own)", async () => {
    const files = new InMemoryFilesAdmin();
    const p = new DataProvisioner({ files });
    p.setFilesSize(async (v) => (v.startsWith("flagship-devfiles-") ? 1 : 2));
    await p.provisionApp({ creator: "alice", slug: "notes", stores: { files: true } });
    await p.provisionApp({ creator: "alice", slug: "notes", stores: { files: true }, space: "dev" });
    expect(files.volumes.get(VOL)?.sizeBytes).toBe(2);
    expect(files.volumes.get("flagship-devfiles-alice--notes")?.sizeBytes).toBe(1);
  });
});

describe("server-detail and app-detail", () => {
  const storage = {
    app: (id: string) =>
      id === "alice-habits"
        ? {
            files: { usedBytes: 100, limitBytes: 200, full: false, enforced: true },
            postgres: { usedBytes: 300, limitBytes: 300, full: true, writesBlocked: true, stopped: false },
          }
        : null,
    server: () => ({
      disk: { totalBytes: 1000, usedBytes: 400 },
      brake: "off" as const,
      capped: true,
      apps: [{ serviceId: "alice-habits", files: { usedBytes: 100, limitBytes: 200, full: false, enforced: true } }],
    }),
  };
  const gate = { has: (t: string) => t === "tok", check: (r: HttpRequest) => (r.headers["x-flagship-session"] === "tok" ? null : { status: 401, headers: {}, body: "" }) };
  const get = (path: string): HttpRequest => ({ method: "GET", path, headers: { "x-flagship-session": "tok" }, body: Buffer.alloc(0) });
  const app = (serviceId: string) => ({
    creator: "alice",
    slug: serviceId.slice(6),
    serviceId,
    manifest: { name: "x", version: "0.1.0", runtime: { port: 8080 } },
    urlLabel: serviceId.slice(6),
    membership: { members: { list: () => [] } },
    containerPort: 8080,
    data: null,
    installedAt: 1,
  });
  const apps = [app("alice-habits"), app("alice-other")];
  const handle = buildScreensHttp({
    serverFqdn: "home.alice.flagship.services",
    username: "alice",
    daemonVersion: "t",
    startedAt: 1,
    now: () => 2,
    gate: gate as never,
    storage,
    servicePlatform: {
      list: () => apps,
      byServiceId: (id: string) => apps.find((a) => a.serviceId === id),
      byLabel: () => undefined,
    } as never,
  });

  it("server-detail carries the disk, the brake and each app's use and limit", async () => {
    const r = await handle(get("/api/screens/server-detail"));
    expect(JSON.parse(r!.body as string).storage).toEqual(storage.server());
  });

  it("app-detail carries the app's own, and leaves it out before it's measured", async () => {
    const r = await handle(get("/api/screens/app-detail/alice-habits"));
    expect(JSON.parse(r!.body as string).storage).toEqual(storage.app("alice-habits"));
    const other = await handle(get("/api/screens/app-detail/alice-other"));
    expect(other!.status).toBe(200);
    expect(JSON.parse(other!.body as string).storage).toBeUndefined();
  });
});

/**
 * P05 dedicated database profile (dataLayer/dedicated.ts): what each
 * instance is held to, how it is made, routed, dropped and dumped, and that
 * the provisioner, the backup ops and the migration sandbox use it. The
 * hostile-database tests run on a real box: dedicatedDb.vm.test.ts.
 */
import { endpoints } from "../src/endpoints.js";
import { setActiveEngine } from "../src/engine/engine.js";
import { resetAddressPools } from "../src/serviceRunner.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  DedicatedPostgres,
  dedicatedContainer,
  dedicatedKey,
  dedicatedRunArgs,
  dedicatedServiceId,
  dedicatedVolume,
  diskRoomLeft,
  memoryDedicatedStateStore,
  DEFAULT_DEDICATED_LIMITS,
  type DedicatedStateStore,
} from "../src/dataLayer/dedicated.js";
import { OwnedPortBook, memoryPortBookStore } from "../src/appGroups/portBook.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../src/dataLayer/index.js";
import { assertNoHostPathInDockerArgs, type CommandRunner } from "../src/serviceRunner.js";
import { buildSandboxPlan } from "../src/migrationSandbox.js";

function world(opts: { free?: number; total?: number; linkOk?: boolean; gateway?: boolean; absent?: boolean; state?: DedicatedStateStore } = {}) {
  const calls: string[] = [];
  const running = new Set<string>();
  const started = new Map<string, string[]>();
  const cmd: CommandRunner = {
    run: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "docker" && a[0] === "run") {
        assertNoHostPathInDockerArgs(a);
        running.add(a[a.indexOf("--name") + 1]!);
        started.set(a[a.indexOf("--name") + 1]!, a);
      }
      if (c === "docker" && a[0] === "rm") running.delete(a[a.length - 1]!);
    },
    capture: async (c, a) => {
      calls.push(`${c} ${a.join(" ")}`);
      if (c === "docker" && a[0] === "network") {
        return { stdout: JSON.stringify([{ name: "flagship-apps", id: "n1", network_interface: "fs-apps", subnets: [{ subnet: "10.89.1.0/24", gateway: "10.89.1.1" }], options: { mode: "unmanaged" }, containers: {} }]), stderr: "" };
      }
      if (c === "docker" && a[0] === "inspect") {
        const n = a[a.length - 1]!;
        if (!running.has(n)) throw new Error("No such object");
        const run = started.get(n);
        const labels = Object.fromEntries((run ?? []).flatMap((x, i) => (x === "--label" ? [run![i + 1]!.split("=") as [string, string]] : [])));
        if (a.includes("--format"))
          return {
            stdout: JSON.stringify({ Id: `id-${n}`, State: { Running: true, StartedAt: "t0" }, Config: { Labels: labels }, NetworkSettings: { Networks: { "flagship-apps": { IPAddress: run?.includes("--ip") ? run[run.indexOf("--ip") + 1] : "10.89.1.9" } } } }),
            stderr: "",
          };
        if (a.some((x) => x.includes("flagship.generation"))) return { stdout: labels["flagship.generation"] ?? "", stderr: "" };
        return { stdout: a.includes("{{.State.Running}}") ? "true" : "id", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
  const volumes = new Map<string, number>();
  const prealloc: string[] = [];
  const linked = new Map<number, string>();
  const admins: string[] = [];
  const adminObjs: InMemoryPostgresAdmin[] = [];
  const book = new OwnedPortBook(memoryPortBookStore());
  const d = new DedicatedPostgres({
    cmd,
    volumes: {
      create: async (v, size) => void volumes.set(v, size),
      remove: async (v) => void volumes.delete(v),
      prepare: async (v) => (opts.absent && !volumes.has(v) ? "absent" : "mounted"),
      imagePath: (v) => `/var/lib/flagship-files/${v}.img`,
    },
    preallocate: async (p, b) => void prealloc.push(`${p}:${b}`),
    disk: async () => ({ freeBytes: opts.free ?? 50 * 2 ** 30, totalBytes: opts.total ?? 80 * 2 ** 30 }),
    ports: book,
    links: () =>
      opts.gateway === false
        ? null
        : {
            link: async (p, _t, o) => {
              if (opts.linkOk === false) return false;
              linked.set(p, o);
              return true;
            },
            unlink: async (p) => void linked.delete(p),
          },
    state: opts.state ?? memoryDedicatedStateStore(),
    admin: (url) => {
      admins.push(url);
      const a = new InMemoryPostgresAdmin();
      adminObjs.push(a);
      return a;
    },
    waitReady: async () => {},
  });
  return { d, calls, running, volumes, prealloc, linked, admins, adminObjs, book };
}

describe("a dedicated instance reached through the endpoint table", () => {
  afterEach(() => {
    setActiveEngine("docker");
    resetAddressPools();
    endpoints.invalidate(dedicatedServiceId(dedicatedKey("alice", "shop")));
  });

  it("Podman: its own address, no published port, the admin and the app link both go to that address on 5432", async () => {
    setActiveEngine("podman");
    const w = world();
    await w.d.forApp("alice", "shop", { diskBytes: 100 * 2 ** 20 });
    const run = w.calls.find((c) => c.startsWith("docker run"))!;
    expect(run).not.toContain(" -p ");
    expect(run).toMatch(/--ip 10\.89\.1\.2 /);
    expect(w.admins[0]).toMatch(/@10\.89\.1\.2:5432\/postgres$/);
    expect(w.linked.get(15400)).toBe("alice--shop");
  });

  it("Docker: an instance an earlier release created (no labels) is still taken as its service's own", async () => {
    setActiveEngine("docker");
    const key = dedicatedKey("alice", "shop");
    const state = { [key]: { key, creator: "alice", slug: "shop", port: 15400, adminPassword: "pw", limits: DEFAULT_DEDICATED_LIMITS, createdAt: 1 } };
    const w2 = world({ state: { load: async () => structuredClone(state) as never, save: async () => {} } });
    w2.running.add(dedicatedContainer(key)); // running, never labelled
    const r = await w2.d.startAll();
    expect(r.failed).toEqual([]);
    expect(endpoints.lookup({ serviceId: dedicatedServiceId(key), env: "live", component: "db", role: "data" })).toMatchObject({ host: "127.0.0.1", port: 15400 });
  });

  it("Docker: a container labelled for another service is refused", async () => {
    setActiveEngine("docker");
    const key = dedicatedKey("alice", "shop");
    const state = { [key]: { key, creator: "alice", slug: "shop", port: 15400, adminPassword: "pw", limits: DEFAULT_DEDICATED_LIMITS, createdAt: 1 } };
    const w = world({ state: { load: async () => structuredClone(state) as never, save: async () => {} } });
    // another service's labelled container sits under this name
    w.running.add(dedicatedContainer(key));
    const orig = w.d as unknown as { deps: { cmd: CommandRunner } };
    const cap = orig.deps.cmd.capture!;
    orig.deps.cmd.capture = async (c, a) =>
      a.includes("--format") ? { stdout: JSON.stringify({ Id: "x", State: { Running: true, StartedAt: "t" }, Config: { Labels: { "flagship.service": "pgd-other", "flagship.generation": "1" } }, NetworkSettings: { Networks: { "flagship-apps": { IPAddress: "10.0.0.5" } } } }), stderr: "" } : cap(c, a);
    const r = await w.d.startAll();
    expect(r.failed).toEqual([key]);
  });
});

describe("a dedicated instance", () => {
  it("is held to its own memory, CPU, processes, connections, temp files and disk", () => {
    const args = dedicatedRunArgs({ key: "a".repeat(24), port: 15400, adminPassword: "pw", limits: DEFAULT_DEDICATED_LIMITS, sandbox: [], network: "flagship-apps" });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("--memory")).toBe("256m");
    expect(at("--memory-swap")).toBe("256m");
    expect(at("--cpus")).toBe("0.50");
    expect(at("--pids-limit")).toBe("128");
    expect(at("-p")).toBe("127.0.0.1:15400:5432");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args.filter((a) => a === "--cap-add").length).toBe(5);
    expect(args).toContain("max_connections=20");
    expect(args).toContain("temp_file_limit=128MB");
    expect(args).toContain("statement_timeout=30s");
    expect(args).toContain("POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256");
    expect(args).toContain(`type=volume,src=${dedicatedVolume("a".repeat(24))},dst=/var/lib/postgresql`);
    // The box's own mount guard accepts exactly these mounts and no host path.
    expect(() => assertNoHostPathInDockerArgs(args)).not.toThrow();
    expect(() => assertNoHostPathInDockerArgs([...args.slice(0, -1), "--mount", "type=bind,src=/var/flagship,dst=/x", "img"])).toThrow();
    expect(() => assertNoHostPathInDockerArgs(["run", "--mount", "type=volume,src=flagship-pgdata-aaaaaaaaaaaaaaaaaaaaaaaa,dst=/data", "img"])).toThrow();
    expect(() => dedicatedRunArgs({ key: "../x", port: 15400, adminPassword: "p", limits: DEFAULT_DEDICATED_LIMITS, sandbox: [], network: "n" })).toThrow();
  });

  it("is made once per app: a preallocated image, a port, a container, a route for that app only", async () => {
    const w = world();
    const a = await w.d.forApp("alice", "shop", { diskBytes: 100 * 2 ** 20 });
    const key = dedicatedKey("alice", "shop");
    expect(a).toMatchObject({ port: 15400, container: dedicatedContainer(key) });
    expect(w.volumes.get(dedicatedVolume(key))).toBe(100 * 2 ** 20);
    expect(w.prealloc).toEqual([`/var/lib/flagship-files/${dedicatedVolume(key)}.img:${100 * 2 ** 20}`]);
    expect(w.linked.get(15400)).toBe("alice--shop");
    expect(w.admins[0]).toMatch(/^postgresql:\/\/flagship_admin:.+@127\.0\.0\.1:15400\/postgres$/);
    const again = await w.d.forApp("alice", "shop");
    expect(again.port).toBe(15400);
    expect(w.calls.filter((c) => c.startsWith("docker run")).length).toBe(1);
    const b = await w.d.forApp("bob", "blog");
    expect(b.port).toBe(15401);
    expect(w.linked.get(15401)).toBe("bob--blog");
    expect(await w.d.socketForPort(15401)).toBe(`flagship-pgsock-${dedicatedKey("bob", "blog")}`);
    expect(await w.d.socketForPort(5432)).toBeNull();
    // Dropping one app's instance leaves the other's.
    await w.d.dropApp("alice", "shop");
    expect(w.volumes.has(dedicatedVolume(key))).toBe(false);
    expect(w.linked.has(15400)).toBe(false);
    expect(await w.book.entries()).toEqual({ [`db:${dedicatedKey("bob", "blog")}`]: 15401 });
    expect(w.running.has(dedicatedContainer(dedicatedKey("bob", "blog")))).toBe(true);
  });

  it("refuses when the disk would be left with less than its reserve, or nothing can route to it", async () => {
    expect(diskRoomLeft(80 * 2 ** 30)).toBe(8 * 2 ** 30);
    const tight = world({ free: 8.2 * 2 ** 30 });
    await expect(tight.d.forApp("alice", "shop", { diskBytes: 512 * 2 ** 20 })).rejects.toThrow(/doesn't have room/);
    expect(tight.volumes.size).toBe(0);
    await expect(world({ gateway: false }).d.forApp("alice", "shop")).rejects.toThrow(/egress gateway/);
    await expect(world({ linkOk: false }).d.forApp("alice", "shop")).rejects.toThrow(/route/);
  });
});

describe("the provisioner with the dedicated profile", () => {
  function provisioner(w: ReturnType<typeof world>, profile: "shared" | "dedicated") {
    const shared = new InMemoryPostgresAdmin();
    return {
      shared,
      p: new DataProvisioner({
        postgres: shared,
        files: new InMemoryFilesAdmin(),
        nameKey: "k".repeat(40),
        endpoints: { postgresHost: "host.flagship.internal", postgresPort: 5432 },
        dedicated: {
          profileFor: () => profile,
          forApp: (c, s, o) => w.d.forApp(c, s, o),
          dropApp: (c, s) => w.d.dropApp(c, s),
        },
      }),
    };
  }

  it("puts an app's databases in its own instance, at its own port, with the same opaque names", async () => {
    const w = world();
    const { p, shared } = provisioner(w, "dedicated");
    const creds = await p.provisionApp({ creator: "alice", slug: "shop", stores: { postgres: ["main", "jobs"] } });
    for (const s of Object.values(creds.postgres!)) {
      expect(s.profile).toBe("dedicated");
      expect(s.container).toBe(dedicatedContainer(dedicatedKey("alice", "shop")));
      expect(s.url).toMatch(/@host\.flagship\.internal:15400\/app_[0-9a-f]{24}$/);
    }
    expect((shared as unknown as { dbs: Map<string, unknown> }).dbs?.size ?? 0).toBe(0);
    // A staging copy (dev space) never gets an instance.
    const dev = await p.provisionApp({ creator: "alice", slug: "shop", stores: { postgres: true }, space: "dev" });
    expect(dev.postgres!.default!.profile).toBeUndefined();
    // Uninstall drops the whole instance.
    await p.dropCredentials(creds);
    expect(w.running.size).toBe(0);
  });

  it("a store added later that fails leaves the app's instance and its other databases alone", async () => {
    const w = world();
    const { p } = provisioner(w, "dedicated");
    await p.provisionApp({ creator: "alice", slug: "shop", stores: { postgres: ["main"] } });
    // The next admin the instance hands out fails to create anything.
    const orig = w.d.forApp.bind(w.d);
    (w.d as unknown as { forApp: typeof orig }).forApp = async (c, s, o) => {
      const r = await orig(c, s, o);
      r.admin.createRoleAndDb = async () => {
        throw new Error("disk full");
      };
      return r;
    };
    await expect(p.provisionApp({ creator: "alice", slug: "shop", stores: { postgres: ["extra"] } })).rejects.toThrow(/disk full/);
    expect(w.running.has(dedicatedContainer(dedicatedKey("alice", "shop")))).toBe(true);
  });

  it("the shared profile is unchanged", async () => {
    const w = world();
    const { p } = provisioner(w, "shared");
    const creds = await p.provisionApp({ creator: "alice", slug: "shop", stores: { postgres: true } });
    expect(creds.postgres!.default).not.toHaveProperty("profile");
    expect(creds.postgres!.default!.url).toMatch(/:5432\//);
    expect(w.calls).toEqual([]);
  });
});

describe("migrations and backups of a dedicated database", () => {
  it("a migration reaches only that instance's socket, with no network", () => {
    const plan = buildSandboxPlan({
      target: { user: "app_x", password: "p", database: "app_x", port: 15400 },
      socketVolume: `flagship-pgsock-${"b".repeat(24)}`,
      containerName: "flagship-migrate-x",
    });
    expect(plan.args).toContain("--network=none");
    expect(plan.args).toContain(`type=volume,src=flagship-pgsock-${"b".repeat(24)},dst=/var/run/postgresql,readonly`);
    expect(plan.args.join(" ")).toContain("-h /var/run/postgresql -p 5432");
    expect(plan.args.join(" ")).not.toContain("host-gateway");
    expect(() => buildSandboxPlan({ target: { user: "a", password: "p", database: "a", port: 1 }, socketVolume: "flagship-files-x" })).toThrow();
    const shared = buildSandboxPlan({ target: { user: "a", password: "p", database: "a", port: 5432 } });
    expect(shared.args).toContain("--network=flagship-staging");
  });

  it("dumps and restores run in the app's own instance", async () => {
    const { pgContainerFor } = await import("../src/appCopy/ops.js");
    const base = { url: "postgresql://r:p@h:5432/d", database: "d", role: "r" };
    expect(pgContainerFor(base)).toBe("flagship-postgres");
    expect(pgContainerFor({ ...base, profile: "dedicated", container: `flagship-pgd-${"c".repeat(24)}` })).toBe(`flagship-pgd-${"c".repeat(24)}`);
    // A registry entry can't send a dump into some other container.
    expect(() => pgContainerFor({ ...base, container: "flagship-alice--shop" })).toThrow();
  });
});

describe("whole-box dumps of the apps' own instances (volumeDump.ts)", () => {
  it("hands out each instance's own admin login, and never one whose state names another app's key", async () => {
    const state = memoryDedicatedStateStore();
    const w = world({ state });
    await w.d.forApp("alice", "shop");
    await w.d.forApp("bob", "blog");
    const ka = dedicatedKey("alice", "shop");
    const logins = await w.d.backupLogins();
    expect(logins.map((l) => [l.key, l.container, l.user])).toEqual(
      [ka, dedicatedKey("bob", "blog")].sort().map((k) => [k, dedicatedContainer(k), "flagship_admin"]),
    );
    expect(w.admins.some((u) => u.includes(encodeURIComponent(logins.find((l) => l.key === ka)!.password)))).toBe(true);
    // A state entry filed under another app's key (a damaged or tampered file) is never used.
    const s = await state.load();
    s[ka] = { ...s[ka]!, slug: "blog", creator: "bob" };
    await state.save(s);
    expect((await w.d.backupLogins()).map((l) => l.key)).toEqual([dedicatedKey("bob", "blog")]);
    expect(await w.d.restoreLogin(ka)).toBeNull();
    expect(await w.d.restoreLogin("../x")).toBeNull();
  });

  it("brings a restored instance up on a fresh quota image before its dump is loaded", async () => {
    const state = memoryDedicatedStateStore();
    const old = world({ state });
    await old.d.forApp("alice", "shop", { diskBytes: 100 * 2 ** 20 });
    const key = dedicatedKey("alice", "shop");
    // The fresh box got the state back but not the instance or its image.
    const fresh = world({ state, absent: true });
    const l = await fresh.d.restoreLogin(key);
    expect(l).toMatchObject({ key, container: dedicatedContainer(key), user: "flagship_admin" });
    expect(fresh.volumes.get(dedicatedVolume(key))).toBe(100 * 2 ** 20);
    expect(fresh.prealloc).toEqual([`/var/lib/flagship-files/${dedicatedVolume(key)}.img:${100 * 2 ** 20}`]);
    expect(fresh.running.has(dedicatedContainer(key))).toBe(true);
    expect(fresh.linked.get(15400)).toBe("alice--shop");
    expect(await fresh.d.restoreLogin(dedicatedKey("bob", "blog"))).toBeNull();
  });

  it("refuses to restore an instance the disk has no room for", async () => {
    const state = memoryDedicatedStateStore();
    await world({ state }).d.forApp("alice", "shop", { diskBytes: 512 * 2 ** 20 });
    const tight = world({ state, absent: true, free: 8.2 * 2 ** 30 });
    await expect(tight.d.restoreLogin(dedicatedKey("alice", "shop"))).rejects.toThrow(/doesn't have room/);
    expect(tight.volumes.size).toBe(0);
    expect(tight.running.size).toBe(0);
  });
});

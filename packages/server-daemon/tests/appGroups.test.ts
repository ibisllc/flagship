/**
 * P05 app groups (docs/app-groups.md): start order, links, a failed start
 * leaving nothing running, transactional upgrade with rollback of every
 * member, and a consistent backup (every member held still).
 */
import { describe, expect, it } from "vitest";
import { ed, signInstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import { RuntimeRouter } from "../src/appRuntimes.js";
import { componentStartOrder } from "../src/appGroups/plan.js";
import { componentContainerName, componentEnvName, owningServiceId } from "../src/appGroups/names.js";
import { memberSpecs, type GroupLinks } from "../src/appGroups/runner.js";
import { OwnedPortBook, memoryPortBookStore } from "../src/appGroups/portBook.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { assertNoHostPathInDockerArgs, type CommandRunner } from "../src/serviceRunner.js";
import { parseAppManifest } from "../src/appModel.js";
import { BOX_CAPABILITIES_0_3 } from "@flagship/protocol";

const HOST = "alice";
const FQDN = `home.${HOST}.flagship.services`;

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function groupManifest(over: { workerImage?: string; version?: string } = {}) {
  return JSON.stringify({
    schema_version: 2,
    name: "shop",
    version: over.version ?? "1.0.0",
    runtime: { image: "ghcr.io/alice/shop-web:1", port: 8080 },
    data: {},
    network: { subdomain: "shop" },
    access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" },
    components: [
      { name: "cache", image: "ghcr.io/alice/shop-cache:1", port: 6379 },
      { name: "worker", image: over.workerImage ?? "ghcr.io/alice/shop-worker:1", startAfter: ["cache", "queue"], resources: { memoryMiB: 128 } },
      { name: "queue", base: "node-24", start: ["node", "queue.js"], port: 7000, startAfter: ["cache"] },
    ],
  });
}

interface World {
  calls: string[];
  running: Set<string>;
  failImage: string | null;
  cmd: CommandRunner;
}

/** A docker that records every call and keeps which containers run. */
function fakeDocker(): World {
  const w: World = { calls: [], running: new Set(), failImage: null, cmd: null as unknown as CommandRunner };
  w.cmd = {
    run: async (c, args) => {
      w.calls.push(`${c} ${args.join(" ")}`);
      if (c !== "docker") return;
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1]!;
        if (w.failImage && args.includes(w.failImage)) throw new Error(`pull access denied for ${w.failImage}`);
        assertNoHostPathInDockerArgs(args);
        w.running.add(name);
      }
      if (args[0] === "stop" || args[0] === "rm") w.running.delete(args[args.length - 1]!);
      if (args[0] === "pause" && !w.running.has(args[1]!)) throw new Error("not running");
    },
    capture: async (c, args) => {
      w.calls.push(`${c} ${args.join(" ")}`);
      if (c === "docker" && args[0] === "ps") {
        const filter = args[args.indexOf("--filter") + 1] ?? "";
        const prefix = filter.replace(/^name=\^/, "").replace(/\\\\\./g, ".").replace(/\\\./g, ".");
        return { stdout: [...w.running].filter((n) => n.startsWith(prefix)).join("\n"), stderr: "" };
      }
      if (c === "docker" && args[0] === "inspect") {
        const name = args[args.length - 1]!;
        return { stdout: w.running.has(name) ? "running 0" : "exited 1", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
  return w;
}

function links(): GroupLinks & { linked: Map<number, string> } {
  const linked = new Map<number, string>();
  return {
    linked,
    gateway: () => "172.30.0.1",
    link: async (port, _t, owner) => {
      linked.set(port, owner);
      return true;
    },
    unlink: async (port) => void linked.delete(port),
  };
}

function platform(w: World, log: string[] = []) {
  const router = new RuntimeRouter(w.cmd, {}, { memberCheck: async ({ container }) => (w.running.has(container) ? { ok: true } : { ok: false, reason: "it's gone" }) });
  router.setGroupLinks(links());
  const irk = key();
  const book = new OwnedPortBook(memoryPortBookStore());
  const p = new ServicePlatform({
    host: { username: HOST, irkPub: irk.publicKey },
    swk: swkOps(crypto.getRandomValues(new Uint8Array(32))),
    appRunner: router,
    dataProvisioner: null,
    runtimeCapabilities: () => router.capabilities(false),
    linkPorts: book,
    onAppForgotten: (id) => router.forget(id),
    onLog: (m) => log.push(m),
  });
  const sign = (manifestJson: string) => {
    const request = { serverId: FQDN, creator: HOST, slug: "shop", manifestJson, addOwnerToMembership: false, issuedAt: Date.now() };
    return { request, signature: signInstallService(request, irk), verify: () => true };
  };
  return { p, router, sign, book };
}

describe("app group naming and order", () => {
  it("orders components after what they name, the main process last", () => {
    expect(
      componentStartOrder([
        { name: "worker", startAfter: ["cache", "queue"] },
        { name: "cache", startAfter: [] },
        { name: "queue", startAfter: ["cache"] },
      ]),
    ).toEqual(["cache", "queue", "worker"]);
    expect(() => componentStartOrder([{ name: "a", startAfter: ["b"] }, { name: "b", startAfter: ["a"] }])).toThrow(/cycle/);
  });

  it("names members inside the app, and every member resolves to its app", () => {
    expect(componentContainerName("alice--shop", "worker")).toBe("flagship-alice--shop.worker");
    expect(owningServiceId("alice--shop.worker")).toBe("alice--shop");
    expect(owningServiceId("alice--shop")).toBe("alice--shop");
    expect(componentEnvName("job-runner")).toBe("FLAGSHIP_COMPONENT_JOB_RUNNER");
    expect(() => componentContainerName("a.b", "x")).toThrow();
  });

  it("refuses a group on a box whose gateway can't link processes", () => {
    const r = parseAppManifest(groupManifest(), BOX_CAPABILITIES_0_3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/several processes/);
  });

  it("gives each member its own container, the group's links and only its own port", () => {
    const parsed = parseAppManifest(groupManifest(), { ...BOX_CAPABILITIES_0_3, appGroups: true });
    expect(parsed.ok).toBe(true);
    const { order, members, main } = memberSpecs(
      {
        serviceId: "alice--shop",
        image: "web:1",
        env: { FLAGSHIP_APP_ID: "alice--shop", PORT: "8080" },
        port: 50000,
        containerPort: 8080,
        group: {
          members: [
            { name: "cache", image: "c:1", port: 6379, hostPort: 50001, linkPort: 15400, startAfter: [] },
            { name: "worker", image: "w:1", startAfter: ["cache"] },
          ],
        },
      },
      "172.30.0.1",
    );
    expect(order).toEqual(["cache", "worker"]);
    expect(members[0]).toMatchObject({ containerName: "flagship-alice--shop.cache", port: 50001, containerPort: 6379, addHosts: { cache: "172.30.0.1" } });
    expect(members[0]!.env).toMatchObject({ FLAGSHIP_COMPONENT: "cache", FLAGSHIP_COMPONENT_CACHE: "cache:15400", PORT: "6379" });
    expect(members[1]!.env!.PORT).toBeUndefined();
    expect(members[1]!.port).toBeUndefined();
    expect(main.env).toMatchObject({ FLAGSHIP_COMPONENT_CACHE: "cache:15400", PORT: "8080" });
    expect(main.group).toBeUndefined();
    expect(() => memberSpecs({ serviceId: "x--y", image: "i", group: { members: [{ name: "c", image: "c", port: 1, hostPort: 2, linkPort: 15400, startAfter: [] }] } }, null)).toThrow(/egress gateway/);
  });
});

describe("app group lifecycle through ServicePlatform", () => {
  it("installs every member in order, with stable link ports, and a component with a base runs the app's image", async () => {
    const w = fakeDocker();
    const { p, sign, book } = platform(w);
    const r = await p.install(sign(groupManifest()));
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    const runs = w.calls.filter((c) => c.startsWith("docker run")).map((c) => /--name (\S+)/.exec(c)![1]);
    expect(runs).toEqual(["flagship-alice--shop.cache", "flagship-alice--shop.queue", "flagship-alice--shop.worker", "flagship-alice--shop"]);
    const queueRun = w.calls.find((c) => c.includes("--name flagship-alice--shop.queue"))!;
    expect(queueRun).toContain("ghcr.io/alice/shop-web:1 node queue.js");
    const workerRun = w.calls.find((c) => c.includes("--name flagship-alice--shop.worker"))!;
    expect(workerRun).toContain("--memory 128m");
    expect(Object.keys(await book.entries()).sort()).toEqual(["group:alice--shop:cache", "group:alice--shop:queue"]);
    expect(r.ok && r.app.manifestSource).toBe(groupManifest());
  });

  it("a member that fails to start leaves nothing of the group running", async () => {
    const w = fakeDocker();
    w.failImage = "ghcr.io/alice/shop-worker:1";
    const { p, sign } = platform(w);
    const r = await p.install(sign(groupManifest()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pull access denied/);
    expect([...w.running]).toEqual([]);
    expect(p.byServiceId("alice--shop")).toBeUndefined();
  });

  it("an upgrade that fails part-way rolls every member back to the previous version, in order", async () => {
    const w = fakeDocker();
    const log: string[] = [];
    const { p, sign } = platform(w, log);
    expect((await p.install(sign(groupManifest()))).ok).toBe(true);
    w.calls.length = 0;
    w.failImage = "ghcr.io/alice/shop-worker:2";
    const r = await p.redeploy(sign(groupManifest({ workerImage: "ghcr.io/alice/shop-worker:2", version: "2.0.0" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/didn't start/);
    // What ran during the attempt: new cache, new queue, then the failed worker; then the old group again.
    const runs = w.calls.filter((c) => c.startsWith("docker run")).map((c) => `${/--name (\S+)/.exec(c)![1]}${c.includes("shop-worker:2") ? "@v2" : ""}`);
    expect(runs).toEqual([
      "flagship-alice--shop.cache",
      "flagship-alice--shop.queue",
      "flagship-alice--shop.worker@v2",
      "flagship-alice--shop.cache",
      "flagship-alice--shop.queue",
      "flagship-alice--shop.worker",
      "flagship-alice--shop",
    ]);
    expect([...w.running].sort()).toEqual(["flagship-alice--shop", "flagship-alice--shop.cache", "flagship-alice--shop.queue", "flagship-alice--shop.worker"]);
    expect(p.byServiceId("alice--shop")!.manifest.version).toBe("1.0.0");
    expect(log.some((l) => /every process of the previous version is back/.test(l))).toBe(true);
  });

  it("an upgrade that drops a component stops it; uninstall stops every member and frees the links", async () => {
    const w = fakeDocker();
    const { p, sign, book } = platform(w);
    expect((await p.install(sign(groupManifest()))).ok).toBe(true);
    const fewer = JSON.parse(groupManifest()) as { components: Array<{ name: string; startAfter?: string[] }> };
    fewer.components = fewer.components.filter((c) => c.name === "cache");
    const r = await p.redeploy(sign(JSON.stringify(fewer)));
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect([...w.running].sort()).toEqual(["flagship-alice--shop", "flagship-alice--shop.cache"]);
    const { signUninstallService } = await import("@flagship/protocol");
    void signUninstallService;
    const u = await (p as unknown as { destroyApp(id: string, app: unknown, slug: string): Promise<{ ok: boolean }> }).destroyApp("alice--shop", p.byServiceId("alice--shop"), "shop");
    expect(u.ok).toBe(true);
    expect([...w.running]).toEqual([]);
    expect(await book.entries()).toEqual({});
  });

  it("holds every member still for a consistent backup and lets them go after", async () => {
    const w = fakeDocker();
    const { p, sign, router } = platform(w);
    expect((await p.install(sign(groupManifest()))).ok).toBe(true);
    w.calls.length = 0;
    const resume = await router.quiesce("alice--shop");
    const paused = w.calls.filter((c) => c.startsWith("docker pause")).map((c) => c.split(" ")[2]);
    expect(paused).toEqual(["flagship-alice--shop.cache", "flagship-alice--shop.queue", "flagship-alice--shop.worker", "flagship-alice--shop"]);
    await resume!();
    const unpaused = w.calls.filter((c) => c.startsWith("docker unpause")).map((c) => c.split(" ")[2]);
    expect(unpaused).toEqual([...paused].reverse());
  });

  it("restores a group whole after a daemon restart (the signed manifest is what is saved)", async () => {
    const w = fakeDocker();
    const saved: unknown[] = [];
    const registry = { save: async (s: unknown[]) => void saved.splice(0, saved.length, ...s), load: async () => saved as never };
    const irk = key();
    const mk = () => {
      const router = new RuntimeRouter(w.cmd, {}, { memberCheck: async () => ({ ok: true }) });
      router.setGroupLinks(links());
      return new ServicePlatform({
        host: { username: HOST, irkPub: irk.publicKey },
        swk: swkOps(new Uint8Array(32).fill(7)),
        appRunner: router,
        dataProvisioner: null,
        runtimeCapabilities: () => router.capabilities(false),
        linkPorts: new OwnedPortBook(memoryPortBookStore()),
        registry: registry as never,
      });
    };
    const a = mk();
    const request = { serverId: FQDN, creator: HOST, slug: "shop", manifestJson: groupManifest(), addOwnerToMembership: false, issuedAt: Date.now() };
    expect((await a.install({ request, signature: signInstallService(request, irk), verify: () => true })).ok).toBe(true);
    await a.flush();
    w.running.clear();
    w.calls.length = 0;
    const b = mk();
    const r = await b.restore({ retries: 0 });
    expect(r.restored).toEqual(["alice--shop"]);
    expect(b.byServiceId("alice--shop")!.app!.components.map((c) => c.name)).toEqual(["cache", "worker", "queue"]);
    expect([...w.running].sort()).toEqual(["flagship-alice--shop", "flagship-alice--shop.cache", "flagship-alice--shop.queue", "flagship-alice--shop.worker"]);
  });
});

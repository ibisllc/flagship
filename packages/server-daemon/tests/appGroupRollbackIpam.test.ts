/**
 * Gym run 51 (arch-v2, Podman): an app group's update failed, and its rollback restarted the previous
 * members at the addresses the daemon's pool kept for them, while containers the Rust controller placed
 * after the pool was seeded held those addresses and the ones above them. Each refusal walked the pool up
 * one address; the tries ran out and every member ended missing. A rollback must bring the group back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ed, signInstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import { RuntimeRouter } from "../src/appRuntimes.js";
import type { GroupLinks } from "../src/appGroups/runner.js";
import { OwnedPortBook, memoryPortBookStore } from "../src/appGroups/portBook.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { endpoints } from "../src/endpoints.js";
import { setActiveEngine } from "../src/engine/engine.js";
import { heldAddresses, resetAddressPools, type CommandRunner } from "../src/serviceRunner.js";

const HOST = "alice";
const FQDN = `home.${HOST}.flagship.services`;
const SID = "alice--shop";

function manifest(workerImage: string, version: string): string {
  return JSON.stringify({
    schema_version: 2,
    name: "shop",
    version,
    runtime: { image: "ghcr.io/alice/shop-web:1", port: 8080 },
    data: {},
    network: { subdomain: "shop" },
    access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" },
    components: [
      { name: "api", image: "ghcr.io/alice/shop-api:1", port: 7000 },
      { name: "worker", image: workerImage, startAfter: ["api"] },
    ],
  });
}

interface Box {
  /** container name -> what the engine knows of it */
  containers: Map<string, { ip: string | null; service: string; running: boolean; generation?: string }>;
  failImage: string | null;
  cmd: CommandRunner;
}

/** A Podman that hands out the address a run asks for only if no container holds it, as its IPAM does. */
function podman(): Box {
  const b: Box = { containers: new Map(), failImage: null, cmd: null as unknown as CommandRunner };
  b.cmd = {
    run: async (_c, args) => {
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1]!;
        const ip = args.includes("--ip") ? args[args.indexOf("--ip") + 1]! : null;
        if (b.failImage && args.includes(b.failImage)) throw new Error(`exited with code 125: Error: initializing source docker://${b.failImage}: manifest unknown`);
        if (b.containers.has(name)) throw new Error(`exited with code 125: Error: the container name "${name}" is already in use`);
        const holder = [...b.containers.entries()].find(([, c]) => ip && c.ip === ip);
        if (holder) throw new Error(`exited with code 126: Error: IPAM error: requested ip address ${ip} is already allocated to container ID ${holder[0]}`);
        const label = args.find((a) => a.startsWith("flagship.service="))!.split("=")[1]!;
        const generation = args.find((a) => a.startsWith("flagship.generation="))!.split("=")[1]!;
        b.containers.set(name, { ip, service: label, running: true, generation });
      }
      if (args[0] === "rm") b.containers.delete(args[args.length - 1]!);
      if (args[0] === "stop") {
        const c = b.containers.get(args[args.length - 1]!);
        if (c) c.running = false;
      }
    },
    capture: async (_c, args) => {
      if (args[0] === "network") {
        return {
          stdout: JSON.stringify([{ name: "flagship-apps", id: "n1", network_interface: "fs-apps", subnets: [{ subnet: "10.89.1.0/24", gateway: "10.89.1.1" }], options: { mode: "unmanaged" }, containers: {} }]),
          stderr: "",
        };
      }
      if (args[0] === "ps") {
        const f = args[args.indexOf("--filter") + 1] ?? "";
        const names = [...b.containers.keys()];
        if (f.startsWith("name=")) {
          const prefix = `flagship-${SID}.`;
          return { stdout: names.filter((n) => n.startsWith(prefix)).join("\n"), stderr: "" };
        }
        return { stdout: names.join("\n"), stderr: "" };
      }
      if (args[0] === "inspect") {
        const name = args[args.length - 1]!;
        const c = b.containers.get(name);
        if (!c) throw new Error(`no such container ${name}`);
        if (args[1] === "-f" && args[2]!.includes("IPAddress")) return { stdout: `${c.ip ?? ""}|${c.service}`, stderr: "" };
        if (args[1] === "-f") return { stdout: `${c.running ? "running" : "exited"} 0`, stderr: "" };
        return {
          stdout: JSON.stringify({
            Id: `id-${name}`,
            State: { Running: c.running, StartedAt: "2026-11-04T02:55:00Z" },
            Config: { Labels: { "flagship.service": c.service, "flagship.generation": c.generation ?? "1" } },
            NetworkSettings: { Networks: c.ip ? { "flagship-apps": { IPAddress: c.ip } } : {} },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  };
  return b;
}

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function platform(b: Box, log: string[]) {
  const router = new RuntimeRouter(b.cmd, {}, { memberCheck: async ({ container }) => (b.containers.get(container)?.running ? { ok: true } : { ok: false, reason: "it's gone" }) });
  const linked = new Map<number, string>();
  const links: GroupLinks = {
    gateway: () => "10.89.1.1",
    link: async (port, t) => {
      linked.set(port, t.host);
      return true;
    },
    unlink: async (port) => void linked.delete(port),
  };
  router.setGroupLinks(links);
  const irk = key();
  const p = new ServicePlatform({
    host: { username: HOST, irkPub: irk.publicKey },
    swk: swkOps(crypto.getRandomValues(new Uint8Array(32))),
    appRunner: router,
    dataProvisioner: null,
    runtimeCapabilities: () => router.capabilities(false),
    linkPorts: new OwnedPortBook(memoryPortBookStore()),
    onAppForgotten: (id) => router.forget(id),
    onLog: (m) => log.push(m),
  });
  const sign = (manifestJson: string) => {
    const request = { serverId: FQDN, creator: HOST, slug: "shop", manifestJson, addOwnerToMembership: false, issuedAt: Date.now() };
    return { request, signature: signInstallService(request, irk), verify: () => true };
  };
  return { p, sign, linked };
}

afterEach(() => {
  resetAddressPools();
  setActiveEngine("docker");
  endpoints.invalidate(SID);
});

describe("an app group's rollback when the engine holds its old addresses", () => {
  it("brings every member back at free addresses, and the links and the endpoint follow them", async () => {
    setActiveEngine("podman");
    const b = podman();
    const log: string[] = [];
    const { p, sign, linked } = platform(b, log);
    const up = await p.install(sign(manifest("ghcr.io/alice/shop-worker:1", "1.0.0")));
    expect(up.ok, up.ok ? "" : up.reason).toBe(true);
    const before = new Map([...b.containers].map(([n, c]) => [n, c.ip]));
    expect(before.get(`flagship-${SID}.api`)).toBe("10.89.1.2");

    // The update stops the group and the new worker's image fails to pull; before the rollback runs, the Rust controller
    // places other apps on the bridge at the addresses it sees free: the group's and the next ones, unknown to the daemon's pool.
    b.failImage = "ghcr.io/alice/shop-worker:2";
    const realRun = b.cmd.run;
    let failed = false;
    let placed = false;
    b.cmd.run = async (c, args) => {
      if (args[0] === "run" && args.includes(b.failImage!)) failed = true;
      else if (failed && !placed && args[0] === "run") {
        placed = true;
        for (let i = 2; i <= 9; i++) {
          const ip = `10.89.1.${i}`;
          if (![...b.containers.values()].some((x) => x.ip === ip)) b.containers.set(`flagship-bob--app${i}`, { ip, service: `bob--app${i}`, running: true });
        }
      }
      return realRun(c, args);
    };
    const r = await p.redeploy(sign(manifest("ghcr.io/alice/shop-worker:2", "2.0.0")));
    expect(r.ok).toBe(false);
    expect(log.find((l) => /didn't come back/.test(l))).toBeUndefined();
    expect(log.some((l) => /every process of the previous version is back/.test(l))).toBe(true);

    const group = [`flagship-${SID}.api`, `flagship-${SID}.worker`, `flagship-${SID}`];
    for (const n of group) expect(b.containers.get(n)?.running, n).toBe(true);
    const all = [...b.containers.values()].map((c) => c.ip);
    expect(new Set(all).size).toBe(all.length);
    // Their old addresses (and the run above them) went to the other apps: they moved past them.
    expect(before.get(`flagship-${SID}`)).toBe("10.89.1.3");
    for (const n of [`flagship-${SID}.api`, `flagship-${SID}`]) expect(Number(b.containers.get(n)!.ip!.split(".")[3])).toBeGreaterThan(9);
    // The api's link and the main process's endpoint name the addresses the containers really have.
    expect([...linked.values()]).toEqual([b.containers.get(`flagship-${SID}.api`)!.ip]);
    expect(endpoints.lookup({ serviceId: SID, env: "live", component: "main", role: "http" })?.host).toBe(b.containers.get(`flagship-${SID}`)!.ip);
    expect(p.byServiceId(SID)!.manifest.version).toBe("1.0.0");
  });

  it("reports the addresses the daemon keeps for stopped members, so core does not give them out", async () => {
    setActiveEngine("podman");
    const b = podman();
    const { p, sign } = platform(b, []);
    expect((await p.install(sign(manifest("ghcr.io/alice/shop-worker:1", "1.0.0")))).ok).toBe(true);
    const ips = [...b.containers.values()].map((c) => c.ip).filter(Boolean);
    b.containers.clear();
    expect((await heldAddresses("flagship-apps")).sort()).toEqual([...ips].sort());
  });
});

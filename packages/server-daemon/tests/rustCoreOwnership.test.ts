// The daemon's executor (rustStack/coreOwnership.ts) against the real Rust controller
// (`flagship-core serve`, built in rust/target/debug): the TS and Rust halves of the app
// reconciler on the same inputs. Shadow mode hands out nothing; rust mode installs, adopts after a
// daemon restart and after a core restart, upgrades, stops and forgets with one container per app.
// Skipped when the binary has not been built (`cargo build -p flagship-core`).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreOwnership, coreCall, specDigest, workloadOfContainer, memoryBytes, type ObservedContainer, type OwnedWorkload, type ReconcilerMode } from "../src/rustStack/coreOwnership.js";

const BIN = new URL("../../../rust/target/debug/flagship-core", import.meta.url).pathname;
const NET = "flagship-apps";

interface Box {
  dir: string;
  sock: string;
  core: ChildProcess | null;
}

const boxes: Box[] = [];

async function startCore(b: Box): Promise<void> {
  rmSync(b.sock, { force: true });
  b.core = spawn(BIN, ["serve"], {
    env: {
      ...process.env,
      FLAGSHIP_CORE_DIR: b.dir,
      FLAGSHIP_CORE_SOCKET: b.sock,
      FLAGSHIP_CORE_BROKER: join(b.dir, "no-broker.sock"),
      FLAGSHIP_CORE_STATUS: join(b.dir, "status.json"),
      FLAGSHIP_CORE_INTERVAL_SECS: "5",
      FLAGSHIP_CORE_TEST_NO_PEER_CHECK: "1",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 200 && !existsSync(b.sock); i++) await new Promise((r) => setTimeout(r, 25));
  expect(existsSync(b.sock)).toBe(true);
}

async function newBox(): Promise<Box> {
  const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "fco-"));
  const b: Box = { dir, sock: join(dir, "core.sock"), core: null };
  boxes.push(b);
  await startCore(b);
  return b;
}

function stopCore(b: Box): Promise<void> {
  return new Promise((resolve) => {
    if (!b.core || b.core.exitCode !== null) return resolve();
    b.core.once("exit", () => resolve());
    b.core.kill("SIGKILL");
  });
}

afterEach(async () => {
  for (const b of boxes.splice(0)) {
    await stopCore(b);
    rmSync(b.dir, { recursive: true, force: true });
  }
});

/** The engine as the daemon sees it. */
class Engine {
  containers = new Map<string, ObservedContainer>();
  creates: Array<[string, number]> = [];
  removes: Array<[string, number]> = [];
  seq = 0;
  observe = async () => [...this.containers.values()].map((c) => ({ ...c, addresses: { ...c.addresses } }));
  create(inst: string, comp: string, generation: number, address: string | null): void {
    const name = comp === "main" ? `flagship-${inst}` : `flagship-${inst}.${comp}`;
    if (this.containers.has(name)) throw new Error(`the container name ${name} is already in use`);
    this.creates.push([name, generation]);
    this.containers.set(name, { name, containerId: `c${++this.seq}`, installation: inst, component: comp, generation, running: true, startedAt: "now", addresses: address ? { [NET]: address } : {} });
  }
  remove = async (o: { installation: string; component: string; generation: number }) => {
    const name = o.component === "main" ? `flagship-${o.installation}` : `flagship-${o.installation}.${o.component}`;
    const c = this.containers.get(name);
    if (c?.generation === o.generation) {
      this.containers.delete(name);
      this.removes.push([name, o.generation]);
    }
  };
}

function owner(b: Box, e: Engine, mode: { m: ReconcilerMode }): CoreOwnership {
  return new CoreOwnership({
    mode: () => mode.m,
    call: (req) => coreCall(req, b.sock, 10_000),
    observe: e.observe,
    networks: async () => [{ name: NET, subnet: "10.89.0.0/24", gateways: ["10.89.0.1"] }],
    removeContainer: e.remove,
    capacity: () => ({ memoryBytes: 8 * 1024 ** 3, cpuMillis: 4000 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    waitMs: 20_000,
  });
}

function app(inst: string, spec: unknown, running = true): OwnedWorkload {
  return { installation: inst, component: "main", kind: "app", network: NET, specDigest: specDigest(spec), running, epoch: 0, resources: { memoryBytes: 512 * 1024 ** 2, cpuMillis: 1000 }, wantsAddress: true };
}

const deployer = (e: Engine, inst: string) => ({ deploy: async (o: { generation: number; address: string | null }) => e.create(inst, "main", o.generation, o.address) });

describe.skipIf(!existsSync(BIN))("the daemon's executor with the Rust controller", () => {
  it("shadow mode: core compares, hands out nothing, and counts agreement", async () => {
    const b = await newBox();
    const e = new Engine();
    const mode = { m: "shadow" as ReconcilerMode };
    const o = owner(b, e, mode);
    o.note(app("alice--notes", { v: 1 }));
    let r = await o.pump();
    expect(r.live).toBe(false);
    expect(r.effects).toEqual([]);
    expect(r.divergent.length).toBe(1);
    e.create("alice--notes", "main", 1000, "10.89.0.50");
    for (let i = 1; i <= 3; i++) {
      r = await o.pump();
      expect(r.agreePasses).toBe(i);
    }
    expect(e.creates.length).toBe(1);
    const status = (await coreCall({ op: "Status" }, b.sock)) as { live: boolean; agreePasses: number };
    expect(status).toMatchObject({ live: false, agreePasses: 3 });
  });

  it("rust mode: install, adopt after a daemon and a core restart, upgrade, stop, forget", async () => {
    const b = await newBox();
    const e = new Engine();
    const mode = { m: "rust" as ReconcilerMode };
    let o = owner(b, e, mode);
    await o.ensure(app("alice--notes", { v: 1 }), deployer(e, "alice--notes"));
    expect(e.creates.length).toBe(1);
    const first = e.containers.get("flagship-alice--notes")!;
    expect(first.addresses[NET]).toMatch(/^10\.89\.0\.\d+$/);
    expect(first.addresses[NET]).not.toBe("10.89.0.1");

    // The daemon restarts (a new executor): the same spec is adopted as it runs.
    o = owner(b, e, mode);
    await o.ensure(app("alice--notes", { v: 1 }), deployer(e, "alice--notes"));
    expect(e.creates.length).toBe(1);

    // Core restarts: its journal holds the desired state and the address.
    await stopCore(b);
    await startCore(b);
    o = owner(b, e, mode);
    await o.ensure(app("alice--notes", { v: 1 }), deployer(e, "alice--notes"));
    expect(e.creates.length).toBe(1);
    expect(e.containers.get("flagship-alice--notes")!.containerId).toBe(first.containerId);

    // An upgrade replaces the container (one at a time), keeping its address.
    await o.ensure(app("alice--notes", { v: 2 }), deployer(e, "alice--notes"));
    const second = e.containers.get("flagship-alice--notes")!;
    expect(second.generation!).toBeGreaterThan(first.generation!);
    expect(second.addresses[NET]).toBe(first.addresses[NET]);
    expect(e.removes).toEqual([["flagship-alice--notes", first.generation]]);
    expect(e.containers.size).toBe(1);

    // Stop, then forget.
    await o.stop("alice--notes", "main");
    expect(e.containers.size).toBe(0);
    await o.forget("alice--notes", "main");
    const r = await o.pump();
    expect(r.workloads.find((w) => w.installation === "alice--notes")).toBeUndefined();
  });

  it("rust mode: a deploy that fails comes back as the app's error, and core backs off", async () => {
    const b = await newBox();
    const e = new Engine();
    const o = owner(b, e, { m: "rust" });
    await expect(
      o.ensure(app("alice--broken", { v: 1 }), {
        deploy: async () => {
          throw new Error("image not found");
        },
      }),
    ).rejects.toThrow("image not found");
    expect(e.creates.length).toBe(0);
  });

  it("switching from shadow to rust adopts what the daemon started", async () => {
    const b = await newBox();
    const e = new Engine();
    const mode = { m: "shadow" as ReconcilerMode };
    const o = owner(b, e, mode);
    const w = app("alice--chess", { v: 1 });
    o.note(w);
    e.create("alice--chess", "main", 1234, "10.89.0.40");
    await o.pump();
    mode.m = "rust";
    await o.ensure(w, deployer(e, "alice--chess"));
    expect(e.creates.length).toBe(1);
    // A new app gets another address than the adopted one.
    await o.ensure(app("alice--notes", { v: 1 }), deployer(e, "alice--notes"));
    expect(e.containers.get("flagship-alice--notes")!.addresses[NET]).not.toBe("10.89.0.40");
  });
});

describe("executor helpers", () => {
  it("names, memory and digests", () => {
    expect(workloadOfContainer("flagship-alice--notes", "alice--notes")).toEqual({ installation: "alice--notes", component: "main" });
    expect(workloadOfContainer("flagship-alice--shop.worker", "alice--shop")).toEqual({ installation: "alice--shop", component: "worker" });
    expect(workloadOfContainer("flagship-localai-0123456789abcdef", "local-ai")).toEqual({ installation: "local-ai", component: "model" });
    expect(workloadOfContainer("flagship-alice--notes", "bob--notes")).toBeNull();
    expect(workloadOfContainer("flagship-stg-abc--x", "stg-abc--x")).toBeNull();
    expect(workloadOfContainer("flagship-pgd-0123456789abcdef01234567", "x")).toBeNull();
    expect(memoryBytes("512m")).toBe(512 * 1024 ** 2);
    expect(memoryBytes("2g")).toBe(2 * 1024 ** 3);
    expect(memoryBytes("nonsense")).toBe(0);
    expect(specDigest({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(specDigest({ b: [2, { d: 4, c: 3 }], a: 1 }));
    expect(specDigest({ a: 1 })).not.toBe(specDigest({ a: 2 }));
  });
});

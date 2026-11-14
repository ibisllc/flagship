/**
 * Store generations (docs/restore-into-server.md §3.3): an app's stores can be
 * made again beside the live ones and swapped in, the old generation kept as
 * the undo point. Generation 0 keeps every name an app had before.
 */
import { describe, expect, it } from "vitest";
import { ed, signInstallService, signUninstallService, verifyInstallService, verifyUninstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import {
  DataProvisioner,
  InMemoryFilesAdmin,
  InMemoryPostgresAdmin,
  filesVolume,
  isFilesVolume,
  isProdFilesVolume,
  pgDatabase,
} from "../src/dataLayer/index.js";
import { MAX_DATA_GENERATION, parseProdFilesVolume } from "../src/dataLayer/naming.js";
import { InMemoryInstalledServicesStore } from "../src/installedServicesStore.js";

const KEY = "n".repeat(40);
const HOST = "alice";
const FQDN = `home.${HOST}.flagship.services`;

describe("store generation names", () => {
  it("generation 0 is exactly the name every app had before generations", () => {
    const id = { creator: "harry", slug: "notes" };
    expect(pgDatabase({ ...id, generation: 0 }, KEY)).toBe(pgDatabase(id, KEY));
    expect(filesVolume({ ...id, generation: 0 })).toBe("flagship-files-harry--notes");
  });

  it("each generation gets its own opaque database and folder, never another app's", () => {
    const seen = new Set<string>();
    for (const slug of ["notes", "notes-g2", "g2"]) {
      for (const generation of [0, 1, 2, 10, MAX_DATA_GENERATION]) {
        const db = pgDatabase({ creator: "harry", slug, generation }, KEY);
        expect(db).toMatch(/^app_[0-9a-f]{24}$/);
        expect(seen.has(db)).toBe(false);
        seen.add(db);
        const v = filesVolume({ creator: "harry", slug, generation });
        expect(seen.has(v)).toBe(false);
        seen.add(v);
        expect(isProdFilesVolume(v) && isFilesVolume(v)).toBe(true);
        expect(parseProdFilesVolume(v)).toEqual({ creator: "harry", slug, installation: `harry--${slug}`, generation });
      }
    }
    // `notes` at generation 2 can't be mistaken for an app called `notes-g2`.
    expect(filesVolume({ creator: "harry", slug: "notes", generation: 2 })).toBe("flagship-files-harry--notes--g2");
  });

  it("refuses a dev generation and out-of-range generations", () => {
    expect(() => filesVolume({ creator: "h", slug: "n", space: "dev", generation: 1 })).toThrow(/dev dataspace/);
    for (const g of [-1, 1.5, MAX_DATA_GENERATION + 1, Number.NaN]) {
      expect(() => pgDatabase({ creator: "h", slug: "n", generation: g }, KEY)).toThrow(/generation/);
    }
    for (const v of ["flagship-files-h--n--g0", "flagship-files-h--n--g01", "flagship-files-h--n--g1000000", "flagship-devfiles-h--n--g2", "flagship-files-h--n--g2--g3"]) {
      expect(isFilesVolume(v), v).toBe(false);
    }
  });
});

function key(): Keypair {
  const p = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: p, publicKey: ed.getPublicKey(p) };
}

function manifest(image: string): string {
  return JSON.stringify({
    schema_version: 1,
    name: "notes",
    version: "0.1.0",
    runtime: { image, port: 8080 },
    data: { stores: { postgres: true, files: true } },
    network: {},
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
  });
}

function world(registry = new InMemoryInstalledServicesStore(), swk = crypto.getRandomValues(new Uint8Array(32))) {
  const runs: string[] = [];
  const pg = new InMemoryPostgresAdmin();
  const files = new InMemoryFilesAdmin();
  let broken = false;
  const cmd: CommandRunner = {
    run: async (c, args) => {
      if (args[0] === "run" && broken && args.some((a) => a.includes(":new"))) throw new Error("exec format error");
      if (args[0] === "run") runs.push(args.join(" "));
    },
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  const irk = key();
  const platform = new ServicePlatform({
    host: { username: HOST, irkPub: irk.publicKey },
    swk: swkOps(swk),
    appRunner: new AppRunner(cmd),
    dataProvisioner: new DataProvisioner({ postgres: pg, files, nameKey: KEY }),
    registry,
  });
  return { platform, runs, pg, files, irk, registry, swk, breakNew: () => (broken = true) };
}

async function install(w: ReturnType<typeof world>) {
  const request = { serverId: FQDN, creator: HOST, slug: "notes", manifestJson: manifest("flagship-vibe-alice--notes:1"), addOwnerToMembership: false, issuedAt: Date.now() };
  const r = await w.platform.install({ request, signature: signInstallService(request, w.irk), verify: verifyInstallService });
  if (!r.ok) throw new Error(r.reason);
  return r.app;
}

const lastRun = (w: ReturnType<typeof world>) => w.runs[w.runs.length - 1]!;

describe("swapping an app onto a new store generation", () => {
  it("prepares generation 1 beside the live stores without touching them", async () => {
    const w = world();
    const app = await install(w);
    expect(app.data!.files!.volume).toBe("flagship-files-alice--notes");
    const live = app.data!.postgres!.default!.database;
    const runsBefore = w.runs.length;
    const p = await w.platform.prepareDataGeneration("alice--notes");
    expect(p.generation).toBe(1);
    expect(p.data!.files!.volume).toBe("flagship-files-alice--notes--g1");
    expect(p.data!.postgres!.default!.database).not.toBe(live);
    expect(p.data!.postgresSingleton).toBe(true);
    expect([...w.pg.databases.keys()]).toEqual([live, p.data!.postgres!.default!.database]);
    expect(w.runs.length).toBe(runsBefore);
    expect(w.platform.byServiceId("alice--notes")!.data).toEqual(app.data);
  });

  it("swaps in seconds-worth of work, keeps the old generation, and survives a restart", async () => {
    const w = world();
    const app = await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    const r = await w.platform.swapDataGeneration(
      "alice--notes",
      { generation: p.generation, data: p.data, manifestJson: manifest("flagship-vibe-alice--notes:2"), appliedMigrations: ["001.sql"] },
      { ref: "r1", expiresAt: Date.now() + 7 * 86_400_000 },
    );
    expect(r.ok).toBe(true);
    const now = w.platform.byServiceId("alice--notes")!;
    expect(now.dataGeneration).toBe(1);
    expect(now.data).toEqual(p.data);
    expect(now.appliedMigrations).toEqual(["001.sql"]);
    expect(now.retainedData).toHaveLength(1);
    expect(now.retainedData![0]).toMatchObject({ ref: "r1", generation: 0, data: app.data });
    expect(lastRun(w)).toContain("flagship-files-alice--notes--g1");
    expect(lastRun(w)).toContain("flagship-vibe-alice--notes:2");
    expect(lastRun(w)).toContain(p.data!.postgres!.default!.database);
    expect(w.platform.retainedVolumes()).toEqual(["flagship-files-alice--notes"]);

    await w.platform.flush();
    const again = world(w.registry, w.swk);
    await again.platform.restore({ retryDelayMs: 0 });
    const back = again.platform.byServiceId("alice--notes")!;
    expect(back.dataGeneration).toBe(1);
    expect(back.retainedData![0]!.ref).toBe("r1");
    expect(lastRun(again)).toContain("flagship-files-alice--notes--g1");
  });

  it("a store a later version adds is made in the app's current generation", async () => {
    const w = world();
    await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    await w.platform.swapDataGeneration("alice--notes", { generation: p.generation, data: p.data, appliedMigrations: [] }, { ref: "r1", expiresAt: Date.now() + 1000 });
    const m = JSON.parse(manifest("flagship-vibe-alice--notes:3")) as { data: { stores: unknown } };
    m.data.stores = { postgres: ["default", "photos"], files: true };
    const request = { serverId: FQDN, creator: HOST, slug: "notes", manifestJson: JSON.stringify(m), addOwnerToMembership: false, issuedAt: Date.now() };
    const r = await w.platform.redeploy({ request, signature: signInstallService(request, w.irk), verify: verifyInstallService });
    expect(r.ok).toBe(true);
    const photos = w.platform.byServiceId("alice--notes")!.data!.postgres!.photos!.database;
    expect(photos).toBe(pgDatabase({ creator: HOST, slug: "notes", storeName: "photos", generation: 1 }, KEY));
  });

  it("a guard that sees a change refuses before anything stops", async () => {
    const w = world();
    const app = await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    const runs = w.runs.length;
    const r = await w.platform.swapDataGeneration("alice--notes", { generation: p.generation, data: p.data, appliedMigrations: [] }, { ref: "r1", expiresAt: 1 }, () => "notes changed since you chose");
    expect(r).toEqual({ ok: false, reason: "notes changed since you chose", changed: true });
    expect(w.runs.length).toBe(runs);
    expect(w.platform.byServiceId("alice--notes")!.data).toEqual(app.data);
    await w.platform.dropPreparedGeneration("alice--notes", p.data);
    expect(w.files.volumes.has("flagship-files-alice--notes--g1")).toBe(false);
    expect(w.files.volumes.has("flagship-files-alice--notes")).toBe(true);
  });

  it("a copy that won't start puts the app back exactly as it was and keeps nothing", async () => {
    const w = world();
    const app = await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    w.breakNew();
    const r = await w.platform.swapDataGeneration("alice--notes", { generation: p.generation, data: p.data, manifestJson: manifest("flagship-vibe-alice--notes:new"), appliedMigrations: [] }, { ref: "r1", expiresAt: 1 });
    expect(r.ok).toBe(false);
    const now = w.platform.byServiceId("alice--notes")!;
    expect(now.data).toEqual(app.data);
    expect(now.dataGeneration).toBeUndefined();
    expect(now.retainedData).toBeUndefined();
    expect(lastRun(w)).toContain("flagship-vibe-alice--notes:1");
    expect(lastRun(w)).toContain("src=flagship-files-alice--notes,dst");
  });

  it("undo puts the kept generation back and drops the restored one", async () => {
    const w = world();
    const app = await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    await w.platform.swapDataGeneration("alice--notes", { generation: p.generation, data: p.data, manifestJson: manifest("flagship-vibe-alice--notes:2"), appliedMigrations: ["001.sql"] }, { ref: "r1", expiresAt: Date.now() + 1000 });
    const u = await w.platform.revertDataGeneration("alice--notes", "r1");
    expect(u.ok).toBe(true);
    const now = w.platform.byServiceId("alice--notes")!;
    expect(now.data).toEqual(app.data);
    expect(now.dataGeneration).toBeUndefined();
    expect(now.retainedData).toBeUndefined();
    expect(now.appliedMigrations).toEqual([]);
    expect(now.manifest.runtime.image).toBe("flagship-vibe-alice--notes:1");
    expect(w.files.volumes.has("flagship-files-alice--notes--g1")).toBe(false);
    expect(w.pg.databases.has(p.data!.postgres!.default!.database)).toBe(false);
    expect(w.pg.databases.has(app.data!.postgres!.default!.database)).toBe(true);
    // A second generation after an undo takes the next number again (1 is free).
    expect((await w.platform.prepareDataGeneration("alice--notes")).generation).toBe(1);
  });

  it("discard drops only the kept generation; expiry lists it; uninstall drops both", async () => {
    const w = world();
    const app = await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    await w.platform.swapDataGeneration("alice--notes", { generation: p.generation, data: p.data, appliedMigrations: [] }, { ref: "r1", expiresAt: 1000 });
    expect(w.platform.expiredRetained(999)).toEqual([]);
    expect(w.platform.expiredRetained(1000)).toEqual([{ serviceId: "alice--notes", ref: "r1" }]);
    expect((await w.platform.discardRetainedGeneration("alice--notes", "r1")).ok).toBe(true);
    expect(w.files.volumes.has(app.data!.files!.volume)).toBe(false);
    expect(w.files.volumes.has(p.data!.files!.volume)).toBe(true);
    expect((await w.platform.discardRetainedGeneration("alice--notes", "r1")).ok).toBe(false);

    const q = await w.platform.prepareDataGeneration("alice--notes");
    expect(q.generation).toBe(2);
    await w.platform.swapDataGeneration("alice--notes", { generation: q.generation, data: q.data, appliedMigrations: [] }, { ref: "r2", expiresAt: 1000 });
    const request = { serverId: FQDN, creator: HOST, slug: "notes", issuedAt: Date.now() };
    const un = await w.platform.uninstall({ request, signature: signUninstallService(request, w.irk), verify: verifyUninstallService });
    expect(un.ok).toBe(true);
    expect([...w.files.volumes.keys()]).toEqual([]);
    expect([...w.pg.databases.keys()]).toEqual([]);
  });

  it("refuses to drop the live or a kept generation as a prepared one, and an older generation as a swap", async () => {
    const w = world();
    const app = await install(w);
    await expect(w.platform.dropPreparedGeneration("alice--notes", app.data)).rejects.toThrow(/live/);
    const r = await w.platform.swapDataGeneration("alice--notes", { generation: 0, data: app.data, appliedMigrations: [] }, { ref: "r", expiresAt: 1 });
    expect(r.ok).toBe(false);
  });

  it("serializes a swap with a redeploy of the same app", async () => {
    const w = world();
    await install(w);
    const p = await w.platform.prepareDataGeneration("alice--notes");
    const request = { serverId: FQDN, creator: HOST, slug: "notes", manifestJson: manifest("flagship-vibe-alice--notes:9"), addOwnerToMembership: false, issuedAt: Date.now() };
    const [s, d] = await Promise.all([
      w.platform.swapDataGeneration("alice--notes", { generation: p.generation, data: p.data, appliedMigrations: [] }, { ref: "r1", expiresAt: 1 }),
      w.platform.redeploy({ request, signature: signInstallService(request, w.irk), verify: verifyInstallService }),
    ]);
    expect(s.ok && d.ok).toBe(true);
    const now = w.platform.byServiceId("alice--notes")!;
    expect(now.data).toEqual(p.data);
    expect(now.dataGeneration).toBe(1);
    expect(now.manifest.runtime.image).toBe("flagship-vibe-alice--notes:9");
  });
});

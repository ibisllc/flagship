/**
 * The per-app quota manager (appQuota/manager.ts) over fakes: budgets from
 * the backup cap become image sizes and reserved blocks for files, write
 * blocks for Postgres; the disk brake freezes everything; staging copies get
 * their own small limits; the owner hears once per fill; state survives a
 * restart so what was revoked is given back.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppQuotaManager,
  DEV_FILES_QUOTA_BYTES,
  DEV_PG_QUOTA_BYTES,
  FakePgQuota,
  quotaNotices,
  type AppBudget,
  type DiskUse,
  type FsUsage,
  type QuotaApp,
  type QuotaEvent,
  type QuotaFiles,
} from "../src/appQuota/index.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

class FakeFiles implements QuotaFiles {
  used = new Map<string, number>();
  images = new Map<string, number>();
  readOnly = new Set<string>();
  calls: Array<{ volume: string; imageBytes: number; limitBytes: number | null; freeze: boolean }> = [];
  prepared: string[] = [];
  async prepare(volume: string, sizeBytes: number) {
    this.prepared.push(`${volume}:${sizeBytes}`);
    return "mounted" as const;
  }
  async applyLimit(volume: string, a: { imageBytes: number; limitBytes: number | null; freeze: boolean }): Promise<FsUsage | null> {
    this.calls.push({ volume, ...a });
    if (!this.images.has(volume)) return null;
    const size = Math.max(this.images.get(volume)!, a.imageBytes);
    this.images.set(volume, size);
    const used = this.used.get(volume) ?? 0;
    const cap = a.freeze ? used : Math.min(size, a.limitBytes ?? size);
    return {
      sizeBytes: size,
      usedBytes: used,
      availBytes: Math.max(0, cap - used),
      imageBytes: size,
      readOnly: this.readOnly.has(volume),
      ballastBytes: 0,
    };
  }
  async setReadOnly(volume: string, ro: boolean) {
    if (ro) this.readOnly.add(volume);
    else this.readOnly.delete(volume);
  }
  async listImages() {
    return [...this.images.keys()];
  }
}

const VOL = "flagship-files-alice--notes";
const pgOnly: QuotaApp = { serviceId: "alice-notes", postgres: [{ database: "app_aaaa", role: "app_aaaa" }] };
const app: QuotaApp = {
  serviceId: "alice-notes",
  files: { volume: VOL },
  postgres: [{ database: "app_aaaa", role: "app_aaaa" }],
};

function setup(o: { budgets?: Map<string, AppBudget> | null; disk?: DiskUse; statePath?: string | null; app?: QuotaApp } = {}) {
  const files = new FakeFiles();
  files.images.set(VOL, 64 * MiB);
  const pg = new FakePgQuota();
  pg.size.set("app_aaaa", 10 * MiB);
  let disk: DiskUse = o.disk ?? { totalBytes: 100 * GiB, availBytes: 50 * GiB };
  let budgets: Map<string, AppBudget> | null = o.budgets === undefined ? null : o.budgets;
  const full: QuotaEvent[] = [];
  const room: QuotaEvent[] = [];
  const brakes: string[] = [];
  const devDbs: string[] = [];
  const m = new AppQuotaManager({
    apps: () => [o.app ?? app],
    budgets: () => budgets,
    files,
    pg: () => pg,
    devDatabases: async () => devDbs,
    hostDisk: async () => disk,
    statePath: o.statePath ?? null,
    onFull: (e) => full.push(e),
    onRoom: (e) => room.push(e),
    onBrake: (s, p) => brakes.push(`${p}->${s}`),
    log: () => {},
  });
  return {
    m,
    files,
    pg,
    full,
    room,
    brakes,
    devDbs,
    setDisk: (d: DiskUse) => (disk = d),
    setBudgets: (b: Map<string, AppBudget> | null) => (budgets = b),
  };
}

const budget = (filesBytes: number, postgresBytes: number): Map<string, AppBudget> =>
  new Map([["alice-notes", { totalBytes: filesBytes + postgresBytes, filesBytes, postgresBytes }]]);

describe("AppQuotaManager", () => {
  it("with no limit sizes the folder at 90 % of the disk and leaves Postgres open", async () => {
    const t = setup();
    await t.m.kick();
    expect(t.files.calls.at(-1)).toEqual({ volume: VOL, imageBytes: 90 * GiB, limitBytes: null, freeze: false });
    expect(t.pg.calls).toEqual([]);
    const v = t.m.serverView();
    expect(v.capped).toBe(false);
    expect(v.brake).toBe("off");
    expect(v.apps[0]).toMatchObject({ serviceId: "alice-notes", files: { usedBytes: 0, limitBytes: null, full: false } });
    expect(t.m.appView("alice-notes")?.postgres).toEqual({ usedBytes: 10 * MiB, limitBytes: null, full: false, writesBlocked: false, stopped: false });
  });

  it("holds each store to its budget and tells the owner once when one fills", async () => {
    const t = setup({ budgets: budget(100 * MiB, 0), app: { ...app, postgres: [] } });
    t.files.used.set(VOL, 100 * MiB);
    await t.m.kick();
    expect(t.files.calls.at(-1)).toMatchObject({ imageBytes: 100 * MiB, limitBytes: 100 * MiB, freeze: false });
    expect(t.full).toEqual([{ serviceId: "alice-notes", store: "files", usedBytes: 100 * MiB, limitBytes: 100 * MiB }]);
    await t.m.kick();
    expect(t.full).toHaveLength(1);
    expect(t.m.appView("alice-notes")?.files).toMatchObject({ full: true, enforced: true });
    t.files.used.set(VOL, 50 * MiB);
    await t.m.kick();
    expect(t.room.map((e) => e.store)).toEqual(["files"]);
    expect(t.m.serverView().capped).toBe(true);
  });

  it("blocks a database at its budget, re-blocks while over, and gives writes back below it", async () => {
    const t = setup({ budgets: budget(0, 50 * MiB), app: pgOnly });
    t.pg.size.set("app_aaaa", 50 * MiB);
    await t.m.kick();
    expect(t.pg.calls).toEqual(["block app_aaaa app_aaaa"]);
    expect(t.full.map((e) => e.store)).toEqual(["postgres"]);
    expect(t.m.appView("alice-notes")?.postgres).toMatchObject({ writesBlocked: true, stopped: false, full: true });
    expect(t.pg.vacuums).toBe(1);
    await t.m.kick();
    expect(t.pg.calls).toEqual(["block app_aaaa app_aaaa", "block app_aaaa app_aaaa"]);
    // The app deleted rows: Postgres can reuse the room, so writes come back.
    t.pg.free.set("app_aaaa", 10 * MiB);
    await t.m.kick();
    expect(t.pg.calls.at(-1)).toBe("unblock app_aaaa app_aaaa");
    expect(t.room.map((e) => e.store)).toEqual(["postgres"]);
    expect(t.m.appView("alice-notes")?.postgres?.writesBlocked).toBe(false);
  });

  it("stops a database that keeps growing while blocked, and lets it log in again once under", async () => {
    const t = setup({ budgets: budget(0, 50 * MiB), app: pgOnly });
    t.pg.size.set("app_aaaa", 50 * MiB);
    await t.m.kick();
    t.pg.size.set("app_aaaa", 50 * MiB + 65 * MiB);
    await t.m.kick();
    expect(t.pg.noLogin.has("app_aaaa")).toBe(true);
    expect(t.m.appView("alice-notes")?.postgres?.stopped).toBe(true);
    t.setBudgets(budget(0, 500 * MiB));
    await t.m.kick();
    expect(t.pg.noLogin.has("app_aaaa")).toBe(false);
    expect(t.pg.calls.slice(-2)).toEqual(["login app_aaaa", "unblock app_aaaa app_aaaa"]);
  });

  it("the disk brake freezes every folder and database once, and lifts under 88 %", async () => {
    const t = setup();
    t.setDisk({ totalBytes: 100 * GiB, availBytes: 9 * GiB });
    await t.m.kick();
    expect(t.brakes).toEqual(["off->on"]);
    expect(t.files.calls.at(-1)?.freeze).toBe(true);
    expect(t.pg.calls).toEqual(["block app_aaaa app_aaaa"]);
    expect(t.full).toEqual([]);
    expect(t.m.appView("alice-notes")?.files?.full).toBe(true);
    t.setDisk({ totalBytes: 100 * GiB, availBytes: 4 * GiB });
    await t.m.kick();
    expect(t.brakes).toEqual(["off->on", "on->hard"]);
    expect(t.files.readOnly.has(VOL)).toBe(true);
    t.setDisk({ totalBytes: 100 * GiB, availBytes: 20 * GiB });
    await t.m.kick();
    expect(t.brakes.at(-1)).toBe("hard->off");
    expect(t.files.readOnly.has(VOL)).toBe(false);
    expect(t.pg.calls.at(-1)).toBe("unblock app_aaaa app_aaaa");
    expect(t.full).toEqual([]);
  });

  it("holds staging copies to their own small limits", async () => {
    const t = setup();
    t.files.images.set("flagship-devfiles-alice--notes", 64 * MiB);
    t.devDbs.push("__dev_bbbb");
    t.pg.size.set("__dev_bbbb", DEV_PG_QUOTA_BYTES + MiB);
    await t.m.kick();
    expect(t.files.calls.find((c) => c.volume === "flagship-devfiles-alice--notes")).toMatchObject({
      imageBytes: DEV_FILES_QUOTA_BYTES,
      limitBytes: DEV_FILES_QUOTA_BYTES,
    });
    expect(t.pg.calls).toContain("block __dev_bbbb __dev_bbbb");
    expect(t.full).toEqual([]);
    // The staging copy is gone: its state goes with it.
    t.devDbs.length = 0;
    await t.m.kick();
    expect(t.pg.calls.filter((c) => c.includes("__dev_"))).toEqual(["block __dev_bbbb __dev_bbbb"]);
  });

  it("starts a new folder at its budget, the room left for an app not yet budgeted, or a staging quota", async () => {
    const t = setup({ budgets: budget(300 * MiB, 50 * MiB) });
    expect(await t.m.imageSizeFor(VOL)).toBe(300 * MiB);
    expect(await t.m.imageSizeFor("flagship-devfiles-alice--notes")).toBe(DEV_FILES_QUOTA_BYTES);
    t.m.setBudgets(() => new Map(), () => 700 * MiB);
    expect(await t.m.imageSizeFor(VOL)).toBe(700 * MiB);
    t.m.setBudgets(() => null);
    expect(await t.m.imageSizeFor(VOL)).toBe(90 * GiB);
    await t.m.prepareVolume(VOL);
    expect(t.files.prepared).toEqual([`${VOL}:${90 * GiB}`]);
  });

  it("keeps what it revoked across a restart, so a later tick gives it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-quota-"));
    const statePath = join(dir, "app-quota.json");
    const a = setup({ budgets: budget(0, 50 * MiB), statePath, app: pgOnly });
    a.pg.size.set("app_aaaa", 60 * MiB);
    await a.m.kick();
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.pg["alice-notes"].stage).toBe("blocked");
    expect(saved.full).toEqual(["alice-notes:postgres"]);

    const b = setup({ budgets: budget(0, 500 * MiB), statePath, app: pgOnly });
    await b.m.load();
    await b.m.kick();
    expect(b.pg.calls).toEqual(["unblock app_aaaa app_aaaa"]);
    expect(b.room.map((e) => e.store)).toEqual(["postgres"]);
  });

  it("gives an empty files folder at least a quarter of the app's room once both stores are measured", async () => {
    // The cap splits growth by what each store holds: 0 files next to a 10 MiB database gets nothing.
    const t = setup({ budgets: budget(0, 110 * MiB) });
    await t.m.kick();
    expect(t.files.calls.at(-1)?.limitBytes).toBe(0);
    await t.m.kick();
    expect(t.files.calls.at(-1)?.limitBytes).toBe(25 * MiB);
    expect(t.m.appView("alice-notes")?.postgres?.limitBytes).toBe(85 * MiB);
  });

  it("gives every app and staging role its connection and timeout limits once per boot", async () => {
    const t = setup();
    t.devDbs.push("__dev_bbbb");
    await t.m.kick();
    await t.m.kick();
    expect([...t.pg.limited].sort()).toEqual(["__dev_bbbb", "app_aaaa"]);
  });

  it("reports what it measured for the backup cap", async () => {
    const t = setup();
    t.files.used.set(VOL, 7 * MiB);
    await t.m.kick();
    expect(t.m.measured().get("alice-notes")).toEqual({ filesBytes: 7 * MiB, postgresBytes: 10 * MiB });
  });
});

describe("quota notices", () => {
  it("write Activity, alert the phone, and wake it at most once per interval", async () => {
    const notes: Array<{ kind: string; detail: string; ok?: boolean; target?: string }> = [];
    const alerts: unknown[] = [];
    let wakes = 0;
    let t = 0;
    const n = quotaNotices({
      note: (kind, detail, o) => notes.push({ kind, detail, ...o }),
      alert: (a) => alerts.push(a),
      wake: async () => wakes++,
      now: () => t,
    });
    n.onFull!({ serviceId: "alice-notes", store: "files", usedBytes: 2 * GiB, limitBytes: 2 * GiB });
    n.onFull!({ serviceId: "bob-chat", store: "postgres", usedBytes: 300 * MiB, limitBytes: null });
    expect(notes[0]).toEqual({
      kind: "app.storage.full",
      detail: "Its files folder is full (2.0 GB of 2.0 GB): it can't save more files until there's room.",
      ok: false,
      target: "alice-notes",
    });
    expect(notes[1]!.detail).toBe("Its database is full (300 MB): it can read and delete, but can't add or change data until there's room.");
    expect(alerts).toEqual([
      { kind: "app-storage-full", serviceId: "alice-notes", store: "files" },
      { kind: "app-storage-full", serviceId: "bob-chat", store: "postgres" },
    ]);
    expect(wakes).toBe(1);
    t = 11 * 60_000;
    n.onBrake!("on", "off");
    expect(wakes).toBe(2);
    expect(notes.at(-1)).toMatchObject({ kind: "server.disk.full", ok: false });
    n.onBrake!("off", "on");
    expect(notes.at(-1)?.kind).toBe("server.disk.room");
    n.onRoom!({ serviceId: "alice-notes", store: "files", usedBytes: 0, limitBytes: null });
    expect(notes.at(-1)).toEqual({ kind: "app.storage.room", detail: "Its files folder has room again.", target: "alice-notes" });
  });
});

import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onNoSpace, replaceWithReserve } from "../src/durableFile.js";
import { ManagementReserve, ResourceBudgets } from "../src/managementReserve.js";

afterEach(() => onNoSpace(null));

describe("management reserve", () => {
  it("is made of real blocks, only when there is room to spare, and given back on demand", async () => {
    const dir = await mkdtemp(join(tmpdir(), "res-"));
    let free = 1_000;
    const r = new ManagementReserve(dir, 2 * 1024 * 1024, async () => free);
    expect(await r.ensure()).toBe(false); // not enough room to keep twice its size free
    free = 100 * 1024 * 1024;
    expect(await r.ensure()).toBe(true);
    expect((await stat(r.file)).size).toBe(2 * 1024 * 1024);
    expect(await r.release()).toBe(true);
    expect(await r.present()).toBe(false);
    expect(await r.release()).toBe(false); // nothing left to give
    expect(await r.ensure()).toBe(true); // rebuilt once space returned
  });

  it("a security write that finds the disk full frees the reserve and lands; without one it fails honestly", async () => {
    const calls: string[] = [];
    let full = true;
    const once = async (p: string) => {
      calls.push(`write ${p}`);
      if (full) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    };
    onNoSpace(async () => { full = false; calls.push("released"); return true; });
    await replaceWithReserve("/x/revocations.json", "{}", 0o600, once);
    expect(calls).toEqual(["write /x/revocations.json", "released", "write /x/revocations.json"]);
    // no reserve left to give: the error is the error
    full = true;
    onNoSpace(async () => false);
    await expect(replaceWithReserve("/x/a", "{}", 0o600, once)).rejects.toMatchObject({ code: "ENOSPC" });
    // other errors are never retried
    onNoSpace(async () => true);
    await expect(replaceWithReserve("/x/b", "{}", 0o600, async () => { throw Object.assign(new Error("perm"), { code: "EACCES" }); })).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("resource budgets", () => {
  const specs = { "pending-alerts": { perService: 5, perHost: 8, windowMs: 60_000 } };

  it("a noisy service is refused on its own limit and the others carry on", () => {
    const b = new ResourceBudgets(specs);
    for (let i = 0; i < 5; i++) expect(b.charge("pending-alerts", "spammer")).toEqual({ ok: true });
    expect(b.charge("pending-alerts", "spammer")).toMatchObject({ ok: false, scope: "service" });
    expect(b.charge("pending-alerts", "quiet")).toEqual({ ok: true });
  });

  it("the host's share bounds everyone together, and says so", () => {
    const b = new ResourceBudgets(specs);
    for (let i = 0; i < 5; i++) b.charge("pending-alerts", "a");
    for (let i = 0; i < 3; i++) expect(b.charge("pending-alerts", "b")).toEqual({ ok: true });
    expect(b.charge("pending-alerts", "c")).toMatchObject({ ok: false, scope: "host" });
  });

  it("windows reset, and unmetered resources pass", () => {
    let t = 0;
    const b = new ResourceBudgets(specs, () => t);
    for (let i = 0; i < 5; i++) b.charge("pending-alerts", "a");
    expect(b.charge("pending-alerts", "a")).toMatchObject({ ok: false });
    t += 61_000;
    expect(b.charge("pending-alerts", "a")).toEqual({ ok: true });
    expect(b.charge("something-else", "a", 9999)).toEqual({ ok: true });
  });
});

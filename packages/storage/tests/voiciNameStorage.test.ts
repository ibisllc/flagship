import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import {
  D1VoiciLinkStorage,
  D1VoiciNameStorage,
  InMemoryVoiciLinkStorage,
  InMemoryVoiciNameStorage,
} from "../src/index.js";
import type { VoiciLinkStorage, VoiciNameRecord, VoiciNameStorage } from "../src/index.js";

// Parity: the same assertions against the D1 adapter (sqlite + every migration, so the
// names registry of 0127) and the in-memory store (docs/named-links.md,
// docs/voici-namespace-spec.md: a given-up link name is retired for good, D7).

const DAY = 86_400_000;
const rec = (key: string, username = "fresh-poppy", serviceId = "fresh-poppy--party", at = 1000): VoiciNameRecord => ({
  key, display: key, username, serviceId, state: "live", setAt: at, lastActiveAt: at, warned: 0,
});

function names(label: string, make: () => VoiciNameStorage, teardown?: () => void) {
  describe(label, () => {
    afterEach(() => teardown?.());

    it("claim() takes a free name and refuses it and its look-alikes, live or retired", async () => {
      const s = make();
      expect(await s.claim(rec("halloweenparty"))).toEqual({ ok: true });
      expect(await s.claim(rec("halloweenparty", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: false, reason: "taken" });
      expect(await s.claim(rec("halloween-party", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: false, reason: "taken" });
      expect(await s.claim(rec("ha1loweenparty", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: false, reason: "taken" });
      await s.release("fresh-poppy", "fresh-poppy--party", "cleared", 2000);
      expect(await s.claim(rec("halloweenparty", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: false, reason: "taken" });
      expect((await s.get("halloweenparty"))?.state).toBe("retired");
      expect(await s.get("halloween-party")).toBeUndefined();
    });

    it("release() retires a service's live name and says why", async () => {
      const s = make();
      await s.claim(rec("halloweenparty"));
      const r = await s.release("fresh-poppy", "fresh-poppy--party", "replaced", 5000);
      expect(r).toMatchObject({ key: "halloweenparty", state: "retired", releasedAt: 5000, releaseReason: "replaced" });
      expect(await s.getLiveByService("fresh-poppy", "fresh-poppy--party")).toBeUndefined();
      expect(await s.release("fresh-poppy", "fresh-poppy--party", "cleared", 6000)).toBeUndefined();
    });

    it("release() with a key frees that name only, while a replace briefly holds two", async () => {
      const s = make();
      await s.claim(rec("halloweenparty"));
      await s.claim(rec("springparty", "fresh-poppy", "fresh-poppy--party", 2000));
      const r = await s.release("fresh-poppy", "fresh-poppy--party", "replaced", 3000, "halloweenparty");
      expect(r).toMatchObject({ key: "halloweenparty", state: "retired" });
      expect((await s.getLiveByService("fresh-poppy", "fresh-poppy--party"))?.key).toBe("springparty");
      expect(await s.release("fresh-poppy", "fresh-poppy--other", "replaced", 3000, "springparty")).toBeUndefined();
    });

    it("a retired name blocks for good, the account that gave it up included (D7)", async () => {
      const s = make();
      await s.claim(rec("halloweenparty"));
      await s.release("fresh-poppy", "fresh-poppy--party", "cleared", 1000);
      expect(await s.claim(rec("halloweenparty", "fresh-poppy", "fresh-poppy--party", 1000 + 400 * DAY))).toEqual({ ok: false, reason: "taken" });
      expect((await s.get("halloweenparty"))?.state).toBe("retired");
    });

    it("countLive() and listLive() count live names only, per account", async () => {
      const s = make();
      await s.claim(rec("aaaa", "fresh-poppy", "fresh-poppy--a", 1));
      await s.claim(rec("bbbb", "fresh-poppy", "fresh-poppy--b", 2));
      await s.claim(rec("cccc", "rapid-bison", "rapid-bison--c", 3));
      await s.release("fresh-poppy", "fresh-poppy--a", "cleared", 10);
      expect(await s.countLive("fresh-poppy")).toBe(1);
      expect((await s.listLive("fresh-poppy")).map((r) => r.key)).toEqual(["bbbb"]);
      expect(await s.countAllLive()).toBe(2);
    });

    it("releaseAllForUser() retires every live name of a deleted account", async () => {
      const s = make();
      await s.claim(rec("aaaa", "fresh-poppy", "fresh-poppy--a"));
      await s.claim(rec("bbbb", "fresh-poppy", "fresh-poppy--b"));
      await s.claim(rec("cccc", "rapid-bison", "rapid-bison--c"));
      expect(await s.releaseAllForUser("fresh-poppy", "deleted", 50)).toBe(2);
      expect((await s.get("aaaa"))?.releaseReason).toBe("deleted");
      expect((await s.get("cccc"))?.state).toBe("live");
    });

    it("listLivePage() pages live names in key order", async () => {
      const s = make();
      for (const k of ["dddd", "aaaa", "cccc", "bbbb"]) await s.claim(rec(k, "fresh-poppy", `fresh-poppy--${k}`));
      expect((await s.listLivePage(0, 2)).map((r) => r.key)).toEqual(["aaaa", "bbbb"]);
      expect((await s.listLivePage(2, 5)).map((r) => r.key)).toEqual(["cccc", "dddd"]);
    });

    it("markActive() resets the warnings; setWarned() records them", async () => {
      const s = make();
      await s.claim(rec("aaaa"));
      await s.setWarned("aaaa", 2);
      expect((await s.get("aaaa"))?.warned).toBe(2);
      await s.markActive("aaaa", 9000);
      expect(await s.get("aaaa")).toMatchObject({ lastActiveAt: 9000, warned: 0 });
    });

    it("changes are counted per service and per account, and pruned", async () => {
      const s = make();
      await s.recordChange("fresh-poppy", "fresh-poppy--a", 100, "n1");
      await s.recordChange("fresh-poppy", "fresh-poppy--a", 200, "n2");
      await s.recordChange("fresh-poppy", "fresh-poppy--b", 300, "n3");
      await s.recordChange("rapid-bison", "rapid-bison--a", 300, "n4");
      expect(await s.nonceUsed("n4")).toBe(true);
      expect(await s.nonceUsed("zz")).toBe(false);
      expect(await s.changesForService("fresh-poppy", "fresh-poppy--a", 150)).toEqual([200]);
      expect(await s.changesForService("fresh-poppy", "fresh-poppy--a", 0)).toEqual([100, 200]);
      expect(await s.countChangesForUser("fresh-poppy", 0)).toBe(3);
      expect(await s.pruneChanges(250)).toBe(2);
      expect(await s.countChangesForUser("fresh-poppy", 0)).toBe(1);
    });
  });
}

function links(label: string, make: () => VoiciLinkStorage, teardown?: () => void) {
  describe(label, () => {
    afterEach(() => teardown?.());
    const row = (code: string, serviceId = "fresh-poppy--party") => ({
      code, username: "fresh-poppy", serviceId, targetUrl: "https://party.fresh-poppy.flagship.services", createdAt: 1,
    });

    it("retireByService() keeps the code (it answers 410, never re-minted) and hides it from getByService", async () => {
      const s = make();
      await s.insert(row("k3x9qa"));
      expect(await s.retireByService("fresh-poppy", "fresh-poppy--party", 500)).toBe(1);
      expect(await s.get("k3x9qa")).toMatchObject({ code: "k3x9qa", retiredAt: 500 });
      expect(await s.getByService("fresh-poppy", "fresh-poppy--party")).toBeUndefined();
      expect(await s.insert(row("k3x9qa"))).toEqual({ ok: false, reason: "code already taken" });
      expect(await s.retireByService("fresh-poppy", "fresh-poppy--party", 600)).toBe(0);
    });

    it("retireAllForUser() retires every service-bound code of the account and no one else's", async () => {
      const s = make();
      await s.insert(row("aaaaaa", "fresh-poppy--a"));
      await s.insert(row("bbbbbb", "fresh-poppy--b"));
      await s.insert({ ...row("cccccc", "rapid-bison--c"), username: "rapid-bison" });
      expect(await s.retireAllForUser("fresh-poppy", 700)).toBe(2);
      expect((await s.get("aaaaaa"))?.retiredAt).toBe(700);
      expect((await s.get("cccccc"))?.retiredAt).toBeUndefined();
    });
  });
}

names("InMemoryVoiciNameStorage", () => new InMemoryVoiciNameStorage());
links("InMemoryVoiciLinkStorage retire", () => new InMemoryVoiciLinkStorage());

let db: SqliteD1 | undefined;
const closeDb = () => {
  db?.close();
  db = undefined;
};
names("D1VoiciNameStorage", () => { db = createSqliteD1(); return new D1VoiciNameStorage(db); }, closeDb);
links("D1VoiciLinkStorage retire", () => { db = createSqliteD1(); return new D1VoiciLinkStorage(db); }, closeDb);

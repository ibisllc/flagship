import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import {
  D1VoiciLinkStorage,
  D1VoiciNameStorage,
  InMemoryVoiciLinkStorage,
  InMemoryVoiciNameStorage,
} from "../src/index.js";
import type { VoiciLinkStorage, VoiciNameRecord, VoiciNameStorage } from "../src/index.js";

// Parity: the same assertions against the D1 adapter (sqlite + migration 0107)
// and the in-memory store (docs/named-links.md).

const DAY = 86_400_000;
const rec = (key: string, username = "fresh-poppy", serviceId = "fresh-poppy--party", at = 1000): VoiciNameRecord => ({
  key, display: key, username, serviceId, state: "live", setAt: at, lastActiveAt: at, warned: 0,
});

function names(label: string, make: () => VoiciNameStorage, teardown?: () => void) {
  describe(label, () => {
    afterEach(() => teardown?.());

    it("claim() takes a free key and refuses a held one, live or waiting", async () => {
      const s = make();
      expect(await s.claim(rec("halloweenparty"))).toEqual({ ok: true });
      expect(await s.claim(rec("halloweenparty", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: false, reason: "taken" });
      await s.release("fresh-poppy", "fresh-poppy--party", "cleared", 2000);
      expect(await s.claim(rec("halloweenparty", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: false, reason: "taken" });
      expect((await s.get("halloweenparty"))?.state).toBe("waiting");
    });

    it("release() moves a service's live name into its wait and says why", async () => {
      const s = make();
      await s.claim(rec("halloweenparty"));
      const r = await s.release("fresh-poppy", "fresh-poppy--party", "replaced", 5000);
      expect(r).toMatchObject({ key: "halloweenparty", state: "waiting", releasedAt: 5000, releaseReason: "replaced" });
      expect(await s.getLiveByService("fresh-poppy", "fresh-poppy--party")).toBeUndefined();
      expect(await s.release("fresh-poppy", "fresh-poppy--party", "cleared", 6000)).toBeUndefined();
    });

    it("deleteWaitingReleasedBefore() frees a name only once its wait is over", async () => {
      const s = make();
      await s.claim(rec("halloweenparty"));
      await s.release("fresh-poppy", "fresh-poppy--party", "cleared", 1000);
      expect(await s.deleteWaitingReleasedBefore(999)).toBe(0);
      expect(await s.get("halloweenparty")).toBeDefined();
      expect(await s.deleteWaitingReleasedBefore(1000 + 30 * DAY)).toBe(1);
      expect(await s.get("halloweenparty")).toBeUndefined();
      expect(await s.claim(rec("halloweenparty", "rapid-bison", "rapid-bison--x"))).toEqual({ ok: true });
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

    it("releaseAllForUser() puts every live name of a deleted account into its wait", async () => {
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
      await s.recordChange("fresh-poppy", "fresh-poppy--a", 100);
      await s.recordChange("fresh-poppy", "fresh-poppy--a", 200);
      await s.recordChange("fresh-poppy", "fresh-poppy--b", 300);
      await s.recordChange("rapid-bison", "rapid-bison--a", 300);
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

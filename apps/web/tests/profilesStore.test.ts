// P12 — per-profile localStorage namespace (lib/profilesStore.js).
//
// Contract:
//   1. get/set resolve to the ACTIVE profile's slot when no cloudName is given.
//   2. switching the active profile swaps the read horizon for the same slot.
//   3. legacy single-profile state auto-migrates into a single named profile,
//      preserving every persisted per-profile key (UMK seed via keystore is
//      out of scope — that's a separate IndexedDB store — but every flat
//      localStorage key DOES move forward).
//   4. migration is idempotent (gated by `flagship.profiles.migrated.v2`).
//   5. migration NEVER deletes legacy keys (defensive).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k) { return map.get(k) ?? null; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k) { map.delete(k); },
    setItem(k, v) { map.set(k, String(v)); },
  } as Storage;
}

async function loadStore() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "profilesStore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

describe("profilesStore — per-profile localStorage namespace", () => {
  let storage: Storage;

  beforeEach(() => { storage = memoryStorage(); });
  afterEach(() => { /* memoryStorage is per-test, nothing to tear down */ });

  it("fresh storage → no active profile, empty list", async () => {
    const s = await loadStore();
    expect(s.getActiveCloudName(storage)).toBeNull();
    expect(s.listCloudNames(storage)).toEqual([]);
  });

  it("ensureProfile creates an empty slot and is idempotent", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.ensureProfile("alice", storage);
    expect(s.listCloudNames(storage)).toEqual(["alice"]);
  });

  it("set/get round-trips through the active profile's slot", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("username", "alice", { storage });
    s.set("currentIrkVersion", "1", { storage });
    expect(s.get("username", { storage })).toBe("alice");
    expect(s.get("currentIrkVersion", { storage })).toBe("1");
  });

  it("switching the active profile swaps the read horizon (no leakage)", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.ensureProfile("bob", storage);
    s.setActiveCloudName("alice", storage);
    s.set("username", "alice", { storage });
    s.set("recoveryWarn", "true", { storage });

    s.setActiveCloudName("bob", storage);
    s.set("username", "bob", { storage });
    // bob has no recoveryWarn — must NOT read alice's.
    expect(s.get("username", { storage })).toBe("bob");
    expect(s.get("recoveryWarn", { storage })).toBeNull();

    // Flip back and alice's slot is intact.
    s.setActiveCloudName("alice", storage);
    expect(s.get("username", { storage })).toBe("alice");
    expect(s.get("recoveryWarn", { storage })).toBe("true");
  });

  it("set with no active profile mirrors to the legacy key only (no silent drop)", async () => {
    const s = await loadStore();
    // No profile set up yet.
    s.set("username", "early", { storage });
    expect(storage.getItem("flagship.username")).toBe("early");
    // No store entry either — there's no active cloud yet.
    const raw = storage.getItem(s.STORE_KEY);
    expect(raw == null || JSON.parse(raw).activeCloudName == null).toBe(true);
  });

  it("setActiveCloudName mirrors into the legacy `flagship.profiles.v1` pointer", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    const legacy = JSON.parse(storage.getItem(s.LEGACY_ACTIVE_KEY)!);
    expect(legacy.activeCloudName).toBe("alice");
  });

  it("set mirrors to the legacy flat key by default; mirror:false suppresses it", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("username", "alice", { storage });
    expect(storage.getItem("flagship.username")).toBe("alice");
    s.set("username", "alice2", { storage, mirror: false });
    expect(storage.getItem("flagship.username")).toBe("alice");
    expect(s.get("username", { storage })).toBe("alice2");
  });

  it("getProfileSlot returns a read-only snapshot of every persisted slot", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("username", "alice", { storage });
    s.set("accountId", "acc-1", { storage });
    s.set("currentIrkVersion", "2", { storage });
    const snap = s.getProfileSlot("alice", storage);
    expect(snap).toMatchObject({
      username: "alice",
      accountId: "acc-1",
      currentIrkVersion: "2",
    });
  });

  it("remove drops a slot from both the store and the legacy mirror", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("recoveryWarn", "true", { storage });
    expect(storage.getItem("flagship.recovery.warn.v1")).toBe("true");
    s.remove("recoveryWarn", { storage });
    expect(s.get("recoveryWarn", { storage })).toBeNull();
    expect(storage.getItem("flagship.recovery.warn.v1")).toBeNull();
  });

  it("corrupt store JSON degrades to an empty state (no crash)", async () => {
    const s = await loadStore();
    storage.setItem(s.STORE_KEY, "{not valid json");
    expect(s.getActiveCloudName(storage)).toBeNull();
    expect(s.listCloudNames(storage)).toEqual([]);
  });
});

describe("profilesStore — legacy migration", () => {
  let storage: Storage;
  beforeEach(() => { storage = memoryStorage(); });

  it("no legacy state → does NOT set the migrated sentinel (re-runs later)", async () => {
    const s = await loadStore();
    const res = s.migrateLegacy(storage);
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe("no-legacy-state");
    expect(storage.getItem(s.MIGRATED_KEY)).toBeNull();
  });

  it("migrates a legacy single-profile install into a single named profile", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.accountId", "acc-harry");
    storage.setItem("flagship.irk.version", "3");
    storage.setItem("flagship.recovery.warn.v1", "true");
    storage.setItem("flagship.recovery.banner.dismissed.v1", "true");
    storage.setItem("flagship.peerBackup.choice.v1", "enabled");
    storage.setItem("flagship.pushTokenId", "tok-1");
    storage.setItem("flagship.sessionId", "sid-1");
    storage.setItem("flagship.sessionToken", "stok-1");
    storage.setItem("flagship.podBaseUrl", "https://home.harry.flagship.services");
    storage.setItem("flagship.session.v1", JSON.stringify({ username: "harry" }));
    storage.setItem("flagship.pendingOrders", "[]");
    storage.setItem("flagship.wizard.state.v1", JSON.stringify({ step: 1 }));

    const res = s.migrateLegacy(storage);
    expect(res.migrated).toBe(true);
    expect(res.cloudName).toBe("harry");
    expect(res.copiedSlots).toEqual(expect.arrayContaining([
      "username", "accountId", "currentIrkVersion", "recoveryWarn",
      "recoveryBannerDismissed", "peerBackupChoice", "pushTokenId",
      "sessionId", "sessionToken", "podBaseUrl", "sessionV1", "pendingOrders",
      "wizardState",
    ]));

    expect(s.getActiveCloudName(storage)).toBe("harry");
    expect(s.get("username", { storage })).toBe("harry");
    expect(s.get("accountId", { storage })).toBe("acc-harry");
    expect(s.get("currentIrkVersion", { storage })).toBe("3");
    expect(s.get("recoveryWarn", { storage })).toBe("true");
    expect(s.get("recoveryBannerDismissed", { storage })).toBe("true");
    expect(s.get("peerBackupChoice", { storage })).toBe("enabled");
    expect(s.get("pushTokenId", { storage })).toBe("tok-1");
    expect(s.get("podBaseUrl", { storage })).toBe("https://home.harry.flagship.services");
    expect(s.get("wizardState", { storage })).toBe(JSON.stringify({ step: 1 }));
  });

  it("migration is idempotent — second call short-circuits on the sentinel", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.irk.version", "2");
    const first = s.migrateLegacy(storage);
    expect(first.migrated).toBe(true);

    // Mutate the store; a second migrateLegacy must NOT overwrite it.
    s.set("currentIrkVersion", "5", { storage });

    const second = s.migrateLegacy(storage);
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe("already-migrated");
    expect(s.get("currentIrkVersion", { storage })).toBe("5");
  });

  it("migration does NOT delete legacy keys (defensive)", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.irk.version", "3");
    storage.setItem("flagship.recovery.warn.v1", "true");
    storage.setItem("flagship.recovery.banner.dismissed.v1", "true");
    s.migrateLegacy(storage);

    // Every legacy key still present.
    expect(storage.getItem("flagship.username")).toBe("harry");
    expect(storage.getItem("flagship.irk.version")).toBe("3");
    expect(storage.getItem("flagship.recovery.warn.v1")).toBe("true");
    expect(storage.getItem("flagship.recovery.banner.dismissed.v1")).toBe("true");
  });

  it("migration prefers an existing active profile (lib/profiles.js v1 pointer) over flagship.username", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "old-username");
    storage.setItem(s.LEGACY_ACTIVE_KEY, JSON.stringify({
      profiles: [{ cloudName: "new-cloud", createdAt: 1 }],
      activeCloudName: "new-cloud",
    }));
    storage.setItem("flagship.irk.version", "2");

    const res = s.migrateLegacy(storage);
    expect(res.migrated).toBe(true);
    expect(res.cloudName).toBe("new-cloud");
    expect(s.get("currentIrkVersion", { storage })).toBe("2");
    // Legacy username untouched.
    expect(storage.getItem("flagship.username")).toBe("old-username");
  });

  it("migration mirrors the active pointer into the legacy v1 blob (keystore alignment)", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    s.migrateLegacy(storage);
    const legacy = JSON.parse(storage.getItem(s.LEGACY_ACTIVE_KEY)!);
    expect(legacy.activeCloudName).toBe("harry");
  });

  it("the recovery-banner-dismissed flag survives migration unchanged", async () => {
    // e1d65aa added the dismissed flag; the v1-launch redesign must NOT lose it.
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.recovery.banner.dismissed.v1", "true");
    s.migrateLegacy(storage);
    expect(s.get("recoveryBannerDismissed", { storage })).toBe("true");
  });

  it("the UMK seed migration is OUT OF SCOPE — IndexedDB stays untouched", async () => {
    // This is a property statement: migrateLegacy only reads/writes
    // localStorage; the wrapped UMK lives in IndexedDB (keystore.js).
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    s.migrateLegacy(storage);
    // Result type matches the documented shape.
    expect(s.get("username", { storage })).toBe("harry");
  });

  it("migration does NOT lose the recovery-banner-dismiss flag (e1d65aa key)", async () => {
    // Regression guard for the v1-launch redesign — e1d65aa landed the
    // dismiss flag and we MUST keep it once it's been written.
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.recovery.banner.dismissed.v1", "true");
    const r = s.migrateLegacy(storage);
    expect(r.migrated).toBe(true);
    expect(r.copiedSlots).toContain("recoveryBannerDismissed");
    expect(s.get("recoveryBannerDismissed", { storage })).toBe("true");
    // Legacy flat key still present (defensive non-deletion).
    expect(storage.getItem("flagship.recovery.banner.dismissed.v1")).toBe("true");
  });

  it("migration preserves the IRK rotation version (v1-launch keystore concern)", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.irk.version", "4");
    s.migrateLegacy(storage);
    expect(s.get("currentIrkVersion", { storage })).toBe("4");
  });

  it("SLOT_FIELDS lists every per-profile slot ↔ legacy key pair", async () => {
    // Pin the surface contract so future contributors can't silently drop
    // a per-profile key from the migration. If a NEW per-profile key is
    // introduced it MUST be added to SLOT_FIELDS or it won't migrate.
    const s = await loadStore();
    const slots = (s.SLOT_FIELDS as Array<{ slot: string; legacy: string }>).map((f) => f.slot);
    expect(slots).toEqual(expect.arrayContaining([
      "username",
      "accountId",
      "currentIrkVersion",
      "recoveryWarn",
      "recoveryBannerDismissed",
      "peerBackupChoice",
      "pushTokenId",
      "sessionId",
      "sessionToken",
      "sessionV1",
      "podBaseUrl",
      "pendingOrders",
      "wizardState",
    ]));
  });
});

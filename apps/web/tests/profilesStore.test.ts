// P12 — per-profile localStorage namespace (lib/profilesStore.js).
//
// Contract (post hard cut-over):
//   1. get/set resolve to the ACTIVE profile's slot when no cloudName is given.
//   2. switching the active profile swaps the read horizon for the same slot.
//   3. legacy single-profile state auto-migrates into a single named profile,
//      preserving every persisted per-profile key (UMK seed via keystore is
//      out of scope — that's a separate IndexedDB store — but every flat
//      localStorage key DOES move forward).
//   4. migration is idempotent (gated by `flagship.profiles.migrated.v2`).
//   5. migration NEVER deletes legacy keys (defensive).
//   6. `set(...)` by DEFAULT does NOT write the legacy flat key. The mirror
//      lived behind a flag during the original P12 migration; this follow-up
//      drops the mirror after refactoring every call-site to read through
//      the store. Slots marked `deviceWideOrPreProfile` (username,
//      wizardState, currentIrkVersion) STILL write the legacy flat key
//      because they're addressed by callers that legitimately run before
//      a profile is active.
//   7. `cleanupLegacyKeys(...)` sweeps legacy flat keys that have been
//      superseded by the per-profile store. Idempotent + defensive: only
//      removes a key when the new store ALREADY has a value for the slot
//      AND the migration sentinel is set.

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

  it("set with no active profile mirrors to the legacy key only for device-wide-or-pre-profile slots", async () => {
    const s = await loadStore();
    // `username` is marked device-wide-or-pre-profile, so a no-active-profile
    // write goes to the legacy flat key (so the bootstrap flow doesn't drop it).
    s.set("username", "early", { storage });
    expect(storage.getItem("flagship.username")).toBe("early");
    // A non-device-wide slot with no active profile is a no-op — there's no
    // profile to hold it and we don't want to silently fall back to the legacy
    // flat key (that's the whole point of the hard cut-over).
    s.set("recoveryWarn", "true", { storage });
    expect(storage.getItem("flagship.recovery.warn.v1")).toBeNull();
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

  it("post hard cut-over: set DOES write the legacy flat key for device-wide slots (username)", async () => {
    // `username` is marked deviceWideOrPreProfile because the keystore +
    // bootstrap flows still address it pre-profile. Confirms the carve-out.
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("username", "alice", { storage });
    expect(storage.getItem("flagship.username")).toBe("alice");
    s.set("username", "alice2", { storage });
    expect(storage.getItem("flagship.username")).toBe("alice2");
    expect(s.get("username", { storage })).toBe("alice2");
    expect(s.isDeviceWideOrPreProfile("username")).toBe(true);
  });

  it("post hard cut-over: set does NOT write the legacy flat key for normal per-profile slots", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("recoveryWarn", "true", { storage });
    // The new store has it…
    expect(s.get("recoveryWarn", { storage })).toBe("true");
    // …but the legacy flat key is NOT written.
    expect(storage.getItem("flagship.recovery.warn.v1")).toBeNull();
    expect(s.isDeviceWideOrPreProfile("recoveryWarn")).toBe(false);
  });

  it("post hard cut-over: explicit mirror:true still writes the legacy flat key (escape hatch)", async () => {
    // Kept so a future caller that genuinely needs the legacy mirror can
    // opt in — without it, this would have to reach into localStorage by hand.
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("recoveryWarn", "true", { storage, mirror: true });
    expect(storage.getItem("flagship.recovery.warn.v1")).toBe("true");
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

  it("remove drops a slot from the store (legacy flat key is irrelevant for non-device-wide slots)", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("recoveryWarn", "true", { storage });
    // Post-cut-over there's no legacy mirror to assert here for non-device-wide
    // slots — the assertion is just "the new store has the value".
    expect(s.get("recoveryWarn", { storage })).toBe("true");
    s.remove("recoveryWarn", { storage });
    expect(s.get("recoveryWarn", { storage })).toBeNull();
  });

  it("remove on a device-wide slot also removes the legacy flat key", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("username", "alice", { storage });
    expect(storage.getItem("flagship.username")).toBe("alice");
    s.remove("username", { storage });
    expect(s.get("username", { storage })).toBeNull();
    expect(storage.getItem("flagship.username")).toBeNull();
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

describe("profilesStore — P12 hard cut-over (drop the legacy mirror)", () => {
  let storage: Storage;
  beforeEach(() => { storage = memoryStorage(); });

  it("default set(...) does not write the legacy flat key for normal per-profile slots", async () => {
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    for (const slot of ["accountId", "recoveryWarn", "recoveryBannerDismissed",
                        "peerBackupChoice", "pushTokenId", "sessionId",
                        "sessionToken", "sessionV1", "podBaseUrl",
                        "pendingOrders"]) {
      s.set(slot, "v", { storage });
    }
    // None of the corresponding flat keys exist post-write.
    for (const { slot, legacy, deviceWideOrPreProfile } of s.SLOT_FIELDS as Array<{
      slot: string; legacy: string; deviceWideOrPreProfile?: boolean;
    }>) {
      if (deviceWideOrPreProfile) continue;
      expect(
        storage.getItem(legacy),
        `legacy key ${legacy} for slot ${slot} should not be written by default`,
      ).toBeNull();
    }
  });

  it("pre-profile call-sites still work — device-wide slots write the flat key with no active profile", async () => {
    const s = await loadStore();
    // No profile active yet.
    s.set("username", "early", { storage });
    s.set("wizardState", JSON.stringify({ stepIdx: 0 }), { storage });
    expect(storage.getItem("flagship.username")).toBe("early");
    expect(storage.getItem("flagship.wizard.state.v1")).toBe(JSON.stringify({ stepIdx: 0 }));
  });

  it("device-wide get(...) falls back to the legacy flat key once a profile IS active", async () => {
    // Wizard state written pre-profile must still be readable post-profile.
    const s = await loadStore();
    s.set("wizardState", JSON.stringify({ stepIdx: 2 }), { storage });
    // Now a profile is opened, the wizardState is still observable.
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    expect(s.get("wizardState", { storage })).toBe(JSON.stringify({ stepIdx: 2 }));
  });

  it("non-device-wide get(...) does NOT silently fall back to legacy under an active profile", async () => {
    // Anti-pattern guard: after migration to a profile, reading a missing
    // slot must NOT return a stale legacy value (it'd cross-contaminate
    // between profiles).
    const s = await loadStore();
    // Plant a legacy value as if pre-migration.
    storage.setItem("flagship.recovery.warn.v1", "true");
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    expect(s.get("recoveryWarn", { storage })).toBeNull();
  });

  it("classifies the device-wide-or-pre-profile slots correctly", async () => {
    const s = await loadStore();
    // Documented carve-outs.
    expect(s.isDeviceWideOrPreProfile("username")).toBe(true);
    expect(s.isDeviceWideOrPreProfile("wizardState")).toBe(true);
    expect(s.isDeviceWideOrPreProfile("currentIrkVersion")).toBe(true);
    // Per-profile slots must NOT be marked.
    expect(s.isDeviceWideOrPreProfile("recoveryWarn")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("recoveryBannerDismissed")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("peerBackupChoice")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("pushTokenId")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("sessionId")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("sessionToken")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("sessionV1")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("podBaseUrl")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("pendingOrders")).toBe(false);
    expect(s.isDeviceWideOrPreProfile("accountId")).toBe(false);
  });
});

describe("profilesStore — cleanupLegacyKeys() sweep", () => {
  let storage: Storage;
  beforeEach(() => { storage = memoryStorage(); });

  it("is a no-op before the migration sentinel is set", async () => {
    const s = await loadStore();
    // Plant a legacy key. Cleanup must NOT touch it without the sentinel.
    storage.setItem("flagship.recovery.warn.v1", "true");
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    const r = s.cleanupLegacyKeys({ storage });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("not-migrated");
    expect(storage.getItem("flagship.recovery.warn.v1")).toBe("true");
  });

  it("is a no-op when no profile is active (even if migrated)", async () => {
    const s = await loadStore();
    storage.setItem(s.MIGRATED_KEY, "1");
    const r = s.cleanupLegacyKeys({ storage });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("no-active-profile");
  });

  it("sweeps legacy flat keys only when the new store has the slot populated", async () => {
    // Upgrade-shape: legacy flat keys + migration sentinel + new-store value.
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.recovery.warn.v1", "true");
    storage.setItem("flagship.pushTokenId", "tok-1");
    storage.setItem("flagship.sessionId", "sid-1");
    s.migrateLegacy(storage);

    // Sanity: migration copied the values forward.
    expect(s.get("username", { storage })).toBe("harry");
    expect(s.get("recoveryWarn", { storage })).toBe("true");
    expect(s.get("pushTokenId", { storage })).toBe("tok-1");
    expect(s.get("sessionId", { storage })).toBe("sid-1");

    const r = s.cleanupLegacyKeys({ storage });
    expect(r.ran).toBe(true);
    // Non-device-wide legacy keys are removed.
    expect(storage.getItem("flagship.recovery.warn.v1")).toBeNull();
    expect(storage.getItem("flagship.pushTokenId")).toBeNull();
    expect(storage.getItem("flagship.sessionId")).toBeNull();
    // Device-wide legacy keys are LEFT IN PLACE (keystore + bootstrap reads).
    expect(storage.getItem("flagship.username")).toBe("harry");
    expect(r.removed).toEqual(expect.arrayContaining([
      "recoveryWarn", "pushTokenId", "sessionId",
    ]));
    expect(r.removed).not.toContain("username");
  });

  it("is idempotent — does NOT destroy slots that only exist in the legacy key", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    s.migrateLegacy(storage);

    // Plant a legacy value for a slot the new store does NOT yet hold.
    // This would happen if a v2-shape user wrote a new legacy-flat-key
    // value via a stale code path. We must NOT delete it on cleanup —
    // doing so would silently drop the only copy of the value.
    storage.setItem("flagship.recovery.warn.v1", "true");
    // (note: the active profile is now "harry" but its recoveryWarn slot
    // was never touched, so the new store has no value for it.)

    const r = s.cleanupLegacyKeys({ storage });
    expect(r.ran).toBe(true);
    expect(r.removed).not.toContain("recoveryWarn");
    expect(storage.getItem("flagship.recovery.warn.v1")).toBe("true");
  });

  it("is idempotent on the happy path — a second sweep is a no-op", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.recovery.warn.v1", "true");
    s.migrateLegacy(storage);
    const first = s.cleanupLegacyKeys({ storage });
    expect(first.ran).toBe(true);
    const second = s.cleanupLegacyKeys({ storage });
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already-cleaned");
    expect(second.removed).toEqual([]);
  });

  it("does NOT sweep device-wide-or-pre-profile slots (wizardState, username, currentIrkVersion)", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.wizard.state.v1", JSON.stringify({ stepIdx: 0 }));
    storage.setItem("flagship.irk.version", "3");
    s.migrateLegacy(storage);
    s.cleanupLegacyKeys({ storage });
    // All three flat keys MUST still exist.
    expect(storage.getItem("flagship.username")).toBe("harry");
    expect(storage.getItem("flagship.wizard.state.v1")).toBe(JSON.stringify({ stepIdx: 0 }));
    expect(storage.getItem("flagship.irk.version")).toBe("3");
  });

  it("fresh-install user (no legacy keys) flows through set→get with zero legacy interaction", async () => {
    const s = await loadStore();
    // No pre-existing flat keys. No migration. Build the world the new way.
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.set("recoveryWarn", "true", { storage });
    s.set("pushTokenId", "tok-fresh", { storage });
    expect(s.get("recoveryWarn", { storage })).toBe("true");
    expect(s.get("pushTokenId", { storage })).toBe("tok-fresh");
    // None of the corresponding flat keys exist.
    expect(storage.getItem("flagship.recovery.warn.v1")).toBeNull();
    expect(storage.getItem("flagship.pushTokenId")).toBeNull();
    // Cleanup is a no-op (no migration ran).
    const r = s.cleanupLegacyKeys({ storage });
    expect(r.ran).toBe(false);
  });

  it("upgrade user (legacy keys + migrated sentinel) gets legacy keys cleaned on first call", async () => {
    const s = await loadStore();
    // Pre-migration state.
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.accountId", "acc-h");
    storage.setItem("flagship.recovery.warn.v1", "true");
    storage.setItem("flagship.peerBackup.choice.v1", "enabled");
    storage.setItem("flagship.podBaseUrl", "https://home.harry.flagship.services");

    s.migrateLegacy(storage);
    // The migration left the legacy keys in place by design (defensive).
    expect(storage.getItem("flagship.recovery.warn.v1")).toBe("true");

    // Now the hard cut-over sweep.
    const r = s.cleanupLegacyKeys({ storage });
    expect(r.ran).toBe(true);

    // Per-profile flat keys are gone…
    expect(storage.getItem("flagship.recovery.warn.v1")).toBeNull();
    expect(storage.getItem("flagship.peerBackup.choice.v1")).toBeNull();
    expect(storage.getItem("flagship.podBaseUrl")).toBeNull();
    expect(storage.getItem("flagship.accountId")).toBeNull();
    // …device-wide flat keys stay.
    expect(storage.getItem("flagship.username")).toBe("harry");

    // The new store still has every value.
    expect(s.get("recoveryWarn", { storage })).toBe("true");
    expect(s.get("peerBackupChoice", { storage })).toBe("enabled");
    expect(s.get("podBaseUrl", { storage })).toBe("https://home.harry.flagship.services");
    expect(s.get("accountId", { storage })).toBe("acc-h");
  });

  it("resetMigrationSentinelForTests clears the cleanup stamp too", async () => {
    const s = await loadStore();
    storage.setItem("flagship.username", "harry");
    storage.setItem("flagship.recovery.warn.v1", "true");
    s.migrateLegacy(storage);
    s.cleanupLegacyKeys({ storage });
    expect(storage.getItem(s.LEGACY_CLEANUP_KEY)).toBe("harry");
    s._resetMigrationSentinelForTests(storage);
    expect(storage.getItem(s.LEGACY_CLEANUP_KEY)).toBeNull();
  });
});

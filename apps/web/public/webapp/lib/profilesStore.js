// P12 — per-profile localStorage namespace.
//
// The webapp owns multiple clouds per browser (personal + family + work — see
// lib/profiles.js). Until now every per-user piece of state was stored under a
// flat key (`flagship.username`, `flagship.irk.version`, `flagship.recovery.
// warn.v1`, …). Adding a second cloud would clobber the first.
//
// profilesStore owns the per-profile slot of those keys under a single
// top-level localStorage record `flagship.profiles.v2`:
//
//   {
//     activeCloudName: string|null,
//     profiles: {
//       [cloudName]: {
//         username, accountId,
//         currentIrkVersion,
//         recoveryWarn, recoveryBannerDismissed,
//         peerBackupChoice,
//         pushTokenId,
//         sessionId, sessionToken, sessionV1,
//         podBaseUrl,
//         pendingOrders,
//         wizardState,
//         createdAt
//       }
//     }
//   }
//
// Active profile mirrors lib/profiles.js's `flagship.profiles.v1` so the
// keystore (which already keys IDB rows by activeCloudName) keeps reading
// the same source-of-truth pointer. Switching the active profile here flips
// BOTH records so legacy callsites and the new store stay in lockstep.
//
// Backward-compat migration runs once on boot — see {@link migrateLegacy}.
// Legacy top-level keys are NEVER deleted by the migration; we copy values
// into the new store and leave the originals in place so any not-yet-
// migrated callsite (or external recovery flow) keeps working. A
// `flagship.profiles.migrated.v2` sentinel guards re-runs.

export const STORE_KEY = "flagship.profiles.v2";
export const MIGRATED_KEY = "flagship.profiles.migrated.v2";
export const LEGACY_ACTIVE_KEY = "flagship.profiles.v1";

/** Every per-profile slot field, paired with its legacy flat localStorage
 *  key. The migration walks this list to copy legacy values into the new
 *  store; the per-key read/write helpers ({@link get}, {@link set}) optionally
 *  mirror back to the legacy key so callsites we haven't refactored yet keep
 *  working. Order is stable; do not reorder without testing migration. */
export const SLOT_FIELDS = Object.freeze([
  { slot: "username",                legacy: "flagship.username" },
  { slot: "accountId",               legacy: "flagship.accountId" },
  { slot: "currentIrkVersion",       legacy: "flagship.irk.version" },
  { slot: "recoveryWarn",            legacy: "flagship.recovery.warn.v1" },
  { slot: "recoveryBannerDismissed", legacy: "flagship.recovery.banner.dismissed.v1" },
  { slot: "peerBackupChoice",        legacy: "flagship.peerBackup.choice.v1" },
  { slot: "pushTokenId",             legacy: "flagship.pushTokenId" },
  { slot: "sessionId",               legacy: "flagship.sessionId" },
  { slot: "sessionToken",            legacy: "flagship.sessionToken" },
  { slot: "sessionV1",               legacy: "flagship.session.v1" },
  { slot: "podBaseUrl",              legacy: "flagship.podBaseUrl" },
  { slot: "pendingOrders",           legacy: "flagship.pendingOrders" },
  { slot: "wizardState",             legacy: "flagship.wizard.state.v1" },
]);

const SLOT_TO_LEGACY = new Map(SLOT_FIELDS.map((f) => [f.slot, f.legacy]));

function isStorage(s) {
  return s && typeof s.getItem === "function" && typeof s.setItem === "function";
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readState(storage) {
  if (!isStorage(storage)) return { activeCloudName: null, profiles: {} };
  const raw = storage.getItem(STORE_KEY);
  if (!raw) return { activeCloudName: null, profiles: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { activeCloudName: null, profiles: {} };
    }
    const profiles = parsed.profiles && typeof parsed.profiles === "object"
      ? parsed.profiles
      : {};
    const activeCloudName = typeof parsed.activeCloudName === "string"
      ? parsed.activeCloudName
      : null;
    return { activeCloudName, profiles };
  } catch {
    return { activeCloudName: null, profiles: {} };
  }
}

function writeState(state, storage) {
  if (!isStorage(storage)) return;
  storage.setItem(STORE_KEY, JSON.stringify({
    activeCloudName: state.activeCloudName ?? null,
    profiles: state.profiles ?? {},
  }));
}

/** Mirror the active pointer into the legacy `flagship.profiles.v1` so
 *  lib/profiles.js / keystore.js (both read that key) stay aligned. We
 *  don't touch the profiles ARRAY in the legacy blob — that's lib/profiles.js's
 *  job. */
function mirrorActiveToLegacy(activeCloudName, storage) {
  if (!isStorage(storage)) return;
  try {
    const raw = storage.getItem(LEGACY_ACTIVE_KEY);
    let parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") parsed = { profiles: [] };
    parsed.activeCloudName = activeCloudName ?? null;
    if (!Array.isArray(parsed.profiles)) parsed.profiles = [];
    storage.setItem(LEGACY_ACTIVE_KEY, JSON.stringify(parsed));
  } catch {
    /* swallow — legacy blob is best-effort */
  }
}

/** Return the active cloudName, or null when no profile is active. Reads
 *  the new store first, falling back to the legacy `flagship.profiles.v1`
 *  pointer so a partially-migrated state still resolves. */
export function getActiveCloudName(storage = defaultStorage()) {
  const state = readState(storage);
  if (state.activeCloudName) return state.activeCloudName;
  if (!isStorage(storage)) return null;
  try {
    const raw = storage.getItem(LEGACY_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.activeCloudName === "string" ? parsed.activeCloudName : null;
  } catch {
    return null;
  }
}

/** List every cloudName the store knows about. Order is insertion order. */
export function listCloudNames(storage = defaultStorage()) {
  const state = readState(storage);
  return Object.keys(state.profiles);
}

/** Ensure a slot exists for `cloudName` (created empty if missing). Idempotent.
 *  Returns the state AFTER the ensure. */
export function ensureProfile(cloudName, storage = defaultStorage()) {
  if (typeof cloudName !== "string" || !cloudName) {
    throw new Error("profilesStore.ensureProfile: cloudName required");
  }
  if (!isStorage(storage)) return readState(storage);
  const state = readState(storage);
  if (!state.profiles[cloudName]) {
    state.profiles[cloudName] = { createdAt: Date.now() };
    writeState(state, storage);
  }
  return state;
}

/** Switch the active profile. Mirrors into the legacy `flagship.profiles.v1`
 *  pointer so the keystore + lib/profiles.js see the same active cloud.
 *  No-op if `cloudName` isn't in the store. */
export function setActiveCloudName(cloudName, storage = defaultStorage()) {
  if (!isStorage(storage)) return null;
  const state = readState(storage);
  if (!cloudName || !state.profiles[cloudName]) return state.activeCloudName;
  state.activeCloudName = cloudName;
  writeState(state, storage);
  mirrorActiveToLegacy(cloudName, storage);
  return cloudName;
}

/** Read a single per-profile slot value. Resolves to the active profile's
 *  slot when `cloudName` is omitted. When NO profile is active anywhere yet
 *  (first-run pre-username) we fall through to the legacy flat key so the
 *  bootstrap flow can keep reading what it just wrote — but once a cloud is
 *  active the store is authoritative (an absent slot is "not set", never a
 *  silent fallthrough to another profile's mirrored legacy value). */
export function get(slot, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!isStorage(storage)) return null;
  const cloudName = opts.cloudName ?? getActiveCloudName(storage);
  if (!cloudName) {
    const legacyKey = SLOT_TO_LEGACY.get(slot);
    return legacyKey ? storage.getItem(legacyKey) : null;
  }
  const state = readState(storage);
  const profile = state.profiles[cloudName] ?? null;
  if (profile && Object.prototype.hasOwnProperty.call(profile, slot)) {
    const v = profile[slot];
    return v == null ? null : String(v);
  }
  return null;
}

/** Persist a per-profile slot value under the active (or specified) profile.
 *  By default also mirrors the value back to the legacy flat localStorage
 *  key so unmigrated read-sites keep working. Set `opts.mirror = false` to
 *  skip the mirror (used by tests that want to assert pure store writes). */
export function set(slot, value, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!isStorage(storage)) return;
  const cloudName = opts.cloudName ?? getActiveCloudName(storage);
  if (!cloudName) {
    // No active profile — fall back to mirroring to the legacy key alone so
    // first-run flows (bootstrap pre-username) don't silently drop the write.
    const legacyKey = SLOT_TO_LEGACY.get(slot);
    if (legacyKey && opts.mirror !== false) {
      if (value == null) storage.removeItem(legacyKey);
      else storage.setItem(legacyKey, String(value));
    }
    return;
  }
  const state = readState(storage);
  state.profiles[cloudName] = state.profiles[cloudName] ?? { createdAt: Date.now() };
  if (value == null) {
    delete state.profiles[cloudName][slot];
  } else {
    state.profiles[cloudName][slot] = String(value);
  }
  writeState(state, storage);
  const legacyKey = SLOT_TO_LEGACY.get(slot);
  if (legacyKey && opts.mirror !== false) {
    if (value == null) storage.removeItem(legacyKey);
    else storage.setItem(legacyKey, String(value));
  }
}

/** Remove a per-profile slot value (equivalent to {@link set} with null). */
export function remove(slot, opts = {}) {
  set(slot, null, opts);
}

/** Return the slot object for `cloudName` (or active). Read-only snapshot. */
export function getProfileSlot(cloudName, storage = defaultStorage()) {
  if (!isStorage(storage)) return null;
  const name = cloudName ?? getActiveCloudName(storage);
  if (!name) return null;
  const state = readState(storage);
  return state.profiles[name] ? { ...state.profiles[name] } : null;
}

/** Auto-migrate legacy single-profile localStorage into the new store. Runs
 *  once per browser; gated by `flagship.profiles.migrated.v2`. Idempotent:
 *  if called twice it short-circuits on the sentinel. Defensive: legacy
 *  keys are LEFT IN PLACE so any callsite still reading flat keys keeps
 *  working. The legacy blob `flagship.profiles.v1` is also left intact —
 *  lib/profiles.js / keystore.js still own that record.
 *
 *  Picks a cloudName by precedence:
 *    1. activeCloudName from `flagship.profiles.v1` (if a real profile is
 *       already wired up via the existing multi-profile path);
 *    2. `flagship.username` (legacy single-profile install);
 *    3. otherwise no migration happens (nothing to migrate). */
export function migrateLegacy(storage = defaultStorage()) {
  if (!isStorage(storage)) return { migrated: false, reason: "no-storage" };
  if (storage.getItem(MIGRATED_KEY) === "1") {
    return { migrated: false, reason: "already-migrated" };
  }

  let cloudName = null;
  try {
    const raw = storage.getItem(LEGACY_ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.activeCloudName === "string") {
        cloudName = parsed.activeCloudName;
      }
    }
  } catch { /* legacy blob unparseable — fall through */ }

  if (!cloudName) {
    const u = storage.getItem("flagship.username");
    if (u) cloudName = u;
  }

  if (!cloudName) {
    // Nothing actionable yet — DO NOT set the migrated sentinel; a later
    // boot (after the user picks a username) can run the migration.
    return { migrated: false, reason: "no-legacy-state" };
  }

  const state = readState(storage);
  const existed = !!state.profiles[cloudName];
  const profile = state.profiles[cloudName] ?? { createdAt: Date.now() };

  const copied = [];
  for (const { slot, legacy } of SLOT_FIELDS) {
    const v = storage.getItem(legacy);
    if (v == null) continue;
    if (!Object.prototype.hasOwnProperty.call(profile, slot)) {
      profile[slot] = v;
      copied.push(slot);
    }
  }
  state.profiles[cloudName] = profile;
  if (!state.activeCloudName) state.activeCloudName = cloudName;

  writeState(state, storage);
  mirrorActiveToLegacy(state.activeCloudName, storage);
  storage.setItem(MIGRATED_KEY, "1");
  return {
    migrated: true,
    cloudName,
    profileExisted: existed,
    copiedSlots: copied,
  };
}

/** Test-only helper: re-arm the migration (clears the sentinel). */
export function _resetMigrationSentinelForTests(storage = defaultStorage()) {
  if (!isStorage(storage)) return;
  storage.removeItem(MIGRATED_KEY);
}

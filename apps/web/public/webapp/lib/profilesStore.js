// P12 — per-profile localStorage namespace (POST-CUT-OVER).
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
// HARD CUT-OVER (P12 follow-up):
//   - `set(...)` NO LONGER writes the legacy flat key by default. All
//     unmigrated webapp read-sites have been refactored to go through
//     this store, so the mirror is no longer needed for correctness.
//     The `mirror` option is retained for completeness but now defaults
//     to `false`.
//   - A slot can opt into legacy-mirror-by-default by marking
//     `deviceWideOrPreProfile: true` in {@link SLOT_FIELDS}. That's the
//     escape hatch for call-sites that run BEFORE any profile is active
//     (e.g. the first-run wizard's persisted progress) and so legitimately
//     can't be addressed through the per-profile namespace. Marked slots
//     still write the flat key on `set(...)` calls (under the active
//     profile AND when there's no active profile yet).
//   - {@link cleanupLegacyKeys} runs once per boot after a successful
//     {@link migrateLegacy} to delete every legacy flat key for which the
//     new store already holds a value. Idempotent: never deletes a slot
//     that's only in the legacy key (you'd lose data).

export const STORE_KEY = "flagship.profiles.v2";
export const MIGRATED_KEY = "flagship.profiles.migrated.v2";
export const LEGACY_ACTIVE_KEY = "flagship.profiles.v1";
/** Sentinel set by {@link cleanupLegacyKeys} once a sweep completes for the
 *  active cloud. Stored per active cloud so a profile switch + later sweep
 *  can re-evaluate. */
export const LEGACY_CLEANUP_KEY = "flagship.profiles.legacy.cleaned.v2";

/** Every per-profile slot field, paired with its legacy flat localStorage
 *  key. The migration walks this list to copy legacy values into the new
 *  store. Order is stable; do not reorder without testing migration.
 *
 *  `deviceWideOrPreProfile`: this slot is legitimately accessed BEFORE any
 *  profile is active (e.g. the wizard's persisted step state, which runs
 *  pre-username). Marked slots STILL write the legacy flat key on `set(...)`
 *  by default, and are excluded from the legacy-key cleanup sweep. */
export const SLOT_FIELDS = Object.freeze([
  // Username is read pre-profile by keyfileBackup (file import landing) and
  // by state.js's `ensureUsername` flow — both can fire before the active
  // cloud is established. We keep the legacy flat key mirrored for those.
  { slot: "username",                legacy: "flagship.username",                       deviceWideOrPreProfile: true },
  { slot: "accountId",               legacy: "flagship.accountId" },
  // `currentIrkVersion` for NAMED profiles is stored through this
  // store (B3 closed the prior P12 carve-out). The DEFAULT profile
  // (`profileId === "__default__"`) still uses the legacy flat key
  // `flagship.irk.version` directly — keystore reads/writes it
  // without round-tripping through this store, because the default
  // profile has no cloudName to key a slot under. We keep
  // deviceWideOrPreProfile:true so the cleanup sweep leaves the
  // legacy key in place for the default-profile path. Non-default
  // keystore writes pass `mirror:false` to skip the default-key
  // auto-mirror, which would otherwise clobber the default profile.
  { slot: "currentIrkVersion",       legacy: "flagship.irk.version",                    deviceWideOrPreProfile: true },
  { slot: "recoveryWarn",            legacy: "flagship.recovery.warn.v1" },
  { slot: "recoveryBannerDismissed", legacy: "flagship.recovery.banner.dismissed.v1" },
  { slot: "proBannerDismissed",      legacy: "flagship.pro.banner.dismissed.v1" },
  { slot: "peerBackupChoice",        legacy: "flagship.peerBackup.choice.v1" },
  { slot: "pushTokenId",             legacy: "flagship.pushTokenId" },
  { slot: "sessionId",               legacy: "flagship.sessionId" },
  { slot: "sessionToken",            legacy: "flagship.sessionToken" },
  { slot: "sessionV1",               legacy: "flagship.session.v1" },
  { slot: "podBaseUrl",              legacy: "flagship.podBaseUrl" },
  { slot: "pendingOrders",           legacy: "flagship.pendingOrders" },
  // Wizard progress can persist BEFORE a username exists (step 1 is
  // device-key generation, step 2 is open-account). Keep the legacy flat
  // key live so the wizard's pre-profile state never drops.
  { slot: "wizardState",             legacy: "flagship.wizard.state.v1",               deviceWideOrPreProfile: true },
  // Graceful-decommission L3 — the JSON set of FQDNs this device retired when
  // it "Replace this server"'d a box. Home filters these out and the boot
  // surfaces decline a retired box's unlock.
  { slot: "decommissionedServers",   legacy: "flagship.decommissioned.servers.v1" },
]);

const SLOT_TO_LEGACY = new Map(SLOT_FIELDS.map((f) => [f.slot, f.legacy]));
const DEVICE_WIDE_SLOTS = new Set(
  SLOT_FIELDS.filter((f) => f.deviceWideOrPreProfile).map((f) => f.slot),
);

/** True iff this slot is legitimately accessed before a profile is active
 *  (and so should still mirror to / read from the legacy flat key). */
export function isDeviceWideOrPreProfile(slot) {
  return DEVICE_WIDE_SLOTS.has(slot);
}

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
 *  slot when `cloudName` is omitted.
 *
 *  Read priority:
 *    1. The per-profile slot under the active (or specified) cloud.
 *    2. When NO profile is active anywhere yet (first-run pre-username) the
 *       legacy flat key (so the bootstrap flow can keep reading what it
 *       just wrote — primarily `username` + `wizardState`).
 *    3. For slots marked {@link DEVICE_WIDE_SLOTS} we fall through to the
 *       legacy flat key even when a cloud IS active, since those slots
 *       are legitimately accessed device-wide (e.g. the wizard state).
 *
 *  Once a cloud is active and the slot is non-device-wide, an absent slot
 *  is "not set" — never a silent fallthrough to another profile's mirrored
 *  legacy value. */
export function get(slot, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!isStorage(storage)) return null;
  const cloudName = opts.cloudName ?? getActiveCloudName(storage);
  const legacyKey = SLOT_TO_LEGACY.get(slot);
  if (!cloudName) {
    return legacyKey ? storage.getItem(legacyKey) : null;
  }
  const state = readState(storage);
  const profile = state.profiles[cloudName] ?? null;
  if (profile && Object.prototype.hasOwnProperty.call(profile, slot)) {
    const v = profile[slot];
    return v == null ? null : String(v);
  }
  // Device-wide-or-pre-profile slots can legitimately come from the legacy
  // flat key (e.g. wizardState written before any profile was active).
  if (DEVICE_WIDE_SLOTS.has(slot) && legacyKey) {
    return storage.getItem(legacyKey);
  }
  return null;
}

/** Persist a per-profile slot value under the active (or specified) profile.
 *
 *  Post-cut-over: by DEFAULT this does NOT mirror to the legacy flat key.
 *  All webapp read-sites have been refactored to go through {@link get}.
 *
 *  Two exceptions still write the legacy flat key:
 *    - The slot is marked `deviceWideOrPreProfile` (see {@link SLOT_FIELDS}).
 *      These are written to the legacy key as well as the per-profile slot.
 *    - The caller passes `opts.mirror === true` explicitly (e.g. a test).
 *
 *  When there's no active profile, only the legacy flat key is written, and
 *  only when the slot is device-wide-or-pre-profile (otherwise the write is
 *  a no-op — there's no profile to hold it). */
export function set(slot, value, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!isStorage(storage)) return;
  const cloudName = opts.cloudName ?? getActiveCloudName(storage);
  const legacyKey = SLOT_TO_LEGACY.get(slot);
  const isDeviceWide = DEVICE_WIDE_SLOTS.has(slot);
  // `opts.mirror === true`  → force-on the legacy mirror (used by tests).
  // `opts.mirror === false` → force-off (B3 — keystore writing a non-
  //                            default-profile slot whose device-wide
  //                            legacy key is reserved for the DEFAULT
  //                            profile; auto-mirror would clobber it).
  // omitted                  → defer to the slot's device-wide flag.
  const shouldMirror =
    opts.mirror === true || (opts.mirror !== false && isDeviceWide);

  if (!cloudName) {
    // No active profile. Non-device-wide writes silently drop here — by
    // design, the caller shouldn't be writing per-profile state without an
    // active profile. Device-wide slots get the legacy mirror so the
    // bootstrap flow (e.g. wizardState) can keep working pre-username.
    if (legacyKey && shouldMirror) {
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
  if (legacyKey && shouldMirror) {
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

/** Sweep legacy flat keys that have been fully superseded by the per-profile
 *  store. Idempotent + DEFENSIVE: we only remove a legacy key when BOTH
 *
 *    1. the migration sentinel is set (so we know the values were copied
 *       forward), AND
 *    2. the active profile actually holds the slot in the new store
 *       (so we never blow away a value that only exists in the legacy key).
 *
 *  Slots marked `deviceWideOrPreProfile` are NEVER swept — their legacy flat
 *  key is the source of truth for pre-profile reads (e.g. wizardState).
 *
 *  Stamps {@link LEGACY_CLEANUP_KEY} on completion so the sweep doesn't run
 *  redundantly on every boot. A profile switch clears the stamp via the
 *  store re-read path (we re-stamp on each sweep). */
export function cleanupLegacyKeys(opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!isStorage(storage)) return { ran: false, reason: "no-storage", removed: [] };
  if (storage.getItem(MIGRATED_KEY) !== "1") {
    return { ran: false, reason: "not-migrated", removed: [] };
  }
  const cloudName = opts.cloudName ?? getActiveCloudName(storage);
  if (!cloudName) {
    return { ran: false, reason: "no-active-profile", removed: [] };
  }
  const stamp = storage.getItem(LEGACY_CLEANUP_KEY);
  if (stamp === cloudName) {
    return { ran: false, reason: "already-cleaned", removed: [] };
  }
  const state = readState(storage);
  const profile = state.profiles[cloudName] ?? {};
  const removed = [];
  for (const { slot, legacy, deviceWideOrPreProfile } of SLOT_FIELDS) {
    if (deviceWideOrPreProfile) continue; // legacy key stays — legitimate device-wide.
    // Only sweep when the slot is genuinely populated in the new store.
    // Idempotency: never delete a slot we don't already hold.
    if (!Object.prototype.hasOwnProperty.call(profile, slot)) continue;
    if (profile[slot] == null) continue;
    if (storage.getItem(legacy) != null) {
      storage.removeItem(legacy);
      removed.push(slot);
    }
  }
  storage.setItem(LEGACY_CLEANUP_KEY, cloudName);
  return { ran: true, removed, cloudName };
}

/** Test-only helper: re-arm the migration (clears the sentinel). */
export function _resetMigrationSentinelForTests(storage = defaultStorage()) {
  if (!isStorage(storage)) return;
  storage.removeItem(MIGRATED_KEY);
  storage.removeItem(LEGACY_CLEANUP_KEY);
}

// ── Fix B — per-pod session token + base URL ──────────────────────────────
//
// Previously `sessionToken` and `podBaseUrl` were single per-profile slots,
// so pairing a second pod overwrote the first pod's token. We split them
// into pod-keyed sub-maps stored as JSON blobs under:
//
//   profiles[cloudName].podTokens   = { [podId]: token }
//   profiles[cloudName].podBaseUrls = { [podId]: baseUrl }
//
// The podId is the pod's lower-cased FQDN (the stable identity used
// everywhere else in the webapp). This is a SEPARATE layer from the legacy
// per-profile `sessionToken` / `podBaseUrl` slots, which remain for callers
// that haven't been updated yet and are migrated on first read (see
// `migratePerPodTokens`).
//
// API:
//   getSessionTokenFor(podId)           — read pod's token
//   setSessionTokenFor(podId, token)    — write pod's token
//   removeSessionTokenFor(podId)        — remove pod's token
//   getPodBaseUrlFor(podId)             — always deterministic: https://<podId>
//   migrateSingleTokenToPod(podId)      — one-time attribution of the legacy
//                                         single token to the anchor pod id
//   listPodTokenIds()                   — list all pod ids with a stored token

function readPodSubMap(subKey, storage) {
  const cloudName = getActiveCloudName(storage);
  if (!cloudName) return {};
  const state = readState(storage);
  const profile = state.profiles[cloudName] ?? {};
  const raw = profile[subKey];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePodSubMap(subKey, map, storage) {
  const cloudName = getActiveCloudName(storage);
  if (!cloudName) return;
  const state = readState(storage);
  state.profiles[cloudName] = state.profiles[cloudName] ?? { createdAt: Date.now() };
  state.profiles[cloudName][subKey] = JSON.stringify(map);
  writeState(state, storage);
}

/**
 * Return the stored session token for `podId` (lower-cased FQDN), or null.
 * @param {string} podId  lower-cased FQDN of the pod
 * @param {{ storage?: Storage, cloudName?: string }} [opts]
 */
export function getSessionTokenFor(podId, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!podId) return null;
  const key = String(podId).toLowerCase();
  const map = readPodSubMap("podTokens", storage);
  return typeof map[key] === "string" ? map[key] : null;
}

/**
 * Persist the session token for `podId`. Pass null/undefined to remove.
 * @param {string} podId  lower-cased FQDN of the pod
 * @param {string|null|undefined} token
 * @param {{ storage?: Storage }} [opts]
 */
export function setSessionTokenFor(podId, token, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!podId) return;
  const key = String(podId).toLowerCase();
  const map = readPodSubMap("podTokens", storage);
  if (token == null) {
    delete map[key];
  } else {
    map[key] = String(token);
  }
  writePodSubMap("podTokens", map, storage);
}

/**
 * Remove the session token for `podId`.
 * @param {string} podId
 * @param {{ storage?: Storage }} [opts]
 */
export function removeSessionTokenFor(podId, opts = {}) {
  setSessionTokenFor(podId, null, opts);
}

/**
 * Derive the base URL for `podId` — always `https://<podId>` (deterministic
 * from the FQDN). This never requires storage; it's a pure helper.
 * Mirrors `lib/podSwitcher.js podBaseUrlFor`.
 * @param {string} podId  lower-cased FQDN
 * @returns {string}
 */
export function getPodBaseUrlFor(podId) {
  const host = String(podId ?? "").trim().toLowerCase();
  return host ? `https://${host}` : "";
}

/**
 * List the pod IDs (FQDNs) that have a stored session token under the active
 * profile. Returns [] when no profile is active.
 * @param {{ storage?: Storage }} [opts]
 * @returns {string[]}
 */
export function listPodTokenIds(opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  const map = readPodSubMap("podTokens", storage);
  return Object.keys(map).filter((k) => typeof map[k] === "string" && map[k]);
}

/**
 * Best-effort migration: if the active profile has a legacy single
 * `sessionToken` but no per-pod token for `anchorPodId`, attribute the
 * legacy token to that pod. Idempotent: a no-op when the pod already has a
 * token or when there's no legacy token.
 *
 * Call this during pairing or when navigating to a pod's detail, with the
 * current anchor pod's lower-cased FQDN as `anchorPodId`.
 *
 * @param {string} anchorPodId  lower-cased FQDN of the pod to attribute to
 * @param {{ storage?: Storage }} [opts]
 * @returns {{ migrated: boolean }}
 */
export function migrateSingleTokenToPod(anchorPodId, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  if (!anchorPodId) return { migrated: false };
  // Only migrate when the pod doesn't already have a per-pod token.
  if (getSessionTokenFor(anchorPodId, { storage })) return { migrated: false };
  // Look for the legacy single-slot token on the active profile.
  const legacyToken = get("sessionToken", { storage });
  if (!legacyToken) return { migrated: false };
  setSessionTokenFor(anchorPodId, legacyToken, { storage });
  return { migrated: true };
}

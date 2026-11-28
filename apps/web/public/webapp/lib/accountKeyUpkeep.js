// The account-key work a browser does on its own (docs/account-key-rotation.md): finish a change it started
// (the pending slot), take a change another admin device made (the receiver), and publish its receive key.
// Runs when the app comes to the foreground, when Home shows and when an `account-key-rotated` push asks;
// one run at a time.

import {
  adoptRegisteredIrk,
  adminRootPubHex,
  clearPendingRotation,
  deriveAccountDeviceSeedFromSeed,
  installSuccessorUmk,
  loadPendingRotation,
  loadReceiveKeySeed,
  persistAccountDeviceSeed,
  persistAdminRootSeed,
  persistReceiveKeySeed,
  putPendingRotation,
} from "../keystore.js";
import { getSession, unlockSession } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { clearAccountReadTokens } from "./accountRead.js";
import { fetchDecryptedDirectory, signedDirectoryFetch, updateSelfDisplayName } from "./accountDirectory.js";
import {
  ACCOUNT_KEY_COPY,
  ensureReceiveKey,
  fetchAccountKeys,
  migrateDerivedDeviceKey,
  postRotation,
  receiveAccountKey,
  resumePendingRotation,
} from "./accountKeyChange.js";
import { isAdminRootKey } from "./keyCustody.js";
import { tr } from "./i18n.js";

const MIN_GAP_MS = 60_000;
const DONE_PREFIX = "flagship.accountKeyChange.";
const RECOVERY_OFF_PREFIX = "flagship.recoveryOffAfterKeyChange.";
const WAITING_PREFIX = "flagship.accountKeyWaiting.";

/** The real keystore and network behind lib/accountKeyChange.js. */
export function accountKeyDeps(overrides = {}) {
  return {
    deriveAccountDeviceSeed: deriveAccountDeviceSeedFromSeed,
    loadReceiveKeySeed,
    persistReceiveKeySeed,
    persistAccountDeviceSeed,
    persistAdminRootSeed: (umk, seed) => persistAdminRootSeed(umk, seed),
    installSuccessorUmk: (oldUmk, newUmk, toEpoch) => installSuccessorUmk(oldUmk, newUmk, toEpoch),
    putPendingRotation: (umk, p) => putPendingRotation(umk, p),
    loadPendingRotation: (umk) => loadPendingRotation(umk),
    clearPendingRotation: () => clearPendingRotation(),
    adoptRegisteredIrk,
    unlockSession,
    clearAccountReadTokens,
    signedDirectoryFetch: (path, init) => signedDirectoryFetch(path, init),
    fetchAccountKeys: (u) => fetchAccountKeys(u),
    postRotation: (u, body) => postRotation(u, body),
    markRotationDone,
    ...overrides,
  };
}

function key(prefix, accountId) {
  return prefix + String(accountId ?? "").toLowerCase();
}

function read(prefix, accountId) {
  try {
    const raw = globalThis.localStorage?.getItem(key(prefix, accountId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(prefix, accountId, value) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key(prefix, accountId));
    else globalThis.localStorage?.setItem(key(prefix, accountId), JSON.stringify(value));
  } catch { /* best-effort */ }
}

/** After a change this browser made: what the progress card follows, and whether recovery must be set up again. */
export function markRotationDone({ keyEpoch, kept, recoveryWasOn }, accountId = getActiveProfile()?.accountId) {
  write(DONE_PREFIX, accountId, { keyEpoch, kept, at: Date.now() });
  if (recoveryWasOn) write(RECOVERY_OFF_PREFIX, accountId, { at: Date.now() });
}

export function rotationInProgress(accountId = getActiveProfile()?.accountId) {
  return read(DONE_PREFIX, accountId);
}

export function clearRotationProgress(accountId = getActiveProfile()?.accountId) {
  write(DONE_PREFIX, accountId, null);
}

export function recoveryOffAfterKeyChange(accountId = getActiveProfile()?.accountId) {
  return read(RECOVERY_OFF_PREFIX, accountId) !== null;
}

/** Cloud recovery was set up again under the new key: the warning goes. */
export function clearRecoveryOffWarning(accountId = getActiveProfile()?.accountId) {
  write(RECOVERY_OFF_PREFIX, accountId, null);
}

/** A push said a change waits (the tab may be locked): the unlock screen shows the banner. */
export function noteKeyChangeWaiting(accountId = getActiveProfile()?.accountId) {
  write(WAITING_PREFIX, accountId, { at: Date.now() });
}

export function keyChangeWaiting(accountId = getActiveProfile()?.accountId) {
  return read(WAITING_PREFIX, accountId) !== null;
}

const MIGRATE_PREFIX = "flagship.deviceKeyMove.";
const MIGRATE_RETRY_MS = 86_400_000;

/** Move an admin browser off a derived device key, at most one attempt a day; keeps its own name. */
export async function migrateOnce({ session, profile }, deps) {
  if (!isAdminRootKey(session?.adminRootSeed)) return "not-admin";
  const last = read(MIGRATE_PREFIX, profile.accountId);
  if (last?.done || (last?.at && Date.now() - last.at < MIGRATE_RETRY_MS)) return "skipped";
  const directory = await (deps.fetchDirectory ?? fetchDecryptedDirectory)();
  const me = directory?.devices?.find((d) => d.deviceId === profile.deviceId);
  const res = await migrateDerivedDeviceKey({ session, profile, grant: me?.grant ?? null }, deps);
  write(MIGRATE_PREFIX, profile.accountId, { at: Date.now(), done: res === "random" || res === "migrated" });
  if (res === "migrated" && me?.selfDisplayName) {
    const current = directory.selfProfiles.find((p) => p.deviceId === profile.deviceId) ?? null;
    await updateSelfDisplayName(me.selfDisplayName, current).catch(() => {});
  }
  return res;
}

const listeners = new Set();
/** `fn({ state, message })` on each step the banner shows: "checking", "updated", "failed". */
export function onAccountKeyState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(state, message) {
  for (const fn of listeners) {
    try { fn({ state, message }); } catch { /* a listener never stops the run */ }
  }
}

let running = null;
let lastRun = 0;

/**
 * One pass. `force` skips the one-a-minute limit (a push, a Retry). Resolves the receiver's state, or
 * "locked" / "skipped". Never throws: a failure is shown on the banner and tried again next time.
 */
export function runAccountKeyUpkeep({ force = false, deps: overrides = {} } = {}) {
  if (running) return running;
  if (!force && Date.now() - lastRun < MIN_GAP_MS) return Promise.resolve("skipped");
  lastRun = Date.now();
  running = (async () => {
    const session = getSession();
    const profile = getActiveProfile();
    if (!(session?.umk instanceof Uint8Array) || !profile?.accountId || profile.demoServer) return "locked";
    const deps = accountKeyDeps(overrides);
    let state = "current";
    try {
      await resumePendingRotation({ session, profile }, deps);
      const own = isAdminRootKey(session.adminRootSeed) ? await adminRootPubHex(session.adminRootSeed) : null;
      const before = keyChangeWaiting(profile.accountId);
      const res = await receiveAccountKey({ session: getSession(), profile }, { ...deps, ownAdminRootPubHex: own });
      state = res.state;
      if (res.state === "updated") {
        // `.com` dropped every device's own profile at the change: this device publishes its own again.
        await updateSelfDisplayName(tr("This browser"), null).catch(() => {});
        write(WAITING_PREFIX, profile.accountId, null);
        emit("updated", ACCOUNT_KEY_COPY.bannerDone);
      } else if (res.state === "current" && before) {
        write(WAITING_PREFIX, profile.accountId, null);
      }
      if (res.state === "current" || res.state === "updated") {
        // A device key derived from the account key is replaced once, on an admin browser (the admin root signs the
        // move: one passkey prompt). A closed prompt is asked again a day later, not on every foreground.
        await migrateOnce({ session: getSession(), profile }, deps).catch(() => "failed");
        await ensureReceiveKey({ session: getSession(), profile }, deps).catch(() => "failed");
      }
    } catch (e) {
      console.error("account key upkeep failed", e);
      state = "failed";
      emit("failed", ACCOUNT_KEY_COPY.receiveFailed);
    }
    return state;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Wire the triggers. Idempotent. */
export function initAccountKeyUpkeep() {
  if (typeof document === "undefined" || initAccountKeyUpkeep._done) return;
  initAccountKeyUpkeep._done = true;
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-home") void runAccountKeyUpkeep();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void runAccountKeyUpkeep();
  });
  void keepPushText();
}

/** Leave the push sentence in this page's language where the service worker reads it (service-worker.js pushText). */
export async function keepPushText() {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open("flagship-push-text-v1");
    await cache.put("/__flagship/push-text/account-key-rotated", new Response(ACCOUNT_KEY_COPY.pushBody, { headers: { "content-type": "text/plain; charset=utf-8" } }));
  } catch { /* English then */ }
}

/** The account-key-rotated push reached an open tab. */
export function onAccountKeyRotatedPush() {
  noteKeyChangeWaiting();
  void runAccountKeyUpkeep({ force: true });
}

/** Test seam. */
export function _resetAccountKeyUpkeepForTests() {
  running = null;
  lastRun = 0;
  listeners.clear();
}

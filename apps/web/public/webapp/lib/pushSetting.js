// The "Push notifications" switch (docs/ai-privacy-and-staging.md §3a,
// "Turning alerts off"). On by default, stored on this device.
//
// Off: this browser drops its Web Push subscription and revokes its push
// registration with flagshipserver.com (and doesn't register again), every box
// it manages is told to stop sending access-request alerts
// (POST /api/screens/settings/access-alerts {enabled:false}), and no access
// sheet pops up. Requests still wait on each app's page.
// On: register again and tell every box enabled:true.
// On start and whenever the app comes back to the foreground, each box is read
// and corrected where it disagrees. A box too old to have the setting (404) is
// skipped silently.

import {
  getPodBaseUrl,
  getSessionToken,
  screensFetchForPod,
  screensFetchFrom,
} from "./api.js";
import { listPodTokenIds, get as profileGet } from "./profilesStore.js";
import { isCompanionProfile } from "./companionGuard.js";
import { getSession } from "./state.js";

import { tr } from "./i18n.js";
export const PUSH_SETTING_KEY = "flagship.pushNotifications.v1";
export const PUSH_SETTING_TITLE = tr("Push notifications");
export const PUSH_SETTING_NOTE =
  tr("When this is off, nothing from Flagship is pushed to this device, so Apple and Google never see when your servers need you. You'll have to open Flagship to approve unlocks and see requests.");
export const ACCESS_ALERTS_PATH = "/api/screens/settings/access-alerts";
/** Foreground resyncs run at most this often. */
export const PUSH_RESYNC_MS = 60 * 1000;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The device's switch; true unless it was turned off. */
export function pushNotificationsEnabled(storage = defaultStorage()) {
  try {
    return storage?.getItem(PUSH_SETTING_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setPushNotificationsEnabled(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem(PUSH_SETTING_KEY, enabled ? "on" : "off");
  } catch {
    /* storage blocked: the switch falls back to on next launch */
  }
}

/**
 * The boxes this device manages, each as `{ id, fetch(path, init) }`: every
 * pod with its own session token, plus the legacy active-pod slot when it
 * isn't one of them. A companion manages none (it can't write).
 */
export function managedBoxes() {
  if (isCompanionProfile()) return [];
  const out = [];
  const seen = new Set();
  for (const fqdn of listPodTokenIds()) {
    const id = String(fqdn).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, fetch: (path, init) => screensFetchForPod(id, path, init) });
  }
  const base = getPodBaseUrl();
  if (base && getSessionToken()) {
    let host = "";
    try {
      host = new URL(base).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (host && !seen.has(host)) {
      out.push({ id: host, fetch: (path, init) => screensFetchFrom(base, path, init) });
    }
  }
  return out;
}

const isMissing = (e) => e?.status === 404;

/**
 * Write `enabled` to every box. Resolves to the ids written, skipped (no
 * setting on that box) and failed (offline, refused); never throws.
 */
export async function writeAccessAlertsToBoxes(enabled, boxes) {
  const written = [];
  const skipped = [];
  const failed = [];
  await Promise.all(
    boxes.map(async (b) => {
      try {
        await b.fetch(ACCESS_ALERTS_PATH, { method: "POST", body: JSON.stringify({ enabled: !!enabled }) });
        written.push(b.id);
      } catch (e) {
        (isMissing(e) ? skipped : failed).push(b.id);
      }
    }),
  );
  return { written, skipped, failed };
}

/** Read each box and write `enabled` only where it differs. Never throws. */
export async function syncAccessAlertsToBoxes(enabled, boxes) {
  const want = !!enabled;
  const written = [];
  const skipped = [];
  const failed = [];
  await Promise.all(
    boxes.map(async (b) => {
      try {
        const cur = await b.fetch(ACCESS_ALERTS_PATH, { method: "GET" });
        if (cur && typeof cur.enabled === "boolean" && cur.enabled === want) return;
        await b.fetch(ACCESS_ALERTS_PATH, { method: "POST", body: JSON.stringify({ enabled: want }) });
        written.push(b.id);
      } catch (e) {
        (isMissing(e) ? skipped : failed).push(b.id);
      }
    }),
  );
  return { written, skipped, failed };
}

/**
 * Flip the switch: store it, then (off) revoke this device's push
 * registration, or (on) register again, and write it to every box. A failed
 * registration is reported back (e.g. the browser blocks notifications) but
 * the switch and the boxes still follow the owner's choice.
 */
export async function applyPushSetting(enabled, deps) {
  const {
    storage = defaultStorage(),
    boxes = managedBoxes,
    subscribe,
    unsubscribe,
  } = deps;
  setPushNotificationsEnabled(enabled, storage);
  let pushError = null;
  try {
    if (enabled) await subscribe?.();
    else await unsubscribe?.();
  } catch (e) {
    pushError = e;
  }
  const result = await writeAccessAlertsToBoxes(enabled, boxes());
  return { ...result, pushError };
}

/**
 * Keep the boxes (and this device's registration) in line with the switch:
 * on start and on each return to the foreground. With the switch off, a push
 * registration still on file (another account on this device, or one made
 * before the switch existed) is revoked.
 */
export function startPushSettingSync({
  isActive,
  unsubscribe,
  storage = defaultStorage(),
  boxes = managedBoxes,
  hasRegistration = () => !!profileGet("pushTokenId"),
  now = Date.now,
  minIntervalMs = PUSH_RESYNC_MS,
  target = globalThis,
}) {
  let lastAt = -Infinity;
  let running = null;
  const sync = async ({ force = false } = {}) => {
    let active = false;
    try {
      active = isActive();
    } catch {
      active = false;
    }
    if (!active) return null;
    if (running) return running;
    if (!force && now() - lastAt < minIntervalMs) return null;
    lastAt = now();
    running = (async () => {
      const enabled = pushNotificationsEnabled(storage);
      if (!enabled && hasRegistration()) {
        // Not awaited: a browser without a ready service worker never settles.
        void Promise.resolve()
          .then(() => unsubscribe?.())
          .catch(() => {
            /* best effort; tried again next time */
          });
      }
      return syncAccessAlertsToBoxes(enabled, boxes());
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  };
  try {
    target.document?.addEventListener("visibilitychange", () => {
      if (target.document.visibilityState === "visible") void sync();
    });
    target.addEventListener?.("focus", () => void sync());
    // Unlocking (or pairing a box) shows a view: the first chance to sync.
    target.document?.addEventListener("flagship:view-shown", () => void sync());
  } catch {
    /* no DOM */
  }
  void sync({ force: true });
  return { sync };
}

/** The shell's predicate for syncing: unlocked, an owner (not a companion). */
export function canSyncPushSetting(isUnlocked) {
  try {
    return isUnlocked() && !isCompanionProfile() && !!getSession()?.umk;
  } catch {
    return false;
  }
}

// A new server asks twice on its first boot: "Unlock device", then about 80 s later "Authorize device to join your
// cloud" (the creating device checks the box's first-contact code on that second request). The second arrived with
// nothing on screen, so the owner had to find it in Activity → Server approvals (Windows acceptance, 2026-11-06).
// After a first-boot unlock is approved the server is watched for a while; when its entitlement request shows up in
// the box inbox (the /pods digest LiveSync feeds) the app brings the approvals back. Mirror of iOS/Android
// SecondStepWatch.

import { inboxFromPods } from "./boxInbox.js";

export const SECOND_STEP_WINDOW_MS = 10 * 60_000;

export function createSecondStepWatch({ windowMs = SECOND_STEP_WINDOW_MS } = {}) {
  /** @type {Map<string, number>} */
  const armed = new Map();
  return {
    /** The owner just approved `server`'s first-boot unlock: its next request is the second step. */
    arm(server, now = Date.now()) {
      armed.set(String(server).toLowerCase(), now + windowMs);
    },
    /** The watched servers whose entitlement request now waits. Each is reported once; a watch past its window
     *  is dropped. */
    arrived(pods, now = Date.now()) {
      for (const [k, until] of armed) if (until < now) armed.delete(k);
      const waiting = new Set(
        inboxFromPods(pods).filter((r) => r.type === "entitlement").map((r) => String(r.serverDomain).toLowerCase()),
      );
      const hits = [...armed.keys()].filter((k) => waiting.has(k)).sort();
      for (const h of hits) armed.delete(h);
      return hits;
    },
  };
}

/** The app's one watch (the approvals arm it, app.js reads it on every LiveSync snapshot). */
export const secondStepWatch = createSecondStepWatch();

/** The Home row of a server that has never come online (a fresh order) and is waiting for an approval opens the
 *  approvals, not its page. A running server keeps its page. `pods` is the /pods (LiveSync) snapshot. */
export function opensApprovals(fqdn, pods) {
  const want = String(fqdn ?? "").toLowerCase();
  const pod = (pods ?? []).find((p) => String(p?.serverDomain ?? "").toLowerCase() === want);
  if (!pod) return false;
  const neverOnline = pod.lastReported == null && pod.currentCert == null;
  return neverOnline && inboxFromPods([pod]).length > 0;
}

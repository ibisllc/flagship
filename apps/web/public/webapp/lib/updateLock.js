// The "update required" lock's switch (docs/security-notices.md). Set by
// lib/securityNotice.js when a verified, in-window update-required notice
// applies to this build; read by the global fetch guard (lib/comFetch.js) and
// the lock screen (lib/noticeUi.js).
//
// While locked the app refuses to act: no signed order and no call to a server
// leaves the page. Reads from .com stay open (sign-out and the key backup
// need them, and they change nothing), and so does everything on the webapp's
// own origin (the shell files an update is made of). Nothing is deleted.

let locked = false;
const subscribers = new Set();

export class UpdateRequiredError extends Error {
  constructor(message = "Update required. Flagship is paused on this device until you update.") {
    super(message);
    this.name = "UpdateRequiredError";
    this.updateRequired = true;
  }
}

export function isUpdateLocked() {
  return locked;
}

export function setUpdateLocked(next) {
  const value = !!next;
  if (value === locked) return;
  locked = value;
  for (const fn of subscribers) {
    try {
      fn(locked);
    } catch {
      /* a listener never blocks the lock */
    }
  }
}

export function subscribeUpdateLock(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * May this request go out while locked? Same-origin always (the shell and its
 * update); a GET or HEAD to the control server (nothing it answers changes
 * anything); nothing else (boxes, data plane, any write).
 * @param {{url:string, method?:string, sameOrigin:boolean, controlHost:boolean}} req
 */
export function updateLockAllows(req) {
  if (!locked) return true;
  if (req.sameOrigin) return true;
  const method = String(req.method || "GET").toUpperCase();
  return req.controlHost && (method === "GET" || method === "HEAD");
}

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
 * The two writes that answer a box's boot-unlock request: the secret request on
 * .com and the response on boot.<apex>. A locked browser must still be able to
 * let the owner's own server start (mirror of the phones' `isBootUnlock`).
 */
function isBootUnlock(url, method, controlHost) {
  if (method !== "POST") return false;
  try {
    const u = new URL(url);
    if (controlHost && u.pathname === "/api/secret-requests") return true;
    return u.hostname.startsWith("boot.") && u.pathname === "/api/boot/response";
  } catch {
    return false;
  }
}

/**
 * May this request go out while locked? Same-origin always (the shell and its
 * update); a GET or HEAD to the control server (nothing it answers changes
 * anything); the two boot-unlock writes; nothing else (boxes, data plane, any
 * other write).
 * @param {{url:string, method?:string, sameOrigin:boolean, controlHost:boolean}} req
 */
export function updateLockAllows(req) {
  if (!locked) return true;
  if (req.sameOrigin) return true;
  const method = String(req.method || "GET").toUpperCase();
  if (isBootUnlock(req.url, method, req.controlHost)) return true;
  return req.controlHost && (method === "GET" || method === "HEAD");
}

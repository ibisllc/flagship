// Home's "account > device" line, kept on this browser so a reload shows the
// names at once instead of the routing handle until the directory is fetched
// and decrypted (and instead of it staying a handle when that fetch fails).
// Only the two display names are kept, per account handle; the directory stays
// the source and overwrites this on every successful read.
//
// MIRRORS: Android PresentationNameStore.

const PREFIX = "flagship.homeIdentity.";

function key(username) {
  return PREFIX + String(username).toLowerCase();
}

/** The last names this browser saw for `username`, or null.
 *  @returns {{ accountDisplayName?: string, deviceDisplayName?: string } | null} */
export function cachedHomeIdentity(username, deps = {}) {
  if (!username) return null;
  try {
    const raw = (deps.storage ?? globalThis.localStorage)?.getItem(key(username));
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object") return null;
    return {
      ...(typeof v.accountDisplayName === "string" && v.accountDisplayName ? { accountDisplayName: v.accountDisplayName } : {}),
      ...(typeof v.deviceDisplayName === "string" && v.deviceDisplayName ? { deviceDisplayName: v.deviceDisplayName } : {}),
    };
  } catch {
    return null;
  }
}

/** Remember the names the directory just gave. Empty names are not stored. */
export function rememberHomeIdentity(username, { accountDisplayName, deviceDisplayName } = {}, deps = {}) {
  if (!username || (!accountDisplayName && !deviceDisplayName)) return;
  try {
    (deps.storage ?? globalThis.localStorage)?.setItem(
      key(username),
      JSON.stringify({ accountDisplayName: accountDisplayName || "", deviceDisplayName: deviceDisplayName || "" }),
    );
  } catch {
    /* private mode / quota: the names are read from the directory next time */
  }
}

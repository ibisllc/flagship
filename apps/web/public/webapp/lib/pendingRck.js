// The routing key (RCK) a pending order for a name was minted with.
//
// `.com` pins a name to the first RCK registered for it, and the webapp keeps
// no RCK secret, only the public key it pinned. A mint for a name that still
// has a recent pending key reuses it, so a retry, a reconnect after the
// builder dropped or a second tap on the same order registers the same claim
// instead of one `.com` refuses ("subdomain already controlled by a different
// RCK"). Nothing here is a secret, and a stale entry can never block a name
// (a released name accepts any key).
//
// MIRRORS: Android PendingRckStore (24 hours, `<public key hex>|<ms>`).

/** A recipe lives at most 24 hours (the longest TTL the wizard offers). */
export const PENDING_RCK_TTL_MS = 24 * 60 * 60 * 1000;

const PREFIX = "flagship.pendingRck.";

function key(serverDomain) {
  return PREFIX + String(serverDomain).toLowerCase();
}

function store(deps) {
  if (deps?.storage) return deps.storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The public key to mint with for `serverDomain`: the pending one when it is
 *  still fresh, otherwise `freshPubHex`, which is then remembered.
 *  @param {string} serverDomain
 *  @param {string} freshPubHex
 *  @param {{ storage?: Storage, now?: () => number }} [deps] */
export function reuseOrRecordRck(serverDomain, freshPubHex, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const s = store(deps);
  try {
    const [pub, at] = String(s?.getItem(key(serverDomain)) ?? "").split("|");
    const savedAt = Number(at);
    if (/^[0-9a-f]{64}$/.test(pub ?? "") && Number.isFinite(savedAt) && now - savedAt >= 0 && now - savedAt <= PENDING_RCK_TTL_MS) {
      return pub;
    }
    s?.setItem(key(serverDomain), `${freshPubHex}|${now}`);
  } catch {
    /* private mode / quota: this mint just uses its own key */
  }
  return freshPubHex;
}

/** The order was cancelled or its server registered: forget the key. */
export function clearPendingRck(serverDomain, deps = {}) {
  try {
    store(deps)?.removeItem(key(serverDomain));
  } catch {
    /* ignore */
  }
}

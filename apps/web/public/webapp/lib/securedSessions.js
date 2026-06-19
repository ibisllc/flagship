// Web-experience gating — held "secured sessions" store
// (docs/service-access-gating.md, "Web-experience gating").
//
// When the webapp AUTHORIZES a browser's QR-login knock, the box returns a
// phone-held `secretId` (never to the knocking browser). We keep a local record
// of that session so Settings → "Open secured sessions" can list it and let the
// owner check its liveness or stop it. The `secretId` is the only sensitive bit,
// and it's a SESSION HANDLE (a capability to query/close ONE browser session),
// not key material — so it lives in plain localStorage like other device-local
// session state, not the UMK-wrapped IndexedDB the AI keys use.
//
// Pure + framework-free (storage injected) so it unit-tests without a DOM; the
// view (views/secured-sessions.js) is the only thing that renders it.

const STORE_KEY = "flagship.securedSessions.v1";

/** Debounce window for a per-session liveness re-check — the box rate-limits
 *  ~1/min/secretId (429), so the UI must not poll faster than this. */
export const STATUS_DEBOUNCE_MS = 60_000;

function defaultStorage() {
  return typeof globalThis !== "undefined" ? globalThis.localStorage : undefined;
}

function readAll(storage) {
  if (!storage) return [];
  let raw;
  try {
    raw = storage.getItem(STORE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSession) : [];
  } catch {
    return [];
  }
}

function writeAll(storage, list) {
  if (!storage) return;
  try {
    storage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* private-mode / quota — best-effort */
  }
}

function isSession(s) {
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.secretId === "string" &&
    /^[0-9a-f]{64}$/i.test(s.secretId) &&
    typeof s.serverId === "string" &&
    typeof s.serviceRef === "string"
  );
}

/**
 * Normalize an authorize result into the stored shape. `serviceUrl` is the
 * tier-1 canonical `https://<svc>.<server>` (falls back to the box root when
 * the svc label is unknown).
 * @param {object} s
 * @returns {object}
 */
function normalize(s) {
  const serviceUrl =
    typeof s.serviceUrl === "string" && s.serviceUrl
      ? s.serviceUrl
      : s.svc && s.serverId
        ? `https://${s.svc}.${s.serverId}`
        : s.serverId
          ? `https://${s.serverId}`
          : "";
  return {
    secretId: s.secretId,
    serverId: s.serverId,
    serviceRef: s.serviceRef,
    serviceUrl,
    browserAgent: typeof s.browserAgent === "string" ? s.browserAgent : "",
    startedAt: typeof s.startedAt === "number" ? s.startedAt : Date.now(),
  };
}

/** All held sessions, newest first. */
export function listSecuredSessions(storage = defaultStorage()) {
  const list = readAll(storage).map(normalize);
  list.sort((a, b) => b.startedAt - a.startedAt);
  return list;
}

/**
 * Persist (or replace, by secretId) a held session. Returns the stored record.
 * @param {object} session  an authorize result ({ secretId, serverId, serviceRef, svc?|serviceUrl?, browserAgent?, startedAt? })
 */
export function saveSecuredSession(session, storage = defaultStorage()) {
  const record = normalize(session);
  if (!isSession(record)) throw new Error("invalid secured session");
  const list = readAll(storage).filter((s) => s.secretId !== record.secretId);
  list.push(record);
  writeAll(storage, list);
  return record;
}

/** Drop a held session by secretId (after a successful close, or to forget it). */
export function removeSecuredSession(secretId, storage = defaultStorage()) {
  const list = readAll(storage).filter((s) => s.secretId !== secretId);
  writeAll(storage, list);
}

/** Forget every held session (used by a device reset). */
export function clearSecuredSessions(storage = defaultStorage()) {
  writeAll(storage, []);
}

/**
 * Should a per-session liveness re-check be allowed now? The box rate-limits
 * ~1/min/secretId, so the UI debounces to `STATUS_DEBOUNCE_MS`. `lastCheckedAt`
 * is the local clock at the previous check (undefined ⇒ never checked ⇒ allow).
 * @param {number|undefined} lastCheckedAt
 * @param {number} [now]
 * @returns {boolean}
 */
export function canCheckStatus(lastCheckedAt, now = Date.now()) {
  if (typeof lastCheckedAt !== "number") return true;
  return now - lastCheckedAt >= STATUS_DEBOUNCE_MS;
}

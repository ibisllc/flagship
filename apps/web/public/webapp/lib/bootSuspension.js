// Durable lock for a server (SEC-LOCK-001, SEC-DEADMAN-001): the webapp's side.
//
// Locking is two independent things and they are reported separately:
//   1. the BOOT SUSPENSION at the boot worker: an owner-signed record that stops
//      every auto-unlock lease for this server from being released until the
//      owner resumes. This is the lock. It outlives the box being stolen.
//   2. the POWER order sent straight to the box.
//
// "Lock and turn off" sends both at once and never delays the power order for
// the worker. "Lock and restart" waits for the worker's durable acknowledgement
// first and offers to shut down instead when it can't get one: a reboot into a
// lease that was never revoked is exactly what this exists to prevent.
//
// Canonical bytes mirror @flagship/protocol bootSuspension.ts exactly (shared
// vectors: packages/protocol/test-vectors/boot-suspension/vectors.json).

import { signWithIrk as defaultSignWithIrk, deriveIrkFromSeed, bytesToHex } from "../keystore.js";
import { getSession } from "./state.js";
import { bootOrigin } from "./apex.js";

export const TAG_BOOT_SUSPENSION = "flagship/boot-suspension/v1";
const TAG_BOOT_AUTH = "flagship/boot-auth/v1";
const PENDING_KEY = "flagship.pendingLocks.v1";

function te(s) {
  return new TextEncoder().encode(s);
}

function guard(name, value) {
  const s = String(value);
  if (s.length === 0) throw new Error(`boot-suspension: empty ${name}`);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error(`boot-suspension: bad character in ${name}`);
  }
}

/** `flagship/boot-suspension/v1|<serverDomain>|<epoch>|<seq>|<action>|<reason>|<signer>|<issuedAt>` */
export function canonicalBootSuspensionBytes(o) {
  guard("serverDomain", o.serverDomain);
  guard("reason", o.reason);
  for (const [n, v] of [["epoch", o.epoch], ["seq", o.seq], ["issuedAt", o.issuedAt]]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`boot-suspension: bad ${n}`);
  }
  if (o.action !== "suspend" && o.action !== "resume") throw new Error("boot-suspension: bad action");
  if (o.signer !== "owner" && o.signer !== "box") throw new Error("boot-suspension: bad signer");
  return te([TAG_BOOT_SUSPENSION, o.serverDomain, o.epoch, o.seq, o.action, o.reason, o.signer, o.issuedAt].join("|"));
}

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function ownerPubHex(session, deps) {
  if (deps.irkPubHex) return deps.irkPubHex;
  if (session.irk?.publicKey) return bytesToHex(session.irk.publicKey);
  return bytesToHex((await deriveIrkFromSeed(session.umk)).publicKey);
}

/** The owner-IRK `Authorization: Flagship-Boot-v1 …` header the boot worker's gate checks. */
export async function ownerBootAuthHeader({ serverDomain, method, path }, session, deps = {}) {
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const envelope = {
    role: "owner",
    serverDomain,
    method: method.toUpperCase(),
    path,
    pubKeyHex: await ownerPubHex(session, deps),
    nonceHex: randomHex(32),
    issuedAt: (deps.now || Date.now)(),
  };
  const canonical = te(
    [TAG_BOOT_AUTH, envelope.role, serverDomain, envelope.method, path, envelope.pubKeyHex.toLowerCase(), envelope.nonceHex, envelope.issuedAt].join("|"),
  );
  const sig = await sign(session.umk, canonical);
  return `Flagship-Boot-v1 ${b64url(te(JSON.stringify({ ...envelope, signatureHex: bytesToHex(sig) })))}`;
}

function sessionOrThrow(deps) {
  const session = deps.session || getSession();
  if (!session?.umk) throw Object.assign(new Error("Unlock the webapp first"), { code: "locked" });
  return session;
}

function bootBase(deps) {
  return (deps.bootBase || bootOrigin()).replace(/\/+$/, "");
}

/** The boot worker's record for this server, or null when it can't be read. */
export async function readSuspension(serverDomain, deps = {}) {
  const session = sessionOrThrow(deps);
  const f = deps.fetch || fetch;
  const path = `/api/boot/suspension/${serverDomain}`;
  try {
    const r = await f(`${bootBase(deps)}${path}`, {
      method: "GET",
      headers: { authorization: await ownerBootAuthHeader({ serverDomain, method: "GET", path }, session, deps) },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j.suspended !== "boolean" || !Number.isSafeInteger(j.epoch)) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * Lock or resume: sign an owner order for epoch + 1 and PUT it. Re-reads and
 * retries when the record moved (a stale epoch). `durable` is true only when the
 * worker says it wrote the record; anything else is reported as not locked.
 */
export async function setOwnerSuspension(serverDomain, action, deps = {}) {
  const session = sessionOrThrow(deps);
  const f = deps.fetch || fetch;
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const reason = action === "suspend" ? deps.reason || "manual-lock" : "owner-resume";
  let last = { durable: false, why: "unreachable" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await readSuspension(serverDomain, deps);
    if (cur === null) return last;
    if (action === "suspend" && cur.suspended && attempt === 0 && deps.reuseExisting !== false) {
      return { durable: true, state: cur, leasesRevoked: 0, alreadySuspended: true };
    }
    if (action === "resume" && !cur.suspended) return { durable: true, state: cur, leasesRevoked: 0 };
    const order = {
      serverDomain,
      epoch: cur.epoch + 1,
      seq: 0,
      action,
      reason,
      signer: "owner",
      issuedAt: (deps.now || Date.now)(),
    };
    const sig = await sign(session.umk, canonicalBootSuspensionBytes(order));
    const path = "/api/boot/suspension";
    try {
      const r = await f(`${bootBase(deps)}${path}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: await ownerBootAuthHeader({ serverDomain, method: "PUT", path }, session, deps),
        },
        body: JSON.stringify({ order, signature: bytesToHex(sig) }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.durable === true) return { durable: true, state: body.state, leasesRevoked: body.leasesRevoked ?? 0 };
      if (r.status === 409) {
        last = { durable: false, why: "moved" };
        continue; // re-read and try the next epoch
      }
      if (r.status === 503) return { durable: false, why: "not-durable" };
      return { durable: false, why: "refused", status: r.status };
    } catch {
      last = { durable: false, why: "unreachable" };
    }
  }
  return last;
}

// ── pending locks: a lock the worker didn't confirm keeps retrying ──────────

function storage(deps) {
  return deps.storage || (typeof localStorage !== "undefined" ? localStorage : null);
}

export function pendingLocks(deps = {}) {
  try {
    const raw = storage(deps)?.getItem(PENDING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function savePending(list, deps) {
  try {
    storage(deps)?.setItem(PENDING_KEY, JSON.stringify([...new Set(list)]));
  } catch {
    // no storage: the lock is still reported as pending in this session
  }
}

export function markLockPending(serverDomain, deps = {}) {
  savePending([...pendingLocks(deps), serverDomain], deps);
}

export function clearLockPending(serverDomain, deps = {}) {
  savePending(pendingLocks(deps).filter((s) => s !== serverDomain), deps);
}

/** Try every lock the worker hasn't confirmed yet. Returns the ones that landed. */
export async function retryPendingLocks(deps = {}) {
  const done = [];
  for (const server of pendingLocks(deps)) {
    const r = await setOwnerSuspension(server, "suspend", { ...deps, reason: "manual-lock" }).catch(() => ({ durable: false }));
    if (r.durable) {
      clearLockPending(server, deps);
      done.push(server);
    }
  }
  return done;
}

/**
 * Lock a server and power it off or restart it. The two outcomes are returned
 * separately so the screen can say exactly what happened.
 *
 *   mode "off":     both at once; the power order never waits for the worker.
 *   mode "restart": the lock first; no restart unless it's durable.
 *
 * @returns {{ lock: "confirmed"|"pending", power: "sent"|"failed"|"not-sent", needsChoice?: "shutdown-instead", detail?: any }}
 */
export async function lockAndPower({ serverDomain, mode, sendPower }, deps = {}) {
  if (mode !== "off" && mode !== "restart") throw new Error(`invalid power mode: ${String(mode)}`);
  if (mode === "restart") {
    const lock = await setOwnerSuspension(serverDomain, "suspend", deps);
    if (!lock.durable) {
      markLockPending(serverDomain, deps);
      return { lock: "pending", power: "not-sent", needsChoice: "shutdown-instead", detail: lock };
    }
    const power = await sendPower("restart").then(() => "sent", () => "failed");
    return { lock: "confirmed", power, detail: lock };
  }
  const [lock, power] = await Promise.all([
    setOwnerSuspension(serverDomain, "suspend", deps).catch((e) => ({ durable: false, why: String(e?.message || e) })),
    sendPower("off").then(() => "sent", () => "failed"),
  ]);
  if (!lock.durable) markLockPending(serverDomain, deps);
  return { lock: lock.durable ? "confirmed" : "pending", power, detail: lock };
}

/** The sentence a screen shows for a lockAndPower result: never "locked" for less. */
export function describeLockResult(r) {
  if (r.needsChoice === "shutdown-instead") {
    return "Couldn't lock this server at the boot service, so it was not restarted. Shut it down instead? It will lock as soon as the service answers.";
  }
  const power = r.power === "sent" ? "The server is powering off" : r.power === "failed" ? "The power command didn't reach the server" : "";
  const lock = r.lock === "confirmed" ? "locked: it can't unlock itself until you resume it" : "remote lock pending: it will be retried";
  if (!power) return `Locked at the boot service: ${lock}.`;
  return `${power}; ${lock}.`;
}

// ── dead-man: a lease never outlives the affirmation ────────────────────────

/** The latest moment an auto-unlock lease may expire, or null when no switch is on. */
export function leaseCapForDeadMan(deadMan, now = Date.now()) {
  if (!deadMan || deadMan.enabled !== true) return null;
  return Math.max(now, Number(deadMan.leaseExpiry) || 0);
}

/**
 * The TTL for a new lease: the normal TTL, shortened to the dead-man
 * affirmation deadline. Returns 0 when the switch has already lapsed (no lease).
 */
export function boundedLeaseTtl(ttlMs, deadMan, now = Date.now()) {
  if (!deadMan || deadMan.enabled !== true) return ttlMs;
  const deadline = Number(deadMan.leaseExpiry) || 0;
  if (deadline <= now) return 0;
  return Math.min(ttlMs, deadline - now);
}

// ── the box's dead-man switch, remembered so renewals can bound themselves ──

const DEADMAN_KEY = "flagship.deadManView.v1";
const DEADMAN_FRESH_MS = 6 * 60 * 60 * 1000;

function readViews(deps) {
  try {
    const raw = storage(deps)?.getItem(DEADMAN_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** Remember what the box said about its switch. `view` null means "this box has none". */
export function rememberDeadManView(serverDomain, view, deps = {}) {
  const all = readViews(deps);
  all[serverDomain] = { view: view ?? { enabled: false, leaseExpiry: 0 }, at: (deps.now || Date.now)() };
  try {
    storage(deps)?.setItem(DEADMAN_KEY, JSON.stringify(all));
  } catch {
    // nothing to remember into; renewals will treat the switch as unknown
  }
}

/** The remembered switch, or undefined when we have no fresh answer (unknown ⇒ do not renew silently). */
export function cachedDeadManView(serverDomain, deps = {}) {
  const e = readViews(deps)[serverDomain];
  if (!e || typeof e.at !== "number") return undefined;
  if ((deps.now || Date.now)() - e.at > DEADMAN_FRESH_MS) return undefined;
  return e.view;
}

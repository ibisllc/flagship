// The owner's server order (docs/server-order.md).
//
// The owner ranks their servers on Home by dragging them; the first one that
// is up is the leader, and the role passes down the list while it is down.
// The order is a sensitive order, signed with the admin master root when this
// account holds one, else the IRK:
//
//   flagship/server-order/v1|<user>|<stk1>,<stk2>,…|<issuedAt ms>|<nonce>
//
// `.com` keeps the newest per account (`POST /api/accounts/<u>/server-order`)
// and returns it on `/pods` as `serverOrder`; boxes re-verify it. After a
// save the browser also hands it to every online box it has a session for
// (`POST /api/screens/server-order`), and each box's `heldIssuedAt` answer,
// like `/pods` `orderIssuedAt`, says which order that box holds.
//
// Must pass packages/protocol/test-vectors/server-order/vectors.json.

import { getSession } from "./state.js";
import { bytesToHex } from "../keystore.js";
import { sensitiveSigner } from "./adminRoot.js";
import { controlApex } from "./apex.js";
import { getActiveProfile } from "./profiles.js";
import { isDemoProfile } from "./demoAccount.js";
import { boxClient } from "./api.js";

import { tr } from "./i18n.js";
export const TAG_SERVER_ORDER = "flagship/server-order/v1";
export const SERVER_ORDER_MAX = 64;
const STORAGE_PREFIX = "flagship.serverOrder.";
const HEX64 = /^[0-9a-f]{64}$/;

/** The canonical bytes; throws on anything the protocol refuses. */
export function canonicalServerOrderBytes(order) {
  const user = String(order?.user ?? "");
  if (!user || /[|\x00-\x1f\x7f]/.test(user)) throw new Error("user is not a valid account name");
  const stks = order?.stks;
  if (!Array.isArray(stks) || stks.length === 0 || stks.length > SERVER_ORDER_MAX) {
    throw new Error(`stks must list 1..${SERVER_ORDER_MAX} servers`);
  }
  const seen = new Set();
  for (const s of stks) {
    if (typeof s !== "string" || !HEX64.test(s)) throw new Error("each stk must be 32-byte lowercase hex");
    if (seen.has(s)) throw new Error("stks must not repeat");
    seen.add(s);
  }
  if (typeof order.nonce !== "string" || !HEX64.test(order.nonce)) throw new Error("nonce must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(order.issuedAt) || order.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return new TextEncoder().encode(
    [TAG_SERVER_ORDER, user.toLowerCase(), stks.join(","), order.issuedAt, order.nonce].join("|"),
  );
}

/** Sign `{user, stks}` into the wire form `{order, signature}`. */
export async function buildSignedServerOrder({ username, stks }, deps = {}) {
  const session = getSession();
  const umk = deps.umk ?? session?.umk;
  if (!umk) throw new Error("unlock the webapp first");
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const order = {
    user: String(username).toLowerCase(),
    stks: stks.map((s) => String(s).toLowerCase()),
    issuedAt: (deps.now ?? Date.now)(),
    nonce: deps.nonceHex ?? bytesToHex(nonce),
  };
  const sign = deps.sign ?? sensitiveSigner();
  const sig = await sign(umk, canonicalServerOrderBytes(order));
  return { order, signature: bytesToHex(sig) };
}

// ── The order this browser knows, per account ─────────────────────────

/** @type {Map<string, { stks: string[], issuedAt: number }>} */
const known = new Map();
const listeners = new Set();

/** Hear every change to a known order (Home repaints from it, so a server
 *  made leader elsewhere is already first, and moves back on a failure). */
export function onServerOrderChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(username) {
  for (const fn of listeners) {
    try {
      fn(username);
    } catch {
      /* a listener's failure never blocks the save */
    }
  }
}

function storage(deps) {
  return deps?.storage ?? globalThis.localStorage;
}

function readStored(username, deps) {
  try {
    const raw = storage(deps)?.getItem(STORAGE_PREFIX + username);
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.stks) && typeof v.issuedAt === "number") return v;
  } catch {
    /* private mode / junk */
  }
  return null;
}

function writeStored(username, v, deps) {
  try {
    if (v) storage(deps)?.setItem(STORAGE_PREFIX + username, JSON.stringify(v));
    else storage(deps)?.removeItem(STORAGE_PREFIX + username);
  } catch {
    /* the in-memory copy still holds */
  }
}

function knownOrder(username, deps) {
  const u = String(username ?? "").toLowerCase();
  if (!u) return null;
  if (!known.has(u)) {
    const stored = readStored(u, deps);
    if (stored) known.set(u, stored);
  }
  return known.get(u) ?? null;
}

/** Record the order `.com` returned (`/pods` `serverOrder`); the newest wins. */
export function rememberServerOrder(username, wire, deps = {}) {
  const u = String(username ?? "").toLowerCase();
  const o = wire?.order;
  if (!u || !o || !Array.isArray(o.stks) || typeof o.issuedAt !== "number") return;
  if (String(o.user ?? "").toLowerCase() !== u) return;
  const current = knownOrder(u, deps);
  if (current && current.issuedAt >= o.issuedAt) return;
  const v = { stks: o.stks.map((s) => String(s).toLowerCase()), issuedAt: o.issuedAt };
  known.set(u, v);
  writeStored(u, v, deps);
  changed(u);
}

/** Replace the known order outright (a local reorder, or putting one back). */
export function setKnownServerOrder(username, v, deps = {}) {
  const u = String(username ?? "").toLowerCase();
  if (!u) return;
  if (v) known.set(u, { stks: [...v.stks], issuedAt: v.issuedAt });
  else known.delete(u);
  writeStored(u, v, deps);
  changed(u);
}

/** The account's order as `{stks, issuedAt}`, or null. */
export function serverOrderOf(username, deps = {}) {
  const v = knownOrder(username, deps);
  return v ? { stks: [...v.stks], issuedAt: v.issuedAt } : null;
}

/** The signed-in account's order (STKs, first = leader), [] when none. */
export function currentServerOrder(deps = {}) {
  return serverOrderOf(getSession()?.username, deps)?.stks ?? [];
}

export function _resetServerOrdersForTests() {
  known.clear();
  acks.clear();
}

// ── Which order each box holds ─────────────────────────────────────────

/** @type {Map<string, number>} box FQDN → the newest `issuedAt` it said it holds. */
const acks = new Map();

/** Record that a box holds the order issued at `issuedAt`. Acks only move
 *  forward; a newer one repaints whoever listens to order changes. */
export function recordServerOrderAck(fqdn, issuedAt) {
  const f = String(fqdn ?? "").trim().toLowerCase();
  if (!f || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return;
  if ((acks.get(f) ?? 0) >= issuedAt) return;
  acks.set(f, issuedAt);
  changed(getSession()?.username ?? "");
}

/** The `issuedAt` of the newest order a `/pods` row's box is known to hold:
 *  the larger of its `/pods` `orderIssuedAt` and what it answered directly. */
export function orderAckOf(pod) {
  const fromPods = typeof pod?.orderIssuedAt === "number" ? pod.orderIssuedAt : 0;
  const direct = acks.get(String(pod?.serverDomain ?? pod?.fqdn ?? "").trim().toLowerCase()) ?? 0;
  const best = Math.max(fromPods, direct);
  return best > 0 ? best : null;
}

const RECENT_REPORT_MS = 15 * 60_000;

function deliveryTargets(pods, now) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(pods) ? pods : []) {
    const fqdn = String(p?.serverDomain ?? p?.fqdn ?? "").trim().toLowerCase();
    if (!fqdn || p?.revokedAt != null || seen.has(fqdn)) continue;
    const online = p?.liveness != null
      ? p.liveness === "live"
      : p?.lastReported != null && now - p.lastReported <= RECENT_REPORT_MS;
    if (!online) continue;
    seen.add(fqdn);
    out.push(fqdn);
  }
  return out;
}

/**
 * Hand a saved order to every online box this browser has a session for, so
 * each acts on it now rather than at its next check-in with `.com` (which
 * still delivers it to the rest). Failures are ignored; every answer that
 * names `heldIssuedAt` (a refusal too) is recorded as that box's ack.
 *
 * @param {{order: object, signature: string}} wire
 * @param {object[]} pods `/pods` rows
 * @returns {Promise<Array<{fqdn: string, heldIssuedAt: number | null}>>}
 */
export async function deliverServerOrder(wire, pods, deps = {}) {
  const clientFor = deps.clientFor ?? boxClient;
  const now = (deps.now ?? Date.now)();
  const sends = deliveryTargets(pods, now).map(async (fqdn) => {
    const client = clientFor(fqdn);
    if (!client?.hasSession?.()) return null;
    let held = null;
    try {
      const body = await client.fetch("/api/screens/server-order", { method: "POST", body: JSON.stringify(wire) });
      held = body?.heldIssuedAt;
    } catch (e) {
      held = e?.body?.heldIssuedAt;
    }
    const heldIssuedAt = Number.isSafeInteger(held) ? held : null;
    if (heldIssuedAt != null) recordServerOrderAck(fqdn, heldIssuedAt);
    return { fqdn, heldIssuedAt };
  });
  return (await Promise.all(sends)).filter(Boolean);
}

// ── Ranking ────────────────────────────────────────────────────────────

/**
 * Rank rows by the order: listed ones in list order, then the rest oldest
 * first, then by domain. Each row gives `{stk, birthDate, domain}` through
 * `key(row)`. Returns a new sorted array.
 */
export function rankByServerOrder(rows, stks, key = (r) => r) {
  const pos = new Map((stks ?? []).map((s, i) => [String(s).toLowerCase(), i]));
  const rank = (r) => pos.get(String(key(r).stk ?? "").toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return rank(a) - rank(b)
      || (ka.birthDate ?? 0) - (kb.birthDate ?? 0)
      || (ka.domain < kb.domain ? -1 : ka.domain > kb.domain ? 1 : 0);
  });
}

/** `/pods` rows ranked by the order. */
export function rankPods(pods, stks) {
  return rankByServerOrder(pods, stks, (p) => ({
    stk: p?.identityPubKey ?? "",
    birthDate: p?.registeredAt ?? 0,
    domain: String(p?.serverDomain ?? p?.fqdn ?? "").toLowerCase(),
  }));
}

/**
 * Leader and line positions for an already-ranked list. `isOnline(row)` says
 * whether a row is up. Returns `{ leaderIndex, standingInFor }`: the first
 * online row (-1 when none), and the rows above it that are down.
 */
export function leadershipOf(ranked, isOnline) {
  const leaderIndex = ranked.findIndex((r) => isOnline(r));
  return { leaderIndex, standingInFor: leaderIndex > 0 ? ranked.slice(0, leaderIndex) : [] };
}

/**
 * Whether the Leader badge is confirmed: no drag is in progress, and the
 * leader reports holding the order on screen (`/pods` `orderIssuedAt` is the
 * `issuedAt` of the order that box last reported). With no order ever saved
 * (`orderIssuedAt` 0) there is nothing to confirm.
 *
 * @param {{ dragging?: boolean, orderIssuedAt?: number, leaderOrderIssuedAt?: number | null }} args
 */
export function isLeaderConfirmed({ dragging = false, orderIssuedAt = 0, leaderOrderIssuedAt = null } = {}) {
  if (dragging) return false;
  if (!orderIssuedAt) return true;
  return typeof leaderOrderIssuedAt === "number" && leaderOrderIssuedAt >= orderIssuedAt;
}

/** Move `stk` to the top of `stks` (adding it when absent). */
export function moveToTop(stks, stk) {
  const s = String(stk).toLowerCase();
  return [s, ...stks.filter((x) => x !== s)];
}

/** Move the item at `from` to `to` in a copy of `list`. */
export function moveItem(list, from, to) {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Make `stk` the leader: move it to the top of the known order (servers not
 *  yet listed follow in `ranked`, the current Home order) and save it. */
export async function makeLeader(stk, rankedStks = currentServerOrder(), deps = {}) {
  return saveServerOrder({ stks: moveToTop(rankedStks, stk) }, deps);
}

// ── Saving ─────────────────────────────────────────────────────────────

export class ServerOrderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The server order is a sensitive order (admin root, docs/server-order.md):
 *  `.com` refuses it from a device that doesn't hold the admin root, so such a
 *  device sees the order without the controls to change it. */
export const SERVER_ORDER_ADMIN_ONLY = tr("Only an admin device can change the server order.");

/** The toast for a failed save: a newer order saved on another device says
 *  so in its own words; anything else gets the caller's usual copy. */
export function serverOrderFailureText(e, fallback) {
  return e instanceof ServerOrderError && e.status === 409 ? e.message : fallback(e);
}

/**
 * Save the owner's new order. The browser shows it at once; a demo account
 * keeps it here only. A real account signs it and posts it to `.com`; on any
 * failure the previous order is put back and the error says why (status 409:
 * a newer order exists, reload `/pods`).
 *
 * Once `.com` takes it, the order goes on to the online boxes in `deps.pods`
 * without holding up the save (`delivered` settles when they've answered).
 *
 * @param {{ stks: string[] }} args
 * @param {{ fetch?: typeof fetch, comBase?: string, sign?: Function, now?: () => number, storage?: Storage, demo?: boolean, pods?: object[], clientFor?: Function }} [deps]
 * @returns {Promise<{ ok: true, local: boolean, stks: string[], delivered?: Promise<unknown> }>}
 */
export async function saveServerOrder({ stks }, deps = {}) {
  const session = getSession();
  const username = String(session?.username ?? "").toLowerCase();
  if (!username) throw new Error("sign in first");
  const list = stks.map((s) => String(s).toLowerCase()).filter((s) => HEX64.test(s));
  if (!list.length) throw new Error("there are no servers to order yet");
  const previous = serverOrderOf(username, deps);
  const now = (deps.now ?? Date.now)();
  const demo = deps.demo ?? isDemoProfile(getActiveProfile());
  setKnownServerOrder(username, { stks: list, issuedAt: now }, deps);
  if (demo) return { ok: true, local: true, stks: list };
  try {
    const wire = await buildSignedServerOrder({ username, stks: list }, { ...deps, now: () => now });
    const comBase = deps.comBase ?? controlApex();
    const r = await (deps.fetch ?? fetch)(`${comBase}/api/accounts/${encodeURIComponent(username)}/server-order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wire),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const reason = r.status === 409
        ? tr("Another device changed the order. Showing the latest one.")
        : String(body?.error ?? `HTTP ${r.status}`);
      throw new ServerOrderError(reason, r.status);
    }
    const delivered = deliverServerOrder(wire, deps.pods ?? [], deps).catch(() => []);
    return { ok: true, local: false, stks: list, delivered };
  } catch (e) {
    setKnownServerOrder(username, previous, deps);
    throw e;
  }
}

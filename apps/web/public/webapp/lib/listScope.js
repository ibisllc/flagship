// Separate access list per server, a Pro option (docs/service-access-gating.md,
// "Separate lists per server (Pro)"; feat/marketplace only).
//
// An app's access list is one list across the account's servers. An admin can
// sign flagship/app-list-scope/v1 to give it a separate list on each server
// ("server") or to go back to one ("account", every server then takes the
// app's lead server's list). The box honours "server" only while it holds a
// CA-signed attestation that the account is Pro. Canonical bytes:
//
//   flagship/app-list-scope/v1|<serviceRef>|<account|server>|<issuedAt>
//
// test-vectors/app-list-scope/vectors.json is the reference.

import { bytesToHex } from "../keystore.js";

import { tr } from "./i18n.js";
export const TAG_APP_LIST_SCOPE = "flagship/app-list-scope/v1";
export const LIST_SCOPES = ["account", "server"];

export const LIST_SCOPE_TITLE = tr("Separate list on each server");
export const LIST_SCOPE_NOTE = tr("Each server keeps its own members and invites.");
export const LIST_SCOPE_PRO_NOTE = tr("Comes with Pro.");
export const LIST_SCOPE_PRO_LINK = tr("See Pro membership");
export const LIST_SCOPE_PENDING = tr("Waiting for this server to confirm Pro.");
export const LIST_SCOPE_READONLY_ON = tr("Each server has its own list.");
export const LIST_SCOPE_ON_TITLE = tr("A separate list on each server?");
export const LIST_SCOPE_ON_CONFIRM = tr("Each server keeps its current list. Changes you make on one server stay on it.");
export const LIST_SCOPE_OFF_TITLE = tr("One list on every server?");
export const PRO_URL = "https://flagshipserver.com/pro";

const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

/** The bytes the admin root signs; throws on anything the box would refuse. */
export function appListScopeCanonicalBytes({ serviceRef, scope, issuedAt }) {
  if (typeof serviceRef !== "string" || !SERVICE_REF_RE.test(serviceRef) || serviceRef.includes("|")) {
    throw new Error(`${TAG_APP_LIST_SCOPE}: bad serviceRef`);
  }
  if (!LIST_SCOPES.includes(scope)) throw new Error(`${TAG_APP_LIST_SCOPE}: bad scope`);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error(`${TAG_APP_LIST_SCOPE}: bad issuedAt`);
  return new TextEncoder().encode([TAG_APP_LIST_SCOPE, serviceRef, scope, String(issuedAt)].join("|"));
}

/** `{order, signature}` for POST …/list-scope, signed by the sensitive-order signer. */
export async function signListScope({ serviceRef, scope, issuedAt, umk, signWithIrk }) {
  const order = { serviceRef, scope, issuedAt };
  const sig = await signWithIrk(umk, appListScopeCanonicalBytes(order));
  return { order, signature: bytesToHex(sig) };
}

const scopePath = (serviceRef) => `/api/screens/services/${encodeURIComponent(serviceRef)}/list-scope`;
export const SUMMARY_PATH = "/api/screens/access-lists/summary";

/** The app's scope on one server; null when that server can't say (older box, offline). */
export async function fetchListScope(serviceRef, { fetchJson }) {
  try {
    return normalizeListScope(await fetchJson(scopePath(serviceRef)));
  } catch {
    return null;
  }
}

export function normalizeListScope(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lower = (v) => (typeof v === "string" ? v.toLowerCase() : "");
  const servers = Array.isArray(raw.servers) ? raw.servers.map(lower).filter(Boolean) : [];
  return {
    serviceRef: typeof raw.serviceRef === "string" ? raw.serviceRef : "",
    scope: raw.scope === "server" ? "server" : "account",
    pending: raw.pending === true,
    plan: raw.plan === "pro" || raw.plan === "free" ? raw.plan : "unknown",
    self: lower(raw.self),
    leader: lower(raw.leader),
    servers: [...new Set(servers)],
  };
}

/** Sign and post the switch; resolves to the new state. A 402 rejects with `code: "pro-required"`. */
export async function setListScope({ serviceRef, scope, umk, signWithIrk, fetchJson, now = Date.now }) {
  if (!umk || typeof signWithIrk !== "function") throw new Error(tr("Unlock the webapp first"));
  const body = await signListScope({ serviceRef, scope, issuedAt: now(), umk, signWithIrk });
  return normalizeListScope(await fetchJson(scopePath(serviceRef), { method: "POST", body: JSON.stringify(body) }));
}

/** `{plan, separateApps, leaders}` across the account; null on any failure. */
export async function fetchSeparateListsSummary({ fetchJson }) {
  try {
    const r = await fetchJson(SUMMARY_PATH);
    if (!r || typeof r !== "object") return null;
    return {
      plan: r.plan === "pro" || r.plan === "free" ? r.plan : "unknown",
      separateApps: Number.isInteger(r.separateApps) && r.separateApps > 0 ? r.separateApps : 0,
      leaders: Array.isArray(r.leaders) ? r.leaders.filter((x) => typeof x === "string").map((x) => x.toLowerCase()) : [],
    };
  } catch {
    return null;
  }
}

/** A server's name for these lines: its first DNS label. */
export function serverName(fqdn) {
  const s = String(fqdn ?? "").trim().toLowerCase();
  return s.split(".")[0] || s;
}

export function listScopeOffConfirm(leader, nameOf = serverName) {
  return tr("Every server will use {0}'s list. People who joined on other servers since lose access.", nameOf(leader));
}

/** Whether the switch can be turned on here (it can always be turned off). */
export function canTurnOn(state) {
  return !!state && state.plan === "pro";
}

/** The plan screen's warning; null when there is nothing to warn about. */
export function separateListsWarning(summary, nameOf = serverName) {
  if (!summary || summary.plan !== "pro" || !(summary.separateApps > 0)) return null;
  const n = summary.separateApps;
  const leaders = [...new Set(summary.leaders ?? [])];
  if (n === 1) {
    return leaders.length === 1
      ? tr("1 app has a separate access list on each server. When Pro ends it will use {0}'s list.", nameOf(leaders[0]))
      : tr("1 app has a separate access list on each server. When Pro ends it will use its lead server's list.");
  }
  return leaders.length === 1
    ? tr("{0} apps have a separate access list on each server. When Pro ends they'll all use {1}'s list.", n, nameOf(leaders[0]))
    : tr("{0} apps have a separate access list on each server. When Pro ends each will use its lead server's list.", n);
}

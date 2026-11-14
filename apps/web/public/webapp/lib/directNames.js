// Direct access on `.com` (docs/direct-access-and-domains.md §8):
//
//   GET  /api/accounts/:u/direct-access                 read token
//   POST /api/accounts/:u/direct-access                 the owner's signed direct-access order
//   POST /api/accounts/:u/direct-names                  the owner's signed direct-name order
//   POST /api/accounts/:u/direct-names/:label/probe     read token, the outside check
//
// and the app's own sentence for every refusal code, publish state and probe
// answer. Mirrors iOS DirectNamesClient.swift (DirectAccessText).

import { controlApex } from "./apex.js";
import { accountReadFetch } from "./accountRead.js";
import { DIRECT_APEX } from "./directName.js";

import { tr } from "./i18n.js";

/** A refusal from `.com` or the box: `code` picks the sentence. */
export class DirectAccessRefusal extends Error {
  constructor(status, body) {
    const code = body && typeof body.code === "string" ? body.code : null;
    const message = body && typeof body.error === "string" ? body.error : null;
    super(directRefusalText(code, message));
    this.name = "DirectAccessRefusal";
    this.status = status;
    this.code = code;
    this.userMessage = this.message;
  }
}

/** The sentence for a refusal code; `fallback` (the other side's own sentence) for a code we don't know. */
export function directRefusalText(code, fallback = null) {
  switch (code) {
    case "malformed":
    case "bad-time":
    case "off-with-addresses":
    case "bad-caa":
    case "no-server":
      return tr("That change couldn't be read. Try again.");
    case "private-address":
      return tr("Only public addresses can be used. Private, local and reserved addresses can't.");
    case "bad-address":
    case "non-canonical-address":
      return tr("One of the addresses isn't an IP address.");
    case "bad-prefix":
      return tr("One of the address ranges isn't valid.");
    case "prefix-too-wide":
      return tr("An address range is too wide. Use an IPv6 /32 or longer, or an IPv4 /24 or longer.");
    case "no-addresses":
      return tr("Add at least one public address or address range.");
    case "too-many":
      return tr("Too many addresses: at most 8 addresses and 4 ranges.");
    case "duplicate":
      return tr("An address is listed twice.");
    case "bad-port":
      return tr("The port must be a number from 1 to 65535.");
    case "bad-name":
      return tr("That name can't be used on fshp.app.");
    case "not-yet-valid":
    case "stale":
      return tr("This device's clock is off. Check the time and try again.");
    case "unknown-account":
      return tr("This account wasn't found.");
    case "not-your-server":
    case "wrong-server":
    case "unknown-server":
      return tr("That server isn't one of this account's servers.");
    case "not-admin":
      return tr("Only an admin device of this account can change direct access.");
    case "replayed":
      return tr("A newer change is already saved. Reload and try again.");
    case "vanity-not-available":
      return tr("Chosen names on fshp.app aren't available yet.");
    case "not-your-name":
      return tr("A direct name must end in this account's own name.");
    case "taken":
      return tr("That name belongs to another account.");
    case "unknown-name":
      return tr("This name isn't on this account.");
    case "probe-too-soon":
      return tr("This name was checked a moment ago. Try again in a minute.");
    case "locked":
      return tr("Unlock the webapp first.");
    default:
      if (typeof fallback === "string" && fallback.trim()) return fallback;
      return tr("Direct access couldn't be changed. Try again.");
  }
}

/** Why a name has no records, or null. */
export function directReasonText(code) {
  switch (code) {
    case "off":
      return tr("Turned off.");
    case "suspended":
      return tr("Suspended after an abuse report.");
    case "account-gone":
      return tr("The account is gone.");
    case "server-gone":
      return tr("Its server is no longer on this account.");
    case "order-unverified":
      return tr("Its order no longer checks out under this account's admin key. Turn it on again.");
    case "direct-access-off":
      return tr("Direct access is off on its server.");
    case "no-addresses":
      return tr("Its server hasn't reported a public address yet.");
    case "caa-account-unknown":
      return tr("Waiting for the certificate account. It will be published soon.");
    default:
      return null;
  }
}

/** The line under a name: its state, and why it has no records. */
export function directNameStateText(n) {
  if (n?.suspended) return tr("Suspended after an abuse report.");
  switch (n?.state) {
    case "published":
      return tr("Published");
    case "pending":
      return tr("Waiting to be published");
    default:
      return directReasonText(n?.reason) ?? tr("Not published");
  }
}

export function directProbeText(p) {
  if (p?.reachable === true) return tr("Reachable from outside.");
  if (p?.reachable === false) return tr("Not reachable from outside.");
  return tr("Not published yet, so there is nothing to check.");
}

/** This server's row in `.com`'s state, or null. */
export function serverStateOf(state, serverDomain) {
  const d = String(serverDomain ?? "").toLowerCase();
  return (state?.servers ?? []).find((s) => String(s?.serverDomain ?? "").toLowerCase() === d) ?? null;
}

/** One name's row in `.com`'s state, or null. */
export function nameStateOf(state, fqdn) {
  const n = String(fqdn ?? "").toLowerCase();
  return (state?.names ?? []).find((x) => String(x?.name ?? "").toLowerCase() === n) ?? null;
}

const seg = (s) => encodeURIComponent(String(s).toLowerCase());

async function asBody(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

/** `GET /api/accounts/:u/direct-access` → `{apex, servers, names}`. */
export async function fetchDirectState(username, deps = {}) {
  const origin = deps.origin ?? controlApex();
  const read = deps.accountReadFetch ?? accountReadFetch;
  const r = await read(`${origin}/api/accounts/${seg(username)}/direct-access`, { cache: "no-store" }, { username });
  const body = await asBody(r);
  if (!r.ok) throw new DirectAccessRefusal(r.status, body);
  return {
    apex: typeof body.apex === "string" && body.apex ? body.apex : DIRECT_APEX,
    servers: Array.isArray(body.servers) ? body.servers : [],
    names: Array.isArray(body.names) ? body.names : [],
  };
}

async function post(path, signed, deps) {
  const origin = deps.origin ?? controlApex();
  const f = deps.fetch ?? fetch;
  const r = await f(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  const body = await asBody(r);
  if (!r.ok) throw new DirectAccessRefusal(r.status, body);
  return body;
}

export function postDirectAccessOrder(username, signed, deps = {}) {
  return post(`/api/accounts/${seg(username)}/direct-access`, signed, deps);
}

export function postDirectNameOrder(username, signed, deps = {}) {
  return post(`/api/accounts/${seg(username)}/direct-names`, signed, deps);
}

/** The outside check: `{at, reachable, why?, https?}`. Changes nothing. */
export async function probeDirectName(username, label, deps = {}) {
  const origin = deps.origin ?? controlApex();
  const read = deps.accountReadFetch ?? accountReadFetch;
  const r = await read(`${origin}/api/accounts/${seg(username)}/direct-names/${seg(label)}/probe`, { method: "POST" }, { username });
  const body = await asBody(r);
  if (!r.ok) throw new DirectAccessRefusal(r.status, body);
  return body;
}

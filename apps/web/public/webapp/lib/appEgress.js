// A live app's internet access. An app reaches nothing by default; its
// manifest may declare hosts (`network.egress`) and the box opens exactly the
// hosts of the newest grant the owner signed for it, with the sensitive-order
// key (admin root when held, else the owner IRK). An empty host list revokes.
// docs/ai-privacy-and-staging.md §3.
//
// Canonical bytes (packages/protocol/src/appEgress.ts):
//   flagship/app-egress/v1|<serverDomain>|<serviceId>|<hosts sorted, comma-joined>|<issuedAt ms>

import { requireOwnerProfile } from "./companionGuard.js";

import { tr } from "./i18n.js";
export const TAG_APP_EGRESS = "flagship/app-egress/v1";

export const EGRESS_TITLE = tr("This app wants to reach the internet");
export const EGRESS_NOTE =
  tr("Until you allow them, the app can't reach any of these. Only allow hosts you expect this app to need.");
export const EGRESS_ALLOW = tr("Allow");
export const EGRESS_APPROVED_TITLE = tr("Allowed to reach the internet");
export const EGRESS_STOP = tr("Stop access");
export const EGRESS_PENDING_BADGE = tr("Wants internet");
export const EGRESS_COMPANION_NOTE = tr("Approve this from your owner app.");

/** Distinct, lowercase, sorted by UTF-16 code unit (the box's order). */
export function normalizeEgressHosts(hosts) {
  const set = new Set();
  for (const h of hosts || []) {
    const v = String(h ?? "").trim().toLowerCase();
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function canonicalAppEgressBytes({ serverDomain, serviceId, hosts, issuedAt }) {
  if (!serverDomain) throw new Error("app-egress: empty serverDomain");
  if (!serviceId) throw new Error("app-egress: empty serviceId");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("app-egress: bad issuedAt");
  const sorted = normalizeEgressHosts(hosts);
  return new TextEncoder().encode(
    [TAG_APP_EGRESS, serverDomain, serviceId, sorted.join(","), String(issuedAt)].join("|"),
  );
}

/** `{declared, approved}` from an apps-list entry or app detail, or null
 *  when the box doesn't report it (an older box shows nothing). */
export function readEgress(app) {
  const e = app?.egress;
  if (!e || typeof e !== "object" || !Array.isArray(e.declared) || !Array.isArray(e.approved)) return null;
  return {
    declared: e.declared.filter((h) => typeof h === "string"),
    approved: e.approved.filter((h) => typeof h === "string"),
  };
}

/** Declared hosts the owner hasn't allowed yet. */
export function pendingEgressHosts(egress) {
  if (!egress) return [];
  const approved = new Set(egress.approved);
  return egress.declared.filter((h) => !approved.has(h));
}

/** Whether the app list row shows the "wants internet" badge. */
export function hasPendingEgress(app) {
  return pendingEgressHosts(readEgress(app)).length > 0;
}

/**
 * What the app page shows: nothing (null) without egress info or with
 * nothing declared or approved; otherwise the hosts waiting for approval,
 * the ones allowed, and whether this device can sign (a companion can't).
 */
export function egressCardState(app, { companion = false } = {}) {
  const egress = readEgress(app);
  if (!egress) return null;
  const pending = pendingEgressHosts(egress);
  if (pending.length === 0 && egress.approved.length === 0) return null;
  return { pending, approved: egress.approved.slice(), declared: egress.declared.slice(), canSign: !companion };
}

/** The error the box gave, said plainly. */
export function egressErrorMessage(e) {
  const status = e?.status;
  const raw = typeof e?.body?.error === "string" && e.body.error ? e.body.error : String(e?.message ?? "");
  if (status === 404) return tr("This app isn't installed on this server anymore.");
  if (status === 409) return tr("A newer approval is already in place. Refresh and try again.");
  if (status === 422) return tr("This app no longer asks for some of these hosts ({0}). Refresh and try again.", raw);
  if (status === 403) {
    if (/stale/i.test(raw)) return tr("This device's clock is more than 10 minutes off. Fix the clock and try again.");
    if (/different server/i.test(raw)) return tr("This approval was for a different server.");
    if (/signature/i.test(raw)) return tr("Your server didn't accept this approval's signature.");
    return raw || tr("Your server refused this approval.");
  }
  return raw || tr("Couldn't update this app's internet access.");
}

/**
 * Sign the grant and send it to the box. `hosts` are the ones to allow
 * (all of the declared hosts to allow, [] to stop access). Resolves to the
 * box's new `{declared, approved}`; throws the screens error otherwise.
 *
 * @param {object} args
 * @param {string} args.serverDomain   the box's FQDN
 * @param {string} args.serviceId
 * @param {string[]} args.hosts
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk  the sensitive-order signer
 * @param {(path: string, init: object) => Promise<any>} args.fetchJson  screensFetch
 * @param {(b: Uint8Array) => string} args.bytesToHex
 * @param {{ now?: () => number, requireOwnerProfile?: () => void }} [deps]
 */
export async function sendEgressGrant(args, deps = {}) {
  const { serverDomain, serviceId, hosts, umk, signWithIrk, fetchJson, bytesToHex } = args;
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  if (!umk || typeof signWithIrk !== "function") throw new Error(tr("Unlock the webapp first"));
  const grant = {
    serverDomain,
    serviceId,
    hosts: normalizeEgressHosts(hosts),
    issuedAt: (deps.now || Date.now)(),
  };
  const sig = await signWithIrk(umk, canonicalAppEgressBytes(grant));
  const r = await fetchJson(`/api/screens/services/${encodeURIComponent(serviceId)}/egress`, {
    method: "POST",
    body: JSON.stringify({ grant, signature: bytesToHex(sig) }),
  });
  return readEgress(r) ?? { declared: [], approved: grant.hosts };
}

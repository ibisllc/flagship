// Custom voi.ci names for services (docs/named-links.md).
//
//   GET  /api/users/:u/voici-name-check/:name    read token  — can this account take that name?
//   GET  /api/users/:u/voici-names               read token  — the names this account holds
//   POST /api/users/:u/apps/:serviceId/voici-name  signed     — set, replace or clear a service's name
//
// The service's random code is separate and permanent (voici.ts); this is the
// optional readable name on top of it. A name belongs to ONE service, is a row of
// the names registry (docs/voici-namespace-spec.md: unique on the safety key with
// every username, code and reserved word), counts against the account's plan, and
// is released after 60 days without a server running the app. A name given up for
// any reason is retired for good (D7): it answers 410 and nobody can take it or a
// look-alike of it again, the account that gave it up included.
//
// Changes (docs/named-links.md §2.6): one counted change per service a week and three in 30 days; a change within 15
// minutes of a set is a free correction (once); the account may claim its plan's budget of names in 30 days; giving up
// the name of an app no server runs any more is never limited.
//
// Refusals carry `{ error, code, ... }`; the apps write their own sentences from
// the code (nothing here is shown to a person).

import {
  parseServiceId,
  parseSignedVoiciNameOrder,
  verifyVoiciNameOrder,
  voiciNameProblem,
  type SignedVoiciNameOrder,
  type VoiciNameProblem,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  DeviceCapabilityGrantStorage,
  NameRegistryStorage,
  TierName,
  TierStorage,
  UsernameStorage,
  VoiciLinkStorage,
  VoiciNameRecord,
  VoiciNameReleaseReason,
  VoiciNameStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { recordAuditEvent } from "./auditEvents.js";
import { hexToBytes } from "./hex.js";
import { isReservedName } from "./labels.js";
import { effectiveTierOf } from "./meter.js";
import { dibsWindowState, dotComRegistered, type DibsFetch, type NameDibsDeps } from "./nameDibs.js";
import { forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

const DAY = 86_400_000;

/** Custom names an account may hold at once, by plan (Free, Pro, Pro Max). */
export const VOICI_NAME_LIMITS: Readonly<Record<TierName, number>> = { free: 5, hobby: 25, maker: 100 };
/** Changes per service in any rolling window of `VOICI_CHANGE_WINDOW_MS`. */
export const VOICI_CHANGES_PER_SERVICE = 3;
export const VOICI_CHANGE_WINDOW_MS = 30 * DAY;
/** At most one counted change per service in this long. */
export const VOICI_CHANGE_COOLDOWN_MS = 7 * DAY;
/** A change this soon after a counted set fixes it (a typo) without counting against the service's limits. */
export const VOICI_CORRECTION_MS = 15 * 60_000;
/** Names an account may claim in any rolling `VOICI_CHANGE_WINDOW_MS`, by plan (corrections included). */
export const VOICI_CLAIM_BUDGETS: Readonly<Record<TierName, number>> = { free: 10, hobby: 100, maker: 500 };
/** A brake on the whole account, not a product rule. */
export const VOICI_CHANGES_PER_ACCOUNT_DAY = 10;
/** No server running the app for this long releases its name. */
export const VOICI_NAME_INACTIVE_MS = 60 * DAY;
/** Warnings go out this long before the release (30 days, then 7 days). */
export const VOICI_WARN_BEFORE_MS = [30 * DAY, 7 * DAY] as const;
const FRESHNESS_MS = 5 * 60_000;

export interface VoiciNamesDeps {
  usernames: UsernameStorage;
  voiciLinks: VoiciLinkStorage;
  voiciNames: VoiciNameStorage;
  tiers?: TierStorage;
  grants?: DeviceCapabilityGrantStorage;
  auditEvents?: AuditEventStorage;
  /** The dibs window, the `.com` lookup and the proofs (nameDibs.ts). */
  dibs: Pick<NameDibsDeps, "window" | "claims" | "fetch">;
  /** A name is only set for an app a server of the account runs (the same check the upkeep uses),
   *  so names cannot be parked on made-up service ids. Absent in tests that don't care. */
  appRunning?: (username: string, serviceId: string) => Promise<boolean>;
  /** The names registry: the availability answer (the claim itself is the registry insert in voiciNames.claim). */
  names: Pick<NameRegistryStorage, "isTaken">;
  now?: () => number;
}

const nowOf = (d: { now?: () => number }): number => (d.now ?? (() => Date.now()))();

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}): HandlerResponseWithHeaders {
  return { status, body: { error, code, ...extra } };
}

export type VoiciNameCheck =
  | { status: "available" }
  | { status: "current" }
  | { status: "invalid"; problem: VoiciNameProblem }
  | { status: "taken" }
  | { status: "dibs"; domain: string; until: number | null }
  | { status: "dibs-unchecked"; domain: string };

/**
 * While the dibs window is open, a name whose `<label>.com` is registered (the
 * typed label and the hyphen-less one) belongs to whoever proved that domain.
 * A lookup that fails counts as registered, so an outage can't hand a brand's
 * name to someone else.
 */
async function dibsBlock(
  deps: Pick<VoiciNamesDeps, "dibs" | "now">,
  username: string,
  typed: string,
): Promise<Extract<VoiciNameCheck, { status: "dibs" | "dibs-unchecked" }> | null> {
  const win = dibsWindowState(deps.dibs.window, nowOf(deps));
  if (!win.open) return null;
  // The `.com` domains a name stands for: as typed, and without hyphens (not the safety key: 0 and 1 stay digits).
  const labels = [...new Set([typed.replace(/-/g, ""), typed])];
  for (const label of labels) {
    let unchecked = false;
    let registered = false;
    try {
      registered = await dotComRegistered(label, deps.dibs.fetch as DibsFetch);
    } catch {
      unchecked = true;
    }
    if (!registered && !unchecked) continue;
    const proof = await deps.dibs.claims.winner(label);
    if (proof && proof.username === username) continue;
    return unchecked
      ? { status: "dibs-unchecked", domain: `${label}.com` }
      : { status: "dibs", domain: `${label}.com`, until: win.end };
  }
  return null;
}

/** Everything about a name except the account's limits. */
export async function checkVoiciName(
  deps: VoiciNamesDeps,
  username: string,
  serviceId: string | null,
  typed: string,
): Promise<VoiciNameCheck> {
  const name = typed.toLowerCase();
  const problem = voiciNameProblem(name);
  if (problem) return { status: "invalid", problem };
  if (serviceId) {
    const held = await deps.voiciNames.get(name);
    if (held && held.state === "live" && held.username === username && held.serviceId === serviceId) return { status: "current" };
  }
  // One generic answer for a username, a link name, a code, a reserved word or a held name, and their look-alikes.
  if (isReservedName(name) || (await deps.names.isTaken(name))) return { status: "taken" };
  const dibs = await dibsBlock(deps, username, name);
  if (dibs) return dibs;
  return { status: "available" };
}

/** `GET /api/users/:u/voici-name-check/:name` */
export async function handleVoiciNameCheck(
  deps: VoiciNamesDeps,
  username: string,
  serviceId: string | null,
  name: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!(await deps.usernames.get(u))) return notFound("unknown account");
  return ok(await checkVoiciName(deps, u, serviceId, name));
}

export interface VoiciLinkState {
  /** The custom name, or null while the service shows its random code. */
  name: string | null;
  /** Custom names this account holds, and the most its plan allows. */
  held: number;
  limit: number;
  /** Changes this service has left in the rolling window, and when the next one is allowed (null: now). Folds in the
   *  weekly cooldown, the account's claim budget and an open correction window, so the field needs nothing else. */
  changesLeft: number;
  nextChangeAt: number | null;
  /** When the name is released for lack of a running server (null: no custom name). */
  releasesAt: number | null;
  /** Until when the last set may be fixed without counting (null: no correction open). */
  correctionUntil: number | null;
  /** Names the account may still claim in the rolling window, of its plan's budget. */
  claimsLeft: number;
  claimBudget: number;
}

interface ServiceLimits {
  /** Counted changes left in the rolling window. */
  left: number;
  /** When the service's own limits next allow a counted change (null: now). */
  blockedUntil: number | null;
  correctionUntil: number | null;
}

async function serviceLimits(deps: Pick<VoiciNamesDeps, "voiciNames">, u: string, serviceId: string, now: number): Promise<ServiceLimits> {
  const [changes, last] = await Promise.all([
    deps.voiciNames.changesForService(u, serviceId, now - VOICI_CHANGE_WINDOW_MS),
    deps.voiciNames.lastChangeForService(u, serviceId),
  ]);
  const left = Math.max(0, VOICI_CHANGES_PER_SERVICE - changes.length);
  const windowEnd = left > 0 ? null : changes[changes.length - VOICI_CHANGES_PER_SERVICE]! + VOICI_CHANGE_WINDOW_MS;
  const newest = changes[changes.length - 1];
  const cooldownEnd = newest !== undefined && now < newest + VOICI_CHANGE_COOLDOWN_MS ? newest + VOICI_CHANGE_COOLDOWN_MS : null;
  const ends = [windowEnd, cooldownEnd].filter((x): x is number => x !== null);
  const correctionUntil =
    last && last.counted && last.op === "set" && now < last.at + VOICI_CORRECTION_MS ? last.at + VOICI_CORRECTION_MS : null;
  return { left, blockedUntil: ends.length ? Math.max(...ends) : null, correctionUntil };
}

interface ClaimBudget {
  left: number;
  budget: number;
  /** When the budget next frees a claim (null: one is free now). */
  nextAt: number | null;
}

const claimsOf = (deps: Pick<VoiciNamesDeps, "voiciNames">, u: string, now: number): Promise<number[]> =>
  deps.voiciNames.claimsForUser(u, now - VOICI_CHANGE_WINDOW_MS);

function claimBudget(claims: number[], tier: TierName): ClaimBudget {
  const budget = VOICI_CLAIM_BUDGETS[tier];
  const left = Math.max(0, budget - claims.length);
  return { left, budget, nextAt: left > 0 ? null : claims[claims.length - budget]! + VOICI_CHANGE_WINDOW_MS };
}

const tierOf = (deps: Pick<VoiciNamesDeps, "tiers">, u: string, now: number): Promise<TierName> =>
  deps.tiers ? effectiveTierOf(deps.tiers, u, now).catch(() => "free" as TierName) : Promise.resolve("free" as TierName);

/** What the service page needs to draw the link field. */
export async function voiciLinkState(
  deps: Pick<VoiciNamesDeps, "voiciNames" | "tiers" | "now">,
  username: string,
  serviceId: string,
): Promise<VoiciLinkState> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  const [live, held, svc, claimTimes, tier] = await Promise.all([
    deps.voiciNames.getLiveByService(u, serviceId),
    deps.voiciNames.countLive(u),
    serviceLimits(deps, u, serviceId, now),
    claimsOf(deps, u, now),
    tierOf(deps, u, now),
  ]);
  const claims = claimBudget(claimTimes, tier);
  const serviceOpen = svc.correctionUntil !== null || svc.blockedUntil === null;
  const changesLeft = svc.correctionUntil !== null ? Math.max(1, svc.left) : svc.blockedUntil === null ? svc.left : 0;
  const blocks = [serviceOpen ? null : svc.blockedUntil, claims.nextAt].filter((x): x is number => x !== null);
  return {
    name: live?.display ?? null,
    held,
    limit: VOICI_NAME_LIMITS[tier],
    changesLeft: blocks.length ? 0 : changesLeft,
    nextChangeAt: blocks.length ? Math.max(...blocks) : null,
    releasesAt: live ? live.lastActiveAt + VOICI_NAME_INACTIVE_MS : null,
    correctionUntil: svc.correctionUntil,
    claimsLeft: claims.left,
    claimBudget: claims.budget,
  };
}

/** `GET /api/users/:u/voici-names` — for "Free one up". */
export async function handleListVoiciNames(deps: VoiciNamesDeps, username: string): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!(await deps.usernames.get(u))) return notFound("unknown account");
  const live = await deps.voiciNames.listLive(u);
  return ok({ names: live.map((r) => ({ serviceId: r.serviceId, name: r.display, setAt: r.setAt })) });
}

async function audit(
  deps: VoiciNamesDeps,
  username: string,
  eventKind: "voici-name-set" | "voici-name-cleared" | "voici-name-released" | "voici-name-warning",
  detail: string,
  now: number,
): Promise<void> {
  if (!deps.auditEvents) return;
  try {
    await recordAuditEvent({ auditEvents: deps.auditEvents }, { username, eventKind, detail, devicePrefix: "", postedAt: now });
  } catch {
    /* an audit hiccup never undoes the change */
  }
}

/** `POST /api/users/:u/apps/:serviceId/voici-name` */
export async function handleVoiciNameSet(
  deps: VoiciNamesDeps,
  username: string,
  serviceIdFromUrl: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  const signed: SignedVoiciNameOrder | null = parseSignedVoiciNameOrder(body);
  if (!signed) return malformed("malformed voici-name order");
  const { order, signature } = signed;
  if (order.user.toLowerCase() !== u) return forbidden("order is for another account");
  if (order.serviceId !== serviceIdFromUrl) return forbidden("serviceId / url mismatch");
  if (!parseServiceId(order.serviceId)) return malformed("malformed serviceId");
  if (Math.abs(now - order.issuedAt) > FRESHNESS_MS) return refuse(403, "stale", "stale request");

  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("unknown account");
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: () => now },
    { username: u, userRec, verifyWith: (pub) => verifyVoiciNameOrder(order, hexToBytes(signature), hexToBytes(pub)) },
  );
  if (!authz.ok) return refuse(403, "not-admin", "only an admin device can change a link");
  if (await deps.voiciNames.nonceUsed(order.nonce)) return refuse(409, "replayed", "this order was already used");

  const current = await deps.voiciNames.getLiveByService(u, order.serviceId);

  if (order.op === "clear") {
    if (current) {
      // Giving up the name of an app no server of the account runs any more (it was deleted) is never limited.
      const gone = deps.appRunning ? !(await deps.appRunning(u, order.serviceId)) : false;
      const svc = await serviceLimits(deps, u, order.serviceId, now);
      const free = gone || svc.correctionUntil !== null;
      if (!free && svc.blockedUntil !== null) {
        return refuse(429, "change-limit", "too many changes for this service", { nextChangeAt: svc.blockedUntil });
      }
      await deps.voiciNames.release(u, order.serviceId, "cleared", now);
      await deps.voiciNames.recordChange(u, order.serviceId, now, order.nonce, { op: "clear", counted: !free });
      await audit(deps, u, "voici-name-cleared", `voi.ci/${current.display}`, now);
    }
    return ok({ ok: true, link: await voiciLinkState(deps, u, order.serviceId) });
  }

  const typed = order.name.toLowerCase();
  const problem = voiciNameProblem(typed);
  if (problem) return refuse(400, "invalid", "that isn't a valid name", { problem });
  if (current && current.key === typed) {
    // Same name again: nothing changes, nothing is counted.
    return ok({ ok: true, link: await voiciLinkState(deps, u, order.serviceId) });
  }

  if (deps.appRunning && !(await deps.appRunning(u, order.serviceId))) {
    return refuse(409, "app-not-running", "none of this account's servers runs this app");
  }

  // The account's limits first: they are known before a name is even looked at.
  const tier = await tierOf(deps, u, now);
  const held = await deps.voiciNames.countLive(u);
  const limit = VOICI_NAME_LIMITS[tier];
  const allowed = current ? held <= limit : held + 1 <= limit;
  if (!allowed) return refuse(409, "name-limit", "all of this plan's custom names are in use", { held, limit });
  const svc = await serviceLimits(deps, u, order.serviceId, now);
  const correction = svc.correctionUntil !== null;
  if (!correction && svc.blockedUntil !== null) {
    return refuse(429, "change-limit", "too many changes for this service", { nextChangeAt: svc.blockedUntil });
  }
  // The account's claim budget answers with the same code: to the person it is the same "next change on" date.
  const budget = claimBudget(await claimsOf(deps, u, now), tier);
  if (budget.nextAt !== null) {
    return refuse(429, "change-limit", "this account claimed its plan's names for now", { nextChangeAt: budget.nextAt, scope: "account" });
  }
  if ((await deps.voiciNames.countChangesForUser(u, now - DAY)) >= VOICI_CHANGES_PER_ACCOUNT_DAY) {
    return refuse(429, "rate-limited", "too many changes today", { retryAfterSec: Math.ceil(DAY / 1000) });
  }

  const check = await checkVoiciName(deps, u, order.serviceId, typed);
  if (check.status === "taken") return refuse(409, "taken", "taken or too similar to an existing name");
  if (check.status === "dibs") return refuse(409, "dibs", "that name is reserved for the owner of its .com", { domain: check.domain, until: check.until });
  if (check.status === "dibs-unchecked") {
    return refuse(503, "dibs-unchecked", "couldn't check the .com registration, try again", { domain: check.domain });
  }

  const rec: VoiciNameRecord = {
    key: typed, display: typed, username: u, serviceId: order.serviceId, state: "live", setAt: now, lastActiveAt: now, warned: 0,
  };
  const claimed = await deps.voiciNames.claim(rec);
  // The registry insert is the collision check: anything holding the safety key refuses it.
  if (!claimed.ok) return refuse(409, "taken", "taken or too similar to an existing name");
  if (current) await deps.voiciNames.release(u, order.serviceId, "replaced", now, current.key);
  await deps.voiciNames.recordChange(u, order.serviceId, now, order.nonce, { op: "set", counted: !correction });
  await audit(deps, u, "voici-name-set", `voi.ci/${typed}${current ? ` (was ${current.display})` : ""}`, now);
  return ok({ ok: true, link: await voiciLinkState(deps, u, order.serviceId) });
}

/** The account was deleted: its names and its codes are retired for good (usernames.delete does the same in its
 *  transaction; this is the explicit form for callers that delete links without the account row). */
export async function releaseAccountLinks(
  deps: Pick<VoiciNamesDeps, "voiciLinks" | "voiciNames" | "now">,
  username: string,
): Promise<void> {
  const now = nowOf(deps);
  await deps.voiciNames.releaseAllForUser(username, "deleted", now);
  await deps.voiciLinks.retireAllForUser(username, now);
}

// ---- the daily upkeep ---------------------------------------------------------------------

/** What the job needs to know about an app: is a server of the account running it right now? */
export type RunningNow = (username: string, serviceId: string) => Promise<boolean>;

export interface VoiciNamesMaintenance {
  /** A name's account was told something (warned, or released). */
  notify?: (event: { kind: "warning" | "released"; username: string; serviceId: string; name: string; releasesAt: number }) => Promise<void>;
}

/**
 * Forgets old changes, and walks one window of live names: a name whose app runs now is marked active; one that has been idle
 * 30 and 7 days short of the limit is warned; one idle for the limit is released.
 * `offset` wraps, so successive calls cover every name in turn.
 */
export async function runVoiciNamesMaintenance(
  deps: Pick<VoiciNamesDeps, "voiciNames" | "now">,
  running: RunningNow,
  window: { offset: number; count: number },
  hooks: VoiciNamesMaintenance = {},
): Promise<{ released: number; warned: number; checked: number }> {
  const now = nowOf(deps);
  await deps.voiciNames.pruneChanges(now - VOICI_CHANGE_WINDOW_MS);
  const total = await deps.voiciNames.countAllLive();
  let released = 0;
  let warned = 0;
  let checked = 0;
  if (total === 0) return { released, warned, checked };
  const offset = window.offset % total;
  const page = await deps.voiciNames.listLivePage(offset, window.count);
  for (const r of page) {
    checked++;
    if (await running(r.username, r.serviceId).catch(() => false)) {
      await deps.voiciNames.markActive(r.key, now);
      continue;
    }
    const idle = now - r.lastActiveAt;
    const releasesAt = r.lastActiveAt + VOICI_NAME_INACTIVE_MS;
    if (idle >= VOICI_NAME_INACTIVE_MS) {
      await deps.voiciNames.release(r.username, r.serviceId, "lapsed" as VoiciNameReleaseReason, now, r.key);
      released++;
      await hooks.notify?.({ kind: "released", username: r.username, serviceId: r.serviceId, name: r.display, releasesAt }).catch(() => {});
      continue;
    }
    const due = VOICI_WARN_BEFORE_MS.filter((before) => idle >= VOICI_NAME_INACTIVE_MS - before).length;
    if (due > r.warned) {
      await deps.voiciNames.setWarned(r.key, due);
      warned++;
      await hooks.notify?.({ kind: "warning", username: r.username, serviceId: r.serviceId, name: r.display, releasesAt }).catch(() => {});
    }
  }
  return { released, warned, checked };
}

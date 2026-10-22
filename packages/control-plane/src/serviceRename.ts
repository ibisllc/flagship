// App URL-stem rename + canonical/instances/short links read.
//
// Two handlers in one module — they share the same data dependencies
// and conceptual surface (an app's URL identity from the user's
// perspective).
//
//   - handleServiceRename: signed by IRK; rewrites display_label. The actual user-zone DNS publish is
//     delegated to a hook the Worker wires up (services-zone
//     publisher); we surface it as deps.publishDns? so tests stub
//     trivially. The service's voi.ci code is permanent and is NOT touched.
//
//   - handleGetAppLinks: public read; surfaces { canonical, short,
//     instances[] } for the apps-list BFF. Falls back to the
//     slug-creator-derived label when no alias row exists.
//
// "Service stem" rules:
//   - DNS-label safe: lowercase, [a-z0-9-], 1..40 chars, no leading
//     or trailing hyphen.
//   - Must not collide with another app's alias for the same user.
//   - Reserved labels rejected ("api", "www", "admin", "_", etc).

import {
  verifyServiceRename,
  deriveUrlFragment,
  parseServiceId,
  type ServiceRename,
} from "@flagship/protocol";
import type {
  CustomDomainOrderStorage,
  DaemonStatusStorage,
  ServerRecord,
  ServerStorage,
  TierStorage,
  UserServiceAliasStorage,
  UsernameStorage,
  VoiciLinkStorage,
  VoiciNameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { mintShortLink, type VoiciDeps } from "./voici.js";
import { voiciLinkState } from "./voiciNames.js";
import { recordAuditEvent } from "./auditEvents.js";
import type { AuditEventStorage } from "@flagship/storage";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface ServiceRenameDeps {
  usernames: UsernameStorage;
  userServiceAliases: UserServiceAliasStorage;
  voiciLinks: VoiciLinkStorage;
  /** Custom names: a minted code never equals one. Also feeds `link` on the links read. */
  voiciNames?: VoiciNameStorage;
  /** With [voiciNames]: the plan that sets how many names the account may hold. */
  tiers?: TierStorage;
  servers: ServerStorage;
  auditEvents: AuditEventStorage;
  /** The boxes' heartbeats, which say which apps each box runs and leads.
   *  Absent: an app is taken to run on every live server. */
  daemonStatus?: DaemonStatusStorage;
  /** #79A — when wired, handleGetAppLinks surfaces the attached
   *  custom domain + whether the Phase-4 verifier confirmed it. */
  customDomainOrders?: CustomDomainOrderStorage;
  /** Optional — Worker wires the services-zone DNS publisher here.
   *  In tests + dev, leave undefined; the rename still completes,
   *  but the user-zone DNS won't be re-published until a real
   *  publisher attaches. */
  publishDns?: (username: string, oldLabel: string, newLabel: string, serviceId: string) => Promise<void>;
  now?: () => number;
  /** voi.ci minter — uses the same VoiciLinkStorage; defaults to
   *  voi.ci hostname unless overridden. */
  shortHost?: string;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/; // no hyphens — see labels.ts
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_LABELS = new Set([
  "www", "api", "admin", "root", "mail", "smtp", "imap", "pop", "ftp",
  "ns", "ns1", "ns2", "dns", "host", "localhost", "test", "staging",
  "dev", "prod", "_acme-challenge", "voi", "voici",
]);

const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** POST /api/users/:u/apps/:serviceId/rename */
export async function handleServiceRename(
  deps: ServiceRenameDeps,
  username: string,
  appIdFromUrl: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) return malformed("malformed username");

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.serviceId !== "string" ||
    typeof r.newDisplayLabel !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.username.toLowerCase() !== u) return forbidden("username / url mismatch");
  if (r.serviceId !== appIdFromUrl) return forbidden("serviceId / url mismatch");
  if (Math.abs(now - r.issuedAt) > DEFAULT_MAX_AGE_MS) return forbidden("stale request");

  const newLabel = r.newDisplayLabel.toLowerCase();
  if (!DNS_LABEL_RE.test(newLabel)) {
    return malformed("newDisplayLabel must be a DNS label (lowercase, [a-z0-9-], 1..40 chars, no leading/trailing hyphen)");
  }
  if (RESERVED_LABELS.has(newLabel)) {
    return malformed(`'${newLabel}' is reserved`);
  }

  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("unknown username");

  // Signature verify against the user's CURRENT IRK.
  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  const claim: ServiceRename = {
    username: u,
    serviceId: r.serviceId,
    newDisplayLabel: newLabel,
    issuedAt: r.issuedAt,
  };
  if (!verifyServiceRename(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  // Uniqueness check — the new label must not collide with another
  // app's alias for the same user. Reading every alias is cheap (per-
  // user list, capped at the user's app count which is small).
  const allAliases = await deps.userServiceAliases.listForUser(u);
  const colliding = allAliases.find(
    (a) => a.serviceId !== r.serviceId && a.displayLabel === newLabel,
  );
  if (colliding) {
    return conflict(`another app already uses '${newLabel}' on your account`);
  }

  // Read the old label so we can:
  //  - tell the DNS publisher what to deprecate
  //  - emit an audit row that names both sides
  const existing = await deps.userServiceAliases.get(u, r.serviceId);
  const oldLabel = existing?.displayLabel ?? deriveUrlFragment(r.serviceId, u);

  // No-op fast path — if the user asked for the same label they
  // already have, skip the cascade so we don't churn voi.ci codes.
  if (oldLabel === newLabel) {
    return ok({ ok: true, unchanged: true, displayLabel: newLabel });
  }

  // Mutation sequence:
  //   1. Upsert the alias (atomic at the storage layer).
  //   2. Keep the service's short code: it is permanent (docs/named-links.md),
  //      and a visit works out the canonical address afresh, so a rename needs
  //      nothing re-minted. A service that has none yet gets one now.
  //   3. Best-effort DNS re-publish via the hook.
  //   4. Append audit row (truncated by recordAuditEvent on overflow).
  const ts = now;
  await deps.userServiceAliases.upsert({
    username: u,
    serviceId: r.serviceId,
    displayLabel: newLabel,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  });

  const newCanonical = (await appHome(deps, u, r.serviceId, newLabel)).canonicalUrl;
  const kept = await deps.voiciLinks.getByService(u, r.serviceId);
  const minted: { code: string; shortUrl: string } | { error: string } = kept
    ? { code: kept.code, shortUrl: `https://${deps.shortHost ?? "voi.ci"}/${kept.code}` }
    : await mintShortLink(
        {
          usernames: deps.usernames,
          voiciLinks: deps.voiciLinks,
          voiciNames: deps.voiciNames,
          now: deps.now,
          shortHost: deps.shortHost,
        } satisfies VoiciDeps,
        { username: u, serviceId: r.serviceId, targetUrl: newCanonical },
      );

  if (deps.publishDns) {
    try {
      await deps.publishDns(u, oldLabel, newLabel, r.serviceId);
    } catch {
      // Best-effort — the alias row has flipped, the short code has
      // rotated; the daemon-side Caddy re-config can lag without
      // breaking correctness on the user-visible side.
    }
  }

  await recordAuditEvent(
    { auditEvents: deps.auditEvents },
    {
      username: u,
      eventKind: "app-renamed",
      detail: `Renamed app '${r.serviceId}': ${oldLabel} → ${newLabel}`,
      devicePrefix: "",
      postedAt: ts,
    },
  );

  if ("error" in minted) {
    // The alias + DNS swap already happened; surface the short-link
    // failure so the client can retry the mint. Returning 200 with
    // shortUrl=null lets the UI render the canonical row + a
    // "Generating short link…" placeholder.
    return ok({
      ok: true,
      displayLabel: newLabel,
      canonicalUrl: newCanonical,
      shortUrl: null,
      deletedShortLinks: 0,
      shortLinkError: minted.error,
    });
  }
  return ok({
    ok: true,
    displayLabel: newLabel,
    canonicalUrl: newCanonical,
    shortUrl: minted.shortUrl,
    shortCode: minted.code,
    deletedShortLinks: 0,
  });
}

export interface AppHome {
  /** `https://<label>.<box>`: the box that leads the app, else one that runs it. */
  canonicalUrl: string;
  /** One per box that runs the app. */
  instances: Array<{ serverDomain: string; url: string }>;
  hasServer: boolean;
}

/**
 * Where an app lives, from its boxes' own heartbeats: each box reports the
 * slugs it runs and the ones it leads (gossip elects one leader per app among
 * the boxes running it). The canonical URL and voi.ci link point at the
 * leader, so an app that runs only on a second box is never sent to the
 * first. A box too old to report what it runs is taken to run everything.
 */
export async function appHome(
  deps: Pick<ServiceRenameDeps, "servers" | "daemonStatus">,
  username: string,
  serviceId: string,
  label: string,
): Promise<AppHome> {
  const live = (await deps.servers.listForUser(username)).filter((s) => !s.revokedAt);
  const slug = parseServiceId(serviceId)?.slug ?? serviceId;
  const reports = await Promise.all(live.map(async (server) => {
    const row = await deps.daemonStatus?.get(server.serverDomain).catch(() => undefined);
    let leads: string[] = [];
    let runs: string[] | null = null;
    try {
      const r = row?.reportJson ? (JSON.parse(row.reportJson) as { leadsServices?: unknown; runsServices?: unknown }) : {};
      if (Array.isArray(r.leadsServices)) leads = r.leadsServices.filter((x): x is string => typeof x === "string");
      if (Array.isArray(r.runsServices)) runs = r.runsServices.filter((x): x is string => typeof x === "string");
    } catch {
      /* a corrupt row says nothing */
    }
    return { server, at: row?.lastReported ?? 0, leads: leads.includes(slug), runs: runs === null ? null : runs.includes(slug) };
  }));
  const runners = reports.filter((r) => r.leads || r.runs !== false);
  const pool = runners.length > 0 ? runners : reports;
  const home: ServerRecord | undefined = (
    [...pool].sort((a, b) => Number(b.leads) - Number(a.leads) || Number(b.runs === true) - Number(a.runs === true) || b.at - a.at)[0]
  )?.server;
  const url = (domain: string) => `https://${label}.${domain}`;
  return {
    canonicalUrl: url(home?.serverDomain ?? `${username}.flagship.services`),
    instances: pool.map((r) => ({ serverDomain: r.server.serverDomain, url: url(r.server.serverDomain) })),
    hasServer: home !== undefined,
  };
}

/** GET /api/users/:u/apps/:serviceId/links — surfaces { canonical, short,
 *  instances }. Public read so the apps-list BFF can fan it out
 *  without per-call auth; the canonical URL is already publishable
 *  (it's literally a DNS label). */
export async function handleGetAppLinks(
  deps: ServiceRenameDeps,
  username: string,
  serviceId: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) return malformed("malformed username");

  const alias = await deps.userServiceAliases.get(u, serviceId);
  const displayLabel = alias?.displayLabel ?? deriveUrlFragment(serviceId, u);

  const { canonicalUrl, instances, hasServer } = await appHome(deps, u, serviceId, displayLabel);

  // V4 — Active app-bound short link via the new getByService index.
  // handleServiceRename cascade-deletes prior rows before minting the
  // new one, so at most ONE row should match. If no row exists
  // (newly installed app that hasn't been renamed), lazy-mint
  // against the canonical so the first /links call already returns
  // a shareable voi.ci/<code>.
  let shortLink = await deps.voiciLinks.getByService(u, serviceId);
  let shortLinkError: string | undefined;
  if (!shortLink && hasServer) {
    const minted = await mintShortLink(
      {
        usernames: deps.usernames,
        voiciLinks: deps.voiciLinks,
        now: deps.now,
        shortHost: deps.shortHost,
      } satisfies VoiciDeps,
      { username: u, serviceId, targetUrl: canonicalUrl },
    );
    if ("code" in minted) {
      shortLink = {
        code: minted.code,
        username: u,
        serviceId,
        targetUrl: canonicalUrl,
        createdAt: (deps.now ?? (() => Date.now()))(),
      };
    } else {
      shortLinkError = minted.error;
    }
  }
  const shortUrl = shortLink
    ? `https://${deps.shortHost ?? "voi.ci"}/${shortLink.code}`
    : null;

  // #79A — attached custom domain. Shown optimistically on request
  // (status='pending'); customDomainConfirmed flips true only once
  // the Phase-4 verifier confirms the CNAME. Absent → null (the iOS
  // apps-list "it's live" swap keys on confirmed===true).
  const cdo = deps.customDomainOrders
    ? await deps.customDomainOrders.get(u, serviceId)
    : undefined;

  // The readable name on top of the code (docs/named-links.md): what the link
  // field on the service page shows, with the limits it needs.
  const link = deps.voiciNames
    ? await voiciLinkState({ voiciNames: deps.voiciNames, tiers: deps.tiers, now: deps.now }, u, serviceId).catch(() => null)
    : null;

  return ok({
    serviceId,
    displayLabel,
    canonicalUrl,
    instances,
    shortUrl,
    shortCode: shortLink?.code ?? null,
    link,
    customDomain: cdo ? cdo.fqdn : null,
    customDomainConfirmed: cdo ? cdo.status === "active" : null,
    ...(shortLinkError ? { shortLinkError } : {}),
  });
}

/** GET /api/users/:u/apps/aliases — flat map of every alias the
 *  user has set. Public read (DNS-label data is already in the open
 *  via the wildcard cert + .services zone). The user's daemon polls
 *  this periodically and reconciles its in-memory urlLabel map +
 *  reverse-proxy config (Caddy on the box).
 *
 *  Returns rows in the shape the daemon's AliasReconciler expects:
 *  `{ aliases: [{ serviceId, displayLabel, updatedAt }, ...] }`. updatedAt
 *  is a unix-ms timestamp so the daemon can short-circuit when
 *  nothing has moved since its last reconcile tick. */
export async function handleListAppAliases(
  deps: Pick<ServiceRenameDeps, "userServiceAliases">,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) return malformed("malformed username");
  const rows = await deps.userServiceAliases.listForUser(u);
  return ok({
    aliases: rows
      .map((r) => ({
        serviceId: r.serviceId,
        displayLabel: r.displayLabel,
        updatedAt: r.updatedAt,
      }))
      // Stable ordering for cache-friendliness on the daemon side.
      .sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
  });
}


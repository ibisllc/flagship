// App URL-stem rename + canonical/instances/short links read.
//
// Two handlers in one module — they share the same data dependencies
// and conceptual surface (an app's URL identity from the user's
// perspective).
//
//   - handleAppRename: signed by IRK; rewrites display_label, cascade-
//     deletes the app's old voi.ci codes, mints a fresh one against
//     the new canonical URL. The actual user-zone DNS publish is
//     delegated to a hook the Worker wires up (services-zone
//     publisher); we surface it as deps.publishDns? so tests stub
//     trivially.
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
  verifyAppRename,
  type AppRename,
} from "@flagship/protocol";
import type {
  ServerStorage,
  UserAppAliasStorage,
  UsernameStorage,
  VoiciLinkStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { mintShortLink, type VoiciDeps } from "./voici.js";
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

export interface AppRenameDeps {
  usernames: UsernameStorage;
  userAppAliases: UserAppAliasStorage;
  voiciLinks: VoiciLinkStorage;
  servers: ServerStorage;
  auditEvents: AuditEventStorage;
  /** Optional — Worker wires the services-zone DNS publisher here.
   *  In tests + dev, leave undefined; the rename still completes,
   *  but the user-zone DNS won't be re-published until a real
   *  publisher attaches. */
  publishDns?: (username: string, oldLabel: string, newLabel: string, appId: string) => Promise<void>;
  now?: () => number;
  /** voi.ci minter — uses the same VoiciLinkStorage; defaults to
   *  voi.ci hostname unless overridden. */
  shortHost?: string;
}

const USERNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_LABELS = new Set([
  "www", "api", "admin", "root", "mail", "smtp", "imap", "pop", "ftp",
  "ns", "ns1", "ns2", "dns", "host", "localhost", "test", "staging",
  "dev", "prod", "_acme-challenge", "voi", "voici",
]);

const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** POST /api/users/:u/apps/:appId/rename */
export async function handleAppRename(
  deps: AppRenameDeps,
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
    typeof r.appId !== "string" ||
    typeof r.newDisplayLabel !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.username.toLowerCase() !== u) return forbidden("username / url mismatch");
  if (r.appId !== appIdFromUrl) return forbidden("appId / url mismatch");
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
  const claim: AppRename = {
    username: u,
    appId: r.appId,
    newDisplayLabel: newLabel,
    issuedAt: r.issuedAt,
  };
  if (!verifyAppRename(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  // Uniqueness check — the new label must not collide with another
  // app's alias for the same user. Reading every alias is cheap (per-
  // user list, capped at the user's app count which is small).
  const allAliases = await deps.userAppAliases.listForUser(u);
  const colliding = allAliases.find(
    (a) => a.appId !== r.appId && a.displayLabel === newLabel,
  );
  if (colliding) {
    return conflict(`another app already uses '${newLabel}' on your account`);
  }

  // Read the old label so we can:
  //  - tell the DNS publisher what to deprecate
  //  - emit an audit row that names both sides
  const existing = await deps.userAppAliases.get(u, r.appId);
  const oldLabel = existing?.displayLabel ?? deriveDefaultLabel(r.appId);

  // No-op fast path — if the user asked for the same label they
  // already have, skip the cascade so we don't churn voi.ci codes.
  if (oldLabel === newLabel) {
    return ok({ ok: true, unchanged: true, displayLabel: newLabel });
  }

  // Mutation sequence:
  //   1. Upsert the alias (atomic at the storage layer).
  //   2. Cascade-delete the OLD app-bound short codes.
  //   3. Mint a fresh short code against the new canonical URL.
  //   4. Best-effort DNS re-publish via the hook.
  //   5. Append audit row (truncated by recordAuditEvent on overflow).
  const ts = now;
  await deps.userAppAliases.upsert({
    username: u,
    appId: r.appId,
    displayLabel: newLabel,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  });
  const deletedShortLinks = await deps.voiciLinks.deleteByApp(u, r.appId);

  // Pick the canonical FQDN: prefer the leader pod's serverFqdn;
  // fall back to any registered server; if none, format against the
  // services-zone apex so the link is at least well-formed.
  const servers = await deps.servers.listForUser(u);
  const leader = servers.find((s) => !s.revokedAt) ?? servers[0];
  const serverFqdn = leader?.serverDomain ?? `${u}.flagship.services`;
  const newCanonical = `https://${newLabel}.${serverFqdn}`;
  const minted = await mintShortLink(
    {
      usernames: deps.usernames,
      voiciLinks: deps.voiciLinks,
      now: deps.now,
      shortHost: deps.shortHost,
    } satisfies VoiciDeps,
    {
      username: u,
      appId: r.appId,
      targetUrl: newCanonical,
      // App-bound short links don't get a TTL — they live as long as
      // the app's display label stays the same.
    },
  );

  if (deps.publishDns) {
    try {
      await deps.publishDns(u, oldLabel, newLabel, r.appId);
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
      // Reuse the existing 'device-replaced' event kind family —
      // semantically this is a rename, not a key rotation, so we
      // surface a fresh detail string and let the UI render it
      // generically. (Adding a new AuditEventKind would require a
      // protocol bump + client updates we defer to a follow-up.)
      eventKind: "device-replaced",
      detail: `Renamed app '${r.appId}': ${oldLabel} → ${newLabel}`,
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
      deletedShortLinks,
      shortLinkError: minted.error,
    });
  }
  return ok({
    ok: true,
    displayLabel: newLabel,
    canonicalUrl: newCanonical,
    shortUrl: minted.shortUrl,
    shortCode: minted.code,
    deletedShortLinks,
  });
}

/** GET /api/users/:u/apps/:appId/links — surfaces { canonical, short,
 *  instances }. Public read so the apps-list BFF can fan it out
 *  without per-call auth; the canonical URL is already publishable
 *  (it's literally a DNS label). */
export async function handleGetAppLinks(
  deps: AppRenameDeps,
  username: string,
  appId: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) return malformed("malformed username");

  const alias = await deps.userAppAliases.get(u, appId);
  const displayLabel = alias?.displayLabel ?? deriveDefaultLabel(appId);

  const servers = await deps.servers.listForUser(u);
  const liveServers = servers.filter((s) => !s.revokedAt);
  const leader = liveServers[0]; // first non-revoked acts as canonical owner
  const canonicalUrl = leader
    ? `https://${displayLabel}.${leader.serverDomain}`
    : `https://${displayLabel}.${u}.flagship.services`;

  const instances = liveServers.map((s) => ({
    serverDomain: s.serverDomain,
    url: `https://${displayLabel}.${s.serverDomain}`,
  }));

  // V4 — Active app-bound short link via the new getByApp index.
  // handleAppRename cascade-deletes prior rows before minting the
  // new one, so at most ONE row should match. If no row exists
  // (newly installed app that hasn't been renamed), lazy-mint
  // against the canonical so the first /links call already returns
  // a shareable voi.ci/<code>.
  let shortLink = await deps.voiciLinks.getByApp(u, appId);
  let shortLinkError: string | undefined;
  if (!shortLink && leader) {
    const minted = await mintShortLink(
      {
        usernames: deps.usernames,
        voiciLinks: deps.voiciLinks,
        now: deps.now,
        shortHost: deps.shortHost,
      } satisfies VoiciDeps,
      { username: u, appId, targetUrl: canonicalUrl },
    );
    if ("code" in minted) {
      shortLink = {
        code: minted.code,
        username: u,
        appId,
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

  return ok({
    appId,
    displayLabel,
    canonicalUrl,
    instances,
    shortUrl,
    ...(shortLinkError ? { shortLinkError } : {}),
  });
}

/** What the URL stem would be if no alias has been set. Mirrors the
 *  daemon's `AppSummary.urlLabel` derivation: slug if it's unique,
 *  else slug-creator. We can't know without listing every install,
 *  so we conservatively use the appId verbatim (composite
 *  `<creator>--<slug>` collapsed to `<creator>-<slug>`). The client
 *  side surfaces the actual default from the daemon's apps list
 *  when present. */
function deriveDefaultLabel(appId: string): string {
  // appId is `<creator>--<slug>`. Default label: `<slug>-<creator>`.
  // If it doesn't match that shape, fall back to a sanitized version
  // of the raw appId.
  const m = /^([a-z0-9-]+)--([a-z0-9-]+)$/.exec(appId);
  if (m) {
    const [, creator, slug] = m;
    return `${slug}-${creator}`.toLowerCase();
  }
  return appId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
}

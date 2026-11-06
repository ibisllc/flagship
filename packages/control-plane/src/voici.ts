// voi.ci (docs/voici-namespace-spec.md): mint codes, and resolve every voi.ci/<path> through one function.
//
//   1. mintShortLink (internal helper) — called only by handleServiceRename and handleGetAppLinks, for an app's own
//      canonical address: voi.ci codes come only from the system, never from a URL a client names. A code is a
//      digit then 0-9a-z (D2), CODE_LENGTH long (D3); it is claimed by one INSERT into the names registry, and a
//      taken safety key (a username, a link name, a code, a reserved word) mints another.
//
//   2. resolveVoiciPath — the voi.ci host. Lowercase and no trailing slash or a 301 there (D13); `/-/…` is the site's
//      own (D11); `/@<x>` only ever names a username (D10, D5); a live link or code 302s to its app; a retired one
//      is 410; a username shows its page when published, else the same 404 as an unknown name; a held username
//      301s to its owner's current name, or 404s when the account is gone.

import { isVoiciName, mintVoiciCode } from "@flagship/protocol";
import type {
  NameRegistryStorage,
  UsernameStorage,
  VoiciLinkStorage,
  VoiciStorage,
} from "@flagship/storage";

/** CODE_LENGTH (D3): the length of a newly minted code. It can only grow; codes minted shorter keep working. */
export const VOICI_CODE_LENGTH = 6;

/** The CODE_LENGTH setting from `.com`'s environment (`VOICI_CODE_LENGTH`): never below the default, at most 12. */
export function voiciCodeLength(setting: string | number | undefined): number {
  const n = typeof setting === "number" ? setting : Number.parseInt(String(setting ?? ""), 10);
  return Number.isInteger(n) && n >= VOICI_CODE_LENGTH && n <= 12 ? n : VOICI_CODE_LENGTH;
}

export interface VoiciDeps {
  usernames: UsernameStorage;
  voiciLinks: VoiciLinkStorage;
  /** Optional clock injection — tests override; production uses Date.now. */
  now?: () => number;
  /** Base hostname used when formatting the short URL the API returns
   *  to clients. Defaults to "voi.ci" — overrideable in dev to point
   *  at a staging hostname. */
  shortHost?: string;
  /** CODE_LENGTH (D3). Defaults to VOICI_CODE_LENGTH. */
  codeLength?: number;
  /** Random bytes for the minter (tests force collisions with it). */
  random?: (n: number) => Uint8Array;
}

/** voi.ci's public-facing hostname (used in the URL returned to
 *  clients). The Worker's voi.ci host resolves every path with
 *  resolveVoiciPath below. */
export const DEFAULT_VOICI_HOST = "voi.ci";

/** Retry budget for code collisions before we return 500: the registry refuses a code whose safety key anything
 *  holds (a username, a link name, a live or retired code, a reserved word), and the minter draws fresh bytes. */
const MAX_MINT_RETRIES = 8;

const TARGET_URL_RE = /^https:\/\/[^\s]+$/i;

/** An app's canonical address in the account's own zone: `https://<label>.[<server>.]<user>.flagship.services`
 *  (or the gym's `gym.flagship.services`), origin only. Another account's zone, a foreign host or a path is refused. */
export function isOwnAppCanonical(targetUrl: string, username: string): boolean {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return false;
  if (u.pathname !== "/" || !/^https:\/\/[^/]+\/?$/i.test(targetUrl)) return false;
  const host = u.hostname.toLowerCase();
  const zone = [`.${username}.flagship.services`, `.${username}.gym.flagship.services`].find((z) => host.endsWith(z));
  if (!zone) return false;
  const below = host.slice(0, host.length - zone.length).split(".");
  return below.length >= 1 && below.length <= 2 && below.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
}

/** Worker-private: pick a fresh code for one app and hand it back with the persisted row. Its callers pass the
 *  canonical address `.com` worked out itself (appHome), never one from a request. */
export async function mintShortLink(
  deps: VoiciDeps,
  args: {
    username: string;
    serviceId: string;
    targetUrl: string;
  },
): Promise<{ code: string; shortUrl: string } | { error: string }> {
  const username = args.username.toLowerCase();
  if (!isVoiciName(username)) return { error: "malformed username" };
  if (args.serviceId.length === 0) return { error: "a code names one app" };
  if (!isOwnAppCanonical(args.targetUrl, username)) return { error: "targetUrl must be the app's own address" };
  const len = deps.codeLength ?? VOICI_CODE_LENGTH;
  const host = deps.shortHost ?? DEFAULT_VOICI_HOST;
  const now = (deps.now ?? (() => Date.now()))();

  for (let attempt = 0; attempt < MAX_MINT_RETRIES; attempt++) {
    const code = mintVoiciCode(len, deps.random);
    const insert = await deps.voiciLinks.insert({
      code,
      username,
      serviceId: args.serviceId,
      targetUrl: args.targetUrl,
      createdAt: now,
    });
    if (insert.ok) {
      return { code, shortUrl: `https://${host}/${code}` };
    }
    // Taken or too similar — mint another (never reuse, D7).
  }
  return { error: "couldn't allocate a unique short code; retry" };
}

// ── resolution (docs/voici-namespace-spec.md, Resolution) ──────────────────────────────────

export type VoiciResolution =
  /** 301 to a canonical path: lowercase / no trailing slash (D13), `/@x` → `/x` (D5), a held name → the current one. */
  | { kind: "redirect"; location: string }
  /** 302 to a live link's or code's app. */
  | { kind: "link"; target: string }
  /** 410: a retired link or code, or an expired one-off ("this link was removed"). */
  | { kind: "gone" }
  /** The page shell: the username has a published page. */
  | { kind: "page"; username: string }
  /** 410 page shell: the page was taken down. */
  | { kind: "page-gone"; username: string }
  /** `/-/<rest>`: the site's own routes and files (D11). */
  | { kind: "system"; rest: string }
  /** `/` */
  | { kind: "home" }
  /** 404: unknown, reserved, an unpublished page, a held name of a deleted account, `/@<link>`. */
  | { kind: "not-found" };

export interface VoiciResolveDeps {
  names: Pick<NameRegistryStorage, "lookup" | "activeUsername">;
  /** Whether a username's page is published (and not taken down). */
  pages: Pick<VoiciStorage, "getPage">;
  /** The service's canonical address (`https://<label>.<user>.flagship.services`), worked out on each visit so a link
   *  follows a rename. Null: fall back to [resolveAppUrl] and then to the stored target. */
  resolveCanonical?: (username: string, serviceId: string) => Promise<string | null>;
  /** An app-bound link's current target (the box that leads the app now). Null keeps the stored one. */
  resolveAppUrl?: (username: string, serviceId: string) => Promise<string | null>;
  /** voi.ci's own origin ("https://voi.ci", gym "https://gym.voi.ci"): every redirect Location is absolute on it. */
  origin?: string;
  now?: () => number;
}

const VOICI_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+$/;
/** The characters a voi.ci path may hold outside `/-/` (names, codes, `@`, the slashes around them); upper case is
 *  allowed only to be folded by the canonicalising 301. */
const VOICI_PATH_RE = /^[A-Za-z0-9@\/-]*$/;

/** One decode of a raw path, or null when it is not valid percent-encoding. */
function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Every request to voi.ci goes through here. `pathname` is the URL's path as received; `search` rides along on a
 * canonicalising 301. Lookups match the exact name, never the safety key: voi.ci/pluckyavocet does not reach
 * plucky-avocet.
 *
 * Never an open redirect (security review M1): outside `/-/` the path, raw and decoded once, must hold only
 * a-z 0-9 - @ / (so `%40x` is a 404, not `@x`, and no `\`, `.` or `%2F` ever reaches a Location); a name part that
 * starts with `/` (`//evil.com`) or holds a `/` is a 404 before any redirect; and every Location is absolute on
 * voi.ci's origin, so a browser can never read it as another host.
 */
export async function resolveVoiciPath(deps: VoiciResolveDeps, pathname: string, search = ""): Promise<VoiciResolution> {
  const raw = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  // D11 first: the site's files keep their case (fonts/Geist-Variable.woff2), so `/-/` is exempt from D13.
  if (raw === "-" || raw.startsWith("-/")) return { kind: "system", rest: raw.slice(2) };
  const decoded = decodeOnce(raw);
  if (decoded === null || decoded !== raw || !VOICI_PATH_RE.test(raw)) return { kind: "not-found" };
  if (raw.startsWith("/")) return { kind: "not-found" };
  const p = raw.toLowerCase().replace(/\/+$/, "");
  if (p.includes("/")) return { kind: "not-found" };
  const origin = deps.origin && VOICI_ORIGIN_RE.test(deps.origin) ? deps.origin : `https://${DEFAULT_VOICI_HOST}`;
  const at = (name: string, query = "") => ({ kind: "redirect" as const, location: `${origin}/${name}${query}` });
  if (p !== raw) return at(p, search.startsWith("?") ? search : "");
  if (p === "") return { kind: "home" };

  if (p.startsWith("@")) {
    // D10: the @ form only ever names a username.
    const row = await deps.names.lookup(p.slice(1), "username");
    const current = row?.owner ? await deps.names.activeUsername(row.owner) : undefined;
    return current ? at(current.name) : { kind: "not-found" };
  }

  const row = await deps.names.lookup(p);
  if (!row || row.kind === "reserved") return { kind: "not-found" };

  if (row.kind === "link" || row.kind === "code") {
    if (row.status !== "active") return { kind: "gone" };
    // A code bound to no app came from the removed any-URL shortener: it no longer redirects.
    if (row.kind === "code" && !row.serviceId) return { kind: "gone" };
    const now = (deps.now ?? (() => Date.now()))();
    if (row.expiresAt !== null && row.expiresAt <= now) return { kind: "gone" };
    const owner = row.owner ?? "";
    let target: string | null = null;
    if (row.serviceId) {
      const canonical = await deps.resolveCanonical?.(owner, row.serviceId).catch(() => null);
      if (canonical && TARGET_URL_RE.test(canonical)) target = canonical;
      else {
        const live = await deps.resolveAppUrl?.(owner, row.serviceId).catch(() => null);
        if (live && TARGET_URL_RE.test(live)) target = live;
      }
    }
    target ??= row.target && TARGET_URL_RE.test(row.target) ? row.target : null;
    return target ? { kind: "link", target } : { kind: "not-found" };
  }

  // A username.
  const current = row.owner ? await deps.names.activeUsername(row.owner) : undefined;
  if (row.status === "held") {
    // During the grace period an old name redirects to the owner's current one; a deleted account's is a 404.
    return current ? at(current.name) : { kind: "not-found" };
  }
  const page = await deps.pages.getPage(row.owner ?? row.name);
  // A page its owner removed is the same 404 as one never published.
  if (!page || page.removedAt != null) return { kind: "not-found" };
  return page.takenDownAt === null ? { kind: "page", username: row.name } : { kind: "page-gone", username: row.name };
}

// voi.ci (docs/voici-namespace-spec.md): mint codes, and resolve every voi.ci/<path> through one function.
//
//   1. mintShortLink (internal helper) — called by handleServiceRename, handleGetAppLinks and the one-off shorten
//      endpoint. A code is a digit then 0-9a-z (D2), CODE_LENGTH long (D3); it is claimed by one INSERT into the
//      names registry, and a taken safety key (a username, a link name, a code, a reserved word) mints another.
//
//   2. resolveVoiciPath — the voi.ci host. Lowercase and no trailing slash or a 301 there (D13); `/-/…` is the site's
//      own (D11); `/@<x>` only ever names a username (D10, D5); a live link or code 302s to its app; a retired one
//      is 410; a username shows its page when published, else the same 404 as an unknown name; a held username
//      301s to its owner's current name, or 404s when the account is gone.
//
//   3. handleVoiciShorten — phone-facing API. Signed by IRK; mints a one-off code (no serviceId binding).

import {
  isVoiciName,
  mintVoiciCode,
  verifyVoiciShorten,
  type VoiciShorten,
} from "@flagship/protocol";
import type {
  NameRegistryStorage,
  UsernameStorage,
  VoiciLinkStorage,
  VoiciStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

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

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const ONE_OFF_TTL_MS = 365 * 24 * 60 * 60_000;

// Matches `^https://` — Worker rejects anything else so an attacker
// can't mint a short code that redirects to `javascript:` etc.
const TARGET_URL_RE = /^https:\/\/[^\s]+$/i;

/** Worker-private: pick a fresh code, hand it back to the caller
 *  along with the persisted row. Used by both the public shorten
 *  endpoint AND the rename handler when minting the post-rename
 *  link. */
export async function mintShortLink(
  deps: VoiciDeps,
  args: {
    username: string;
    serviceId?: string;
    targetUrl: string;
    expiresAt?: number;
  },
): Promise<{ code: string; shortUrl: string } | { error: string }> {
  const username = args.username.toLowerCase();
  if (!isVoiciName(username)) return { error: "malformed username" };
  if (!TARGET_URL_RE.test(args.targetUrl)) return { error: "targetUrl must be https://…" };
  const len = deps.codeLength ?? VOICI_CODE_LENGTH;
  const host = deps.shortHost ?? DEFAULT_VOICI_HOST;
  const now = (deps.now ?? (() => Date.now()))();

  for (let attempt = 0; attempt < MAX_MINT_RETRIES; attempt++) {
    const code = mintVoiciCode(len, deps.random);
    const insert = await deps.voiciLinks.insert({
      code,
      username,
      ...(args.serviceId ? { serviceId: args.serviceId } : {}),
      targetUrl: args.targetUrl,
      createdAt: now,
      ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
    });
    if (insert.ok) {
      return { code, shortUrl: `https://${host}/${code}` };
    }
    // Taken or too similar — mint another (never reuse, D7).
  }
  return { error: "couldn't allocate a unique short code; retry" };
}

/** Phone-facing API. Signed by IRK over canonical bytes. Mints a
 *  one-off code (no serviceId binding). App-bound codes ride through
 *  handleServiceRename instead — serviceId binding lets that handler cascade-
 *  delete on subsequent renames. */
export async function handleVoiciShorten(
  deps: VoiciDeps,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = DEFAULT_MAX_AGE_MS;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.targetUrl !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - r.issuedAt) > maxAgeMs) return forbidden("stale request");
  if (!TARGET_URL_RE.test(r.targetUrl)) return malformed("targetUrl must be https://…");

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("unknown username");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  const claim: VoiciShorten = {
    username: r.username,
    ...(typeof r.serviceId === "string" && r.serviceId.length > 0 ? { serviceId: r.serviceId } : {}),
    targetUrl: r.targetUrl,
    issuedAt: r.issuedAt,
  };
  if (!verifyVoiciShorten(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  const minted = await mintShortLink(deps, {
    username: r.username,
    ...(typeof r.serviceId === "string" && r.serviceId.length > 0 ? { serviceId: r.serviceId } : {}),
    targetUrl: r.targetUrl,
    expiresAt: now + ONE_OFF_TTL_MS,
  });
  if ("error" in minted) return { status: 500, body: { error: minted.error } };
  return ok({
    ok: true,
    code: minted.code,
    shortUrl: minted.shortUrl,
  });
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
  now?: () => number;
}

/**
 * Every request to voi.ci goes through here. `pathname` is the URL's path as received (it is never decoded, so
 * `%40x` is not `@x`); `search` rides along on a canonicalising 301. Lookups match the exact name, never the safety
 * key: voi.ci/pluckyavocet does not reach plucky-avocet.
 */
export async function resolveVoiciPath(deps: VoiciResolveDeps, pathname: string, search = ""): Promise<VoiciResolution> {
  const raw = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  // D11 first: the site's files keep their case (fonts/Geist-Variable.woff2), so `/-/` is exempt from D13.
  if (raw === "-" || raw.startsWith("-/")) return { kind: "system", rest: raw.slice(2) };
  const p = raw.toLowerCase().replace(/\/+$/, "");
  if (p !== raw) return { kind: "redirect", location: `/${p}${search}` };
  if (p === "") return { kind: "home" };
  if (p.includes("/")) return { kind: "not-found" };

  if (p.startsWith("@")) {
    // D10: the @ form only ever names a username.
    const row = await deps.names.lookup(p.slice(1), "username");
    const current = row?.owner ? await deps.names.activeUsername(row.owner) : undefined;
    return current ? { kind: "redirect", location: `/${current.name}` } : { kind: "not-found" };
  }

  const row = await deps.names.lookup(p);
  if (!row || row.kind === "reserved") return { kind: "not-found" };

  if (row.kind === "link" || row.kind === "code") {
    if (row.status !== "active") return { kind: "gone" };
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
    return current ? { kind: "redirect", location: `/${current.name}` } : { kind: "not-found" };
  }
  const page = await deps.pages.getPage(row.owner ?? row.name);
  if (!page) return { kind: "not-found" };
  return page.takenDownAt === null ? { kind: "page", username: row.name } : { kind: "page-gone", username: row.name };
}

/**
 * App-alias handlers — `<slug>.<user>.flagship.services` collapse.
 *
 * Routes:
 *   POST /api/aliases/declare        — IRK-signed declare
 *   POST /api/aliases/release        — IRK-signed release
 *   GET  /api/aliases/resolve?host=  — public; returns the resolution
 *   GET  /api/aliases/by-user/<user> — public listing
 *
 * See docs/multiplexing.md for the design.
 */

import {
  verifyAliasDeclare,
  verifyAliasRelease,
  type AliasDeclareRequest,
  type AliasReleaseRequest,
} from "@flagship/protocol";
import type {
  AppAliasRecord,
  AppAliasStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";

export interface AliasDeps {
  aliases: AppAliasStorage;
  usernames: UsernameStorage;
  freshnessMs?: number;
  now?: () => number;
  /**
   * Optional hook fired when an alias is declared/released — production
   * wires it to a CloudflareDnsClient that writes/removes the CNAME.
   */
  onDeclared?: (rec: AppAliasRecord) => Promise<void>;
  onReleased?: (username: string, slug: string) => Promise<void>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FULL_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SERVER_FQDN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.flagship\.services$/;
// Reserved labels that must never be claimed as an alias slug — they
// collide with infrastructure or recognizable conventions.
const RESERVED_SLUGS = new Set([
  "www", "mail", "admin", "api", "auth", "docs", "status", "marketplace",
  "build", "download", "blog", "help", "abuse", "security", "privacy",
  "terms", "faq", "pricing", "_acme-challenge",
]);

interface DeclareBody {
  request?: Partial<AliasDeclareRequest>;
  signature?: string;
}

export async function handleAliasDeclare(
  deps: AliasDeps,
  body: DeclareBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.slug !== "string" ||
    typeof r.fullLabel !== "string" ||
    typeof r.serverDomain !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) return malformed("malformed body");

  if (!SLUG_RE.test(r.slug)) return malformed("invalid slug");
  if (RESERVED_SLUGS.has(r.slug)) return malformed("slug is reserved");
  if (!FULL_LABEL_RE.test(r.fullLabel)) return malformed("invalid fullLabel");
  if (!SERVER_FQDN_RE.test(r.serverDomain)) return malformed("invalid serverDomain");

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");

  // The serverDomain must belong to this user (i.e. middle label = username).
  // <server>.<user>.flagship.services
  const parts = r.serverDomain.split(".");
  if (parts[1] !== r.username) {
    return forbidden("serverDomain does not belong to this user");
  }

  const claim: AliasDeclareRequest = {
    username: r.username,
    slug: r.slug,
    fullLabel: r.fullLabel,
    serverDomain: r.serverDomain,
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }
  if (!verifyAliasDeclare(claim, sig, irkPub)) return forbidden("invalid signature");

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  const rec: AppAliasRecord = {
    username: r.username,
    slug: r.slug,
    fullLabel: r.fullLabel,
    serverDomain: r.serverDomain,
    declaredAt: now,
    declaredByIrkPubHex: userRec.irkPubHex,
    declaredIrkSignatureHex: body.signature,
  };
  const result = await deps.aliases.declare(rec);
  if (!result.ok) {
    return {
      status: 409,
      body: {
        error: "conflict",
        existing: serializeAlias(result.existing),
        candidates: [serializeAlias(result.existing), serializeAlias(rec)],
      },
    };
  }
  if (!result.alreadyEqual && deps.onDeclared) {
    try {
      await deps.onDeclared(rec);
    } catch {
      // Best-effort DNS write — caller can retry. We've already
      // committed to the alias in the table.
    }
  }
  return ok({
    ok: true,
    idempotent: !!result.alreadyEqual,
    alias: serializeAlias(rec),
    shortHost: `${r.slug}.${r.username}.flagship.services`,
  });
}

interface ReleaseBody {
  request?: Partial<AliasReleaseRequest>;
  signature?: string;
}

export async function handleAliasRelease(
  deps: AliasDeps,
  body: ReleaseBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.slug !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) return malformed("malformed body");

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");

  const claim: AliasReleaseRequest = {
    username: r.username,
    slug: r.slug,
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }
  if (!verifyAliasRelease(claim, sig, irkPub)) return forbidden("invalid signature");

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  await deps.aliases.release(r.username, r.slug);
  if (deps.onReleased) {
    try { await deps.onReleased(r.username, r.slug); } catch { /* best-effort */ }
  }
  return ok({ ok: true });
}

/**
 * Public resolver for `<slug>.<user>.flagship.services`. The Worker's
 * disambiguation page calls this to decide what to render.
 */
export async function handleAliasResolve(
  deps: AliasDeps,
  host: string,
): Promise<HandlerResponse> {
  const parsed = parseShortHost(host);
  if (!parsed) {
    return ok({ kind: "missing", host });
  }
  const rec = await deps.aliases.get(parsed.username, parsed.slug);
  if (!rec) {
    return ok({ kind: "missing", host });
  }
  return ok({
    kind: "single",
    host,
    alias: serializeAlias(rec),
    /** The full long-form host the browser should use. */
    longHost: `${rec.fullLabel}.${rec.serverDomain}`,
  });
}

export async function handleAliasListByUser(
  deps: AliasDeps,
  username: string,
): Promise<HandlerResponse> {
  const aliases = await deps.aliases.listByUser(username);
  return ok({ aliases: aliases.map(serializeAlias) });
}

function parseShortHost(host: string): { username: string; slug: string } | null {
  const lower = host.toLowerCase();
  // Accept "<slug>.<user>.flagship.services". Reject longer forms so
  // we don't accidentally treat the long form as a short one.
  const re = /^([a-z0-9][a-z0-9-]{0,62})\.([a-z0-9][a-z0-9-]{0,31})\.flagship\.services$/;
  const m = lower.match(re);
  if (!m) return null;
  return { slug: m[1]!, username: m[2]! };
}

function serializeAlias(r: AppAliasRecord) {
  return {
    username: r.username,
    slug: r.slug,
    full_label: r.fullLabel,
    server_domain: r.serverDomain,
    long_host: `${r.fullLabel}.${r.serverDomain}`,
    short_host: `${r.slug}.${r.username}.flagship.services`,
    replication_set: r.replicationSet ? JSON.parse(r.replicationSet) as string[] : null,
    declared_at: r.declaredAt,
  };
}

/**
 * App-claim primitives — `/api/url/*`.
 *
 * Apps in containers reach the daemon at:
 *
 *   GET  /api/url            list of all URLs the calling app may interact
 *                            with on this pod (canonical + ones with a cap)
 *   POST /api/url/claim      { fqdn } — claim a non-canonical URL
 *   POST /api/url/release    { fqdn } — release a previously-claimed URL
 *   GET  /api/url/owned      what THIS instance currently holds
 *
 * carrying `Authorization: Bearer <FLAGSHIP_APP_TOKEN>`.
 *
 * Three checks every claim must pass (see N0h capabilityStore):
 *   1. The capability's appId must equal the appId behind the bearer.
 *   2. The capability's siblingId must equal THIS pod's serverId.
 *   3. The capability's fqdn must equal the request's fqdn.
 *
 * Canonical URLs are immutable. The pod's own
 * `<server>.<user>.flagship.services` and `*.<server>.<user>...` cannot
 * be claimed or released — they always point here. Attempting to do so
 * is a 400 (so apps don't waste cycles on a meaningless call).
 *
 * Release does NOT require a capability — any app can drop a claim it
 * (or its predecessor on this pod) currently holds. We do require a
 * matching cap to EXIST, otherwise the release request reveals the
 * existence of mappings the caller has no business knowing about.
 *
 * NO harness replication. NO auto-claim.
 */

import type { AppAuthTokens } from "../appAuthToken.js";
import type {
  CapabilityStore,
  RevocationCache,
  StoredCapability,
} from "../capabilityStore.js";
import { checkCapability } from "../capabilityStore.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { UrlController } from "../runtime.js";

const J = { "content-type": "application/json" } as const;

export interface UrlHttpDeps {
  appAuthTokens: AppAuthTokens;
  capabilityStore: CapabilityStore;
  revocations: RevocationCache;
  urlController: UrlController;
  /** This pod's serverId — used as the fixed siblingId in cap checks. */
  thisSiblingId: string;
  /**
   * Resolver: given an appId, return the canonical app FQDNs that
   * always point here. For a self-authored slug `notes` on pod
   * `home.alice.flagship.services` this is just
   * `notes.home.alice.flagship.services`. Cross-creator slugs add the
   * `-creator` suffix. The resolver is supplied by the caller because
   * it depends on AppPlatform — we don't import that here so this
   * module stays leaf.
   */
  canonicalFqdnsForApp: (appId: string) => string[];
  now?: () => number;
}

export type UrlKind = "canonical" | "alias" | "custom";

export interface UrlEntry {
  fqdn: string;
  kind: UrlKind;
  ownedBy: "self" | string | null;
  canClaim: boolean;
  capabilityExpiresAt: number | null;
}

export function buildUrlHttpHandlers(deps: UrlHttpDeps) {
  const now = deps.now ?? (() => Date.now());

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/url")) return null;

    const appId = await resolveAppId(req, deps.appAuthTokens);
    if (!appId) return jerr(401, "missing or invalid app token");

    if (req.path === "/api/url" && req.method === "GET") {
      const entries = await listEntries(appId, deps, now);
      return ok({ urls: entries });
    }

    if (req.path === "/api/url/owned" && req.method === "GET") {
      const owned = deps.urlController.list();
      return ok({ owned: owned.map((fqdn) => ({ fqdn })) });
    }

    if (req.path === "/api/url/claim" && req.method === "POST") {
      const body = parseBody(req);
      if (!body || typeof body.fqdn !== "string") return jerr(400, "malformed body");
      const fqdn = body.fqdn.toLowerCase();
      if (isCanonicalUrl(fqdn, deps.thisSiblingId)) {
        return jerr(400, "canonical URLs cannot be claimed/released");
      }
      const r = await checkCapability(
        { callerAppId: appId, thisSiblingId: deps.thisSiblingId, requestedFqdn: fqdn },
        deps.capabilityStore,
        deps.revocations,
        now,
      );
      if (!r.ok) return jerr(403, "no valid capability for this (app, fqdn) on this pod");
      await deps.urlController.claim(fqdn);
      return ok({ ok: true, fqdn });
    }

    if (req.path === "/api/url/release" && req.method === "POST") {
      const body = parseBody(req);
      if (!body || typeof body.fqdn !== "string") return jerr(400, "malformed body");
      const fqdn = body.fqdn.toLowerCase();
      if (isCanonicalUrl(fqdn, deps.thisSiblingId)) {
        return jerr(400, "canonical URLs cannot be claimed/released");
      }
      // Defense-in-depth: require a matching cap to exist before
      // acknowledging the release. Otherwise an app could probe by
      // trying release on every fqdn and observe the success/error
      // shape.
      const r = await checkCapability(
        { callerAppId: appId, thisSiblingId: deps.thisSiblingId, requestedFqdn: fqdn },
        deps.capabilityStore,
        deps.revocations,
        now,
      );
      if (!r.ok) return jerr(403, "no valid capability for this (app, fqdn) on this pod");
      await deps.urlController.release(fqdn);
      return ok({ ok: true, fqdn });
    }

    return null;
  };
}

async function listEntries(
  appId: string,
  deps: UrlHttpDeps,
  now: () => number,
): Promise<UrlEntry[]> {
  const ownedSet = new Set(deps.urlController.list().map((s) => s.toLowerCase()));
  const all = await deps.capabilityStore.list();
  const seen = new Set<string>();
  const out: UrlEntry[] = [];
  // Canonical URLs first — always self-owned, no cap, immutable.
  for (const fqdn of deps.canonicalFqdnsForApp(appId)) {
    const lower = fqdn.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({
      fqdn: lower,
      kind: "canonical",
      ownedBy: "self",
      canClaim: false,
      capabilityExpiresAt: null,
    });
  }
  // Caps stored on this pod for this app on this sibling. These are the
  // FQDNs the app *may* claim (or already has).
  for (const stored of all) {
    if (stored.capability.appId !== appId) continue;
    if (stored.capability.siblingId !== deps.thisSiblingId) continue;
    const lower = stored.capability.fqdn.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const ownedBy: "self" | null = ownedSet.has(lower) ? "self" : null;
    const expired = stored.capability.expiresAt <= now();
    const revoked = await deps.revocations.has({
      username: stored.capability.username,
      capabilityId: stored.id,
    });
    out.push({
      fqdn: lower,
      kind: detectKind(lower, deps.thisSiblingId),
      ownedBy,
      canClaim: !expired && !revoked,
      capabilityExpiresAt: stored.capability.expiresAt,
    });
  }
  return out;
}

function detectKind(fqdn: string, thisSiblingId: string): UrlKind {
  const sib = thisSiblingId.toLowerCase();
  if (fqdn.endsWith(`.${sib}`)) return "canonical";
  if (fqdn.endsWith(".flagship.services")) return "alias";
  return "custom";
}

function isCanonicalUrl(fqdn: string, thisSiblingId: string): boolean {
  const lower = fqdn.toLowerCase();
  const sib = thisSiblingId.toLowerCase();
  if (lower === sib) return true;
  if (lower === `*.${sib}`) return true;
  if (lower.endsWith(`.${sib}`)) return true;
  return false;
}

function parseBody(req: HttpRequest): { fqdn?: unknown } | null {
  try {
    return JSON.parse(req.body.toString("utf8")) as { fqdn?: unknown };
  } catch {
    return null;
  }
}

async function resolveAppId(req: HttpRequest, tokens: AppAuthTokens): Promise<string | null> {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  return await tokens.resolve(auth.slice("Bearer ".length).trim());
}

function ok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}

function jerr(status: number, error: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error }) };
}

// Re-export so test helpers can build StoredCapability without pulling
// the type from a separate module.
export type { StoredCapability };

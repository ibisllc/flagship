/**
 * App-claim primitives — `/api/url/*`.
 *
 *   GET  /api/url            list URLs the calling app may interact
 *                            with on this pod
 *   POST /api/url/claim      { fqdn } — ask the hub to transfer the
 *                            slot to this pod
 *   POST /api/url/release    { fqdn } — drop our claim record
 *   GET  /api/url/owned      what this instance currently has asked for
 *
 * carrying `Authorization: Bearer <FLAGSHIP_APP_TOKEN>`.
 *
 * Under the entitlement model (N12), per-fqdn capabilities are GONE.
 * The pod's IRK-signed cert presented to the .services hub at HELLO
 * time is the authority. This handler is a thin pass-through:
 *  - `claim` calls `urlController.claim(fqdn)` → hub `FRAME_REQUEST_TRANSFER`.
 *  - `release` is informational; the hub-side release happens via
 *    FCFS reassignment when another peer claims, or via socket-death
 *    redistribution.
 *
 * Validation is out at the hub now: the hub checks "is this fqdn
 * derivable from any of your cert's canonicals?" via the allocator.
 * If it isn't, the request is silently a no-op there. This keeps the
 * daemon side dumb and tracks the user's "stay dumb" principle for
 * the .services edge.
 */

import type { AppAuthTokens } from "../serviceAuthToken.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { UrlController } from "../runtime.js";

const J = { "content-type": "application/json" } as const;

export interface UrlHttpDeps {
  appAuthTokens: AppAuthTokens;
  urlController: UrlController;
  /** This pod's serverId — used to compute canonical URLs for the list. */
  thisSiblingId: string;
  /**
   * Resolver: given an serviceId, return the canonical app FQDNs that
   * always point here. Same shape as before; supplied by the runtime.
   */
  canonicalFqdnsForApp: (serviceId: string) => string[];
  now?: () => number;
}

export type UrlKind = "canonical" | "alias" | "custom";

export interface UrlEntry {
  fqdn: string;
  kind: UrlKind;
  ownedBy: "self" | string | null;
}

export function buildUrlHttpHandlers(deps: UrlHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/url")) return null;

    const serviceId = await resolveAppId(req, deps.appAuthTokens);
    if (!serviceId) return jerr(401, "missing or invalid app token");

    if (req.path === "/api/url" && req.method === "GET") {
      const entries = listEntries(serviceId, deps);
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
      await deps.urlController.release(fqdn);
      return ok({ ok: true, fqdn });
    }

    return null;
  };
}

function listEntries(serviceId: string, deps: UrlHttpDeps): UrlEntry[] {
  const ownedSet = new Set(deps.urlController.list().map((s) => s.toLowerCase()));
  const out: UrlEntry[] = [];
  for (const fqdn of deps.canonicalFqdnsForApp(serviceId)) {
    out.push({
      fqdn: fqdn.toLowerCase(),
      kind: "canonical",
      ownedBy: "self",
    });
  }
  for (const fqdn of ownedSet) {
    if (out.some((e) => e.fqdn === fqdn)) continue;
    out.push({
      fqdn,
      kind: detectKind(fqdn, deps.thisSiblingId),
      ownedBy: "self",
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

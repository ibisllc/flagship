/**
 * One authorization layer in front of every control-API route (SEC-AUTH-002).
 *
 * A request resolves to a principal before any handler runs, and each principal
 * may reach only the routes this registry gives it. Routes added later reject for
 * a restricted principal until someone writes the line that allows them, instead
 * of being open to every "paired session" by default (the 2026-10 `/api/build`
 * hole). Owner sessions are unchanged here: their routes still carry their own
 * signed-order and biometric requirements.
 *
 *  - owner      an owner/admin paired session. Not restricted by this layer.
 *  - companion  a Remote (browser) session. Read-only by default; `/api/companion/*`
 *               is how it asks the owner for a write. Never build, deploy, key,
 *               backup, AI or credential routes.
 *  - share      a co-manager session (`fss_` token). `/api/shares/*` only, where the
 *               share's own signed scope applies.
 *  - anonymous  no session token. Public routes carry their own checks, as before.
 */

import type { HttpRequest, HttpResponse } from "./runtime.js";
import { extractPairedSessionToken } from "./pairedSessionStore.js";

export type Principal = "owner" | "companion" | "share" | "anonymous";

export const CENTRAL_DENIED_CODE = "route-not-allowed-for-session";

type Method = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RouteRule {
  /** Path prefix, matched on a segment boundary. */
  prefix: string;
  /** Methods the principal may use under it. */
  methods: readonly Method[];
}

const READ: readonly Method[] = ["GET", "HEAD", "OPTIONS"];
const ALL: readonly Method[] = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

/** Under `/api/screens/` a companion reads everything except these subtrees. */
const COMPANION_NO_READ: readonly string[] = [
  "/api/screens/llm",
  "/api/screens/vibe-code",
  "/api/screens/server-archive",
  "/api/screens/app-backup",
  "/api/screens/paired-sessions",
  "/api/screens/debug-access",
  "/api/screens/api-keys",
  "/api/screens/build-credentials",
];

const COMPANION_ALLOW: readonly RouteRule[] = [
  { prefix: "/api/screens", methods: READ },
  { prefix: "/api/deadman", methods: READ },
  { prefix: "/api/front-page", methods: READ },
  // The one write path: a request the owner approves from their own app.
  { prefix: "/api/companion/request-write", methods: ["POST"] },
  { prefix: "/api/companion/my-pending", methods: ["GET"] },
];

const SHARE_ALLOW: readonly RouteRule[] = [{ prefix: "/api/shares", methods: ALL }];

/**
 * Every control-API prefix the daemon serves. A prefix missing here fails the
 * inventory test (`centralAuthorization.test.ts`), so a new route family has to
 * be classified before it ships.
 */
export const ROUTE_FAMILIES: Readonly<Record<string, { owner: "session" | "signed-order" | "public" | "mixed"; note: string }>> = {
  "/api/screens": { owner: "mixed", note: "phone/webapp BFF; writes carry signed orders" },
  "/api/shares": { owner: "mixed", note: "co-manager sessions; per-action signed scope" },
  "/api/service-access": { owner: "signed-order", note: "access lists, invites" },
  "/api/service-invites": { owner: "public", note: "invitee redeem, proof in body" },
  "/api/service-certs": { owner: "signed-order", note: "per-service certificates" },
  "/api/url": { owner: "session", note: "url controller" },
  "/api/services": { owner: "mixed", note: "installed services" },
  "/api/live_siblings": { owner: "signed-order", note: "box to box" },
  "/api/companion": { owner: "mixed", note: "Remote ticket redeem and write relay" },
  "/api/build": { owner: "session", note: "build modes; owner only" },
  "/api/llm": { owner: "session", note: "AI sessions; owner only" },
  "/api/browser": { owner: "session", note: "app browser; off" },
  "/api/phone": { owner: "signed-order", note: "phone orders" },
  "/api/access-sync": { owner: "signed-order", note: "box to box MAC" },
  "/api/orders-from-user": { owner: "signed-order", note: "signed phone orders" },
  "/api/front-page": { owner: "public", note: "landing data" },
  "/api/deadman": { owner: "session", note: "dead-man view and affirm" },
  "/api/backups": { owner: "session", note: "app backups; owner only" },
  "/api/peer-backup": { owner: "signed-order", note: "box to box" },
  "/api/app-copy": { owner: "signed-order", note: "box to box" },
  "/api/alerts": { owner: "session", note: "alert inbox" },
  "/api/identity": { owner: "session", note: "identity rotate; owner only" },
  "/api/journal": { owner: "signed-order", note: "signed journal reads" },
  "/api/power": { owner: "signed-order", note: "lock/restart/off; phone-signed" },
  "/api/archive-download": { owner: "signed-order", note: "box to box archive transfer" },
  "/api/archive-probe": { owner: "signed-order", note: "box to box archive transfer" },
  "/api/multipod": { owner: "session", note: "test harness skin; not mounted on a production box" },
  "/mcp/build": { owner: "session", note: "per-build bearer key, not a paired session" },
};

export function principalOf(req: HttpRequest, isCompanion: (r: HttpRequest) => boolean): Principal {
  const token = extractPairedSessionToken(req);
  if (!token) return "anonymous";
  if (token.startsWith("fss_")) return "share";
  return isCompanion(req) ? "companion" : "owner";
}

function pathOnly(path: string): string {
  const q = path.indexOf("?");
  return q >= 0 ? path.slice(0, q) : path;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function normalise(path: string): string | null {
  // Reject what a handler might normalise into a different route.
  if (/%2e|%2f|%5c|\\|\/\//i.test(path) || path.split("/").some((s) => s === "." || s === "..")) return null;
  return path;
}

export type Decision = { allow: true } | { allow: false; status: 403 | 404; reason: string };

export function authorizeRoute(principal: Principal, method: string, rawPath: string): Decision {
  if (principal === "owner" || principal === "anonymous") return { allow: true };
  const path = normalise(pathOnly(rawPath));
  if (path === null) return { allow: false, status: 403, reason: "ambiguous path" };
  const m = method.toUpperCase();
  if (principal === "share") {
    return SHARE_ALLOW.some((r) => under(path, r.prefix) && r.methods.includes(m as Method))
      ? { allow: true }
      : { allow: false, status: 403, reason: "a co-manager session reaches only /api/shares" };
  }
  // companion
  if (COMPANION_NO_READ.some((p) => under(path, p))) return { allow: false, status: 403, reason: "not available to a Remote session" };
  return COMPANION_ALLOW.some((r) => under(path, r.prefix) && r.methods.includes(m as Method))
    ? { allow: true }
    : { allow: false, status: 403, reason: "a Remote session is read-only here" };
}

export function centralAuthorization(deps: { isCompanionRequest: (r: HttpRequest) => boolean }) {
  return async (req: HttpRequest): Promise<HttpResponse | null> => {
    const path = pathOnly(req.path);
    // Only control-API families; the per-app proxy and static surfaces have their own gates.
    if (!path.startsWith("/api/") && !path.startsWith("/mcp/")) return null;
    const principal = principalOf(req, deps.isCompanionRequest);
    const d = authorizeRoute(principal, req.method, req.path);
    if (d.allow) return null;
    return {
      status: d.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: CENTRAL_DENIED_CODE, message: "Open your owner app to do this" }),
    };
  };
}

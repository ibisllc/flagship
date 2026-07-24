/**
 * `GET /api/leads` — the box's client-facing, UNAUTHENTICATED read of its LIVE
 * gossip-computed per-service leadership map.
 *
 * This mirrors `GET /api/services` exactly: it is served on the box's own pinned
 * pipe (the `<server>.<user>` FQDN), is unauthenticated (a public read like the
 * front-page picker's services list), and is CORS-enabled for the webapp by the
 * shared `withCors`/`corsPreflight` wrapper in the runtime's connection handler
 * (it wraps EVERY `/api/*` response, this one included — no per-handler CORS).
 *
 * Clients read this to learn fresh leadership DIRECTLY from a box, instead of
 * only the ~5-min `.com` `/pods` relay. Because the map is the UNION of every
 * live member's slugs, ANY live box of the account answers for ALL the account's
 * live-hosted services — a box reports the leader even for services it doesn't
 * itself host.
 *
 * When gossip is DISABLED (no CGK provisioned / not wired) the box still answers
 * 200, with `gossipActive:false` and an empty `leads` map.
 */
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { LeadsSnapshot } from "./index.js";

export interface LeadsHttpDeps {
  /** This box's fqdn/podCanonical — the response's `self`. */
  serverFqdn: string;
  /** Compute the live snapshot. Always present; returns disabled when no gossip. */
  snapshot: () => LeadsSnapshot;
  /**
   * The box's running git commit (its own `/opt/flagship` HEAD), or null when
   * the daemon isn't running from a checkout. Surfaced publicly so a client can
   * confirm which endorsed version a box is actually running — the observable
   * signal that "Update this server" moved a box to the target commit. The code
   * is public; the running version is not a secret.
   */
  commit?: () => string | null;
  /** Injected clock for `asOf` (deterministic tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build a handler that answers `GET /api/leads` and falls through (null) for
 * every other path/method — so it composes in the runtime's first-non-null
 * handler chain alongside `/internal/gossip` etc.
 */
export function buildLeadsHttpHandler(
  deps: LeadsHttpDeps,
): (req: HttpRequest) => Promise<HttpResponse | null> {
  const now = deps.now ?? (() => Date.now());
  return async function leadsHandler(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0] ?? req.path;
    if (path !== "/api/leads") return null;
    if (req.method.toUpperCase() !== "GET") return null;
    const snap = deps.snapshot();
    const body = {
      asOf: now(),
      self: deps.serverFqdn,
      gossipActive: snap.gossipActive,
      leads: snap.leads,
      commit: deps.commit ? deps.commit() : null,
    };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  };
}

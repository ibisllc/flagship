/**
 * An admin's app hands the box its serving records directly (docs/architecture-v2/serving-wiring.md §3-4): on app
 * open the fresh leases, after an edit the new policy. `.com` delivers the same records on the heartbeat reply, so
 * this only makes a renewal take effect at once.
 *
 *   GET  /api/screens/serving                                → the server-detail `serving` view
 *   POST /api/screens/serving {policy?, leases?, delegations?} → 200 {ok, policyAdopted, leasesAccepted, refused, serving}
 *
 * Every record carries the admin's own signature and the store verifies it under the pinned key, so the owner
 * session only keeps strangers out; a Remote (companion) session can read but not post.
 */
import type { ServingStore } from "./servingStore.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const SERVING_PATH = "/api/screens/serving";

const J = { "content-type": "application/json" };
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });

export function buildServingHttp(deps: {
  store: Pick<ServingStore, "offer" | "view">;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
}) {
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== SERVING_PATH) return null;
    if (method === "GET") return json(200, deps.store.view());
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    let body: unknown;
    try {
      body = req.body.length === 0 ? null : JSON.parse(req.body.toString("utf-8"));
    } catch {
      return json(400, { error: "body must be JSON", code: "serving-malformed" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "Send {policy?, leases?, delegations?}.", code: "serving-malformed" });
    }
    const { policy, leases, delegations } = body as Record<string, unknown>;
    const r = await deps.store.offer({ policy, leases, delegations }, "an admin's device");
    return json(200, { ok: true, ...r, serving: deps.store.view() });
  };
}

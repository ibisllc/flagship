/**
 * The phone hands this box the owner's new server order directly
 * (docs/server-order.md "Delivery and acknowledgement"), so a reorder takes
 * effect in seconds instead of on the next heartbeat. `.com` still delivers
 * it to every box the phone can't reach.
 *
 *   GET  /api/screens/server-order               → { heldIssuedAt }
 *   POST /api/screens/server-order {order, signature}
 *        → 200 { ok, adopted, heldIssuedAt }     held order is this one or newer
 *        → 422 { error, heldIssuedAt }           it doesn't verify for this account
 *
 * `heldIssuedAt` is the box's acknowledgement: the `issuedAt` of the order it
 * now ranks by (0 when none). The order carries the owner's signature and the
 * holder verifies it, so the paired session only keeps strangers out; a
 * companion session can read but not post.
 */
import type { ServerOrderHolder } from "./serverOrderHolder.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const SERVER_ORDER_PATH = "/api/screens/server-order";

const J = { "content-type": "application/json" };
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });

export function buildServerOrderHttp(deps: {
  holder: Pick<ServerOrderHolder, "current" | "offer">;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
}) {
  const heldIssuedAt = () => deps.holder.current()?.order.issuedAt ?? 0;
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== SERVER_ORDER_PATH) return null;
    if (method === "GET") return json(200, { heldIssuedAt: heldIssuedAt() });
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    let body: unknown;
    try {
      body = req.body.length === 0 ? null : JSON.parse(req.body.toString("utf-8"));
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const sent = (body as { order?: { issuedAt?: unknown } } | null)?.order?.issuedAt;
    const adopted = await deps.holder.offer(body, "the owner's device");
    const held = heldIssuedAt();
    if (adopted || (typeof sent === "number" && held >= sent)) {
      return json(200, { ok: true, adopted, heldIssuedAt: held });
    }
    return json(422, { error: "This server didn't accept the order: it isn't signed by this account's key.", heldIssuedAt: held });
  };
}

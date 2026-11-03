import type { HttpRequest, HttpResponse } from "./runtime.js";

/**
 * Routes a 0.2 app still calls that 0.3 retired (owner rule F9: a 0.2 app is told to update, never left with a
 * bare 404). The answer is a sentence the 0.2 iOS and Android apps show word for word (a capital first letter, a
 * full stop, no raw-error markers; control-plane clientUpdate.ts holds the same rule for `.com`).
 *
 *   POST /api/deadman/policy, /api/deadman/affirm  the 0.2 dead-man switch, replaced by the serving time limit
 *                                                  (serving-policy/v1, `/api/screens/serving`)
 */
export const DEADMAN_UPDATE_APP =
  "This server's time limit is set in the newest version of Flagship. Update the app, then try again.";

const H = { "content-type": "application/json" };

export function buildLegacyClientRoutes() {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0];
    if (path !== "/api/deadman/policy" && path !== "/api/deadman/affirm") return null;
    return { status: 410, headers: H, body: JSON.stringify({ error: DEADMAN_UPDATE_APP, code: "app-update-required" }) };
  };
}

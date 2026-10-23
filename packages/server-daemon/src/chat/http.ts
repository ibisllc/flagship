/**
 * The app-facing chat routes (SECURITY-HARDENING-PLAN.md 17.5). Every call is authenticated by the
 * app's bearer token and acts as that app only; a token for one app cannot name another.
 *
 *   POST /api/chat/v1/listen    { originScope, ownedInstanceScope }  -> { subscriptionId }
 *   POST /api/chat/v1/message   { receiverAuthor, receiverApp, body, targetUser?, requestId, accessProof?, phrase? }
 *                               or { conversationId, body, requestId }  -> { accepted, conversationId? }
 *   POST /api/chat/v1/close     { conversationId }  -> { accepted }
 *   GET  /api/chat/v1/poll      -> { events: [...] }
 */
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { AppAuthTokens } from "../serviceAuthToken.js";
import { ChatInputError, type AppIdentity } from "./types.js";
import type { ChatHarness } from "./harness.js";

const J = { "content-type": "application/json" } as const;

export interface ChatHttpDeps {
  harness: ChatHarness;
  appAuthTokens: AppAuthTokens;
  /** `<creator>--<slug>` for an installed app, or null if it is not one. */
  identityOf: (serviceId: string) => AppIdentity | null;
}

export function buildChatHttpHandlers(deps: ChatHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    if (!path.startsWith("/api/chat/v1/")) return null;
    const auth = req.headers["authorization"] ?? req.headers["Authorization"];
    const serviceId = typeof auth === "string" && auth.startsWith("Bearer ") ? await deps.appAuthTokens.resolve(auth.slice(7).trim()) : null;
    const app = serviceId ? deps.identityOf(serviceId) : null;
    if (!app) return err(401, "missing or invalid app token");
    try {
      if (path === "/api/chat/v1/poll" && req.method === "GET") return ok({ events: deps.harness.poll(app) });
      if (req.method !== "POST") return err(405, "method not allowed");
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        return err(400, "invalid json");
      }
      if (path === "/api/chat/v1/listen") {
        return ok(deps.harness.listen(app, { originScope: b.originScope as never, ownedInstanceScope: b.ownedInstanceScope as never }));
      }
      if (path === "/api/chat/v1/message") {
        if (typeof b.conversationId === "string") {
          return ok(await deps.harness.reply(app, { conversationId: b.conversationId, body: b.body as string, requestId: b.requestId as string }));
        }
        return ok(
          await deps.harness.start(app, {
            receiverAuthor: String(b.receiverAuthor ?? ""), receiverApp: String(b.receiverApp ?? ""), body: b.body as string, requestId: b.requestId as string,
            ...(typeof b.targetUser === "string" ? { targetUser: b.targetUser } : {}),
            ...(b.accessProof && typeof b.accessProof === "object" ? { accessProof: b.accessProof as never } : {}),
            ...(typeof b.phrase === "string" ? { phrase: b.phrase } : {}),
            ...("server" in b ? { server: b.server } : {}),
          }),
        );
      }
      if (path === "/api/chat/v1/close") return ok(await deps.harness.close(app, { conversationId: String(b.conversationId ?? "") }));
      return err(404, "no such chat route");
    } catch (e) {
      if (e instanceof ChatInputError) return err(e.code === "rate-limited" ? 429 : e.code === "unknown-conversation" ? 404 : 400, e.message, e.code);
      throw e;
    }
  };
}

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: J, body: JSON.stringify(body) });
const err = (status: number, error: string, code?: string): HttpResponse => ({ status, headers: J, body: JSON.stringify({ error, ...(code ? { code } : {}) }) });

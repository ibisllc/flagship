/**
 * App-facing sibling API. Apps in containers reach the daemon at
 *
 *   GET  /api/sibling/list
 *   POST /api/sibling/send       { toSiblingId, payloadHex }
 *   GET  /api/sibling/poll       (long-poll fallback for subscribe; the
 *                                 real WS endpoint is wired in N0e-2)
 *
 * carrying `Authorization: Bearer <FLAGSHIP_APP_TOKEN>`. The handler
 * resolves the bearer back to an appId; that appId becomes the scope
 * key for both send (fromAppId) and subscribe (the only id apps may
 * receive on). Two apps on the same pod cannot read each other's
 * inbound traffic and cannot send under each other's identity.
 */

import type { AppAuthTokens } from "../appAuthToken.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type {
  AppMessageListener,
  InMemorySiblingRouter,
  InboundAppMessage,
} from "./router.js";

const J = { "content-type": "application/json" } as const;

export interface SiblingHttpDeps {
  router: InMemorySiblingRouter;
  appAuthTokens: AppAuthTokens;
  /** This pod's serverId — used as `fromSiblingId` on send. */
  thisSiblingId: string;
  /** Long-poll wait window for /api/sibling/poll. Default 25s. */
  pollWaitMs?: number;
  /** Pending message buffer per app (only while a poll is active). */
  pollBufferMax?: number;
}

export function buildSiblingHttpHandlers(deps: SiblingHttpDeps) {
  // App-scoped pending queues for long-poll. Each entry holds a list
  // of buffered messages (received while no poll was active) plus a
  // pending-resolver if a poll is currently waiting.
  interface PollSlot {
    buffer: InboundAppMessage[];
    resolver?: (msgs: InboundAppMessage[]) => void;
    listener: AppMessageListener;
  }
  const slots = new Map<string, PollSlot>();
  const pollWaitMs = deps.pollWaitMs ?? 25_000;
  const bufferMax = deps.pollBufferMax ?? 256;

  function ensureSlot(appId: string): PollSlot {
    let s = slots.get(appId);
    if (s) return s;
    const slot: PollSlot = {
      buffer: [],
      listener: (msg) => {
        if (slot.resolver) {
          const r = slot.resolver;
          slot.resolver = undefined;
          r([msg]);
          return;
        }
        if (slot.buffer.length < bufferMax) slot.buffer.push(msg);
        // Else drop — apps that don't drain are responsible for their own
        // backpressure.
      },
    };
    deps.router.subscribe(appId, slot.listener);
    slots.set(appId, slot);
    return slot;
  }

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/sibling/")) return null;

    const appId = await resolveAppId(req, deps.appAuthTokens);
    if (!appId) return jerr(401, "missing or invalid app token");

    if (req.path === "/api/sibling/list" && req.method === "GET") {
      return {
        status: 200,
        headers: J,
        body: JSON.stringify({ siblings: deps.router.list() }),
      };
    }

    if (req.path === "/api/sibling/send" && req.method === "POST") {
      let body: { toSiblingId?: unknown; payloadHex?: unknown };
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        return jerr(400, "invalid json");
      }
      if (
        typeof body.toSiblingId !== "string" ||
        typeof body.payloadHex !== "string" ||
        !/^[0-9a-f]*$/.test(body.payloadHex) ||
        body.payloadHex.length % 2 !== 0
      ) {
        return jerr(400, "malformed body");
      }
      const r = await deps.router.send({
        fromAppId: appId,
        fromSiblingId: deps.thisSiblingId,
        toSiblingId: body.toSiblingId,
        payloadHex: body.payloadHex,
      });
      if (!r.ok) {
        const status = r.reason === "unknown sibling" ? 404 : r.reason === "sibling offline" ? 503 : 502;
        return {
          status,
          headers: J,
          body: JSON.stringify({ error: r.reason, ...(r.message ? { message: r.message } : {}) }),
        };
      }
      return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
    }

    if (req.path === "/api/sibling/poll" && req.method === "GET") {
      const slot = ensureSlot(appId);
      // If we have buffered messages, return immediately.
      if (slot.buffer.length > 0) {
        const msgs = slot.buffer.splice(0);
        return {
          status: 200,
          headers: J,
          body: JSON.stringify({ messages: msgs }),
        };
      }
      // Park the request waiting for a message or the long-poll
      // timeout to fire.
      const msgs = await new Promise<InboundAppMessage[]>((resolve) => {
        slot.resolver = resolve;
        const t = setTimeout(() => {
          if (slot.resolver === resolve) {
            slot.resolver = undefined;
            resolve([]);
          }
        }, pollWaitMs);
        // unref so a hung poll doesn't keep the daemon alive
        (t as unknown as { unref?: () => void }).unref?.();
      });
      return { status: 200, headers: J, body: JSON.stringify({ messages: msgs }) };
    }

    return null;
  };
}

async function resolveAppId(req: HttpRequest, tokens: AppAuthTokens): Promise<string | null> {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  return await tokens.resolve(auth.slice("Bearer ".length).trim());
}

function jerr(status: number, error: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error }) };
}

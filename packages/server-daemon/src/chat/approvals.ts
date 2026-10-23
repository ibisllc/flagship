/**
 * The admin's screens for app chat (SECURITY-HARDENING-PLAN.md 17.6, 18.8).
 *
 *   GET  /api/screens/chat/requests          -> { requests: [...], always: [{receiverApp, claimedSender}] }
 *   POST /api/screens/chat/answer              { requestId, kind, decision, issuedAt, signature }
 *   POST /api/screens/chat/always/revoke       { author, slug, sender?: {author, slug} }   (receiving app; one sender or all)
 *
 * An answer that lets something in is an owner signature (`flagship/chat-approval/v1`, the sensitive-order
 * key), so a stolen paired session cannot admit a stranger's app or approve an app's contact with another
 * owner. Withdrawing an Always allow only narrows what is open and needs the session alone. The wording the
 * clients show is "a remote machine claiming to run <author>/<app>": the sender is a claim, never an identity.
 */
import { verifyChatApproval, type ChatApprovalDecision, type ChatApprovalKind } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { SensitiveAuthority } from "../egress/approvals.js";
import type { ChatHarness } from "./harness.js";

const J = { "content-type": "application/json" } as const;
export const CHAT_REQUESTS_PATH = "/api/screens/chat/requests";
export const CHAT_ANSWER_PATH = "/api/screens/chat/answer";
export const CHAT_REVOKE_PATH = "/api/screens/chat/always/revoke";

export function isChatApprovalPath(path: string): boolean {
  return path === CHAT_REQUESTS_PATH || path === CHAT_ANSWER_PATH || path === CHAT_REVOKE_PATH;
}

export interface ChatApprovalsOptions {
  serverDomain: string;
  /** Read fresh at every answer: the admin devices change. */
  authority: () => SensitiveAuthority;
  harness: ChatHarness;
  now?: () => number;
  maxSkewMs?: number;
}

const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
const err = (status: number, error: string): HttpResponse => json(status, { error });
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function buildChatApprovalsHttp(o: ChatApprovalsOptions) {
  const now = o.now ?? (() => Date.now());
  const skew = o.maxSkewMs ?? 10 * 60_000;
  const usedOrders = new Set<string>();

  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path === CHAT_REQUESTS_PATH) {
      if (method !== "GET") return err(405, "method not allowed");
      return json(200, { requests: o.harness.pendingList(), always: o.harness.alwaysList() });
    }
    if (method !== "POST") return err(405, "method not allowed");
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return err(400, "invalid json");
    }
    if (path === CHAT_REVOKE_PATH) {
      if (typeof b.author !== "string" || typeof b.slug !== "string" || !NAME.test(b.author) || !NAME.test(b.slug)) return err(400, "name the app");
      const s = b.sender as Record<string, unknown> | undefined;
      if (s !== undefined && (!s || typeof s.author !== "string" || typeof s.slug !== "string" || !NAME.test(s.author) || !NAME.test(s.slug))) return err(400, "name the sending app");
      return json(200, { ended: await o.harness.revokeAlwaysAllow({ author: b.author, slug: b.slug }, s ? { author: s.author as string, slug: s.slug as string } : undefined) });
    }
    if (path !== CHAT_ANSWER_PATH) return null;
    const { requestId, kind, decision, issuedAt, signature } = b;
    if (typeof requestId !== "string" || typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return err(400, "a signed answer is required");
    if (kind !== "incoming" && kind !== "outgoing") return err(400, "bad kind");
    if (decision !== "allow" && decision !== "always" && decision !== "deny") return err(400, "bad decision");
    if (!Number.isSafeInteger(issuedAt)) return err(400, "bad issuedAt");
    if (Math.abs(now() - (issuedAt as number)) > skew) return err(400, "stale answer");
    const order = { serverDomain: o.serverDomain, requestId, kind: kind as ChatApprovalKind, decision: decision as ChatApprovalDecision, issuedAt: issuedAt as number };
    let verified = false;
    try {
      const a = o.authority();
      verified = authorizeSensitiveOrder({
        ownerIrkPub: a.ownerIrkPub,
        ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
        username: a.username,
        ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
        order,
        signature: Uint8Array.from(Buffer.from(signature, "hex")),
        verify: verifyChatApproval,
      });
    } catch {
      verified = false;
    }
    if (!verified) return err(403, "that answer was not signed by the owner");
    const used = `${requestId}|${kind}`;
    if (usedOrders.has(used)) return err(409, "already answered");
    usedOrders.add(used);
    if (usedOrders.size > 4096) usedOrders.delete(usedOrders.values().next().value!);
    const found = kind === "incoming" ? await o.harness.answerIncoming(requestId, decision as "allow" | "always" | "deny") : await o.harness.approveOutgoing(requestId, decision === "deny" ? "deny" : "allow");
    return found ? json(200, { ok: true }) : err(404, "that request is no longer waiting");
  };
}

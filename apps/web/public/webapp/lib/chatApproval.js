// `flagship/chat-approval/v1`: the owner's answer to a held app-chat request, signed with the sensitive-order
// key and carried by the paired session to POST /api/screens/chat/answer. Wire parity with
// packages/protocol/src/chatWire.ts; pinned by packages/protocol/test-vectors/chat-approval/vectors.json.
//
//   flagship/chat-approval/v1|<serverDomain lowercase>|<requestId>|<kind>|<decision>|<issuedAt>

export const CHAT_APPROVAL_TAG = "flagship/chat-approval/v1";

const clean = (s) => typeof s === "string" && s.length > 0 && !/[|\x00-\x1f\x7f]/.test(s);

export function canonicalChatApproval(o) {
  if (!clean(o.serverDomain)) throw new Error("serverDomain");
  if (!clean(o.requestId)) throw new Error("requestId");
  if (o.kind !== "incoming" && o.kind !== "outgoing") throw new Error("kind");
  if (!["allow", "always", "deny"].includes(o.decision)) throw new Error("decision");
  if (o.decision === "always" && o.kind !== "incoming") throw new Error("always allow applies to incoming requests only");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("issuedAt");
  return new TextEncoder().encode([CHAT_APPROVAL_TAG, o.serverDomain.toLowerCase(), o.requestId, o.kind, o.decision, o.issuedAt].join("|"));
}

/** The JSON body of POST /api/screens/chat/answer; `sign(bytes)` returns the 64-byte signature. */
export async function chatAnswerBody(order, sign) {
  const sig = await sign(canonicalChatApproval(order));
  return {
    requestId: order.requestId,
    kind: order.kind,
    decision: order.decision,
    issuedAt: order.issuedAt,
    signature: Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

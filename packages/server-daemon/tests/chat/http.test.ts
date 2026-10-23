import { describe, expect, it } from "vitest";
import { ChatHarness, buildChatHttpHandlers } from "../../src/chat/index.js";
import type { AppAuthTokens } from "../../src/serviceAuthToken.js";
import type { HttpRequest } from "../../src/runtime.js";

const tokens: Record<string, string> = { tokA: "carol--lobby", tokB: "carol--game" };
const appTokens = { resolve: async (t: string) => tokens[t] ?? null } as unknown as AppAuthTokens;
const harness = () => new ChatHarness({ self: { account: "carol" }, lead: { generation: () => 1, mayAdmit: () => false }, admission: null, transport: { sendToLead: async () => { throw new Error("off"); }, sendOnRoute: async () => {} }, notifier: { approval: () => {} }, hostsApp: () => false, crossOwner: false });
const mk = () => buildChatHttpHandlers({ harness: harness(), appAuthTokens: appTokens, identityOf: (id) => { const [author, slug] = id.split("--"); return { author: author!, slug: slug! }; } });
const call = (h: ReturnType<typeof mk>, token: string | null, method: string, path: string, body?: unknown) =>
  h({ method, path, headers: token ? { authorization: `Bearer ${token}` } : {}, body: Buffer.from(body ? JSON.stringify(body) : "") } as HttpRequest);

describe("app-facing chat routes", () => {
  it("every call needs an app token and acts as that app only", async () => {
    const h = mk();
    expect((await call(h, null, "GET", "/api/chat/v1/poll"))?.status).toBe(401);
    expect((await call(h, "nope", "GET", "/api/chat/v1/poll"))?.status).toBe(401);
    expect(await call(h, "tokA", "GET", "/api/other")).toBeNull();
  });

  it("two local apps converse; neither can use the other's handle; the cross-owner path is accepted and silent", async () => {
    const h = mk();
    await call(h, "tokB", "POST", "/api/chat/v1/listen", { originScope: "same-account", ownedInstanceScope: "this-server" });
    const start = JSON.parse((await call(h, "tokA", "POST", "/api/chat/v1/message", { receiverAuthor: "carol", receiverApp: "game", body: "hi", requestId: "r1" }))!.body as string);
    expect(start.accepted).toBe(true);
    const polled = JSON.parse((await call(h, "tokB", "GET", "/api/chat/v1/poll"))!.body as string);
    expect(polled.events[0]).toMatchObject({ type: "message", envelope: { body: "hi", claimedSender: { author: "carol", slug: "lobby" } } });
    const theirId = polled.events[0].envelope.conversationId;
    // tokA presenting B's handle, and B presenting A's, are both refused
    expect((await call(h, "tokA", "POST", "/api/chat/v1/message", { conversationId: theirId, body: "x", requestId: "r2" }))?.status).toBe(404);
    expect((await call(h, "tokB", "POST", "/api/chat/v1/message", { conversationId: start.conversationId, body: "x", requestId: "r3" }))?.status).toBe(404);
    const cross = await call(h, "tokA", "POST", "/api/chat/v1/message", { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "hello", requestId: "r4" });
    expect(cross?.status).toBe(200);
    expect(JSON.parse(cross!.body as string).accepted).toBe(true);
  });

  it("bad input fails normally and locally", async () => {
    const h = mk();
    expect((await call(h, "tokA", "POST", "/api/chat/v1/message", { receiverAuthor: "carol", receiverApp: "game", body: "x".repeat(70_000), requestId: "r" }))?.status).toBe(400);
    expect((await call(h, "tokA", "POST", "/api/chat/v1/listen", { originScope: "everyone", ownedInstanceScope: "this-server" }))?.status).toBe(400);
  });
});

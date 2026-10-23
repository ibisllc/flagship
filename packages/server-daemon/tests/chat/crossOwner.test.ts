import { describe, expect, it } from "vitest";
import { chatWireBodySha256, ed, signChatApproval, signChatWire } from "@flagship/protocol";
import { ChatHarness, appKey, type ApprovalRequest } from "../../src/chat/index.js";
import { buildChatApprovalsHttp } from "../../src/chat/approvals.js";
import { buildCrossOwnerChat, type CrossOwnerChat } from "../../src/chat/system.js";
import { CHAT_WIRE_PATH, chatAppHost } from "../../src/chat/wire.js";
import type { ChatPeerDirectory } from "../../src/chat/peerDirectory.js";
import type { AppIdentity } from "../../src/chat/types.js";
import type { HttpRequest } from "../../src/runtime.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const APEX = "flagship.services";
const CHESS = { author: "alice", slug: "chess" };
const CLUB = { author: "carol", slug: "club" };

interface Box {
  domain: string;
  account: string;
  seed: Uint8Array;
  apps: AppIdentity[];
  cross: CrossOwnerChat;
  harness: ChatHarness;
  alerts: ApprovalRequest[];
}

/** A relay that, like the real one, sends each name to the one box registered for it. */
function world() {
  const boxes = new Map<string, Box>();
  const registry = new Map<string, { pubHex: string; username: string }>();
  const names = new Map<string, Box>();
  const directory: ChatPeerDirectory = { server: async (d) => registry.get(d.toLowerCase()) ?? null };
  const fetchImpl = (async (url: string, init: { body: string; method: string }) => {
    const u = new URL(url);
    const box = names.get(u.hostname) ?? boxes.get(u.hostname);
    if (!box) throw new Error("unreachable");
    const app = box.apps.find((a) => chatAppHost(a, box.account, APEX) === u.hostname);
    const r = await box.cross.gate({ method: init.method, path: u.pathname, headers: {}, body: Buffer.from(init.body) } as HttpRequest, app ? `${app.author}--${app.slug}` : null);
    return r ? new Response(r.body as string, { status: r.status }) : new Response("app", { status: 200 });
  }) as unknown as typeof fetch;

  function mk(domain: string, account: string, seedByte: number, apps: AppIdentity[]): Box {
    const seed = new Uint8Array(32).fill(seedByte);
    registry.set(domain, { pubHex: hex(ed.getPublicKey(seed)), username: account });
    const alerts: ApprovalRequest[] = [];
    const holder: { box: Box | null } = { box: null };
    const cross = buildCrossOwnerChat({
      self: domain, account, apex: APEX, controlPlaneBaseUrl: "https://com.invalid", sign: (m) => ed.sign(m, seed),
      holdsName: (a) => names.get(chatAppHost(a, account, APEX)) === holder.box, directory, fetchImpl,
    });
    const harness = new ChatHarness({
      self: { account }, lead: cross.lead, admission: null, transport: cross.transport, notifier: { approval: (r) => alerts.push(r) },
      hostsApp: (a) => apps.some((h) => appKey(h) === appKey(a)), crossOwner: true,
    });
    cross.attach(harness, (ref) => apps.find((a) => `${a.author}--${a.slug}` === ref) ?? null);
    const box: Box = { domain, account, seed, apps, cross, harness, alerts };
    holder.box = box;
    boxes.set(domain, box);
    for (const a of apps) {
      const host = chatAppHost(a, account, APEX);
      if (!names.has(host)) names.set(host, box);
    }
    return box;
  }
  return { mk, names, boxes };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

async function contact(carol: Box, body: string) {
  const s = await carol.harness.start(CLUB, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body, requestId: `r-${body}` });
  await carol.harness.approveOutgoing(s.conversationId!, "allow");
  await settle();
  return s;
}

describe("chat between two owners' boxes, addressed by the app's name", () => {
  it("goes out only after the sender's admin allows it, in only after the receiver's, and replies come back", async () => {
    const w = world();
    const alice = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    alice.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });

    const started = await carol.harness.start(CLUB, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "shall we play?", requestId: "r1" });
    expect(started.accepted).toBe(true);
    await settle();
    expect(carol.alerts.map((a) => a.kind)).toEqual(["outgoing"]);
    expect(alice.alerts).toEqual([]);

    await carol.harness.approveOutgoing(started.conversationId!, "allow");
    await settle();
    expect(alice.alerts.map((a) => a.kind)).toEqual(["incoming"]);
    expect(alice.harness.poll(CHESS)).toEqual([]);

    await alice.harness.answerIncoming(alice.alerts[0]!.requestId, "allow");
    const [ev] = alice.harness.poll(CHESS);
    expect(ev).toMatchObject({ type: "message", envelope: { body: "shall we play?", claimedSender: CLUB } });

    const convId = (ev as { envelope: { conversationId: string } }).envelope.conversationId;
    await alice.harness.reply(CHESS, { conversationId: convId, body: "yes", requestId: "r2" });
    await settle();
    expect(carol.harness.poll(CLUB)).toMatchObject([{ type: "message", envelope: { body: "yes", claimedSender: CHESS } }]);
  });

  it("reaches another author's app at slug--author on the hosting owner's account", async () => {
    const w = world();
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CHESS]);
    const LOBBY = { author: "dave", slug: "lobby" };
    const dave = w.mk("home.dave.flagship.services", "dave", 4, [LOBBY]);
    expect(chatAppHost(CHESS, "carol", APEX)).toBe("chess--alice.carol.flagship.services");
    carol.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const s = await dave.harness.start(LOBBY, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "carol", body: "hi", requestId: "r1" });
    await dave.harness.approveOutgoing(s.conversationId!, "allow");
    await settle();
    expect(carol.alerts.map((a) => a.kind)).toEqual(["incoming"]);
  });

  it("an app with no listener hears nothing, raises nothing and uses nothing", async () => {
    const w = world();
    const alice = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    await contact(carol, "hi");
    expect(alice.alerts).toEqual([]);
    expect(alice.harness.pendingCounts()).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("only the box holding the app's name admits; when the name moves, the new holder does", async () => {
    const w = world();
    const home = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const home2 = w.mk("home2.alice.flagship.services", "alice", 5, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    for (const b of [home, home2]) b.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    await contact(carol, "one");
    expect(home.alerts.map((a) => a.kind)).toEqual(["incoming"]);
    expect(home2.alerts).toEqual([]);

    w.names.set(chatAppHost(CHESS, "alice", APEX), home2);
    await contact(carol, "two");
    expect(home.alerts).toHaveLength(1);
    expect(home2.alerts.map((a) => a.kind)).toEqual(["incoming"]);
  });

  it("a box reached on a name it does not hold admits nothing", async () => {
    const w = world();
    const home = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const home2 = w.mk("home2.alice.flagship.services", "alice", 5, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    home2.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    // Delivered to home2 by its own per-box name while home holds the app's name.
    const body = JSON.stringify({ kind: "start", wireId: "s".repeat(24), counter: 1, leadGeneration: 1, target: { ...CHESS, targetUser: "alice" }, claimedSender: CLUB, submittedAt: Date.now(), body: "hi" });
    const statement = { purpose: "frame" as const, fromServer: carol.domain, toServer: chatAppHost(CHESS, "alice", APEX), issuedAt: Date.now(), nonce: "9".repeat(32), bodySha256Hex: chatWireBodySha256(new TextEncoder().encode(body)) };
    const sigHex = hex(signChatWire(statement, (m) => ed.sign(m, carol.seed)));
    const r = await home2.cross.gate({ method: "POST", path: CHAT_WIRE_PATH, headers: {}, body: Buffer.from(JSON.stringify({ statement, sigHex, body })) } as HttpRequest, "alice--chess");
    expect(r?.status).toBe(200); // the same answer as for everything authenticated
    await settle();
    expect(home2.alerts).toEqual([]);
    expect(home.alerts).toEqual([]);
  });

  it("an instance that does not hold its app's name starts nothing with other owners", async () => {
    const w = world();
    const alice = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    const carol2 = w.mk("home2.carol.flagship.services", "carol", 3, [CLUB]);
    alice.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const s = await carol2.harness.start(CLUB, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "hi", requestId: "r1" });
    expect(s.accepted).toBe(true);
    await settle();
    expect(carol2.alerts).toEqual([]); // nothing to approve: it would never hear the replies
    expect(alice.alerts).toEqual([]);
    expect(carol.alerts).toEqual([]);
  });

  it("refuses a frame signed by anyone but the registered key, a replay, a stranger, a wrong addressee and the owner's own boxes", async () => {
    const w = world();
    const alice = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const alice2 = w.mk("home2.alice.flagship.services", "alice", 5, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    const mallory = w.mk("home.mallory.flagship.services", "mallory", 3, []);
    const chessHost = chatAppHost(CHESS, "alice", APEX);
    const body = JSON.stringify({ kind: "close", wireId: "w".repeat(24), counter: 1, leadGeneration: 1 });
    const send = async (t: { sign: Uint8Array; from: string; to: string; nonce: string }) => {
      const statement = { purpose: "frame" as const, fromServer: t.from, toServer: t.to, issuedAt: Date.now(), nonce: t.nonce, bodySha256Hex: chatWireBodySha256(new TextEncoder().encode(body)) };
      const sigHex = hex(signChatWire(statement, (m) => ed.sign(m, t.sign)));
      const req = { method: "POST", path: CHAT_WIRE_PATH, headers: {}, body: Buffer.from(JSON.stringify({ statement, sigHex, body })) } as HttpRequest;
      return (await alice.cross.gate(req, "alice--chess"))?.status;
    };
    expect(await send({ sign: carol.seed, from: carol.domain, to: chessHost, nonce: "a".repeat(32) })).toBe(200);
    expect(await send({ sign: carol.seed, from: carol.domain, to: chessHost, nonce: "a".repeat(32) })).toBe(401); // same nonce
    expect(await send({ sign: mallory.seed, from: carol.domain, to: chessHost, nonce: "b".repeat(32) })).toBe(401); // not carol's key
    expect(await send({ sign: carol.seed, from: "home.nobody.flagship.services", to: chessHost, nonce: "c".repeat(32) })).toBe(401); // not registered
    expect(await send({ sign: carol.seed, from: carol.domain, to: alice.domain, nonce: "d".repeat(32) })).toBe(401); // a box, not the app
    expect(await send({ sign: carol.seed, from: carol.domain, to: chatAppHost(CHESS, "bob", APEX), nonce: "e".repeat(32) })).toBe(401); // another account's app
    expect(await send({ sign: alice2.seed, from: alice2.domain, to: chessHost, nonce: "f".repeat(32) })).toBe(401); // own account: never over the wire
    const other = { method: "POST", path: CHAT_WIRE_PATH, headers: {}, body: Buffer.from("{}") } as HttpRequest;
    expect((await alice.cross.gate(other, null))?.status).toBe(404); // not on an app's host
    expect(await alice.cross.gate({ ...other, path: "/index.html" } as HttpRequest, "alice--chess")).toBeNull(); // the app's own paths pass through
  });

  it("an answer that lets contact in must be signed by the owner", async () => {
    const w = world();
    const alice = w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = w.mk("home.carol.flagship.services", "carol", 2, [CLUB]);
    alice.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    await contact(carol, "hi");
    const owner = new Uint8Array(32).fill(9);
    const http = buildChatApprovalsHttp({
      serverDomain: alice.domain, harness: alice.harness,
      authority: () => ({ username: "alice", ownerIrkPub: ed.getPublicKey(owner) }),
    });
    const list = JSON.parse((await http("/api/screens/chat/requests", "GET", {} as HttpRequest))!.body as string);
    expect(list.requests).toMatchObject([{ kind: "incoming", claimedSender: CLUB, receiverApp: CHESS }]);
    const requestId = list.requests[0].requestId as string;
    const answer = (sig: Uint8Array) => http("/api/screens/chat/answer", "POST", { body: Buffer.from(JSON.stringify({ requestId, kind: "incoming", decision: "allow", issuedAt: Date.now(), signature: hex(sig) })) } as HttpRequest);
    const wrong = signChatApproval({ serverDomain: alice.domain, requestId, kind: "incoming", decision: "deny", issuedAt: Date.now() }, (m) => ed.sign(m, owner));
    expect((await answer(wrong))?.status).toBe(403);
    expect((await answer(new Uint8Array(64)))?.status).toBe(403);
    expect(alice.harness.poll(CHESS)).toEqual([]);
    const issuedAt = Date.now();
    const good = signChatApproval({ serverDomain: alice.domain, requestId, kind: "incoming", decision: "allow", issuedAt }, (m) => ed.sign(m, owner));
    const ok = await http("/api/screens/chat/answer", "POST", { body: Buffer.from(JSON.stringify({ requestId, kind: "incoming", decision: "allow", issuedAt, signature: hex(good) })) } as HttpRequest);
    expect(ok?.status).toBe(200);
    expect(alice.harness.poll(CHESS)).toMatchObject([{ type: "message", envelope: { body: "hi" } }]);
  });
});

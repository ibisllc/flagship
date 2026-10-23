import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signChatApproval } from "@flagship/protocol";
import { ChatHarness, appKey, type ApprovalRequest } from "../../src/chat/index.js";
import { buildChatApprovalsHttp } from "../../src/chat/approvals.js";
import { buildCrossOwnerChat, type CrossOwnerChat } from "../../src/chat/system.js";
import type { ChatPeerDirectory } from "../../src/chat/peerDirectory.js";
import type { HttpRequest } from "../../src/runtime.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const CHESS = { author: "alice", slug: "chess" };
const CLUB = { author: "carol", slug: "club" };

interface Box {
  domain: string;
  account: string;
  seed: Uint8Array;
  cross: CrossOwnerChat;
  harness: ChatHarness;
  alerts: ApprovalRequest[];
}

async function world() {
  const boxes = new Map<string, Box>();
  const registry = new Map<string, { pubHex: string; username: string }>();
  const leads = new Map<string, string>();
  const directory: ChatPeerDirectory = {
    server: async (d) => registry.get(d.toLowerCase()) ?? null,
    leadOf: async (u, ref) => leads.get(`${u}|${ref}`) ?? null,
  };
  const fetchImpl = (async (url: string, init: { body: string; method: string }) => {
    const u = new URL(url);
    const box = boxes.get(u.hostname);
    if (!box) throw new Error("unreachable");
    for (const h of box.cross.handlers) {
      const r = await h({ method: init.method, path: u.pathname, headers: {}, body: Buffer.from(init.body) } as HttpRequest);
      if (r) return new Response(r.body as string, { status: r.status });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  async function mk(domain: string, account: string, seedByte: number, hosts: Array<{ author: string; slug: string }>, membersOf: string[] = [domain], campaign = true): Promise<Box> {
    const seed = new Uint8Array(32).fill(seedByte);
    registry.set(domain, { pubHex: hex(ed.getPublicKey(seed)), username: account });
    const dir = await mkdtemp(join(tmpdir(), "xo-"));
    const alerts: ApprovalRequest[] = [];
    const cross = buildCrossOwnerChat({
      self: domain, dir, controlPlaneBaseUrl: "https://com.invalid", sign: (m) => ed.sign(m, seed),
      members: () => membersOf, shouldCampaign: () => campaign, now: () => Date.now(), directory, fetchImpl,
      baseUrl: (d) => `https://${d}`,
    });
    const harness = new ChatHarness({
      self: { account }, lead: cross.lead, admission: null, transport: cross.transport, notifier: { approval: (r) => alerts.push(r) },
      hostsApp: (a) => hosts.some((h) => appKey(h) === appKey(a)), crossOwner: true,
    });
    cross.attach(harness);
    await cross.start();
    const box = { domain, account, seed, cross, harness, alerts };
    boxes.set(domain, box);
    return box;
  }
  return { mk, leads, registry, boxes, directory };
}

describe("the lead term across one owner's boxes", () => {
  it("needs a majority of ALL the owner's servers, and a lone survivor of two leads nothing", async () => {
    const w = await world();
    const both = ["home.alice.flagship.services", "home2.alice.flagship.services"];
    const a1 = await w.mk(both[0]!, "alice", 1, [CHESS], both);
    expect(a1.cross.lead.mayAdmit()).toBe(false); // the second server is not up: no quorum
    const a2 = await w.mk(both[1]!, "alice", 2, [CHESS], both, false);
    await a1.cross.stop();
    await a1.cross.start(); // campaigns again with both voting
    expect(a1.cross.lead.mayAdmit()).toBe(true);
    expect(a1.cross.lead.generation()).toBeGreaterThan(0);
    expect(a2.cross.lead.mayAdmit()).toBe(false); // it does not campaign
    // The other server drops out of reach: the survivor cannot renew a majority.
    w.boxes.delete(both[1]!);
    await a1.cross.stop();
    await a1.cross.start();
    expect(a1.cross.lead.mayAdmit()).toBe(false);
  });

  it("refuses a vote request from a server that is not one of the owner's", async () => {
    const w = await world();
    const alice = await w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const mallory = await w.mk("home.mallory.flagship.services", "mallory", 3, []);
    const r = await mallory.cross.transport.post(alice.domain, "lease", JSON.stringify({ op: "grant", term: 99, leaseMs: 30_000 }), "/api/chat/lease").catch((e: Error) => e);
    expect(r instanceof Error && /403/.test(r.message)).toBe(true);
  });
});

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("chat between two owners' boxes", () => {
  it("goes out only after the sender's admin allows it, in only after the receiver's, and replies come back", async () => {
    const w = await world();
    const alice = await w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = await w.mk("home.carol.flagship.services", "carol", 2, []);
    w.leads.set("alice|alice--chess", alice.domain);
    expect(alice.cross.lead.mayAdmit()).toBe(true);

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

  it("an app with no listener hears nothing, raises nothing and uses nothing", async () => {
    const w = await world();
    const alice = await w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = await w.mk("home.carol.flagship.services", "carol", 2, []);
    w.leads.set("alice|alice--chess", alice.domain);
    const s = await carol.harness.start(CLUB, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "hi", requestId: "r1" });
    await carol.harness.approveOutgoing(s.conversationId!, "allow");
    await settle();
    expect(alice.alerts).toEqual([]);
    expect(alice.harness.pendingCounts()).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("a box that does not hold the lead term admits nothing", async () => {
    const w = await world();
    const alice = await w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = await w.mk("home.carol.flagship.services", "carol", 2, []);
    w.leads.set("alice|alice--chess", alice.domain);
    await alice.cross.stop();
    expect(alice.cross.lead.mayAdmit()).toBe(false);
    alice.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const s = await carol.harness.start(CLUB, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "hi", requestId: "r1" });
    await carol.harness.approveOutgoing(s.conversationId!, "allow");
    await settle();
    expect(alice.alerts).toEqual([]);
  });

  it("refuses a frame signed by anyone but the registered key, a replay, a stranger and a wrong addressee", async () => {
    const w = await world();
    const alice = await w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = await w.mk("home.carol.flagship.services", "carol", 2, []);
    const mallory = await w.mk("home.mallory.flagship.services", "mallory", 3, []);
    const body = JSON.stringify({ kind: "close", wireId: "w".repeat(24), counter: 1, leadGeneration: 1 });
    const send = async (t: { sign: Uint8Array; from: string; to: string; replayOf?: string; nonce?: string }) => {
      const { chatWireBodySha256, signChatWire } = await import("@flagship/protocol");
      const statement = { purpose: "frame" as const, fromServer: t.from, toServer: t.to, issuedAt: Date.now(), nonce: t.nonce ?? "a".repeat(32), bodySha256Hex: chatWireBodySha256(new TextEncoder().encode(body)) };
      const sigHex = hex(signChatWire(statement, (m) => ed.sign(m, t.sign)));
      const req = { method: "POST", path: "/api/chat/wire", headers: {}, body: Buffer.from(JSON.stringify({ statement, sigHex, body })) } as HttpRequest;
      return alice.cross.handlers[0]!(req);
    };
    expect((await send({ sign: carol.seed, from: carol.domain, to: alice.domain }))?.status).toBe(200);
    expect((await send({ sign: carol.seed, from: carol.domain, to: alice.domain }))?.status).toBe(401); // same nonce
    expect((await send({ sign: mallory.seed, from: carol.domain, to: alice.domain, nonce: "b".repeat(32) }))?.status).toBe(401); // not carol's key
    expect((await send({ sign: carol.seed, from: "home.nobody.flagship.services", to: alice.domain, nonce: "c".repeat(32) }))?.status).toBe(401); // not registered
    expect((await send({ sign: carol.seed, from: carol.domain, to: "home.other.flagship.services", nonce: "d".repeat(32) }))?.status).toBe(401); // not for this box
  });

  it("an answer that lets contact in must be signed by the owner", async () => {
    const w = await world();
    const alice = await w.mk("home.alice.flagship.services", "alice", 1, [CHESS]);
    const carol = await w.mk("home.carol.flagship.services", "carol", 2, []);
    w.leads.set("alice|alice--chess", alice.domain);
    alice.harness.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const s = await carol.harness.start(CLUB, { receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "hi", requestId: "r1" });
    await carol.harness.approveOutgoing(s.conversationId!, "allow");
    await settle();
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
    expect((await answer(wrong))?.status).toBe(403); // signed for another decision
    expect((await answer(new Uint8Array(64)))?.status).toBe(403);
    expect(alice.harness.poll(CHESS)).toEqual([]);
    const issuedAt = Date.now();
    const good = signChatApproval({ serverDomain: alice.domain, requestId, kind: "incoming", decision: "allow", issuedAt }, (m) => ed.sign(m, owner));
    const ok = await http("/api/screens/chat/answer", "POST", { body: Buffer.from(JSON.stringify({ requestId, kind: "incoming", decision: "allow", issuedAt, signature: hex(good) })) } as HttpRequest);
    expect(ok?.status).toBe(200);
    expect(alice.harness.poll(CHESS)).toMatchObject([{ type: "message", envelope: { body: "hi" } }]);
  });
});

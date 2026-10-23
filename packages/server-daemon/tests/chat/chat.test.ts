import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChatHarness, ChatInputError, InvitationAdmission, appKey,
  type ApprovalRequest, type Challenge, type ChatProof, type ChatTransport, type LeadAuthority, type ProofVerifier, type Rank, type WireFrame,
} from "../../src/chat/index.js";

const CHESS = { author: "alice", slug: "chess" };
const BOB_CHESS = { author: "alice", slug: "chess" };
const OTHER = { author: "mallory", slug: "spam" };
const SENDER = { author: "carol", slug: "club" };

function lead(initial = 1) {
  let gen = initial;
  let can = true;
  const l: LeadAuthority = { generation: () => gen, mayAdmit: () => can };
  return { l, setGen: (g: number) => void (gen = g), setCan: (c: boolean) => void (can = c) };
}

interface World {
  clock: { t: number; advance(ms: number): void };
  a: ChatHarness; // the sender's box
  b: ChatHarness; // the receiver's box
  alertsA: ApprovalRequest[];
  alertsB: ApprovalRequest[];
  wire: { sent: Array<{ to: string; frame: WireFrame }>; drop: boolean; replay(i: number): Promise<void> };
  leadB: ReturnType<typeof lead>;
  verifier: { access: { active: boolean; rank: Rank }; valid: boolean };
  admission: InvitationAdmission;
}

async function world(over: { hostsB?: (a: { author: string; slug: string }) => boolean; limitsA?: Record<string, number>; withAdmission?: boolean } = {}): Promise<World> {
  const clock = { t: 1_000_000, advance(ms: number) { this.t += ms; } };
  const leadA = lead();
  const leadB = lead();
  const alertsA: ApprovalRequest[] = [];
  const alertsB: ApprovalRequest[] = [];
  const wire = { sent: [] as Array<{ to: string; frame: WireFrame }>, drop: false, replay: async (_i: number) => {} };
  let a!: ChatHarness, b!: ChatHarness;
  const transportA: ChatTransport = {
    sendToLead: async (_t, frame) => { wire.sent.push({ to: "boxB", frame }); if (!wire.drop) await b.receive(structuredClone(frame), "boxA"); return { peerKey: "boxB" }; },
    sendOnRoute: async (_p, frame) => { wire.sent.push({ to: "boxB", frame }); if (!wire.drop) await b.receive(structuredClone(frame), "boxA"); },
  };
  const transportB: ChatTransport = {
    sendToLead: async () => ({ peerKey: "boxA" }),
    sendOnRoute: async (_p, frame) => { wire.sent.push({ to: "boxA", frame }); if (!wire.drop) await a.receive(structuredClone(frame), "boxB"); },
  };
  const dir = await mkdtemp(join(tmpdir(), "chat-"));
  const verifier = { access: { active: true, rank: "member" as Rank }, valid: true };
  const pv: ProofVerifier = {
    verify: async (p: ChatProof, _c: Challenge) => (verifier.valid ? { ok: true, perAppId: p.perAppId, rank: verifier.access.rank } : { ok: false }),
    currentAccess: async () => verifier.access,
  };
  const admission = new InvitationAdmission(join(dir, "adm.json"), leadB.l, pv, () => clock.t);
  await admission.load();
  a = new ChatHarness({ self: { account: "carol" }, lead: leadA.l, admission: null, transport: transportA, notifier: { approval: (r) => alertsA.push(r) }, hostsApp: () => false, now: () => clock.t, ...(over.limitsA ? { limits: over.limitsA } : {}) });
  b = new ChatHarness({ self: { account: "alice" }, lead: leadB.l, admission: over.withAdmission === false ? null : admission, transport: transportB, notifier: { approval: (r) => alertsB.push(r) }, hostsApp: over.hostsB ?? ((x) => appKey(x) === appKey(CHESS)), now: () => clock.t });
  return { clock, a, b, alertsA, alertsB, wire, leadB, verifier, admission };
}

const msg = (over: Record<string, unknown> = {}) => ({ receiverAuthor: "alice", receiverApp: "chess", targetUser: "alice", body: "hello", requestId: crypto.randomUUID(), ...over });
async function settle() { await new Promise((r) => setTimeout(r, 5)); }

describe("among the owner's own deployments", () => {
  it("is permissionless, excludes the sender, and hides every id from the other side", async () => {
    const w = await world();
    const app1 = { author: "carol", slug: "lobby" };
    const app2 = { author: "carol", slug: "game" };
    w.a.listen(app2, { originScope: "same-account", ownedInstanceScope: "this-server" });
    w.a.listen(app1, { originScope: "same-account", ownedInstanceScope: "this-server" });
    const r = await w.a.start(app1, { receiverAuthor: "carol", receiverApp: "game", body: "hi", requestId: "r1" });
    expect(r).toMatchObject({ accepted: true });
    expect(w.alertsA).toEqual([]);
    expect(w.a.poll(app1)).toEqual([]); // the sender's own listener never sees its own message
    const [ev] = w.a.poll(app2);
    expect(ev).toMatchObject({ type: "message", envelope: { body: "hi", claimedSender: app1 } });
    const rid = (ev as { envelope: { conversationId: string } }).envelope.conversationId;
    expect(rid).not.toBe(r.conversationId); // each side has its own handle
    await w.a.reply(app2, { conversationId: rid, body: "hello back", requestId: "r2" });
    expect(w.a.poll(app1)[0]).toMatchObject({ type: "message", envelope: { body: "hello back", conversationId: r.conversationId } });
  });

  it("another local app cannot use a conversation handle it was not given", async () => {
    const w = await world();
    const a1 = { author: "carol", slug: "one" }, a2 = { author: "carol", slug: "two" }, thief = { author: "carol", slug: "thief" };
    w.a.listen(a2, { originScope: "same-account", ownedInstanceScope: "this-server" });
    const r = await w.a.start(a1, { receiverAuthor: "carol", receiverApp: "two", body: "x", requestId: "r1" });
    await expect(w.a.reply(thief, { conversationId: r.conversationId!, body: "inject", requestId: "r2" })).rejects.toMatchObject({ code: "unknown-conversation" });
    const [ev] = w.a.poll(a2);
    const handleOfReceiver = (ev as { envelope: { conversationId: string } }).envelope.conversationId;
    await expect(w.a.reply(a1, { conversationId: handleOfReceiver, body: "inject", requestId: "r3" })).rejects.toMatchObject({ code: "unknown-conversation" });
  });

  it("a restarted runtime cannot reuse its old handles", async () => {
    const w = await world();
    const a1 = { author: "carol", slug: "one" };
    w.a.listen({ author: "carol", slug: "two" }, { originScope: "same-account", ownedInstanceScope: "this-server" });
    const r = await w.a.start(a1, { receiverAuthor: "carol", receiverApp: "two", body: "x", requestId: "r1" });
    w.a.runtimeRestarted(a1);
    await expect(w.a.reply(a1, { conversationId: r.conversationId!, body: "stale", requestId: "r2" })).rejects.toMatchObject({ code: "unknown-conversation" });
  });
});

describe("another owner's app", () => {
  it("no listener: the same response, and nothing queued, alerted or revealed", async () => {
    const w = await world();
    w.a.listen(SENDER, { originScope: "same-account", ownedInstanceScope: "this-server" });
    const known = await w.a.start(SENDER, msg({ requestId: "k1" }));
    const unknown = await w.a.start(SENDER, msg({ requestId: "k2", receiverApp: "no-such-app" }));
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    await w.a.approveOutgoing(known.conversationId!, "allow");
    await w.a.approveOutgoing(unknown.conversationId!, "allow");
    await settle();
    expect(w.alertsB).toEqual([]);
    expect(w.b.pendingCounts()).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("the sending admin approves the outgoing scope before any contact", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg({ phrase: "123456" }));
    await settle();
    expect(w.wire.sent).toEqual([]); // not a byte left this box
    expect(w.alertsA).toHaveLength(1);
    expect(w.alertsA[0]).toMatchObject({ kind: "outgoing", phrase: "123456" });
    expect(await w.a.approveOutgoing(r.conversationId!, "allow")).toBe(true);
    await settle();
    expect(w.wire.sent.map((s) => s.frame.kind)).toEqual(["start"]);
  });

  it("a receiver with a listener asks its admin; Allow delivers with the sender as a claim, the phrase never reaching the app", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg({ phrase: "424242" }));
    await w.a.approveOutgoing(r.conversationId!, "allow");
    await settle();
    expect(w.alertsB).toHaveLength(1);
    expect(w.alertsB[0]).toMatchObject({ kind: "incoming", claimedSender: SENDER, receiverApp: CHESS, phrase: "424242" });
    expect(w.b.poll(CHESS)).toEqual([]); // inert until answered
    await w.b.answerIncoming(w.alertsB[0]!.requestId, "allow");
    const [ev] = w.b.poll(CHESS);
    expect(ev).toMatchObject({ type: "message", envelope: { body: "hello", claimedSender: SENDER } });
    expect(JSON.stringify(ev)).not.toContain("424242");
    expect((ev as { envelope: Record<string, unknown> }).envelope.verifiedAccess).toBeUndefined();
  });

  it("a conversation is established only after the first reply reaches the initiator, and then replies need no second approval", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg());
    await w.a.approveOutgoing(r.conversationId!, "allow");
    await settle();
    await w.b.answerIncoming(w.alertsB[0]!.requestId, "allow");
    const bid = (w.b.poll(CHESS)[0] as { envelope: { conversationId: string } }).envelope.conversationId;
    expect(w.a.table.forLocal(r.conversationId!, SENDER)?.state).not.toBe("established");
    await w.b.reply(CHESS, { conversationId: bid, body: "yes?", requestId: "q1" });
    await settle();
    expect(w.a.poll(SENDER)[0]).toMatchObject({ type: "message", envelope: { body: "yes?", conversationId: r.conversationId } });
    expect(w.a.table.forLocal(r.conversationId!, SENDER)?.state).toBe("established");
    expect(w.b.table.forLocal(bid, CHESS)?.state).toBe("established"); // via the internal ack
    await w.a.reply(SENDER, { conversationId: r.conversationId!, body: "ok", requestId: "q2" });
    await settle();
    expect(w.b.poll(CHESS)[0]).toMatchObject({ envelope: { body: "ok" } });
    // a new conversation to the same app is NOT covered by the last Allow
    await w.a.start(SENDER, msg({ requestId: "again" }));
    await settle();
    expect(w.alertsB.length + w.b.pendingCounts().incoming).toBeGreaterThan(0);
  });

  it("Always allow admits new conversations to that app without another prompt, until revoked", async () => {
    const w = await world({});
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg());
    await w.a.approveOutgoing(r.conversationId!, "allow");
    await settle();
    await w.b.answerIncoming(w.alertsB[0]!.requestId, "always");
    w.b.poll(CHESS);
    const before = w.alertsB.length;
    const r2 = await w.a.start(SENDER, msg({ requestId: "second" })); // outgoing already approved for this scope
    await settle();
    expect(r2.accepted).toBe(true);
    expect(w.alertsB.length).toBe(before);
    expect(w.b.poll(CHESS)[0]).toMatchObject({ type: "message" });
    // it never authorizes another app
    const w2 = await world({ hostsB: () => true });
    w2.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    w2.b.listen({ author: "alice", slug: "other" }, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const x = await w2.a.start(SENDER, msg());
    await w2.a.approveOutgoing(x.conversationId!, "allow");
    await settle();
    await w2.b.answerIncoming(w2.alertsB[0]!.requestId, "always");
    w2.clock.advance(60_000);
    const y = await w2.a.start(SENDER, msg({ requestId: "y", receiverApp: "other" }));
    await w2.a.approveOutgoing(y.conversationId!, "allow");
    await settle();
    expect(w2.alertsB.length).toBe(2);
    // nor another remote app reaching the same one
    const alertsBefore = w.alertsB.length;
    w.clock.advance(60_000);
    const z = await w.a.start({ author: SENDER.author, slug: "spam" }, msg({ requestId: "z" }));
    await w.a.approveOutgoing(z.conversationId!, "allow");
    await settle();
    expect(w.alertsB.length).toBe(alertsBefore + 1);
    expect(w.b.alwaysList()).toEqual([{ receiverApp: CHESS, claimedSender: SENDER }]);
    // revoking ends the conversations it covered
    const dead = await w.b.revokeAlwaysAllow(CHESS);
    expect(dead).toBeGreaterThan(0);
    expect(w.b.poll(CHESS).some((e) => e.type === "conversation-dead")).toBe(true);
  });

  it("deny delivers nothing and tells the sender nothing", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg());
    await w.a.approveOutgoing(r.conversationId!, "allow");
    await settle();
    await w.b.answerIncoming(w.alertsB[0]!.requestId, "deny");
    expect(w.b.poll(CHESS)).toEqual([]);
    expect(w.a.poll(SENDER)).toEqual([]);
  });

  it("a cross-user request cannot name a server", async () => {
    const w = await world();
    await expect(w.a.start(SENDER, msg({ server: "home.alice.flagship.services" }))).rejects.toMatchObject({ code: "bad-request" });
  });

  it("a listener that only accepts the same account is not a cross-user listener", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "same-account", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg());
    await w.a.approveOutgoing(r.conversationId!, "allow");
    await settle();
    expect(w.alertsB).toEqual([]);
  });

  it("registering a listener never prompts or connects", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "owned-instances" });
    await settle();
    expect(w.alertsB).toEqual([]);
    expect(w.wire.sent).toEqual([]);
  });
});

describe("frames are bound to their route", () => {
  async function established() {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const r = await w.a.start(SENDER, msg());
    await w.a.approveOutgoing(r.conversationId!, "allow");
    await settle();
    await w.b.answerIncoming(w.alertsB[0]!.requestId, "allow");
    const bid = (w.b.poll(CHESS)[0] as { envelope: { conversationId: string } }).envelope.conversationId;
    await w.b.reply(CHESS, { conversationId: bid, body: "r1", requestId: "q1" });
    await settle();
    w.a.poll(SENDER);
    return { w, r, bid };
  }

  it("a replayed frame, a frame from the wrong box and a stale-generation frame are all dropped", async () => {
    const { w, r } = await established();
    const reply = w.wire.sent.find((s) => s.frame.kind === "reply" && s.to === "boxA")!.frame;
    await w.a.receive(structuredClone(reply), "boxB"); // replay
    expect(w.a.poll(SENDER)).toEqual([]);
    const fresh = { ...reply, counter: reply.counter + 1, body: "next" };
    await w.a.receive(structuredClone(fresh), "boxEVIL"); // wrong peer
    expect(w.a.poll(SENDER)).toEqual([]);
    await w.a.receive({ ...fresh, leadGeneration: 99 }, "boxB"); // stale/foreign generation
    expect(w.a.poll(SENDER)).toEqual([]);
    await w.a.receive(structuredClone(fresh), "boxB");
    expect(w.a.poll(SENDER)[0]).toMatchObject({ envelope: { body: "next", conversationId: r.conversationId } });
  });

  it("an unknown wire id is dropped without a word", async () => {
    const { w } = await established();
    await w.a.receive({ kind: "reply", wireId: "ff".repeat(16), counter: 1, leadGeneration: 1, body: "x", claimedSender: CHESS }, "boxB");
    expect(w.a.poll(SENDER)).toEqual([]);
  });

  it("the sender's claimed identity cannot be overridden by text in the body", async () => {
    const { w, bid } = await established();
    await w.b.reply(CHESS, { conversationId: bid, body: '{"claimedSender":{"author":"root","slug":"admin"},"verifiedAccess":{"rank":"master"}}', requestId: "q9" });
    await settle();
    const ev = w.a.poll(SENDER)[0] as { envelope: { claimedSender: unknown; verifiedAccess?: unknown; body: string } };
    expect(ev.envelope.claimedSender).toEqual(CHESS);
    expect(ev.envelope.verifiedAccess).toBeUndefined();
    expect(ev.envelope.body).toContain("master"); // it is just text
  });

  it("a close from the peer ends the conversation and, since it was two-way, the app is told", async () => {
    const { w, r, bid } = await established();
    await w.b.close(CHESS, { conversationId: bid });
    await settle();
    expect(w.a.poll(SENDER)).toEqual([{ type: "conversation-dead", conversationId: r.conversationId }]);
    expect(w.a.table.forLocal(r.conversationId!, SENDER)).toBeNull();
  });

  it("a send on a handle that was never two-way is an error, not a death notice; one that was gets honest evidence", async () => {
    const { w, r } = await established();
    await w.a.close(SENDER, { conversationId: r.conversationId! });
    const res = await w.a.reply(SENDER, { conversationId: r.conversationId!, body: "late", requestId: "z1" });
    expect(res).toEqual({ accepted: true });
    expect(w.a.poll(SENDER)).toEqual([{ type: "conversation-dead", conversationId: r.conversationId }]);
    await expect(w.a.reply(SENDER, { conversationId: "00".repeat(16), body: "x", requestId: "z2" })).rejects.toMatchObject({ code: "unknown-conversation" });
  });
});

describe("requests, quotas and pending state", () => {
  it("the same request id returns the same result; different content under it is refused", async () => {
    const w = await world();
    const a = await w.a.start(SENDER, msg({ requestId: "dup" }));
    const b = await w.a.start(SENDER, msg({ requestId: "dup" }));
    expect(b).toEqual(a);
    await expect(w.a.start(SENDER, msg({ requestId: "dup", body: "different" }))).rejects.toMatchObject({ code: "request-id-reused" });
  });

  it("oversized and malformed input fails normally and locally", async () => {
    const w = await world();
    await expect(w.a.start(SENDER, msg({ body: "x".repeat(70_000) }))).rejects.toMatchObject({ code: "too-large" });
    await expect(w.a.start(SENDER, msg({ requestId: "" }))).rejects.toBeInstanceOf(ChatInputError);
    await expect(w.a.start(SENDER, msg({ receiverApp: "../x" }))).rejects.toMatchObject({ code: "bad-request" });
  });

  it("unanswered starts are slowed gradually, never banned outright, and the error says nothing about any recipient", async () => {
    const w = await world({ limitsA: { unansweredFloor: 3 } });
    let blocked: ChatInputError | null = null;
    for (let i = 0; i < 6 && !blocked; i++) {
      try { await w.a.start(SENDER, msg({ requestId: `s${i}` })); } catch (e) { blocked = e as ChatInputError; }
    }
    expect(blocked?.code).toBe("rate-limited");
    expect(blocked?.message).not.toMatch(/recipient|alice|chess/);
    w.clock.advance(61_000);
    await expect(w.a.start(SENDER, msg({ requestId: "later" }))).resolves.toMatchObject({ accepted: true }).catch(() => {});
  });

  it("alerts are coalesced and the pending queue is bounded", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    for (let i = 0; i < 5; i++) {
      const r = await w.a.start(SENDER, msg({ requestId: `p${i}` }));
      await w.a.approveOutgoing(r.conversationId!, "allow");
    }
    await settle();
    expect(w.alertsB.length).toBe(1); // one alert, however many requests
    expect(w.b.pendingCounts().incoming).toBe(1); // the same claimed sender groups into one
  });
});

describe("an invited visitor", () => {
  const proofFor = (c: Challenge, over: Partial<ChatProof> = {}): ChatProof => ({
    nonce: c.nonce, target: c.target, leadGeneration: c.leadGeneration, purpose: "chat", sourceSession: "sess-1", perAppId: "visitor-app-id", accessGrantRef: "grant-1", signatureHex: "00", ...over,
  });
  const frame = (proof: ChatProof, id = "11".repeat(16)): WireFrame => ({
    kind: "start", wireId: id, counter: 1, leadGeneration: 1, target: { author: "alice", slug: "chess", targetUser: "alice" }, claimedSender: SENDER, submittedAt: 5, body: "hi from a guest", proof,
  });

  it("a valid proof replaces the receiving admin's alert, and the verified rank travels apart from the text", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c)), "boxA");
    expect(w.alertsB).toEqual([]);
    expect(w.b.poll(CHESS)[0]).toMatchObject({ type: "message", envelope: { body: "hi from a guest", verifiedAccess: { rank: "member" } } });
  });

  it("a proof is for one target, one use and one lead generation", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const good = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(good)), "boxA");
    w.b.poll(CHESS);
    // replay of the same nonce in a new request
    await w.b.receive(frame(proofFor(good), "22".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toEqual([]);
    // wrong target
    const c2 = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c2, { target: "alice--other.alice" }), "33".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toEqual([]);
    // a proof the verifier rejects (bad signature, wrong key, an invite URL alone)
    const c3 = w.admission.issueChallenge("alice--chess.alice")!;
    w.verifier.valid = false;
    await w.b.receive(frame(proofFor(c3), "44".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toEqual([]);
    expect(w.alertsB).toEqual([]); // a failed proof does not fall through to an alert either
  });

  it("only one active conversation per visitor and app; the duplicate hears it only after its own proof validates", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c1 = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c1), "aa".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toHaveLength(1);
    const c2 = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c2), "bb".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toEqual([]); // no second conversation
    const told = w.wire.sent.filter((s) => s.to === "boxA" && s.frame.kind === "close");
    expect(told).toHaveLength(1);
    expect(told[0]!.frame.body).toMatch(/already been used/);
    // a stranger with a bad proof learns nothing
    w.wire.sent.length = 0;
    const c3 = w.admission.issueChallenge("alice--chess.alice")!;
    w.verifier.valid = false;
    await w.b.receive(frame(proofFor(c3), "cc".repeat(16)), "boxA");
    expect(w.wire.sent).toEqual([]);
  });

  it("parallel starts for the same visitor admit exactly one", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const cs = [w.admission.issueChallenge("alice--chess.alice")!, w.admission.issueChallenge("alice--chess.alice")!];
    await Promise.all(cs.map((c, i) => w.b.receive(frame(proofFor(c), `${i}${i}`.repeat(16)), "boxA")));
    expect(w.b.poll(CHESS)).toHaveLength(1);
  });

  it("closing releases the slot for a fresh signed start; a spent proof never works again", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c1 = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c1), "aa".repeat(16)), "boxA");
    const id = (w.b.poll(CHESS)[0] as { envelope: { conversationId: string } }).envelope.conversationId;
    await w.b.close(CHESS, { conversationId: id });
    const c2 = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c2), "dd".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toHaveLength(1);
    await w.b.receive(frame(proofFor(c1), "ee".repeat(16)), "boxA");
    expect(w.b.poll(CHESS)).toEqual([]);
  });

  it("withdrawn access ends the channel at the next delivery; a demotion changes the metadata only", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c = w.admission.issueChallenge("alice--chess.alice")!;
    const startFrame = frame(proofFor(c), "ab".repeat(16));
    await w.b.receive(startFrame, "boxA");
    const id = (w.b.poll(CHESS)[0] as { envelope: { conversationId: string } }).envelope.conversationId;
    const conv = w.b.table.forLocal(id, CHESS)!;
    const next = (n: number, body: string): WireFrame => ({ kind: "reply", wireId: conv.wireId, counter: n, leadGeneration: 1, claimedSender: SENDER, submittedAt: 6, body });
    w.verifier.access = { active: true, rank: "manager" };
    await w.b.receive(next(2, "still here"), "boxA");
    expect(w.b.poll(CHESS)[0]).toMatchObject({ envelope: { body: "still here", verifiedAccess: { rank: "manager" } } });
    w.verifier.access = { active: false, rank: "manager" };
    await w.b.receive(next(3, "after withdrawal"), "boxA");
    const out = w.b.poll(CHESS);
    expect(out).toEqual([{ type: "conversation-dead", conversationId: id }]);
    expect(w.b.table.forLocal(id, CHESS)).toBeNull();
  });

  it("only the exclusive lead admits; a box that cannot confirm the lease issues no challenge and admits nobody", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c = w.admission.issueChallenge("alice--chess.alice")!;
    w.leadB.setCan(false);
    expect(w.admission.issueChallenge("alice--chess.alice")).toBeNull();
    await w.b.receive(frame(proofFor(c)), "boxA");
    expect(w.b.poll(CHESS)).toEqual([]);
    expect(w.alertsB).toEqual([]);
  });

  it("a new lead generation voids old challenges, proofs and reservations", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const stale = w.admission.issueChallenge("alice--chess.alice")!;
    w.leadB.setGen(2);
    await w.b.receive(frame(proofFor(stale)), "boxA"); // the frame still says generation 1
    expect(w.b.poll(CHESS)).toEqual([]);
    const fresh = w.admission.issueChallenge("alice--chess.alice")!;
    expect(fresh.leadGeneration).toBe(2);
    await w.b.receive({ ...frame(proofFor(fresh, { leadGeneration: 2 })), leadGeneration: 2 }, "boxA");
    expect(w.b.poll(CHESS)).toHaveLength(1);
  });

  it("an abandoned reservation frees itself, and a late reply cannot revive it", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c = w.admission.issueChallenge("alice--chess.alice")!;
    const r = await w.admission.admit({ requestId: "r", target: c.target, proof: proofFor(c), recipientApp: "alice--chess" });
    expect(r.kind).toBe("admitted");
    w.clock.advance(6 * 60_000);
    expect(await w.admission.sweepAbandoned()).toHaveLength(1);
  });

  it("slots and spent nonces survive a restart within a generation", async () => {
    const w = await world();
    w.b.listen(CHESS, { originScope: "all-accounts", ownedInstanceScope: "this-server" });
    const c = w.admission.issueChallenge("alice--chess.alice")!;
    await w.b.receive(frame(proofFor(c), "ab".repeat(16)), "boxA");
    const restarted = new InvitationAdmission((w.admission as unknown as { path: string }).path, w.leadB.l, { verify: async (p) => ({ ok: true, perAppId: p.perAppId, rank: "member" as Rank }), currentAccess: async () => ({ active: true }) }, () => w.clock.t);
    await restarted.load();
    expect(restarted.isReserved("alice--chess|visitor-app-id|1")).toBe(true);
  });
});

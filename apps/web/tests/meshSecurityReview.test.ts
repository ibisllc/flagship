/**
 * Security review 2026-11-02 (relay mesh, phone route): M3 (a full relay hijacking a bare phone name), M4 (unbounded
 * `begin` fan-out) and the Lows (mailbox holders, grant ids, bridged SNI, /mesh handshakes). relay-mesh.md §6.1, §6.4,
 * §7.6, §8.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  PHONE_BEGIN_BURST,
  PHONE_GENERATION_MAX_JUMP,
  PHONE_GENERATION_MEMORY_MS,
  PHONE_LEDGER_TOP_K,
  PHONE_ROUTE_GRANT_TTL_MS,
  PHONE_TUNNEL_MAX_PER_IP,
  MESH_HANDSHAKE_MAX_PENDING,
  MESH_HANDSHAKE_MAX_PENDING_PER_IP,
  canonicalPbMailboxAnnounce,
  pbMailboxEpoch,
  pbMailboxId,
  phoneLedgerRanking,
  signDeviceCapabilityGrant,
  signRelayMeshRecord,
  signServingRecord,
  type PhoneItem,
  type PhoneRouteGrant,
  type RouteClaim,
} from "@flagship/protocol";
import { MeshDirectory } from "../src/tunnel/mesh/directory.js";
import { AttachmentStore } from "../src/tunnel/mesh/attachments.js";
import { MeshFeed } from "../src/tunnel/mesh/feed.js";
import { answerLedgerRequest, meshPhoneEligibility, MeshPhoneLedgerClient, PhoneLedgerHost } from "../src/tunnel/mesh/phoneLedger.js";
import { bridgedSniMatches, PendingHandshakes } from "../src/tunnel/mesh/bridge.js";
import { PhoneRoutes, type PhoneRouteLedgerClient, type PhoneSessionHandle } from "../src/tunnel/phoneRoute.js";
import { AddressLimiter } from "../src/tunnel/phoneTunnel.js";
import { clientHello } from "../../../tools/relay-conformance/harness.js";
import { APEX, hex, keypair, MeshFixture } from "./support/meshFixture.js";

function rig(relayIds: string[] = ["ra", "rb", "rc", "rd", "re"]) {
  const fx = new MeshFixture();
  let t = 10_000_000;
  fx.now = () => t;
  const relays = Object.fromEntries(relayIds.map((id) => [id, fx.addRelay(id)]));
  const entry = fx.addRelay("rx", "entry");
  fx.mintDirectory();
  const dir = new MeshDirectory({ servicesApex: APEX, caKeys: () => [fx.caPub], now: () => t });
  dir.offer(fx.directory);
  const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source(), now: () => t });
  const ctx = () => ({ servicesApex: APEX, log: feed.state, directory: dir.current, now: t });
  const store = new AttachmentStore({ selfRelayId: "zz", servicesApex: APEX, ctx });
  return { fx, dir, feed, store, relays, entry, ctx, now: () => t, advance: (ms: number) => (t += ms) };
}

const phoneKey = keypair();
const claimFor = (g: PhoneRouteGrant, k = phoneKey): { claim: RouteClaim; claimSignature: string } => {
  const claim: RouteClaim = { account: g.hostname.split(".")[0]!, phoneRoutePub: g.phoneRoutePub, hostname: g.hostname, generation: g.generation, sessionNonce: "5e".repeat(16), issuedAt: g.issuedAt - 1_000 };
  return { claim, claimSignature: hex(signServingRecord("route-claim", claim, (m) => ed.sign(m, k.privateKey))) };
};
function phoneItem(r: ReturnType<typeof rig>, account: string, o: { ledger: string; holder: string; generation: number; issuedAt?: number }): PhoneItem {
  const issuedAt = o.issuedAt ?? r.now();
  const g: PhoneRouteGrant = { hostname: `${account}.${APEX}`, phoneRoutePub: hex(phoneKey.publicKey), generation: o.generation, holderRelayId: o.holder, ledgerRelayId: o.ledger, issuedAt, notAfter: issuedAt + PHONE_ROUTE_GRANT_TTL_MS };
  return { kind: "phone", grant: g, signature: signRelayMeshRecord("phone-route-grant", g, (m) => ed.sign(m, r.relays[o.ledger]!.key.privateKey)), ...claimFor(g) };
}

describe("M3: a phone item's ledger, claim and generation", () => {
  it("only a relay in the account's top k may sign its grant; the item must carry the phone's claim", () => {
    const r = rig();
    const rank = phoneLedgerRanking("erin", r.dir.current, r.feed.state);
    const inside = rank[0]!;
    const outside = rank[PHONE_LEDGER_TOP_K]!;
    expect(r.store.offerPhone(phoneItem(r, "erin", { ledger: outside, holder: outside, generation: 3 }), outside)).toBe(false);
    expect(r.store.stats().rejected[`${outside}:phone-not-ledger`]).toBe(1);
    const good = phoneItem(r, "erin", { ledger: inside, holder: inside, generation: 3 });
    const { claim: _c, ...noClaim } = good;
    expect(r.store.offerPhone(noClaim as PhoneItem, inside)).toBe(false);
    expect(r.store.offerPhone({ ...good, claimSignature: hex(signServingRecord("route-claim", good.claim, (m) => ed.sign(m, keypair().privateKey))) }, inside)).toBe(false);
    expect(r.store.offerPhone(good, inside)).toBe(true);
  });

  it("a generation may not jump far above a live item; the memory follows the ledger relay and lapses", () => {
    const r = rig();
    const rank = phoneLedgerRanking("erin", r.dir.current, r.feed.state);
    const [l1, l2] = [rank[0]!, rank[1]!];
    expect(r.store.offerPhone(phoneItem(r, "erin", { ledger: l1, holder: l1, generation: 5 }), l1)).toBe(true);
    expect(r.store.offerPhone(phoneItem(r, "erin", { ledger: l2, holder: l2, generation: 5 + PHONE_GENERATION_MAX_JUMP + 1 }), l2)).toBe(false);
    expect(r.store.offerPhone(phoneItem(r, "erin", { ledger: l2, holder: l2, generation: 5 + PHONE_GENERATION_MAX_JUMP }), l2)).toBe(true);
    expect(r.store.maxPhoneGeneration(`erin.${APEX}`)).toBe(5 + PHONE_GENERATION_MAX_JUMP);
    // The relay that signed the highest generation is retired: its generations go with it.
    r.store.dropRelay(l2);
    expect(r.store.maxPhoneGeneration(`erin.${APEX}`)).toBe(5);
    // An hour after the last item lapsed, the hostname is forgotten.
    r.advance(PHONE_ROUTE_GRANT_TTL_MS + PHONE_GENERATION_MEMORY_MS + 1);
    r.store.sweep();
    expect(r.store.maxPhoneGeneration(`erin.${APEX}`)).toBe(0);
  });
});

describe("M3: the ledger relay", () => {
  const fakePeer = (relayId: string) => {
    const sent: Array<Record<string, unknown>> = [];
    return { relayId, sent, rejected: 0, send: (m: Record<string, unknown>) => void sent.push(m) };
  };

  it("answers only full peers, only for accounts it ranks in the top k, and only claims the phone signed", () => {
    const r = rig();
    const rank = phoneLedgerRanking("erin", r.dir.current, r.feed.state);
    const self = rank[0]!;
    const holderId = rank[1]!;
    const host = new PhoneLedgerHost({
      selfRelayId: self,
      servicesApex: APEX,
      sign: (m) => ed.sign(m, r.relays[self]!.key.privateKey),
      now: r.now,
      maxSeenGeneration: () => 0,
      onVacant: () => undefined,
      peerMayAsk: (id) => id !== "rx",
      servesAccount: (u) => phoneLedgerRanking(u, r.dir.current, r.feed.state).slice(0, PHONE_LEDGER_TOP_K).includes(self),
    });
    // An entry relay is not answered at all.
    const ent = fakePeer("rx");
    answerLedgerRequest(host, ent as never, { type: "phone-begin", qid: "q1", account: "erin" });
    expect(ent.sent).toEqual([]);
    expect(ent.rejected).toBe(1);
    // An account this relay is not in the top k of: malformed.
    const other = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"].find((u) => !phoneLedgerRanking(u, r.dir.current, r.feed.state).slice(0, PHONE_LEDGER_TOP_K).includes(self))!;
    const p = fakePeer(holderId);
    answerLedgerRequest(host, p as never, { type: "phone-begin", qid: "q2", account: other });
    expect(p.sent.at(-1)).toMatchObject({ type: "phone-claimed", qid: "q2", ok: false, code: "malformed" });
    answerLedgerRequest(host, p as never, { type: "phone-begin", qid: "q3", account: "erin" });
    expect(p.sent.at(-1)).toMatchObject({ type: "phone-begun", qid: "q3", generation: 1 });
    // A claim without the phone's signed claim, or with one for another generation: malformed.
    const hostname = `erin.${APEX}`;
    const holder = { relayId: holderId, sessionId: "s1", phoneRoutePub: hex(phoneKey.publicKey) };
    const g: PhoneRouteGrant = { hostname, phoneRoutePub: holder.phoneRoutePub, generation: 1, holderRelayId: holderId, ledgerRelayId: self, issuedAt: r.now(), notAfter: r.now() + 1 };
    answerLedgerRequest(host, p as never, { type: "phone-claim", qid: "q4", hostname, generation: 1, holder });
    expect(p.sent.at(-1)).toMatchObject({ qid: "q4", ok: false, code: "malformed" });
    const wrongGen = claimFor({ ...g, generation: 2 });
    answerLedgerRequest(host, p as never, { type: "phone-claim", qid: "q5", hostname, generation: 1, holder, ...wrongGen });
    expect(p.sent.at(-1)).toMatchObject({ qid: "q5", ok: false, code: "malformed" });
    const forged = claimFor(g, keypair());
    answerLedgerRequest(host, p as never, { type: "phone-claim", qid: "q6", hostname, generation: 1, holder, ...forged });
    expect(p.sent.at(-1)).toMatchObject({ qid: "q6", ok: false, code: "malformed" });
    answerLedgerRequest(host, p as never, { type: "phone-claim", qid: "q7", hostname, generation: 1, holder, ...claimFor(g) });
    expect(p.sent.at(-1)).toMatchObject({ qid: "q7", ok: true });
  });

  it("P announces every grant with the phone's claim, renewals included, and every relay accepts it", async () => {
    const r = rig();
    const rank = phoneLedgerRanking("erin", r.dir.current, r.feed.state);
    const self = rank[0]!;
    const host = new PhoneLedgerHost({ selfRelayId: self, servicesApex: APEX, sign: (m) => ed.sign(m, r.relays[self]!.key.privateKey), now: r.now, maxSeenGeneration: () => 0, onVacant: () => undefined });
    const announced: PhoneItem[] = [];
    const client = new MeshPhoneLedgerClient({ selfRelayId: self, ledgerFor: () => ({ local: host }), announce: (it) => void announced.push(it), withdraw: () => undefined });
    const hostname = `erin.${APEX}`;
    const g: PhoneRouteGrant = { hostname, phoneRoutePub: hex(phoneKey.publicKey), generation: 1, holderRelayId: self, ledgerRelayId: self, issuedAt: r.now(), notAfter: r.now() + 1 };
    const c = claimFor(g);
    expect(await client.apply({ op: "acquire", hostname, generation: 1, holder: { relayId: self, sessionId: "s1", phoneRoutePub: g.phoneRoutePub }, ...c })).toMatchObject({ ok: true });
    r.advance(15_000);
    expect(await client.apply({ op: "renew", hostname, generation: 1, sessionId: "s1" })).toMatchObject({ ok: true });
    expect(announced).toHaveLength(2);
    for (const it of announced) {
      expect(it.claim).toEqual(c.claim);
      expect(r.store.offerPhone(it, self)).toBe(true);
    }
  });
});

describe("Low: device grant ids the log cannot carry", () => {
  it("a mesh relay ignores a presented grant whose id could never be revoked through the log", async () => {
    const fx = new MeshFixture();
    const admin = keypair();
    fx.authority("carol", hex(admin.publicKey), hex(keypair().publicKey));
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    const device = keypair();
    for (const [grantId, kept] of [["grant_1", false], ["zz-not-hex", false], ["ab".repeat(32), true]] as const) {
      const g = { grantId, username: "carol", deviceId: "cd".repeat(16), devicePubKey: device.publicKey, scopes: ["admin"] as never, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 86_400_000 };
      const presented = [{ grant: { grantId, username: "carol", deviceId: "cd".repeat(16), devicePubHex: hex(device.publicKey), scopes: ["admin"], issuedAt: g.issuedAt, expiresAt: g.expiresAt }, signatureHex: hex(signDeviceCapabilityGrant(g, admin)), signerRoot: "admin-root" }];
      const rec = (await meshPhoneEligibility(() => feed.state)("carol", presented))!;
      expect(rec.grants.length, grantId).toBe(kept ? 1 : 0);
    }
  });
});

describe("Low: mailboxes keep their first holder", () => {
  it("another relay's announcement for a held mailbox is ignored until the holder withdraws it", () => {
    const r = rig();
    const pik = keypair();
    const epoch = pbMailboxEpoch(r.now());
    const ann = { pikPubHex: hex(pik.publicKey), epoch };
    const signature = hex(ed.sign(canonicalPbMailboxAnnounce(ann.pikPubHex, epoch), pik.privateKey));
    const id = pbMailboxId(ann.pikPubHex, epoch);
    expect(r.store.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "ra" }, "ra")).toBe(true);
    expect(r.store.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "rb" }, "rb")).toBe(true);
    expect(r.store.mailboxRelay(id)).toBe("ra");
    expect(r.store.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "rc" }, "rc")).toBe(true);
    // A withdrawal by another relay does not move the holder; the holder's own hands it to the next in line.
    r.store.withdrawMailboxes([id], "rc");
    expect(r.store.mailboxRelay(id)).toBe("ra");
    r.store.withdrawMailboxes([id], "ra");
    expect(r.store.mailboxRelay(id)).toBe("rb");
    // Its bridge going (or its retirement) does the same; then nobody holds it.
    r.store.dropMailboxesOf("rb");
    expect(r.store.mailboxRelay(id)).toBeNull();
  });
});

describe("Low: a bridged stream routes by its ClientHello", () => {
  it("the SNI in the first DATA must be the OPEN's", () => {
    const hello = Buffer.from(clientHello(`home.alice.${APEX}`));
    expect(bridgedSniMatches(`home.alice.${APEX}`, hello)).toBe(true);
    expect(bridgedSniMatches(`HOME.alice.${APEX}`, hello)).toBe(true);
    expect(bridgedSniMatches(`home.bob.${APEX}`, hello)).toBe(false);
    expect(bridgedSniMatches(`home.alice.${APEX}`, Buffer.from("not tls"))).toBe(false);
  });
});

describe("Low: /mesh handshakes are capped", () => {
  it("per client address and in all", () => {
    const p = new PendingHandshakes();
    for (let i = 0; i < MESH_HANDSHAKE_MAX_PENDING_PER_IP; i++) expect(p.tryAdd("1.1.1.1")).toBe(true);
    expect(p.tryAdd("1.1.1.1")).toBe(false);
    p.done("1.1.1.1");
    expect(p.tryAdd("1.1.1.1")).toBe(true);
    let n = MESH_HANDSHAKE_MAX_PENDING_PER_IP;
    for (let i = 0; n < MESH_HANDSHAKE_MAX_PENDING; i++) if (p.tryAdd(`10.0.${i >> 2}.${i & 3}`)) n++;
    expect(p.tryAdd("9.9.9.9")).toBe(false);
  });
});

describe("M4: phone tunnels and begins", () => {
  it("caps open phone tunnels per client address", () => {
    const l = new AddressLimiter(PHONE_TUNNEL_MAX_PER_IP);
    for (let i = 0; i < PHONE_TUNNEL_MAX_PER_IP; i++) expect(l.tryAdd("2.2.2.2")).toBe(true);
    expect(l.tryAdd("2.2.2.2")).toBe(false);
    expect(l.tryAdd("3.3.3.3")).toBe(true);
    l.done("2.2.2.2");
    expect(l.tryAdd("2.2.2.2")).toBe(true);
  });

  function routes(o: { eligible: boolean; reads: { n: number } }) {
    let t = 1_000_000;
    const admin = keypair();
    const device = keypair();
    const grant = { grantId: "ab".repeat(32), username: "erin", deviceId: "cd".repeat(16), devicePubKey: device.publicKey, scopes: ["admin"] as never, issuedAt: t - 1_000, expiresAt: t + 86_400_000 };
    const ledger: PhoneRouteLedgerClient = {
      read: async () => {
        o.reads.n++;
        return { generation: 4, holder: null, leaseUntil: 0 };
      },
      apply: async () => null,
    };
    const pr = new PhoneRoutes({
      relayId: "ra",
      apex: APEX,
      ledger,
      now: () => t,
      eligibility: async () =>
        o.eligible
          ? { adminRootPub: hex(admin.publicKey), grants: [{ grant, signatureHex: hex(signDeviceCapabilityGrant(grant, admin)), signerRoot: "admin-root", revokedAt: null }] }
          : { adminRootPub: hex(admin.publicKey), grants: [] },
    });
    const handle = (): PhoneSessionHandle & { sent: Array<Record<string, unknown>> } => {
      const sent: Array<Record<string, unknown>> = [];
      return { sent, send: (m) => void sent.push(m), tunnel: {} as never, streamCount: () => 0, closeStreams: () => undefined, close: () => undefined };
    };
    return { pr, handle, advance: (ms: number) => (t += ms) };
  }

  it("refuses an ineligible account before asking the ledger (no generation revealed)", async () => {
    const reads = { n: 0 };
    const { pr, handle } = routes({ eligible: false, reads });
    const h = handle();
    await pr.begin(pr.attach(h, "4.4.4.4"), "erin");
    expect(h.sent.at(-1)).toMatchObject({ type: "refused", code: "not-eligible" });
    expect(h.sent.at(-1)).not.toHaveProperty("generation");
    expect(reads.n).toBe(0);
  });

  it("budgets begins per address and reuses a ledger read for a moment", async () => {
    const reads = { n: 0 };
    const { pr, handle, advance } = routes({ eligible: true, reads });
    const h = handle();
    const s = pr.attach(h, "5.5.5.5");
    for (let i = 0; i < PHONE_BEGIN_BURST; i++) await pr.begin(s, "erin");
    expect(h.sent.filter((m) => m.type === "challenge")).toHaveLength(PHONE_BEGIN_BURST);
    expect(reads.n).toBe(1);
    await pr.begin(s, "erin");
    expect(h.sent.at(-1)).toMatchObject({ type: "refused", code: "busy" });
    // Another address has its own budget; the cached read lapses.
    advance(3_000);
    const h2 = handle();
    await pr.begin(pr.attach(h2, "6.6.6.6"), "erin");
    expect(h2.sent.at(-1)).toMatchObject({ type: "challenge", generation: 5 });
    expect(reads.n).toBe(2);
  });
});

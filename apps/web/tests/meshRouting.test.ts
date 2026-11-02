/**
 * The mesh's routing pieces in isolation (relay-mesh.md §5.3, §7.2–§7.3, §10): the query (single flight, first valid
 * answer, negative cache, inbound rate limit), account homes and moves, rebalancing decisions from counted traffic,
 * and the legacy announcer's timing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MOVE_TTL_MS,
  accountHash,
  ATTACH_TTL_MS,
  ed,
  LEGACY_TTL_MS,
  REBALANCE_MIN_BYTES,
  signRelayMeshRecord,
  type AttachmentItem,
  type BoxAttachment,
  type MeshCheckContext,
} from "@flagship/protocol";
import { MeshQuery } from "../src/tunnel/mesh/query.js";
import { AccountHomes } from "../src/tunnel/mesh/home.js";
import { Rebalancer } from "../src/tunnel/mesh/rebalance.js";
import { LegacyAnnouncer } from "../src/tunnel/mesh/legacy.js";
import type { BridgePeer } from "../src/tunnel/mesh/bridge.js";
import { APEX, hex, keypair, MeshFixture } from "./support/meshFixture.js";

function fakePeer(relayId: string, answer?: (m: Record<string, unknown>) => Record<string, unknown> | null) {
  const sent: Record<string, unknown>[] = [];
  const p = {
    relayId,
    sent,
    rejected: 0,
    send(m: Record<string, unknown>) {
      sent.push(m);
      const a = answer?.(m);
      if (a) setTimeout(() => q.onAnswer(p as unknown as BridgePeer, a), 5);
    },
    noteOverLimit() {},
  };
  let q!: MeshQuery;
  return { p, bind: (x: MeshQuery) => (q = x) };
}

describe("mesh query", () => {
  it("is single-flight per name, takes the first answer that becomes the winner, and remembers a miss for 10 s", async () => {
    let t = 1_000;
    const a = fakePeer("ra", (m) => (m.type === "query" ? { type: "answer", qid: m.qid, items: [] } : null));
    const b = fakePeer("rb", (m) => (m.type === "query" ? { type: "answer", qid: m.qid, items: [{ kind: "box", attachment: { relayId: "rb" } }] } : null));
    let accept = true;
    const q = new MeshQuery({ transport: { peers: () => [a.p, b.p] as unknown as BridgePeer[] }, accept: () => accept, now: () => t, timeoutMs: 200 });
    a.bind(q);
    b.bind(q);
    const [x, y] = await Promise.all([q.ask("home.alice.flagship.services"), q.ask("home.alice.flagship.services")]);
    expect(x).toBe("rb");
    expect(y).toBe("rb");
    expect(a.p.sent.length).toBe(1);
    accept = false;
    expect(await q.ask("home.bob.flagship.services")).toBeNull();
    const sentBefore = a.p.sent.length;
    expect(await q.ask("home.bob.flagship.services")).toBeNull();
    expect(a.p.sent.length).toBe(sentBefore); // negative cache: no second query
    t += 10_001;
    await q.ask("home.bob.flagship.services");
    expect(a.p.sent.length).toBe(sentBefore + 1);
  });

  it("answers `busy` past 500 a second (burst 1,000) without a lookup", () => {
    const peer = { relayId: "rb", sent: [] as Record<string, unknown>[], send(m: Record<string, unknown>) { this.sent.push(m); }, noteOverLimit() {} };
    const q = new MeshQuery({ transport: { peers: () => [] }, accept: () => false, now: () => 5_000 });
    let lookups = 0;
    for (let i = 0; i < 1_001; i++) q.onQuery(peer as unknown as BridgePeer, { type: "query", qid: `q${i}`, name: "x" }, () => (lookups++, []));
    expect(lookups).toBe(1_000);
    expect(peer.sent[1_000]).toEqual({ type: "answer", qid: "q1000", items: [], busy: true });
  });
});

function ctxRig() {
  const fx = new MeshFixture();
  let t = 50_000_000;
  fx.now = () => t;
  fx.addRelay("ra");
  fx.addRelay("rb");
  fx.addRelay("rc");
  fx.mintDirectory();
  const ctx = (): MeshCheckContext => ({ servicesApex: APEX, log: { revokedRelays: new Map() } as never, directory: fx.directory, now: t });
  return { fx, ctx, advance: (ms: number) => (t += ms), now: () => t };
}

function item(relayId: string, attachedAt: number, pod = `b${Math.random().toString(36).slice(2, 8)}.bob.${APEX}`): AttachmentItem {
  const a: BoxAttachment = { serverFqdn: pod, boxPub: "00".repeat(32), regGen: 1, relayId, attachedAt, issuedAt: attachedAt, notAfter: attachedAt + ATTACH_TTL_MS };
  return { kind: "box", attachment: a, signature: "00".repeat(64) };
}

describe("account homes", () => {
  it("home = most attachments, then earliest attachedAt; a move from the home wins while its target holds a box", () => {
    const { fx, ctx, now } = ctxRig();
    let winners = [item("ra", now()), item("rb", now() - 10)];
    const ra = fx.relays[0]!;
    const homes = new AccountHomes({ selfRelayId: "rc", ctx, winners: () => winners, sign: (m) => ed.sign(m, ra.key.privateKey) });
    expect(homes.homeOf("bob")).toBe("rb");
    winners = [...winners, item("ra", now())];
    expect(homes.homeOf("bob")).toBe("ra");
    const move = { accountHash: accountHash("bob"), fromRelayId: "ra", toRelayId: "rc", issuedAt: now(), notAfter: now() + ACCOUNT_MOVE_TTL_MS };
    const sig = (k = ra.key.privateKey) => signRelayMeshRecord("relay-account-move", move, (m) => ed.sign(m, k));
    // Signed by a relay that is not the home: refused.
    expect(homes.offer({ move: { ...move, fromRelayId: "rb" }, signature: signRelayMeshRecord("relay-account-move", { ...move, fromRelayId: "rb" }, (m) => ed.sign(m, fx.relays[1]!.key.privateKey)) }, "bob", "rb")).toEqual({ ok: false, reason: "not-home" });
    expect(homes.offer({ move, signature: sig(fx.relays[1]!.key.privateKey) }, "bob", "ra")).toEqual({ ok: false, reason: "bad-signature" });
    expect(homes.offer({ move, signature: sig() }, "bob", "ra")).toEqual({ ok: true });
    // The target holds nothing yet: rule 2 still decides. Once it holds a box, it is the home.
    expect(homes.homeOf("bob")).toBe("ra");
    winners = [...winners, item("rc", now())];
    expect(homes.homeOf("bob")).toBe("rc");
    // A second move within 6 h is refused.
    const again = { ...move, fromRelayId: "rc", toRelayId: "ra" };
    expect(homes.offer({ move: again, signature: signRelayMeshRecord("relay-account-move", again, (m) => ed.sign(m, fx.relays[2]!.key.privateKey)) }, "bob", "rc")).toEqual({ ok: false, reason: "too-soon" });
  });
});

describe("rebalancing", () => {
  it("moves an account whose visitors mostly arrive through another fresh, light relay, and never one with an old box", () => {
    let t = 100_000_000;
    const moved: Array<[string, string]> = [];
    let legacy = false;
    const r = new Rebalancer({
      selfRelayId: "ra",
      now: () => t,
      intervalMs: 60_000,
      relays: () => [
        { relayId: "ra", relayKind: "full", lastLoadAt: t, draining: false, tunnels: 10, capacity: 100 },
        { relayId: "rc", relayKind: "full", lastLoadAt: t - 1_000, draining: false, tunnels: 10, capacity: 100 },
      ],
      homeOf: () => "ra",
      lastMove: () => null,
      hasLegacyBox: () => legacy,
      move: (a, to) => moved.push([a, to]),
    });
    r.countBytes("bob", "rc", REBALANCE_MIN_BYTES);
    r.countBytes("bob", "ra", 1_000);
    legacy = true;
    r.runOnce();
    expect(moved).toEqual([]);
    expect(r.decisions["legacy-box"]).toBe(1);
    legacy = false;
    r.runOnce();
    expect(moved).toEqual([["bob", "rc"]]);
    // A quiet account (below 64 MiB and 500 streams) stays.
    r.countBytes("amy", "rc", 1_000);
    r.runOnce();
    expect(r.decisions["below-threshold"]).toBe(1);
    t += 61_000;
    r.runOnce();
  });
});

describe("legacy announcer", () => {
  it("announces an old box at once and every 60 s; waits 10 s for a mesh box; signs with the relay key", () => {
    vi.useFakeTimers();
    try {
      const fx = new MeshFixture();
      const relay = fx.addRelay("ra");
      const got: AttachmentItem[] = [];
      const box = { serverFqdn: `home.old.${APEX}`, boxPub: hex(keypair().publicKey), regGen: 1, attachedAt: Date.now() };
      const old = new LegacyAnnouncer({ selfRelayId: "ra", sign: (m) => ed.sign(m, relay.key.privateKey) }, box, (i) => got.push(i));
      old.start(false);
      expect(got.length).toBe(1);
      expect(got[0]!.attachment.notAfter - got[0]!.attachment.issuedAt).toBe(LEGACY_TTL_MS);
      vi.advanceTimersByTime(60_000);
      expect(got.length).toBe(2);
      old.stop();
      const meshGot: AttachmentItem[] = [];
      const m = new LegacyAnnouncer({ selfRelayId: "ra", sign: (x) => ed.sign(x, relay.key.privateKey) }, box, (i) => meshGot.push(i));
      m.start(true);
      vi.advanceTimersByTime(9_999);
      expect(meshGot.length).toBe(0);
      vi.advanceTimersByTime(1);
      expect(meshGot.length).toBe(1);
      m.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

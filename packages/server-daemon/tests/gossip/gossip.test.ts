/**
 * Phase 5 — the daemon gossip loop + per-service claim/yield.
 *
 * Covers (per the Phase-5 test plan):
 *   - ingest decrypts + verifies + upserts a sibling; rejects a bad-MAC frame;
 *   - a dead sibling expires from the SiblingView within the liveness window;
 *   - election picks the highest-clout live runner of a service;
 *   - claim/yield: self claims when it's the lead, releases when outranked,
 *     no-ops when steady;
 *   - convergence over a couple of rounds (live siblings → one stable leader).
 */
import { describe, expect, it } from "vitest";
import {
  canonicalGossip,
  type GossipAnnouncement,
  macGossip,
  openGossip,
  sealGossip,
} from "@flagship/protocol";

import { buildGossipIngestHandler } from "../../src/gossip/gossipHttp.js";
import { SiblingView } from "../../src/gossip/siblingView.js";
import {
  decideClaimActions,
  runElectionRound,
  type SelfMember,
} from "../../src/gossip/election.js";
import { buildGossipLoop } from "../../src/gossip/gossipLoop.js";
import type { RouteClaimer } from "../../src/gossip/routeClaimer.js";
import {
  tier2FqdnFor,
  urlControllerRouteClaimer,
} from "../../src/gossip/routeClaimer.js";
import { resolveCgk } from "../../src/gossip/cgk.js";

const CGK = new Uint8Array(32).fill(7);
const USER = "harry";

function ann(over: Partial<GossipAnnouncement>): GossipAnnouncement {
  return {
    user: USER,
    name: "a.harry.flagship.services",
    birthAuthHex: "aa".repeat(32),
    birthDate: 1000,
    voteStkHex: "none",
    voteDate: 0,
    services: ["blog"],
    liveness: "live",
    issuedAt: 1,
    ...over,
  };
}

/** Build the opaque CGK-sealed body the transport delivers to /internal/gossip. */
function sealedBody(a: GossipAnnouncement, mac = macGossip(a, CGK)): Buffer {
  const plaintext = new TextEncoder().encode(JSON.stringify({ announcement: a, mac }));
  return Buffer.from(sealGossip(plaintext, CGK));
}

function req(body: Buffer) {
  return { method: "POST", path: "/internal/gossip", headers: {}, body };
}

// A mock RouteClaimer over a held-set — exactly the seam the spec calls for.
class MockClaimer implements RouteClaimer {
  held = new Set<string>();
  log: Array<{ op: "claim" | "release"; service: string }> = [];
  async claim(service: string) {
    this.log.push({ op: "claim", service });
    this.held.add(service);
  }
  async release(service: string) {
    this.log.push({ op: "release", service });
    this.held.delete(service);
  }
  holds(service: string) {
    return this.held.has(service);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Ingest: decrypt + verify + upsert; reject bad MAC.
// ─────────────────────────────────────────────────────────────────────────
describe("inbound /internal/gossip ingest", () => {
  it("decrypts, verifies the MAC, and upserts the sibling (replying 204, body ignored)", async () => {
    const view = new SiblingView(10_000);
    const handle = buildGossipIngestHandler({
      cgk: CGK,
      view,
      user: USER,
      selfId: "self.harry.flagship.services",
      now: () => 5000,
    });
    const a = ann({ name: "b.harry.flagship.services", services: ["blog", "chat"] });
    const res = await handle(req(sealedBody(a)));
    expect(res).toEqual({ status: 204, body: "" });
    expect(view.size()).toBe(1);
    const rec = view.get("b.harry.flagship.services");
    expect(rec?.services).toEqual(["blog", "chat"]);
    expect(rec?.receivedAt).toBe(5000);
  });

  it("rejects (silently, still 204) a frame with a tampered MAC — no upsert", async () => {
    const view = new SiblingView(10_000);
    const handle = buildGossipIngestHandler({
      cgk: CGK,
      view,
      user: USER,
      selfId: "self.harry.flagship.services",
    });
    const a = ann({ name: "evil.harry.flagship.services" });
    // Seal with a VALID seal but a WRONG mac (forged claims).
    const res = await handle(req(sealedBody(a, "00".repeat(32))));
    expect(res).toEqual({ status: 204, body: "" });
    expect(view.size()).toBe(0);
  });

  it("rejects a body sealed under a DIFFERENT key (undecryptable) — silent, no upsert", async () => {
    const view = new SiblingView(10_000);
    const handle = buildGossipIngestHandler({
      cgk: CGK,
      view,
      user: USER,
      selfId: "self.harry.flagship.services",
    });
    const a = ann({});
    const wrongKey = new Uint8Array(32).fill(9);
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ announcement: a, mac: macGossip(a, wrongKey) }),
    );
    const body = Buffer.from(sealGossip(plaintext, wrongKey));
    const res = await handle(req(body));
    expect(res).toEqual({ status: 204, body: "" });
    expect(view.size()).toBe(0);
  });

  it("ignores a frame for a DIFFERENT account and our OWN echoed frame", async () => {
    const view = new SiblingView(10_000);
    const handle = buildGossipIngestHandler({
      cgk: CGK,
      view,
      user: USER,
      selfId: "self.harry.flagship.services",
    });
    const otherAccount = ann({ user: "mallory", name: "x.mallory.flagship.services" });
    // MAC must match the frame's OWN canonical bytes (which include user=mallory)
    // to get past the MAC gate, so the account guard is what rejects it.
    await handle(req(sealedBody(otherAccount, macGossip(otherAccount, CGK))));
    const ownEcho = ann({ name: "self.harry.flagship.services" });
    await handle(req(sealedBody(ownEcho)));
    expect(view.size()).toBe(0);
  });

  it("returns null for a non-gossip path (lets the chain continue)", async () => {
    const view = new SiblingView(10_000);
    const handle = buildGossipIngestHandler({
      cgk: CGK,
      view,
      user: USER,
      selfId: "self.harry.flagship.services",
    });
    expect(await handle({ method: "GET", path: "/api/health", headers: {}, body: Buffer.alloc(0) })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. SiblingView liveness expiry.
// ─────────────────────────────────────────────────────────────────────────
describe("SiblingView liveness expiry", () => {
  it("drops a sibling not re-heard within the liveness window", () => {
    const view = new SiblingView(100); // 100ms window
    view.upsert(ann({ name: "b.harry.flagship.services" }), 1000);
    expect(view.liveMembers(1050).map((m) => m.id)).toEqual(["b.harry.flagship.services"]);
    // 200ms later, past the 100ms window → not live.
    expect(view.liveMembers(1200)).toEqual([]);
    view.prune(1200);
    expect(view.size()).toBe(0);
  });

  it("a fresh frame refreshes liveness; a STALE (older issuedAt) frame does not", () => {
    const view = new SiblingView(100);
    view.upsert(ann({ name: "b.harry.flagship.services", issuedAt: 10 }), 1000);
    // A replayed OLDER frame at t=1090 must NOT refresh receivedAt.
    view.upsert(ann({ name: "b.harry.flagship.services", issuedAt: 5 }), 1090);
    expect(view.liveMembers(1150)).toEqual([]); // still aged off the 1000 receipt
    // A genuinely newer frame DOES refresh.
    view.upsert(ann({ name: "b.harry.flagship.services", issuedAt: 20 }), 1140);
    expect(view.liveMembers(1200).map((m) => m.id)).toEqual(["b.harry.flagship.services"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Election picks the highest-clout live runner.
// ─────────────────────────────────────────────────────────────────────────
describe("per-service election", () => {
  it("self claims when it is the highest-clout live runner", () => {
    // Self is OLDER (lower birthDate) than the sibling → self leads on the
    // birthDate tie-break (no votes).
    const self: SelfMember = {
      id: "self.harry.flagship.services",
      domain: "self.harry.flagship.services",
      birthDate: 100,
      voteIssuedAt: null,
      services: ["blog"],
    };
    const claimer = new MockClaimer();
    const actions = decideClaimActions({
      self,
      liveSiblings: [
        {
          id: "b.harry.flagship.services",
          domain: "b.harry.flagship.services",
          birthDate: 200,
          voteIssuedAt: null,
          liveness: "live",
          services: ["blog"],
        },
      ],
      claimer,
    });
    expect(actions).toEqual([{ kind: "claim", service: "blog" }]);
  });

  it("self releases when an OUTRANKING live sibling exists and self holds the route", () => {
    const self: SelfMember = {
      id: "self.harry.flagship.services",
      domain: "self.harry.flagship.services",
      birthDate: 300, // younger → loses to the older sibling
      voteIssuedAt: null,
      services: ["blog"],
    };
    const claimer = new MockClaimer();
    claimer.held.add("blog"); // self currently holds it
    const actions = decideClaimActions({
      self,
      liveSiblings: [
        {
          id: "b.harry.flagship.services",
          domain: "b.harry.flagship.services",
          birthDate: 100, // older → leads
          voteIssuedAt: null,
          liveness: "live",
          services: ["blog"],
        },
      ],
      claimer,
    });
    expect(actions).toEqual([{ kind: "release", service: "blog" }]);
  });

  it("an owner VOTE outranks seniority (a younger voted pod leads)", () => {
    const self: SelfMember = {
      id: "self.harry.flagship.services",
      domain: "self.harry.flagship.services",
      birthDate: 100, // oldest, but unvoted
      voteIssuedAt: null,
      services: ["blog"],
    };
    const claimer = new MockClaimer();
    claimer.held.add("blog");
    const actions = decideClaimActions({
      self,
      liveSiblings: [
        {
          id: "b.harry.flagship.services",
          domain: "b.harry.flagship.services",
          birthDate: 999,
          voteIssuedAt: 5000, // owner voted for b → b leads
          liveness: "live",
          services: ["blog"],
        },
      ],
      claimer,
    });
    expect(actions).toEqual([{ kind: "release", service: "blog" }]);
  });

  it("no-op when steady (self already leads AND holds; or a non-runner)", () => {
    const self: SelfMember = {
      id: "self.harry.flagship.services",
      domain: "self.harry.flagship.services",
      birthDate: 100,
      voteIssuedAt: null,
      services: ["blog"],
    };
    const claimer = new MockClaimer();
    claimer.held.add("blog"); // already holds + is the lead
    const actions = decideClaimActions({ self, liveSiblings: [], claimer });
    expect(actions).toEqual([]);
  });

  it("ignores a sibling that self-reports unreachable (it can't lead)", () => {
    const self: SelfMember = {
      id: "self.harry.flagship.services",
      domain: "self.harry.flagship.services",
      birthDate: 300,
      voteIssuedAt: null,
      services: ["blog"],
    };
    const claimer = new MockClaimer();
    const actions = decideClaimActions({
      self,
      liveSiblings: [
        {
          id: "b.harry.flagship.services",
          domain: "b.harry.flagship.services",
          birthDate: 100, // would outrank, but…
          voteIssuedAt: null,
          liveness: "unreachable", // …not live ⇒ excluded
          services: ["blog"],
        },
      ],
      claimer,
    });
    // Self is the only LIVE runner ⇒ self claims.
    expect(actions).toEqual([{ kind: "claim", service: "blog" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. runElectionRound applies actions through the claimer (idempotently).
// ─────────────────────────────────────────────────────────────────────────
describe("runElectionRound application", () => {
  it("applies claim then is a no-op on a second steady round", async () => {
    const self: SelfMember = {
      id: "self.harry.flagship.services",
      domain: "self.harry.flagship.services",
      birthDate: 100,
      voteIssuedAt: null,
      services: ["blog", "chat"],
    };
    const claimer = new MockClaimer();
    const a1 = await runElectionRound({ self, liveSiblings: [], claimer });
    expect(a1.map((x) => x.kind)).toEqual(["claim", "claim"]);
    expect([...claimer.held].sort()).toEqual(["blog", "chat"]);
    // Steady: nothing changes.
    const a2 = await runElectionRound({ self, liveSiblings: [], claimer });
    expect(a2).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. urlController route-claimer adapter (the LIVE seam).
// ─────────────────────────────────────────────────────────────────────────
describe("urlControllerRouteClaimer (live seam shape)", () => {
  it("maps a slug → <slug>.<user>.<apex> and tracks holdings via list()", async () => {
    const claimed: string[] = [];
    const url = {
      async claim(f: string) {
        claimed.push(f);
      },
      async release(f: string) {
        const i = claimed.indexOf(f);
        if (i >= 0) claimed.splice(i, 1);
      },
      list: () => [...claimed],
    };
    const rc = urlControllerRouteClaimer({
      urlController: url,
      fqdnForService: tier2FqdnFor("harry", "flagship.services"),
    });
    expect(rc.holds("blog")).toBe(false);
    await rc.claim("blog");
    expect(claimed).toEqual(["blog.harry.flagship.services"]);
    expect(rc.holds("blog")).toBe(true);
    await rc.release("blog");
    expect(rc.holds("blog")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. End-to-end loop + convergence over a couple of rounds.
// ─────────────────────────────────────────────────────────────────────────
describe("gossip loop convergence", () => {
  it("ingests a sibling's broadcast and converges leadership over rounds", async () => {
    // Two boxes share a CGK. Self is the YOUNGER box; the sibling is OLDER, so
    // the sibling should lead `blog` and self should NOT hold it.
    const view = new SiblingView(10_000);
    const claimer = new MockClaimer();
    let clock = 1000;
    const now = () => clock;

    // The hub fans the broadcast to our /internal/gossip; model it by feeding
    // the loop's POST body straight into our ingest handler.
    const ingest = buildGossipIngestHandler({
      cgk: CGK,
      view,
      user: USER,
      selfId: "self.harry.flagship.services",
      now,
    });
    const fetchImpl = (async (_url: string, init?: { body?: BodyInit }) => {
      // The OLDER sibling's announcement (what the hub would deliver to us). We
      // synthesize it here; the loop's OWN POST body is self's frame, which the
      // ingest handler self-echo-rejects, so deliver the sibling's instead.
      const sib = ann({ name: "old.harry.flagship.services", birthDate: 1, issuedAt: clock });
      await ingest(req(sealedBody(sib)));
      void init;
      return { ok: true, status: 204, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const loop = buildGossipLoop({
      cgk: CGK,
      view,
      claimer,
      broadcastUrl: "https://broadcast--harry.flagship.services",
      fetchImpl,
      now,
      readSelf: () => ({
        user: USER,
        name: "self.harry.flagship.services",
        birthAuthHex: "bb".repeat(32),
        birthDate: 500, // younger than the sibling (birthDate 1)
        vote: null,
        services: ["blog"],
      }),
    });

    // Round 1: self announces, hub delivers the older sibling, self elects.
    await loop.tick();
    expect(view.size()).toBe(1);
    // The older sibling leads blog ⇒ self does NOT claim it.
    expect(claimer.holds("blog")).toBe(false);

    // Round 2: steady — sibling still live, still leads, still no claim.
    clock += 1000;
    await loop.tick();
    expect(claimer.holds("blog")).toBe(false);

    // The sibling goes dark: no more deliveries, and time advances past the
    // liveness window. Self should now CLAIM blog (it becomes the only live
    // runner).
    const silentFetch = (async () => ({ ok: true, status: 204, text: async () => "" } as Response)) as unknown as typeof fetch;
    const loop2 = buildGossipLoop({
      cgk: CGK,
      view,
      claimer,
      broadcastUrl: "https://broadcast--harry.flagship.services",
      fetchImpl: silentFetch,
      now,
      readSelf: () => ({
        user: USER,
        name: "self.harry.flagship.services",
        birthAuthHex: "bb".repeat(32),
        birthDate: 500,
        vote: null,
        services: ["blog"],
      }),
    });
    clock += 11_000; // past the 10s window since the last delivery
    await loop2.tick();
    expect(claimer.holds("blog")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. CGK provisioning (env path) + disabled-when-absent.
// ─────────────────────────────────────────────────────────────────────────
describe("CGK provisioning", () => {
  it("resolves the CGK from FLAGSHIP_CGK_HEX (mirrors the SWK read)", async () => {
    const saved = process.env.FLAGSHIP_CGK_HEX;
    const savedBlob = process.env.FLAGSHIP_INSTALL_BLOB;
    process.env.FLAGSHIP_CGK_HEX = "07".repeat(32);
    process.env.FLAGSHIP_INSTALL_BLOB = "/nonexistent-blob.json";
    try {
      const cgk = await resolveCgk({ cgkHexFilePath: "/nonexistent-cgk.hex" });
      expect(cgk).toEqual(new Uint8Array(32).fill(7));
    } finally {
      if (saved === undefined) delete process.env.FLAGSHIP_CGK_HEX;
      else process.env.FLAGSHIP_CGK_HEX = saved;
      if (savedBlob === undefined) delete process.env.FLAGSHIP_INSTALL_BLOB;
      else process.env.FLAGSHIP_INSTALL_BLOB = savedBlob;
    }
  });

  it("returns null (gossip disabled) when no CGK is provisioned anywhere", async () => {
    const saved = process.env.FLAGSHIP_CGK_HEX;
    const savedBlob = process.env.FLAGSHIP_INSTALL_BLOB;
    delete process.env.FLAGSHIP_CGK_HEX;
    process.env.FLAGSHIP_INSTALL_BLOB = "/nonexistent-blob.json";
    try {
      expect(await resolveCgk({ cgkHexFilePath: "/nonexistent-cgk.hex" })).toBeNull();
    } finally {
      if (saved !== undefined) process.env.FLAGSHIP_CGK_HEX = saved;
      if (savedBlob === undefined) delete process.env.FLAGSHIP_INSTALL_BLOB;
      else process.env.FLAGSHIP_INSTALL_BLOB = savedBlob;
    }
  });
});

// Sanity: the seal/open round-trips under the CGK (the transport assumption).
describe("transport sanity", () => {
  it("openGossip(sealGossip(x)) round-trips and canonicalGossip is stable", () => {
    const a = ann({});
    const body = sealedBody(a);
    const opened = openGossip(new Uint8Array(body), CGK);
    const parsed = JSON.parse(Buffer.from(opened).toString("utf8"));
    expect(parsed.announcement.name).toBe(a.name);
    expect(Buffer.from(canonicalGossip(a)).length).toBeGreaterThan(0);
  });
});

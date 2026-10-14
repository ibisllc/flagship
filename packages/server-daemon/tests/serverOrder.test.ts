/**
 * The owner's server order on the box (docs/server-order.md): the holder
 * adopts only verified, newer orders and keeps them across restarts; gossip
 * frames carry the order to siblings; leadership follows the order and passes
 * down it while higher servers are down.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ed,
  macGossip,
  openGossip,
  sealGossip,
  signServerOrder,
  type GossipAnnouncement,
  type Keypair,
  type ServerOrder,
  type SignedServerOrder,
} from "@flagship/protocol";
import { buildServerOrderHolder } from "../src/serverOrderHolder.js";
import { buildGossipIngestHandler } from "../src/gossip/gossipHttp.js";
import { buildGossipLoop } from "../src/gossip/gossipLoop.js";
import { SiblingView } from "../src/gossip/siblingView.js";
import { accountLeader, leadsSnapshot, type SelfMember } from "../src/gossip/election.js";
import type { RouteClaimer } from "../src/gossip/routeClaimer.js";

const USER = "harry";
const CGK = new Uint8Array(32).fill(7);
const key = (seed: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(seed);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const irk = key(1);
const [A, B, C] = [hex(key(10).publicKey), hex(key(11).publicKey), hex(key(12).publicKey)];

function signed(stks: string[], issuedAt: number, signer = irk, user = USER): SignedServerOrder {
  const order: ServerOrder = { user, stks, issuedAt, nonce: "cd".repeat(32) };
  return { order, signature: signServerOrder(order, signer) };
}

function holder(dir = mkdtempSync(join(tmpdir(), "server-order-"))) {
  const path = join(dir, "server-order.json");
  return { path, h: buildServerOrderHolder({ path, user: USER, ownerIrkPub: irk.publicKey }) };
}

describe("server order holder", () => {
  it("adopts a verified order, ranks by it, and reloads it after a restart", async () => {
    const { path, h } = holder();
    expect(await h.offer(signed([B, A], 100), ".com")).toBe(true);
    expect(h.rankOf(B)).toBe(0);
    expect(h.rankOf(A.toUpperCase())).toBe(1);
    expect(h.rankOf(C)).toBeNull();
    const again = buildServerOrderHolder({ path, user: USER, ownerIrkPub: irk.publicKey });
    await again.load();
    expect(again.current()?.order.stks).toEqual([B, A]);
  });

  it("ignores an older or equal order, a forged one, another account's, and junk", async () => {
    const { h } = holder();
    await h.offer(signed([A], 100), ".com");
    expect(await h.offer(signed([B], 100), "gossip")).toBe(false);
    expect(await h.offer(signed([B], 50), "gossip")).toBe(false);
    expect(await h.offer(signed([B], 200, key(2)), "gossip")).toBe(false);
    expect(await h.offer(signed([B], 200, irk, "mallory"), "gossip")).toBe(false);
    expect(await h.offer({ order: { user: USER }, signature: "zz" }, "gossip")).toBe(false);
    expect(await h.offer(null, "gossip")).toBe(false);
    expect(h.current()?.order.stks).toEqual([A]);
    expect(await h.offer(signed([B, A], 300), "gossip")).toBe(true);
  });

  it("needs the admin root once one is pinned", async () => {
    const admin = key(3);
    const dir = mkdtempSync(join(tmpdir(), "server-order-"));
    const h = buildServerOrderHolder({
      path: join(dir, "o.json"), user: USER, ownerIrkPub: irk.publicKey, adminRootPub: admin.publicKey,
    });
    expect(await h.offer(signed([A], 100), ".com")).toBe(false);
    expect(await h.offer(signed([A], 100, admin), ".com")).toBe(true);
  });

  it("treats a corrupt file as no order", async () => {
    const { path, h } = holder();
    writeFileSync(path, "{nope");
    await h.load();
    expect(h.current()).toBeNull();
  });
});

describe("gossip carries the order", () => {
  class NoopClaimer implements RouteClaimer {
    holds() { return false; }
    async claim() {}
    async release() {}
  }

  it("a frame carries the held order and its date; a sibling's ingest offers it", async () => {
    const order = signed([B, A], 100);
    let posted: Uint8Array | null = null;
    const loop = buildGossipLoop({
      cgk: CGK,
      view: new SiblingView(10_000),
      claimer: new NoopClaimer(),
      broadcastUrl: "https://broadcast--harry.flagship.services",
      fetchImpl: (async (_u: string, init?: { body?: Uint8Array }) => {
        posted = init?.body ?? null;
        return { ok: true, status: 204 } as Response;
      }) as unknown as typeof fetch,
      now: () => 1000,
      readSelf: () => ({ user: USER, name: "a.harry.flagship.services", birthAuthHex: A, birthDate: 1, order, services: [] }),
    });
    await loop.tick();
    const frame = JSON.parse(Buffer.from(openGossip(posted!, CGK)).toString("utf8")) as {
      announcement: GossipAnnouncement; serverOrder: SignedServerOrder;
    };
    expect(frame.announcement.orderDate).toBe(100);
    expect(frame.serverOrder).toEqual(order);

    const { h } = holder();
    const ingest = buildGossipIngestHandler({
      cgk: CGK, view: new SiblingView(10_000), user: USER, selfId: "b.harry.flagship.services",
      onServerOrder: (raw, from) => h.offer(raw, from),
    });
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ announcement: frame.announcement, mac: macGossip(frame.announcement, CGK), serverOrder: order }),
    );
    await ingest({ method: "POST", path: "/internal/gossip", headers: {}, body: Buffer.from(sealGossip(plaintext, CGK)) });
    expect(h.current()?.order.stks).toEqual([B, A]);
  });
});

describe("leadership follows the order", () => {
  const self = (rank: number | null, services: string[] = ["blog"]): SelfMember => ({
    id: "a.harry.flagship.services", domain: "a.harry.flagship.services", stkHex: A, birthDate: 1, orderRank: rank, services,
  });
  const sib = (domain: string, stkHex: string, rank: number | null, liveness: "live" | "unreachable" = "live") => ({
    id: domain, domain, stkHex, birthDate: 5, orderRank: rank, liveness, services: ["blog"],
  });

  it("the first live server in the order leads; the role passes down and comes back", () => {
    const b = sib("b.harry.flagship.services", B, 0);
    const c = sib("c.harry.flagship.services", C, 1);
    expect(accountLeader({ self: self(2), liveSiblings: [b, c] })).toBe("b.harry.flagship.services");
    expect(leadsSnapshot({ self: self(2), liveSiblings: [b, c] }).blog?.leaderFqdn).toBe("b.harry.flagship.services");
    const bDown = { ...b, liveness: "unreachable" as const };
    expect(accountLeader({ self: self(2), liveSiblings: [bDown, c] })).toBe("c.harry.flagship.services");
    expect(accountLeader({ self: self(2), liveSiblings: [c] })).toBe("c.harry.flagship.services");
    expect(accountLeader({ self: self(2), liveSiblings: [b, c] })).toBe("b.harry.flagship.services");
  });

  it("an unlisted server comes after every listed one", () => {
    const c = sib("c.harry.flagship.services", C, 0);
    expect(accountLeader({ self: self(null), liveSiblings: [c] })).toBe("c.harry.flagship.services");
  });
});


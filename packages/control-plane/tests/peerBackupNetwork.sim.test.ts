/**
 * Peer backup between accounts, end to end in one process (docs/peer-backup.md):
 * ten servers of ten accounts on ten networks, 4-of-8 bricks, the real `.com`
 * handlers, the real box engines. Honest holders, a holder that drops its
 * bricks, one that returns garbage, colluding holders, churn, and a restore
 * from nothing but the account's key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreFromPeers, fetchPeerRoot } from "../../server-daemon/src/peerNet/restore.js";
import { Sim, type SimBox } from "./peerBackupSim.js";

const HOUR = 3600_000;

async function settle(sim: Sim, owner: SimBox, rounds = 6): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    await sim.holderTicks();
    await owner.owner.step();
    sim.advance(10 * 60_000);
  }
}

/** Holders check in every hour (as often as reliability needs); the owner steps each hour. */
async function runHours(sim: Sim, owner: SimBox, hours: number): Promise<void> {
  for (let h = 0; h < hours; h++) {
    sim.advance(HOUR);
    await sim.holderTicks();
    await owner.owner.step();
  }
}

async function network(size: number, opts: { poolBricks?: number } = {}): Promise<Sim> {
  const sim = new Sim();
  for (let i = 0; i < size; i++) sim.addBox(opts);
  await sim.holderTicks(); // register + first filler
  return sim;
}

describe("peer backup between accounts (simulation)", { timeout: 120_000 }, () => {
  it("places a 4-of-8 backup on eight other accounts and restores it from the account key alone", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    const archive = sim.writeArchive("a1", 150_000);
    await owner.owner.offer(archive);
    await settle(sim, owner);

    const s = await owner.owner.summary();
    expect(s.state).toBe("protected");
    expect(s.holders).toHaveLength(8);
    expect(s.totalBricks).toBe(s.healthyBricks);
    expect(await owner.owner.pinned()).toEqual(new Set([archive.archiveId]));

    // Eight distinct holders, none of them the owner's own account.
    const st = await owner.owner.state();
    const piks = st.current!.root.stripes.flat().map((m) => m.pikPubHex);
    expect(new Set(piks).size).toBe(8);
    expect(piks).not.toContain(await owner.holder.pikPubHex());

    // Restore: a brand-new server with only the PBK (which any device of the account derives).
    const out = join(sim.dir, "restored.data");
    const r = await restoreFromPeers({ serverId: owner.serverId, pbk: owner.pbk, com: sim.boxes[9]!.com, transport: sim.transport, outPath: out, now: sim.now });
    expect(r.archiveId).toBe(archive.archiveId);
    expect(new Uint8Array(readFileSync(out))).toEqual(archive.content);
    expect(r.backupFile).toBe(readFileSync(archive.backupPath, "utf8"));
  });

  it("no two bricks anywhere are equal, and holders hold same-sized bricks only", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    // A payload of zeros: without per-brick keys every data brick would be identical.
    const a = sim.writeArchive("zeros", 80_000);
    a.content.fill(0);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(a.dataPath, a.content);
    const { createHash } = await import("node:crypto");
    a.sha256 = createHash("sha256").update(a.content).digest("hex");
    await owner.owner.offer(a);
    await settle(sim, owner);
    const seen = new Set<string>();
    let bricks = 0;
    for (const b of sim.boxes) {
      for (const [name, bytes] of b.holderBlobs.blobs) {
        expect(bytes.length).toBe(sim.deps.network.brickBytes);
        const h = createHash("sha256").update(bytes).digest("hex");
        expect(seen.has(h)).toBe(false);
        seen.add(h);
        if (name.startsWith("b-")) bricks++;
      }
    }
    expect(bricks).toBeGreaterThan(0);
  });

  it("survives any four holders being gone, not five", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    const archive = sim.writeArchive("a2", 100_000);
    await owner.owner.offer(archive);
    await settle(sim, owner);
    const members = [...(await owner.owner.state()).current!.root.stripes[0]!];
    const byPik = new Map<string, SimBox>();
    for (const b of sim.boxes) byPik.set(await b.holder.pikPubHex(), b);
    const holders = members.map((m) => byPik.get(m.pikPubHex)!);

    await sim.misbehave(holders[0]!, "offline");
    await sim.misbehave(holders[2]!, "drop-bricks");
    await sim.misbehave(holders[5]!, "garbage");
    await sim.misbehave(holders[7]!, "offline");
    const out = join(sim.dir, "four-gone.data");
    await restoreFromPeers({ serverId: owner.serverId, pbk: owner.pbk, com: sim.boxes[9]!.com, transport: sim.transport, outPath: out, now: sim.now });
    expect(new Uint8Array(readFileSync(out))).toEqual(archive.content);

    await sim.misbehave(holders[3]!, "offline");
    await expect(
      restoreFromPeers({ serverId: owner.serverId, pbk: owner.pbk, com: sim.boxes[9]!.com, transport: sim.transport, outPath: join(sim.dir, "x.data"), now: sim.now }),
    ).rejects.toThrow(/Only 3 of the 4 pieces/);
  });

  it("a holder that drops its bricks fails its proofs and its share moves to a new holder", async () => {
    const sim = await network(11);
    const owner = sim.boxes[0]!;
    const archive = sim.writeArchive("a3", 100_000);
    await owner.owner.offer(archive);
    await settle(sim, owner);
    const before = (await owner.owner.state()).current!.root.stripes[0]!.map((m) => m.pikPubHex);
    const byPik = new Map<string, SimBox>();
    for (const b of sim.boxes) byPik.set(await b.holder.pikPubHex(), b);
    const cheat = byPik.get(before[1]!)!;
    await sim.misbehave(cheat, "drop-bricks");

    await runHours(sim, owner, 28);
    const after = (await owner.owner.state()).current!;
    const now = after.root.stripes[0]!.map((m) => m.pikPubHex);
    expect(now).not.toContain(before[1]);
    expect(now[1]).not.toBe(before[1]);
    expect(after.root.stripes[0]![1]!.rev).toBe(1);
    expect(after.depositedRevision).toBeGreaterThan(1);
    expect((await owner.owner.summary()).state).toBe("protected");

    // The repaired backup restores, even with the cheat and three more gone.
    await sim.misbehave(cheat, "offline");
    for (const p of now.slice(4, 7)) await sim.misbehave(byPik.get(p)!, "offline");
    const out = join(sim.dir, "repaired.data");
    await restoreFromPeers({ serverId: owner.serverId, pbk: owner.pbk, com: sim.boxes[10]!.com, transport: sim.transport, outPath: out, now: sim.now });
    expect(new Uint8Array(readFileSync(out))).toEqual(archive.content);
  });

  it("colluding holders can't pass each other's proofs by sharing storage", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("a4", 100_000));
    await settle(sim, owner);
    const members = [...(await owner.owner.state()).current!.root.stripes[0]!];
    const byPik = new Map<string, SimBox>();
    for (const b of sim.boxes) byPik.set(await b.holder.pikPubHex(), b);
    const x = byPik.get(members[0]!.pikPubHex)!;
    const y = byPik.get(members[1]!.pikPubHex)!;
    // X throws its bricks away and answers from Y's disk instead.
    for (const name of [...x.holderBlobs.blobs.keys()]) if (name.startsWith("b-")) x.holderBlobs.blobs.delete(name);
    const yNames = [...y.holderBlobs.blobs.keys()].filter((n) => n.startsWith("b-"));
    const original = x.holderBlobs.get.bind(x.holderBlobs);
    x.holderBlobs.get = async (name: string) => (await original(name)) ?? (await y.holderBlobs.get(yNames[0]!));
    await runHours(sim, owner, 28);
    const now = (await owner.owner.state()).current!.root.stripes[0]!.map((m) => m.pikPubHex);
    expect(now).not.toContain(members[0]!.pikPubHex);
    expect(now).toContain(members[1]!.pikPubHex);
  });

  it("an offline holder is replaced after 72 hours", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("a5", 60_000));
    await settle(sim, owner);
    const members = [...(await owner.owner.state()).current!.root.stripes[0]!];
    const byPik = new Map<string, SimBox>();
    for (const b of sim.boxes) byPik.set(await b.holder.pikPubHex(), b);
    await sim.misbehave(byPik.get(members[4]!.pikPubHex)!, "offline");
    await runHours(sim, owner, 80);
    const now = (await owner.owner.state()).current!.root.stripes[0]!.map((m) => m.pikPubHex);
    expect(now).not.toContain(members[4]!.pikPubHex);
  });

  it("waits, saying why, while fewer than eight other accounts can hold it", async () => {
    const sim = await network(6);
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("a6", 50_000));
    await settle(sim, owner, 2);
    const s = await owner.owner.summary();
    expect(s.state).toBe("waiting-for-peers");
    expect(s.reason).toBe("Peer backup starts once 8 other servers can hold it. 5 can now.");
  });

  it("two servers of one account, or one network, never share a stripe", async () => {
    const sim = new Sim();
    sim.addBox({ username: "alice" });
    for (let i = 0; i < 8; i++) sim.addBox({ username: "bob", ip: `203.0.113.${i + 1}` });
    for (let i = 0; i < 4; i++) sim.addBox({ username: `carol${i}`, ip: "192.0.2.5" });
    await sim.holderTicks();
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("a7", 50_000));
    await settle(sim, owner, 2);
    // bob counts once and carol's four share one network: two usable, not eight.
    expect((await owner.owner.summary()).reason).toBe("Peer backup starts once 8 other servers can hold it. 2 can now.");
    expect((await owner.owner.state()).pending).toBeNull();
    expect((await owner.owner.state()).current).toBeNull();
  });

  it("a server can place only about what it proves it holds for others", async () => {
    const sim = new Sim();
    sim.addBox({ poolBricks: 0 }); // the owner reserves nothing
    for (let i = 0; i < 9; i++) sim.addBox();
    await sim.holderTicks();
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("big", 400_000));
    await settle(sim, owner, 2);
    const s = await owner.owner.summary();
    expect(s.state).toBe("waiting-for-peers");
    expect(s.reason).toMatch(/used the space it has earned/);
  });

  it("a token spent twice loses the second lease when the holder redeems it", async () => {
    const sim = await network(3);
    const [a, b, c] = sim.boxes as [SimBox, SimBox, SimBox];
    // Mint one token the honest way, then spend it at two holders.
    const { blindPrepare, pbTokenMessage, rsaBlind, rsaFinalize, ed } = await import("@flagship/protocol");
    const { callHolder } = await import("../../server-daemon/src/peerNet/mailOps.js");
    const info = await a.com.network();
    const serialHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const prefix = crypto.getRandomValues(new Uint8Array(32));
    const prepared = blindPrepare(pbTokenMessage(serialHex), prefix);
    const blind = rsaBlind(info.tokenKey, prepared);
    const [blindSig] = await a.com.tokens([Buffer.from(blind.blindedMsg).toString("hex")]);
    const sig = rsaFinalize(info.tokenKey, prepared, Buffer.from(blindSig!, "hex"), blind.inv);
    const token = { serialHex, prefixHex: Buffer.from(prefix).toString("hex"), sigHex: Buffer.from(sig).toString("hex") };
    void ed;
    for (const h of [b, c]) {
      await callHolder(sim.transport, { pikPubHex: await h.holder.pikPubHex(), xPubHex: await h.holder.xPubHex() }, {
        op: "lease.open",
        leaseId: null,
        leaseKeySeed: crypto.getRandomValues(new Uint8Array(32)),
        includeLkPub: true,
        args: { slots: 1, tokens: [token] },
        now: sim.t,
      });
    }
    expect((await b.holder.status()).leases + (await c.holder.status()).leases).toBe(2);
    sim.advance(2 * HOUR);
    await sim.holderTicks();
    expect((await b.holder.status()).leases + (await c.holder.status()).leases).toBe(1);
  });

  it("filler is proven: a holder that throws filler away fails .com's challenges", async () => {
    const sim = await network(2);
    const [honest, cheat] = sim.boxes as [SimBox, SimBox];
    expect((await cheat.holder.status()).fillerBytes).toBeGreaterThan(0);
    for (const name of [...cheat.holderBlobs.blobs.keys()]) cheat.holderBlobs.blobs.set(name, new Uint8Array(sim.deps.network.brickBytes));
    for (let h = 0; h < 30; h++) {
      sim.advance(HOUR + 60_000);
      await sim.holderTicks();
    }
    const rows = await sim.store.listHolders();
    const row = (b: SimBox) => rows.find((r) => r.serverDomain === b.serverId)!;
    expect(row(honest).proofsFailed).toBe(0);
    expect(row(honest).proofsOk).toBeGreaterThan(10);
    expect(row(cheat).proofsOk).toBe(0);
    expect(row(cheat).proofsFailed).toBeGreaterThan(10);
    expect((await honest.holder.status()).reliability).toBeGreaterThan((await cheat.holder.status()).reliability!);
  });

  it("a newer archive becomes a new generation and the old one's leases close", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("g1", 60_000));
    await settle(sim, owner);
    const g1 = (await owner.owner.state()).current!;
    const second = sim.writeArchive("g2", 70_000);
    await owner.owner.offer(second);
    await settle(sim, owner, 2);
    expect((await owner.owner.state()).current!.root.generation).toBe(g1.root.generation); // not a week yet
    // A week on (the default cadence), the newer archive goes out.
    await runHours(sim, owner, 7 * 24);
    await settle(sim, owner);
    const cur = (await owner.owner.state()).current!;
    expect(cur.root.generation).toBe(g1.root.generation + 1);
    expect(cur.root.archive.archiveId).toBe(second.archiveId);
    const root = await fetchPeerRoot(sim.boxes[3]!.com, owner.serverId, owner.pbk);
    expect(root.generation).toBe(cur.root.generation);
    // The first generation's leases are closed: tombstoned now, freed after the grace period.
    let closed = 0;
    for (const b of sim.boxes) {
      const st = await b.holder.state();
      for (const l of Object.values(st.leases)) if (l.closedAt !== null) closed++;
    }
    expect(closed).toBe(8);
    const out = join(sim.dir, "g2.data");
    await restoreFromPeers({ serverId: owner.serverId, pbk: owner.pbk, com: sim.boxes[3]!.com, transport: sim.transport, outPath: out, now: sim.now });
    expect(new Uint8Array(readFileSync(out))).toEqual(second.content);
  });

  it("a holder leaving peer backup is moved away from, then frees its pool", async () => {
    const sim = await network(10);
    const owner = sim.boxes[0]!;
    await owner.owner.offer(sim.writeArchive("lv", 60_000));
    await settle(sim, owner);
    const m0 = (await owner.owner.state()).current!.root.stripes[0]![0]!;
    const byPik = new Map<string, SimBox>();
    for (const b of sim.boxes) byPik.set(await b.holder.pikPubHex(), b);
    const leaver = byPik.get(m0.pikPubHex)!;
    await leaver.holder.leave();
    await runHours(sim, owner, 26);
    expect((await owner.owner.state()).current!.root.stripes[0]!.map((m) => m.pikPubHex)).not.toContain(m0.pikPubHex);
    expect(await leaver.holder.left()).toBe(false);
    // After the leave window it drops everything.
    sim.advance(14 * 24 * HOUR);
    await leaver.holder.tick();
    expect(await leaver.holder.left()).toBe(true);
    expect(leaver.holderBlobs.blobs.size).toBe(0);
  });
});

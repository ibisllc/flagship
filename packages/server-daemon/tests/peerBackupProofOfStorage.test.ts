import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "@flagship/protocol";
import { canonicalPbResponse } from "@flagship/tunnel-protocol";
import {
  InMemoryShardRegistry,
  type MyShardRow,
} from "../src/peerBackup/registry.js";
import {
  ProofOfStorageScheduler,
  type ChallengeIssuer,
  type OwnerShardSource,
} from "../src/peerBackup/proofOfStorage.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeShardData(seed: number): Uint8Array {
  const b = new Uint8Array(8 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = ((i + seed) * 31) & 0xff;
  return b;
}

function honestSource(shards: Map<string, Uint8Array>): OwnerShardSource {
  return {
    loadShardSlice(enc, idx, off, len) {
      const data = shards.get(`${bytesToHex(enc)}#${idx}`);
      if (!data) return undefined;
      if (off + len > data.length) return undefined;
      return data.slice(off, off + len);
    },
    shardLength(enc, idx) {
      return shards.get(`${bytesToHex(enc)}#${idx}`)?.length;
    },
  };
}

function honestPeerIssuer(
  shards: Map<string, Uint8Array>,
  peerSTK: { privateKey: Uint8Array; publicKey: Uint8Array },
): ChallengeIssuer {
  return {
    async challenge(args) {
      const data = shards.get(`${bytesToHex(args.encChunkId)}#${args.shardIndex}`);
      if (!data) return { ok: false };
      const slice = data.slice(args.offset, args.offset + args.length);
      const concat = new Uint8Array(args.nonce.length + slice.length);
      concat.set(args.nonce, 0);
      concat.set(slice, args.nonce.length);
      const hash = sha256(concat);
      const hashHex = bytesToHex(hash);
      const sig = ed.sign(
        canonicalPbResponse({
          encChunkId: bytesToHex(args.encChunkId),
          shardIndex: args.shardIndex,
          nonce: bytesToHex(args.nonce),
          hash: hashHex,
        }),
        peerSTK.privateKey,
      );
      return { ok: true, hash: hashHex, signature: sig };
    },
  };
}

const peerSTKPriv = new Uint8Array(32).fill(7);
const peerSTKPub = ed.getPublicKey(peerSTKPriv);

function row(over: Partial<MyShardRow> = {}): MyShardRow {
  return {
    chunkId: over.chunkId ?? new Uint8Array(32).fill(0xa),
    encChunkId: over.encChunkId ?? new Uint8Array(32).fill(0xb),
    shardIndex: over.shardIndex ?? 0,
    peerServerId: over.peerServerId ?? "peer-A",
    peerStkPub: over.peerStkPub ?? peerSTKPub,
    storedAt: over.storedAt ?? 0,
    challengeStreak: over.challengeStreak ?? 0,
    ...over,
  };
}

function deterministicRandom() {
  let n = 1;
  return {
    randomBytes(len: number): Uint8Array {
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) b[i] = (n++ * 13) & 0xff;
      return b;
    },
    randomInt(max: number): number {
      n++;
      // Stable but non-zero for the jitter-roll
      return Math.floor(((n * 17) % 100) / 100 * max);
    },
  };
}

describe("ProofOfStorageScheduler — sweep", () => {
  it("challenges shards and records ok when the peer matches the owner's local data", async () => {
    const reg = new InMemoryShardRegistry();
    const shards = new Map<string, Uint8Array>();
    const enc = new Uint8Array(32).fill(0x33);
    shards.set(`${bytesToHex(enc)}#0`, makeShardData(1));
    reg.recordMyShard(row({ encChunkId: enc, peerServerId: "peer-A" }));
    const rng = deterministicRandom();
    const sched = new ProofOfStorageScheduler({
      registry: reg,
      source: honestSource(shards),
      issuerFor: () => honestPeerIssuer(shards, { privateKey: peerSTKPriv, publicKey: peerSTKPub }),
      now: () => 999_999_999,
      ...rng,
    });
    const result = await sched.sweepOnce();
    expect(result.challenged).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(0);
    const updated = reg.myShards()[0]!;
    expect(updated.lastChallenge).toBe(999_999_999);
    expect(updated.challengeStreak).toBe(0);
  });

  it("records failures when the peer signs a hash that does not match owner's data", async () => {
    const reg = new InMemoryShardRegistry();
    const ownerData = new Map<string, Uint8Array>();
    const peerData = new Map<string, Uint8Array>();
    const enc = new Uint8Array(32).fill(0x44);
    ownerData.set(`${bytesToHex(enc)}#0`, makeShardData(1));
    peerData.set(`${bytesToHex(enc)}#0`, makeShardData(2)); // different bytes!
    reg.recordMyShard(row({ encChunkId: enc, peerServerId: "peer-A" }));
    const rng = deterministicRandom();
    const sched = new ProofOfStorageScheduler({
      registry: reg,
      source: honestSource(ownerData),
      issuerFor: () => honestPeerIssuer(peerData, { privateKey: peerSTKPriv, publicKey: peerSTKPub }),
      now: () => 1,
      ...rng,
    });
    const result = await sched.sweepOnce();
    expect(result.failed).toBe(1);
    expect(reg.myShards()[0]!.challengeStreak).toBe(1);
  });

  it("declares the shard lost (and fires onShardLost) after lossStreakThreshold consecutive failures", async () => {
    const reg = new InMemoryShardRegistry();
    const ownerData = new Map<string, Uint8Array>();
    const enc = new Uint8Array(32).fill(0x77);
    ownerData.set(`${bytesToHex(enc)}#0`, makeShardData(1));
    reg.recordMyShard(row({ encChunkId: enc, peerServerId: "peer-A", challengeStreak: 2 }));
    let lostFired = 0;
    // Peer that always returns ok:false → counts as a failure.
    const failingIssuer: ChallengeIssuer = {
      async challenge() {
        return { ok: false, reason: "unreachable" };
      },
    };
    const rng = deterministicRandom();
    const sched = new ProofOfStorageScheduler({
      registry: reg,
      source: honestSource(ownerData),
      issuerFor: () => failingIssuer,
      onShardLost: async () => {
        lostFired++;
      },
      now: () => 1,
      ...rng,
    });
    const result = await sched.sweepOnce();
    expect(result.lost).toBe(1);
    expect(lostFired).toBe(1);
  });

  it("skips shards challenged recently (jitter-aware), then revisits them after the interval elapses", async () => {
    const reg = new InMemoryShardRegistry();
    const shards = new Map<string, Uint8Array>();
    const enc = new Uint8Array(32).fill(0x55);
    shards.set(`${bytesToHex(enc)}#0`, makeShardData(1));
    reg.recordMyShard(row({ encChunkId: enc, peerServerId: "peer-A" }));
    let nowVal = 0;
    const rng = deterministicRandom();
    const sched = new ProofOfStorageScheduler({
      registry: reg,
      source: honestSource(shards),
      issuerFor: () => honestPeerIssuer(shards, { privateKey: peerSTKPriv, publicKey: peerSTKPub }),
      now: () => nowVal,
      intervalMs: 1000,
      jitterMs: 50,
      ...rng,
    });
    nowVal = 100;
    let r = await sched.sweepOnce();
    expect(r.challenged).toBe(1);
    nowVal = 200;
    r = await sched.sweepOnce();
    expect(r.challenged).toBe(0);
    nowVal = 100 + 2000;
    r = await sched.sweepOnce();
    expect(r.challenged).toBe(1);
  });

  it("rejects responses signed with the wrong STK (peer impersonation defense)", async () => {
    const reg = new InMemoryShardRegistry();
    const shards = new Map<string, Uint8Array>();
    const enc = new Uint8Array(32).fill(0x66);
    shards.set(`${bytesToHex(enc)}#0`, makeShardData(1));
    // Registry says peer-A's STK pub is peerSTKPub, but issuer signs with wrongSTK.
    const wrongSTKPriv = new Uint8Array(32).fill(0x99);
    reg.recordMyShard(row({ encChunkId: enc, peerServerId: "peer-A", peerStkPub: peerSTKPub }));
    const rng = deterministicRandom();
    const sched = new ProofOfStorageScheduler({
      registry: reg,
      source: honestSource(shards),
      issuerFor: () =>
        honestPeerIssuer(shards, { privateKey: wrongSTKPriv, publicKey: ed.getPublicKey(wrongSTKPriv) }),
      now: () => 1,
      ...rng,
    });
    const result = await sched.sweepOnce();
    expect(result.failed).toBe(1);
    expect(reg.myShards()[0]!.challengeStreak).toBe(1);
  });
});

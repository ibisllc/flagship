import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { deriveSTK, deriveSWK } from "@flagship/protocol";
import { BackupLoop } from "../src/backupLoop.js";
import { InMemoryShardRegistry } from "../src/peerBackup/registry.js";
import { InMemoryShardBytesStore } from "../src/peerBackup/shardStore.js";
import { InMemoryManifestStore, uploadBackupManifest } from "../src/peerBackup/manifest.js";
import {
  handlePbFramesRequest,
  type PbFramesHandlerOptions,
} from "../src/peerBackup/httpPeerLink.js";
import { buildHttpShardPusher } from "../src/peerBackup/shipper.js";
import {
  buildRestorePoller,
  fsRestoreSink,
  runRestoreOnce,
  type RestoreProgress,
} from "../src/peerBackup/restore.js";

// ── World: one owner box, 5 peer boxes, a fake .com manifest lane. ────
// Backup runs on "box A", restore runs on a FRESH "box B" with nothing
// but the re-derived SWK — the migration phase-3 pre-seed, end to end
// through the REAL HttpPeerLink transport + verbatim PeerBackupServer.

const OWNER = "home.alice.flagship.services";
const umk = { seed: new Uint8Array(32).fill(21) };
const swk = deriveSWK(umk, OWNER);
const ownerSTK = deriveSTK(swk);

const PEER_IDS = ["attic", "garage", "closet", "shed", "loft"].map(
  (n) => `${n}.alice.flagship.services`,
);

interface World {
  fetchImpl: typeof fetch;
  peers: Map<string, { store: InMemoryShardBytesStore; registry: InMemoryShardRegistry }>;
  comManifest: { ciphertextHex: string; nonceHex: string; generation: number } | null;
  downPeers: Set<string>;
  shardFetches: number;
}

function makeWorld(): World {
  const peers = new Map<string, { store: InMemoryShardBytesStore; registry: InMemoryShardRegistry }>();
  const peerSTKs = new Map(PEER_IDS.map((id) => [id, deriveSTK(deriveSWK(umk, id))]));
  for (const id of PEER_IDS) peers.set(id, { store: new InMemoryShardBytesStore(), registry: new InMemoryShardRegistry() });

  const world: World = {
    peers,
    comManifest: null,
    downPeers: new Set(),
    shardFetches: 0,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      // fake .com manifest lane
      if (u.pathname === `/api/server/${encodeURIComponent(OWNER)}/backup-manifest`) {
        if (init?.method === "PUT") {
          const b = JSON.parse(String(init.body)) as { ciphertextHex: string; nonceHex: string; generation: number };
          world.comManifest = { ciphertextHex: b.ciphertextHex, nonceHex: b.nonceHex, generation: b.generation };
          return new Response(JSON.stringify({ stored: true }), { status: 200 });
        }
        if (!world.comManifest) return new Response(JSON.stringify({ error: "no manifest" }), { status: 404 });
        return new Response(JSON.stringify(world.comManifest), { status: 200 });
      }
      // box↔box frames
      if (u.pathname === "/api/peer-backup/frames") {
        const peerId = u.hostname;
        if (world.downPeers.has(peerId)) throw new Error(`ECONNREFUSED ${peerId}`);
        const peer = world.peers.get(peerId);
        if (!peer) return new Response("not found", { status: 404 });
        world.shardFetches += 1;
        const opts: PbFramesHandlerOptions = {
          myServerId: peerId,
          mySTK: peerSTKs.get(peerId)!,
          store: peer.store,
          registry: peer.registry,
          resolveCallerStk: (sid) => (sid === OWNER ? ownerSTK.publicKey : null),
        };
        const body = JSON.parse(String(init?.body)) as Parameters<typeof handlePbFramesRequest>[1];
        const r = await handlePbFramesRequest(opts, body);
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      throw new Error(`unexpected fetch ${u.href}`);
    }) as typeof fetch,
  };
  return world;
}

const FILES = [
  { path: "postgres/dump.sql", content: new TextEncoder().encode("CREATE TABLE t (id int);\n".repeat(500)) },
  { path: "minio/blob.bin", content: new Uint8Array(50_000).map((_, i) => (i * 131) % 256) },
  { path: "config/tiny.json", content: new TextEncoder().encode(`{"a":1}`) },
];

async function backupOnBoxA(world: World) {
  const loop = new BackupLoop({
    swk,
    k: 3,
    n: 5,
    initiallyEnabled: true,
    shipping: {
      myServerId: OWNER,
      peerProvider: {
        async requestPeers(args) {
          return PEER_IDS.slice(0, args.n).map((id) => ({
            serverId: id,
            stkPub: deriveSTK(deriveSWK(umk, id)).publicKey,
          }));
        },
      },
      pusher: buildHttpShardPusher({ myServerId: OWNER, mySTK: ownerSTK, fetchImpl: world.fetchImpl, timeoutMs: 2000 }),
      registry: new InMemoryShardRegistry(),
      ownShards: new InMemoryShardBytesStore(),
      manifestStore: new InMemoryManifestStore(),
      uploadManifest: (m) =>
        uploadBackupManifest(
          { controlPlaneBaseUrl: "https://flagshipserver.com", serverId: OWNER, mySTK: ownerSTK, swk, fetchImpl: world.fetchImpl },
          m,
        ),
    },
  });
  const report = await loop.runOnce(FILES, 7777);
  expect(report.shardsPlaced).toBe(15);
  expect(report.manifestUploaded).toBe(true);
  return report;
}

function freshBoxB(world: World, over: { swk?: Uint8Array } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pb-restore-"));
  const progress: RestoreProgress[] = [];
  const opts = {
    serverId: OWNER,
    swk: over.swk ?? swk, // deriveSWK(umk, serverId) — deterministic re-derivation
    mySTK: ownerSTK, // deriveSTK(swk) — same derivation on the replacement box
    controlPlaneBaseUrl: "https://flagshipserver.com",
    sink: fsRestoreSink(root),
    fetchImpl: world.fetchImpl,
    onProgress: (p: RestoreProgress) => progress.push(p),
  };
  return { root, opts, progress };
}

function expectFilesIdentical(root: string) {
  for (const f of FILES) {
    const got = new Uint8Array(readFileSync(join(root, f.path)));
    expect(Buffer.from(sha256(got)).toString("hex")).toBe(Buffer.from(sha256(f.content)).toString("hex"));
    expect(got.length).toBe(f.content.length);
  }
}

describe("peer-backup restore on a fresh box", () => {
  it("full round-trip: backup on A → restore on fresh B → byte-identical files", async () => {
    const world = makeWorld();
    await backupOnBoxA(world);

    const b = freshBoxB(world);
    const outcome = await runRestoreOnce(b.opts);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    expect(outcome.report.restored).toBe(3);
    expect(outcome.report.skipped).toBe(0);
    expect(outcome.report.failed).toEqual([]);
    expect(outcome.report.bytesWritten).toBe(FILES.reduce((n, f) => n + f.content.length, 0));
    expectFilesIdentical(b.root);
    // Honest progress: monotone chunksDone ending at total.
    expect(b.progress.at(-1)!.chunksDone).toBe(3);
    expect(b.progress.at(-1)!.currentPath).toBeNull();
  });

  it("restores with only k of n peers reachable", async () => {
    const world = makeWorld();
    await backupOnBoxA(world);
    world.downPeers.add(PEER_IDS[3]!);
    world.downPeers.add(PEER_IDS[4]!);

    const b = freshBoxB(world);
    const outcome = await runRestoreOnce(b.opts);
    expect(outcome.status).toBe("complete");
    expectFilesIdentical(b.root);
  });

  it("fails cleanly (no partial garbage) when fewer than k shards are retrievable", async () => {
    const world = makeWorld();
    await backupOnBoxA(world);
    for (const id of PEER_IDS.slice(0, 3)) world.downPeers.add(id); // only 2 of 5 left

    const b = freshBoxB(world);
    const outcome = await runRestoreOnce(b.opts);
    expect(outcome.status).toBe("partial");
    if (outcome.status !== "partial") throw new Error("unreachable");
    expect(outcome.report.restored).toBe(0);
    expect(outcome.report.failed).toHaveLength(3);
    expect(outcome.report.failed[0]!.reason).toMatch(/only 2 of 3 required shards/);
    // Nothing written — not even tmp files.
    expect(existsSync(join(b.root, FILES[0]!.path))).toBe(false);
    expect(readdirSync(b.root)).toEqual([]);
  });

  it("a corrupt shard is detected by the manifest hash and routed around", async () => {
    const world = makeWorld();
    await backupOnBoxA(world);

    // Tamper: flip bytes of every shard held by the first peer.
    const attic = world.peers.get(PEER_IDS[0]!)!;
    const logs: string[] = [];
    for (const row of attic.registry.theirShards()) {
      const bytes = attic.store.get(row.encChunkId, row.shardIndex)!;
      bytes[0] = bytes[0]! ^ 0xff;
      attic.store.put(row.encChunkId, row.shardIndex, bytes);
    }

    const b = freshBoxB(world);
    const outcome = await runRestoreOnce({ ...b.opts, onLog: (m) => logs.push(m) });
    expect(outcome.status).toBe("complete"); // other 4 peers carry ≥ k shards
    expectFilesIdentical(b.root);
    expect(logs.some((l) => l.includes("corrupt"))).toBe(true);
  });

  it("is idempotent + resumable: a second run skips everything and fetches nothing", async () => {
    const world = makeWorld();
    await backupOnBoxA(world);

    const b = freshBoxB(world);
    expect((await runRestoreOnce(b.opts)).status).toBe("complete");

    const fetchesAfterFirst = world.shardFetches;
    const again = await runRestoreOnce(b.opts);
    expect(again.status).toBe("complete");
    if (again.status !== "complete") throw new Error("unreachable");
    expect(again.report.skipped).toBe(3);
    expect(again.report.restored).toBe(0);
    expect(world.shardFetches).toBe(fetchesAfterFirst); // zero new shard traffic

    // Partial resume: a run interrupted after some chunks (simulated by a
    // fresh root where one file already landed) only fetches the rest.
    const c = freshBoxB(world);
    await c.opts.sink.writeFile(FILES[1]!.path, FILES[1]!.content);
    const resumed = await runRestoreOnce(c.opts);
    expect(resumed.status).toBe("complete");
    if (resumed.status !== "complete") throw new Error("unreachable");
    expect(resumed.report.skipped).toBe(1);
    expect(resumed.report.restored).toBe(2);
    expectFilesIdentical(c.root);
  });

  it("wrong SWK → clean failure before ANY file is touched", async () => {
    const world = makeWorld();
    await backupOnBoxA(world);

    const wrongSwk = deriveSWK({ seed: new Uint8Array(32).fill(99) }, OWNER);
    const framesBefore = world.shardFetches; // backup's own pushes
    const b = freshBoxB(world, { swk: wrongSwk });
    const outcome = await runRestoreOnce(b.opts);
    // The manifest itself refuses to open under the wrong key — restore
    // aborts before a single shard is fetched or a single byte written.
    expect(outcome.status).toBe("error");
    expect(readdirSync(b.root)).toEqual([]);
    expect(world.shardFetches).toBe(framesBefore);
  });

  it("poller: no-manifest → keeps polling; complete → stops itself", async () => {
    const world = makeWorld();
    const b = freshBoxB(world);
    const poller = buildRestorePoller({ ...b.opts, intervalMs: 60_000 });
    expect((await poller.pollOnce()).status).toBe("no-manifest");

    await backupOnBoxA(world);
    let completed = 0;
    const poller2 = buildRestorePoller({
      ...b.opts,
      intervalMs: 60_000,
      onComplete: () => {
        completed += 1;
      },
    });
    const outcome = await poller2.pollOnce();
    expect(outcome.status).toBe("complete");
    expect(completed).toBe(1);
    expectFilesIdentical(b.root);
    poller.stop();
    poller2.stop();
  });

  it("fsRestoreSink refuses a path that escapes the restore root", async () => {
    const sink = fsRestoreSink(mkdtempSync(join(tmpdir(), "pb-sink-")));
    await expect(sink.writeFile("../evil", new Uint8Array([1]))).rejects.toThrow(/escapes restore root/);
  });
});

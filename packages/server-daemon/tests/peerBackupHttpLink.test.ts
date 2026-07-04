import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { deriveSTK, deriveSWK, type Keypair } from "@flagship/protocol";
import {
  PB_FRAMES_PATH,
  createHttpPeerLink,
  handlePbFramesRequest,
  type PbFramesHandlerOptions,
} from "../src/peerBackup/httpPeerLink.js";
import { InMemoryShardBytesStore } from "../src/peerBackup/shardStore.js";
import { InMemoryShardRegistry } from "../src/peerBackup/registry.js";
import { PeerBackupClient } from "../src/peerBackup/transport.js";

const OWNER = "home.alice.flagship.services";
const PEER = "attic.alice.flagship.services";
const STRANGER = "home.eve.flagship.services";

const ownerSTK = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(11) }, OWNER));
const peerSTK = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(22) }, PEER));
const strangerSTK = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(33) }, STRANGER));

const DIRECTORY: Record<string, Uint8Array> = {
  [OWNER]: ownerSTK.publicKey,
  [PEER]: peerSTK.publicKey,
  [STRANGER]: strangerSTK.publicKey,
};

/** In-proc HTTP: fetch hands the JSON body straight to the peer's handler. */
function fetchToHandler(opts: PbFramesHandlerOptions): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toContain(PB_FRAMES_PATH);
    const body = JSON.parse(String(init?.body)) as Parameters<typeof handlePbFramesRequest>[1];
    const r = await handlePbFramesRequest(opts, body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

function peerHandler(over: Partial<PbFramesHandlerOptions> = {}) {
  const store = new InMemoryShardBytesStore();
  const registry = new InMemoryShardRegistry();
  const accepted: { sizeBytes: number; ownerServerId: string }[] = [];
  const opts: PbFramesHandlerOptions = {
    myServerId: PEER,
    mySTK: peerSTK,
    store,
    registry,
    resolveCallerStk: (sid) => DIRECTORY[sid] ?? null,
    onShardAccepted: (i) => accepted.push({ sizeBytes: i.sizeBytes, ownerServerId: i.ownerServerId }),
    ...over,
  };
  return { store, registry, accepted, opts };
}

function client(opts: PbFramesHandlerOptions, over: { mySTK?: Keypair; myServerId?: string } = {}) {
  const link = createHttpPeerLink({
    peerBaseUrl: `https://${PEER}`,
    remoteServerId: PEER,
    myServerId: over.myServerId ?? OWNER,
    mySTK: over.mySTK ?? ownerSTK,
    fetchImpl: fetchToHandler(opts),
  });
  return new PeerBackupClient(link, over.mySTK ?? ownerSTK, over.myServerId ?? OWNER);
}

const enc = sha256(new Uint8Array([1, 2, 3]));
const SHARD = new Uint8Array(150_000).map((_, i) => (i * 7) % 256);

describe("HttpPeerLink against a verbatim PeerBackupServer", () => {
  it("PUT streams over one signed POST, stores, records their_shards, ACKs", async () => {
    const { store, registry, accepted, opts } = peerHandler();
    const c = client(opts);
    const r = await c.putShard({ encChunkId: enc, shardIndex: 2, bytes: SHARD, peerServerId: PEER });
    expect(r).toEqual({ ok: true });
    expect(Array.from(store.get(enc, 2)!)).toEqual(Array.from(SHARD));
    const row = registry.theirShard(enc, 2)!;
    expect(row.ownerServerId).toBe(OWNER);
    expect(Array.from(row.ownerStkPub)).toEqual(Array.from(ownerSTK.publicKey));
    expect(row.sizeBytes).toBe(SHARD.length);
    expect(accepted).toEqual([{ sizeBytes: SHARD.length, ownerServerId: OWNER }]);
  });

  it("GET round-trips the shard back to the owner", async () => {
    const { opts } = peerHandler();
    const c = client(opts);
    await c.putShard({ encChunkId: enc, shardIndex: 0, bytes: SHARD, peerServerId: PEER });
    const r = await c.getShard({ encChunkId: enc, shardIndex: 0 });
    expect(r.ok).toBe(true);
    expect(Array.from(r.bytes!)).toEqual(Array.from(SHARD));
  });

  it("CHALLENGE returns a peer-STK-signed proof over the requested window", async () => {
    const { opts } = peerHandler();
    const c = client(opts);
    await c.putShard({ encChunkId: enc, shardIndex: 1, bytes: SHARD, peerServerId: PEER });
    const nonce = new Uint8Array(32).fill(9);
    const r = await c.challenge({ encChunkId: enc, shardIndex: 1, nonce, offset: 64, length: 1024 });
    expect(r.ok).toBe(true);
    const window = SHARD.slice(64, 64 + 1024);
    const concat = new Uint8Array(nonce.length + window.length);
    concat.set(nonce, 0);
    concat.set(window, nonce.length);
    expect(r.hash).toBe(Buffer.from(sha256(concat)).toString("hex"));
  });

  it("a caller unknown to the directory is rejected before any frame runs", async () => {
    const { store, opts } = peerHandler({ resolveCallerStk: () => null });
    const errors: unknown[] = [];
    const link = createHttpPeerLink({
      peerBaseUrl: `https://${PEER}`,
      remoteServerId: PEER,
      myServerId: OWNER,
      mySTK: ownerSTK,
      fetchImpl: fetchToHandler(opts),
      onError: (e) => errors.push(e),
    });
    const c = new PeerBackupClient(link, ownerSTK, OWNER);
    const put = c.putShard({ encChunkId: enc, shardIndex: 0, bytes: SHARD, peerServerId: PEER });
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 50));
    expect(await Promise.race([put, timeout])).toBe("timeout"); // no ACK ever arrives
    expect(errors.length).toBe(1);
    expect(store.get(enc, 0)).toBeUndefined();
  });

  it("an envelope signed by the wrong STK is a 403", async () => {
    const { store, opts } = peerHandler();
    const errors: unknown[] = [];
    const link = createHttpPeerLink({
      peerBaseUrl: `https://${PEER}`,
      remoteServerId: PEER,
      myServerId: OWNER, // claims to be the owner…
      mySTK: strangerSTK, // …but signs with a different key
      fetchImpl: fetchToHandler(opts),
      onError: (e) => errors.push(e),
    });
    const c = new PeerBackupClient(link, strangerSTK, OWNER);
    void c.getShard({ encChunkId: enc, shardIndex: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("403");
    expect(store.get(enc, 0)).toBeUndefined();
  });

  it("a stale envelope is rejected (replay window)", async () => {
    const { opts } = peerHandler({ now: () => 10_000_000 });
    const errors: unknown[] = [];
    const link = createHttpPeerLink({
      peerBaseUrl: `https://${PEER}`,
      remoteServerId: PEER,
      myServerId: OWNER,
      mySTK: ownerSTK,
      now: () => 10_000_000 - 6 * 60_000,
      fetchImpl: fetchToHandler(opts),
      onError: (e) => errors.push(e),
    });
    const c = new PeerBackupClient(link, ownerSTK, OWNER);
    void c.getShard({ encChunkId: enc, shardIndex: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(String(errors[0])).toContain("403");
  });

  it("a forged inner PUT signature is rejected by the verbatim server (ok:false ACK)", async () => {
    // Envelope verifies as STRANGER (it IS a registered box), but the inner
    // PUT signature binds the owner serverId — PeerBackupServer verifies it
    // against the STRANGER's STK and refuses.
    const { store, opts } = peerHandler();
    const link = createHttpPeerLink({
      peerBaseUrl: `https://${PEER}`,
      remoteServerId: PEER,
      myServerId: STRANGER,
      mySTK: strangerSTK,
      fetchImpl: fetchToHandler(opts),
    });
    // Inner frames signed with the OWNER key (a stolen PUT replayed by eve).
    const c = new PeerBackupClient(link, ownerSTK, OWNER);
    const r = await c.putShard({ encChunkId: enc, shardIndex: 0, bytes: SHARD, peerServerId: PEER });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid signature");
    expect(store.get(enc, 0)).toBeUndefined();
  });

  it("GET/CHALLENGE are owner-scoped: a verified foreign box cannot read another owner's shard", async () => {
    const { opts } = peerHandler();
    // Owner deposits.
    await client(opts).putShard({ encChunkId: enc, shardIndex: 0, bytes: SHARD, peerServerId: PEER });
    // Eve (registered, valid envelope) tries to read it.
    const eve = client(opts, { mySTK: strangerSTK, myServerId: STRANGER });
    const r = await eve.getShard({ encChunkId: enc, shardIndex: 0 });
    // Peer answers with the "not held" empty-stream signal — no bytes leak.
    expect(r.bytes?.length ?? 0).toBe(0);
    const nonce = new Uint8Array(32).fill(1);
    const ch = eve.challenge({ encChunkId: enc, shardIndex: 0, nonce, offset: 0, length: 64 });
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 50));
    expect(await Promise.race([ch, timeout])).toBe("timeout"); // server stays silent
  });

  it("the owner CAN read back after a restart of the peer (registry re-load path)", async () => {
    const { registry, store, opts } = peerHandler();
    await client(opts).putShard({ encChunkId: enc, shardIndex: 3, bytes: SHARD, peerServerId: PEER });
    // Simulate restart: fresh handler over the SAME store+registry.
    const { opts: opts2 } = peerHandler();
    const r = await client({ ...opts2, store, registry }).getShard({ encChunkId: enc, shardIndex: 3 });
    expect(r.ok).toBe(true);
    expect(r.bytes!.length).toBe(SHARD.length);
  });
});

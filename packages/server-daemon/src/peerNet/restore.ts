/**
 * Bring an archive back from peers (docs/peer-backup.md §9). Needs only the
 * PBK, which any device of the account derives from the UMK: the root comes
 * from `.com`, the bricks from holders through the relay. Each brick is
 * decrypted and checked against its shard hash before Reed-Solomon sees it,
 * so a holder returning garbage costs a retry, never a wrong file.
 */
import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { decodeShards, derivePbBrickId, derivePbBrickKey, openPbRoot, type PbRoot } from "@flagship/protocol";
import { brickCrypt } from "./fastCrypto.js";
import { callHolder, fromHex, sha256Hex } from "./mailOps.js";
import type { PbComClient, PbMailTransport } from "./types.js";

export class PeerRestoreError extends Error {}

export interface PeerRestoreResult {
  dataPath: string;
  backupFile: string;
  archiveId: string;
  bytes: number;
  sha256: string;
  root: PbRoot;
}

export async function fetchPeerRoot(com: PbComClient, serverId: string, pbk: Uint8Array): Promise<PbRoot> {
  const sealed = await com.getRoot(serverId);
  if (!sealed) throw new PeerRestoreError("No peer backup of that server was found.");
  try {
    return openPbRoot(sealed, pbk, serverId);
  } catch {
    throw new PeerRestoreError("The peer backup record doesn't open with this account's key.");
  }
}

/** Fetch `k` good shards of one segment, trying members in order. */
async function fetchSegment(
  root: PbRoot,
  pbk: Uint8Array,
  transport: PbMailTransport,
  seg: number,
  shardHash: (shard: number) => string,
  now: () => number,
  bad: Set<string>,
): Promise<Uint8Array> {
  const net = root.network;
  const stripe = root.stripes[seg % root.stripes.length]!;
  const got: Array<Uint8Array | null> = new Array<Uint8Array | null>(net.n).fill(null);
  let have = 0;
  // Data shards first: decoding them is a copy.
  for (let i = 0; i < net.n && have < net.k; i++) {
    const m = stripe[i]!;
    if (bad.has(m.pikPubHex)) continue;
    const brickId = derivePbBrickId(pbk, root.generation, seg, i, m.rev);
    try {
      const r = await callHolder(transport, m, {
        op: "brick.get",
        leaseId: m.leaseId,
        leaseKeySeed: fromHex(m.leaseKeySeedHex),
        args: { brickId },
        now: now(),
      });
      if (r.body.length !== net.brickBytes) continue;
      const shard = brickCrypt(derivePbBrickKey(pbk, brickId), r.body);
      if (sha256Hex(shard) !== shardHash(i)) continue;
      got[i] = shard;
      have++;
    } catch {
      // Unreachable or refused: count on the others, and don't wait on it again.
      bad.add(m.pikPubHex);
    }
  }
  if (have < net.k) {
    throw new PeerRestoreError(`Only ${have} of the ${net.k} pieces needed for part ${seg + 1} could be fetched. Try again later.`);
  }
  return decodeShards(got, net.k, net.n, net.k * net.brickBytes);
}

export async function restoreFromPeers(a: {
  serverId: string;
  pbk: Uint8Array;
  com: PbComClient;
  transport: PbMailTransport;
  /** Where the data file goes. */
  outPath: string;
  /** Restore this root instead of the newest (a device picked an older revision). */
  root?: PbRoot;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}): Promise<PeerRestoreResult> {
  const now = a.now ?? Date.now;
  const root = a.root ?? (await fetchPeerRoot(a.com, a.serverId, a.pbk));
  const net = root.network;
  const segBytes = net.k * net.brickBytes;
  const bad = new Set<string>();
  // Members that fail on one segment are tried again on the next one.
  const fresh = () => {
    bad.clear();
    return bad;
  };

  const index = new Uint8Array(root.indexSegments * segBytes);
  for (let t = 0; t < root.indexSegments; t++) {
    const seg = root.segments + t;
    const plain = await fetchSegment(root, a.pbk, a.transport, seg, (i) => root.indexShardHashes[t * net.n + i] ?? "", now, fresh());
    index.set(plain, t * segBytes);
  }
  const hashOf = (seg: number, i: number) => Buffer.from(index.subarray((seg * net.n + i) * 32, (seg * net.n + i + 1) * 32)).toString("hex");

  const tmp = `${a.outPath}.partial`;
  const fh = await open(tmp, "w", 0o600);
  const sha = createHash("sha256");
  try {
    for (let s = 0; s < root.segments; s++) {
      const plain = await fetchSegment(root, a.pbk, a.transport, s, (i) => hashOf(s, i), now, fresh());
      const len = Math.min(segBytes, root.payloadBytes - s * segBytes);
      const part = plain.subarray(0, len);
      await fh.write(part, 0, part.length, s * segBytes);
      sha.update(part);
      a.onProgress?.(s + 1, root.segments);
    }
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.sync();
  await fh.close();
  const digest = sha.digest("hex");
  if (digest !== root.archive.sha256) {
    await rm(tmp, { force: true });
    throw new PeerRestoreError("The backup put together from peers doesn't match its checksum.");
  }
  await rename(tmp, a.outPath);
  return { dataPath: a.outPath, backupFile: root.archive.backupFile, archiveId: root.archive.archiveId, bytes: root.payloadBytes, sha256: digest, root };
}

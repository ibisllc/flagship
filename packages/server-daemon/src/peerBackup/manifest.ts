import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import {
  openBackupManifest,
  sealBackupManifest,
  signPbManifestDeposit,
  type Bytes,
  type Keypair,
  type PbManifestDeposit,
} from "@flagship/protocol";

// ──────────────────────────────────────────────────────────────────────
// Backup manifest — the owner box's map of chunk → shard placements.
//
// This is the recovery ROOT: a fresh replacement box knows nothing but
// its recipe; with the manifest (fetched from .com, opened with the
// re-derived SWK) it knows every chunk's decrypt parameters and which
// peer holds which shard. Everything a peer/.com ever sees of it is
// ciphertext; the plaintext (which includes per-chunk plaintext hashes)
// exists only on the box's own encrypted disk and in the sealed blob.
// ──────────────────────────────────────────────────────────────────────

export interface ManifestPlacement {
  shardIndex: number;
  peerServerId: string;
  peerStkPubHex: string;
  /** sha256 of the shard bytes — lets restore reject a corrupt shard BEFORE decode. */
  shardSha256Hex: string;
}

export interface ManifestChunk {
  /** Logical file path relative to the backup root. */
  path: string;
  /** sha256(plaintext), hex — also the decrypt contentHash (chunk-key salt). */
  chunkIdHex: string;
  /** sha256(ciphertext), hex — the peer-visible chunk identity. */
  encChunkIdHex: string;
  /** Chunk GCM nonce, hex. */
  nonceHex: string;
  /** Ciphertext length — decodeShards needs it to trim shard padding. */
  ciphertextLength: number;
  plainLength: number;
  k: number;
  n: number;
  placements: ManifestPlacement[];
}

export interface BackupManifest {
  version: 1;
  serverId: string;
  /** Monotonic — bumped on every backup run that changes anything. */
  generation: number;
  updatedAt: number;
  chunks: ManifestChunk[];
}

export function emptyManifest(serverId: string): BackupManifest {
  return { version: 1, serverId, generation: 0, updatedAt: 0, chunks: [] };
}

/** True iff the chunk has >= k distinct shard indices placed on peers. */
export function chunkIsRestorable(chunk: ManifestChunk): boolean {
  return new Set(chunk.placements.map((p) => p.shardIndex)).size >= chunk.k;
}

export interface ManifestStore {
  load(): BackupManifest | null;
  save(m: BackupManifest): void;
}

/** Local snapshot, plaintext on the box's own (encrypted) disk. */
export class FileManifestStore implements ManifestStore {
  constructor(private readonly path: string) {}

  load(): BackupManifest | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as BackupManifest;
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  save(m: BackupManifest): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class InMemoryManifestStore implements ManifestStore {
  private m: BackupManifest | null = null;
  load(): BackupManifest | null {
    return this.m ? (JSON.parse(JSON.stringify(this.m)) as BackupManifest) : null;
  }
  save(m: BackupManifest): void {
    this.m = JSON.parse(JSON.stringify(m)) as BackupManifest;
  }
}

// ──────────────────────────────────────────────────────────────────────
// .com upload / fetch (sealed; STK-signed deposit)
// ──────────────────────────────────────────────────────────────────────

export interface ManifestComClientOptions {
  controlPlaneBaseUrl: string;
  serverId: string;
  fetchImpl?: typeof fetch;
}

export async function uploadBackupManifest(
  opts: ManifestComClientOptions & { mySTK: Keypair; swk: Bytes },
  manifest: BackupManifest,
): Promise<{ ok: boolean; reason?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
  const sealed = sealBackupManifest(plaintext, opts.swk);
  const deposit: PbManifestDeposit = {
    serverId: opts.serverId,
    generation: manifest.generation,
    updatedAt: manifest.updatedAt,
    ciphertextSha256Hex: toHex(sha256(sealed.ciphertext)),
    nonceHex: toHex(sealed.nonce),
  };
  const signature = signPbManifestDeposit(deposit, opts.mySTK);
  try {
    const res = await fetchImpl(
      `${opts.controlPlaneBaseUrl}/api/server/${encodeURIComponent(opts.serverId)}/backup-manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generation: deposit.generation,
          updatedAt: deposit.updatedAt,
          ciphertextHex: toHex(sealed.ciphertext),
          nonceHex: deposit.nonceHex,
          signatureHex: toHex(signature),
        }),
      },
    );
    if (res.status === 409) {
      // A newer generation is already stored (e.g. the box restarted with
      // a stale local manifest). Not fatal — the stored one is newer.
      return { ok: false, reason: "stale generation" };
    }
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fetch + open the manifest with the (re-derived) SWK. `null` when .com
 * has none; throws on a wrong SWK (GCM auth failure) — the caller must
 * treat that as "abort, do not touch the data dir".
 */
export async function fetchBackupManifest(
  opts: ManifestComClientOptions & { swk: Bytes },
): Promise<BackupManifest | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${opts.controlPlaneBaseUrl}/api/server/${encodeURIComponent(opts.serverId)}/backup-manifest`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`manifest fetch failed: status ${res.status}`);
  const json = (await res.json()) as { ciphertextHex?: string; nonceHex?: string };
  if (typeof json.ciphertextHex !== "string" || typeof json.nonceHex !== "string") {
    throw new Error("malformed manifest response");
  }
  const plaintext = openBackupManifest(
    { ciphertext: fromHex(json.ciphertextHex), nonce: fromHex(json.nonceHex) },
    opts.swk,
  );
  const manifest = JSON.parse(new TextDecoder().decode(plaintext)) as BackupManifest;
  if (manifest.version !== 1) throw new Error(`unsupported manifest version`);
  return manifest;
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hexStr: string): Bytes {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}

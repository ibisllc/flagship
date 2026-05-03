import type { Bytes } from "./types.js";
import { gfAdd, gfDiv, gfMul, gfPow } from "./gf256.js";

/**
 * Systematic Reed-Solomon over GF(2^8).
 *
 * Given K data shards and N total shards, produces (N - K) parity shards such
 * that ANY K of the N shards reconstruct the original data. Storage overhead
 * is N/K — for the canonical 10-of-16 configuration, that's 1.6x.
 *
 * Construction: Vandermonde generator matrix G of shape N×K where row i is
 * (i^0, i^1, ..., i^(K-1)) over GF(2^8). The first K rows are the identity
 * (so the systematic property holds — first K shards == data shards). The
 * remaining N-K rows are the parity rows.
 *
 * Decoding: pick any K surviving shards' rows from G; invert that K×K
 * submatrix; multiply against surviving shards. Done.
 */

export interface Shards {
  k: number;
  n: number;
  /** Length of original data (so decode can trim padding). */
  dataLength: number;
  shards: Bytes[];
}

const MAX_N = 256; // GF(2^8) gives at most 256 distinct rows

export function encodeShards(data: Bytes, k: number, n: number): Shards {
  validateKN(k, n);
  if (k === 1) {
    // Trivial case: N-way replication.
    const shards: Bytes[] = [];
    for (let i = 0; i < n; i++) shards.push(new Uint8Array(data));
    return { k, n, dataLength: data.length, shards };
  }

  const shardLen = Math.ceil(data.length / k);
  // Pad data to k * shardLen with zero bytes.
  const padded = new Uint8Array(shardLen * k);
  padded.set(data, 0);

  const shards: Bytes[] = [];
  // Data shards: first K shards are slices of the padded data.
  for (let i = 0; i < k; i++) {
    const slice = new Uint8Array(shardLen);
    slice.set(padded.subarray(i * shardLen, (i + 1) * shardLen));
    shards.push(slice);
  }
  // Parity shards: row index r in the generator matrix has elements
  // (r+1)^0, (r+1)^1, ..., (r+1)^(K-1). Rows are 1-indexed to avoid the
  // identity overlap and ensure K linearly-independent surviving shard rows.
  for (let r = 0; r < n - k; r++) {
    const x = r + 1;
    const parity = new Uint8Array(shardLen);
    for (let j = 0; j < k; j++) {
      const coeff = gfPow(x, j);
      const dataShard = shards[j]!;
      for (let b = 0; b < shardLen; b++) {
        parity[b] = gfAdd(parity[b]!, gfMul(coeff, dataShard[b]!));
      }
    }
    shards.push(parity);
  }
  return { k, n, dataLength: data.length, shards };
}

export function decodeShards(
  recovered: ReadonlyArray<Bytes | null>,
  k: number,
  n: number,
  dataLength: number,
): Bytes {
  validateKN(k, n);
  if (recovered.length !== n) {
    throw new Error(`recovered.length ${recovered.length} != n ${n}`);
  }

  if (k === 1) {
    for (const s of recovered) {
      if (s) return new Uint8Array(s);
    }
    throw new Error("All shards lost — cannot recover");
  }

  // Pick any K surviving shards.
  const indices: number[] = [];
  const survivors: Bytes[] = [];
  for (let i = 0; i < n && indices.length < k; i++) {
    const s = recovered[i];
    if (s !== null && s !== undefined) {
      indices.push(i);
      survivors.push(s);
    }
  }
  if (indices.length < k) {
    throw new Error(`need at least ${k} shards, got ${indices.length}`);
  }
  const shardLen = survivors[0]!.length;
  for (const s of survivors) {
    if (s.length !== shardLen) throw new Error("shards have inconsistent length");
  }

  // Build the K×K submatrix M where M[r][j] is the j-th coefficient of the
  // generator row corresponding to the r-th surviving shard.
  //   - If indices[r] < k, that shard is a data shard: row is identity (j == indices[r]).
  //   - If indices[r] >= k, that shard is parity row (indices[r] - k + 1)^j.
  const m: number[][] = [];
  for (let r = 0; r < k; r++) {
    const row: number[] = new Array(k).fill(0);
    if (indices[r]! < k) {
      row[indices[r]!] = 1;
    } else {
      const x = indices[r]! - k + 1;
      for (let j = 0; j < k; j++) row[j] = gfPow(x, j);
    }
    m.push(row);
  }
  const inv = invertMatrix(m, k);

  // Multiply inv (K×K) by survivors (K shards) to get the K data shards.
  const out = new Uint8Array(dataLength);
  for (let r = 0; r < k; r++) {
    const dataShard = new Uint8Array(shardLen);
    for (let j = 0; j < k; j++) {
      const coeff = inv[r]![j]!;
      const s = survivors[j]!;
      for (let b = 0; b < shardLen; b++) {
        dataShard[b] = gfAdd(dataShard[b]!, gfMul(coeff, s[b]!));
      }
    }
    // Copy into out, respecting dataLength padding.
    const offset = r * shardLen;
    const len = Math.min(shardLen, dataLength - offset);
    if (len > 0) out.set(dataShard.subarray(0, len), offset);
  }
  return out;
}

function validateKN(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n)) throw new Error("k, n must be integers");
  if (k < 1) throw new Error("k must be >= 1");
  if (n < k) throw new Error("n must be >= k");
  if (n > MAX_N - 1) throw new Error(`n must be <= ${MAX_N - 1}`);
}

/** Gauss-Jordan inversion in GF(2^8). */
function invertMatrix(m: number[][], k: number): number[][] {
  const a: number[][] = m.map((row) => row.slice());
  const id: number[][] = [];
  for (let r = 0; r < k; r++) {
    const row = new Array(k).fill(0);
    row[r] = 1;
    id.push(row);
  }
  for (let col = 0; col < k; col++) {
    // Find pivot
    let pivot = -1;
    for (let r = col; r < k; r++) {
      if (a[r]![col] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) throw new Error("matrix is singular — surviving shard set has dependencies");
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [id[col], id[pivot]] = [id[pivot]!, id[col]!];
    }
    // Normalize pivot row to leading 1
    const pinv = a[col]![col]!;
    for (let j = 0; j < k; j++) {
      a[col]![j] = gfDiv(a[col]![j]!, pinv);
      id[col]![j] = gfDiv(id[col]![j]!, pinv);
    }
    // Eliminate the pivot column from all other rows
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < k; j++) {
        a[r]![j] = gfAdd(a[r]![j]!, gfMul(factor, a[col]![j]!));
        id[r]![j] = gfAdd(id[r]![j]!, gfMul(factor, id[col]![j]!));
      }
    }
  }
  return id;
}

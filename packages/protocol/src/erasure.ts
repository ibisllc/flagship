import type { Bytes } from "./types.js";
import { gfAdd, gfDiv, gfMul } from "./gf256.js";

/**
 * Systematic Reed-Solomon over GF(2^8).
 *
 * Given K data shards and N total shards, produces (N - K) parity shards such
 * that ANY K of the N shards reconstruct the original data.
 *
 * Generator: the first K rows are the identity (the first K shards are the
 * data), and parity row r is the Cauchy row c[r][j] = 1 / (x_r + y_j) with
 * x_r = K + r and y_j = j. Every square submatrix of a Cauchy matrix is
 * invertible, so [I; C] is MDS for every K <= N <= 255.
 *
 * Until 2026-10-16 the parity rows were Vandermonde rows (r+1)^j. Identity
 * stacked on Vandermonde is NOT MDS in general: with K=4, N=8 the survivors
 * {2,4,5,6} were singular (docs/peer-backup.md §4). Shards made by that code
 * decode here only from their data shards.
 */

export interface Shards {
  k: number;
  n: number;
  /** Length of original data (so decode can trim padding). */
  dataLength: number;
  shards: Bytes[];
}

const MAX_N = 256;

const mulTables = new Map<number, Uint8Array>();
function mulTable(c: number): Uint8Array {
  let t = mulTables.get(c);
  if (!t) {
    t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) t[v] = gfMul(c, v);
    mulTables.set(c, t);
  }
  return t;
}

/** dst ^= c * src, bytewise. */
function mulAdd(dst: Uint8Array, src: Uint8Array, c: number): void {
  if (c === 0) return;
  const len = dst.length;
  if (c === 1) {
    for (let b = 0; b < len; b++) dst[b] = dst[b]! ^ src[b]!;
    return;
  }
  const t = mulTable(c);
  for (let b = 0; b < len; b++) dst[b] = dst[b]! ^ t[src[b]!]!;
}

/** Generator row for shard `index` (identity for data shards, Cauchy for parity). */
export function generatorRow(index: number, k: number): number[] {
  const row = new Array<number>(k).fill(0);
  if (index < k) {
    row[index] = 1;
    return row;
  }
  const x = index;
  for (let j = 0; j < k; j++) row[j] = gfDiv(1, gfAdd(x, j));
  return row;
}

export function encodeShards(data: Bytes, k: number, n: number): Shards {
  validateKN(k, n);
  if (k === 1) {
    const shards: Bytes[] = [];
    for (let i = 0; i < n; i++) shards.push(new Uint8Array(data));
    return { k, n, dataLength: data.length, shards };
  }

  const shardLen = Math.ceil(data.length / k);
  const padded = new Uint8Array(shardLen * k);
  padded.set(data, 0);

  const shards: Bytes[] = [];
  for (let i = 0; i < k; i++) {
    shards.push(padded.slice(i * shardLen, (i + 1) * shardLen));
  }
  for (let i = k; i < n; i++) {
    const row = generatorRow(i, k);
    const parity = new Uint8Array(shardLen);
    for (let j = 0; j < k; j++) mulAdd(parity, shards[j]!, row[j]!);
    shards.push(parity);
  }
  return { k, n, dataLength: data.length, shards };
}

/** Re-make one shard of a segment from its K data shards (repair without the others). */
export function encodeOneShard(dataShards: ReadonlyArray<Bytes>, index: number, k: number, n: number): Bytes {
  validateKN(k, n);
  if (dataShards.length !== k) throw new Error(`need the ${k} data shards`);
  if (index < 0 || index >= n) throw new Error("shard index out of range");
  if (k === 1) return new Uint8Array(dataShards[0]!);
  if (index < k) return new Uint8Array(dataShards[index]!);
  const row = generatorRow(index, k);
  const out = new Uint8Array(dataShards[0]!.length);
  for (let j = 0; j < k; j++) mulAdd(out, dataShards[j]!, row[j]!);
  return out;
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
      if (s) return new Uint8Array(s).subarray(0, dataLength);
    }
    throw new Error("All shards lost — cannot recover");
  }

  // Prefer data shards (no arithmetic for them), then parity.
  const indices: number[] = [];
  for (let i = 0; i < n && indices.length < k; i++) {
    if (recovered[i] !== null && recovered[i] !== undefined) indices.push(i);
  }
  if (indices.length < k) {
    throw new Error(`need at least ${k} shards, got ${indices.length}`);
  }
  const survivors = indices.map((i) => recovered[i]!);
  const shardLen = survivors[0]!.length;
  for (const s of survivors) {
    if (s.length !== shardLen) throw new Error("shards have inconsistent length");
  }

  const inv = invertMatrix(indices.map((i) => generatorRow(i, k)), k);
  const out = new Uint8Array(dataLength);
  for (let r = 0; r < k; r++) {
    const offset = r * shardLen;
    const len = Math.min(shardLen, dataLength - offset);
    if (len <= 0) continue;
    let dataShard: Uint8Array;
    if (indices[r] === r) {
      dataShard = survivors[r]!;
    } else {
      dataShard = new Uint8Array(shardLen);
      for (let j = 0; j < k; j++) mulAdd(dataShard, survivors[j]!, inv[r]![j]!);
    }
    out.set(dataShard.subarray(0, len), offset);
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
    const row = new Array<number>(k).fill(0);
    row[r] = 1;
    id.push(row);
  }
  for (let col = 0; col < k; col++) {
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
    const pinv = a[col]![col]!;
    for (let j = 0; j < k; j++) {
      a[col]![j] = gfDiv(a[col]![j]!, pinv);
      id[col]![j] = gfDiv(id[col]![j]!, pinv);
    }
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

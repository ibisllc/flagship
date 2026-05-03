/**
 * GF(2^8) arithmetic — the field used by Reed-Solomon for Flagship's
 * peer-backup erasure coding.
 *
 * Generator polynomial: 0x11d (x^8 + x^4 + x^3 + x^2 + 1).
 * Primitive element: 2 (alpha = 0x02).
 *
 * Implementation strategy: precomputed log/antilog tables make multiply,
 * inverse, divide all O(1).
 */

const PRIM_POLY = 0x11d;

const exp_ = new Uint8Array(512);
const log_ = new Uint8Array(256);

let acc = 1;
for (let i = 0; i < 255; i++) {
  exp_[i] = acc;
  log_[acc] = i;
  acc <<= 1;
  if (acc & 0x100) acc ^= PRIM_POLY;
}
// Wrap exp table to 512 entries so multiplications can index without modulo.
for (let i = 255; i < 512; i++) exp_[i] = exp_[i - 255]!;

export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return exp_[log_[a]! + log_[b]!]!;
}

export function gfDiv(a: number, b: number): number {
  if (a === 0) return 0;
  if (b === 0) throw new Error("GF(256) division by zero");
  // log[a] - log[b] mod 255, but we add 255 to keep it positive
  return exp_[(log_[a]! + 255 - log_[b]!) % 255]!;
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error("GF(256) inverse of zero");
  return exp_[(255 - log_[a]!) % 255]!;
}

export function gfPow(a: number, p: number): number {
  if (a === 0) return p === 0 ? 1 : 0;
  let lp = (log_[a]! * p) % 255;
  if (lp < 0) lp += 255;
  return exp_[lp]!;
}

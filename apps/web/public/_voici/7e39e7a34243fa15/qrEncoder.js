// Minimal QR code encoder — byte-mode, error-correction level L,
// auto-sized to fit. Returns an inline SVG string.
//
// Why hand-roll: every npm QR lib pulls in 30-60 KB of polyfills and
// historical baggage. The use case here is encoding a URL (from a short
// join link up to a ~600-byte signed transfer offer) into a scannable SVG
// rendered at a fixed size. The algorithm below covers exactly that path
// (byte mode, versions 1-40) and nothing more.
//
// Implementation is a tight port of the QR ISO/IEC 18004 byte-mode
// path: no dependencies, deterministic output. apps/web/tests/qrEncoder
// checks every version and level module-for-module against the `qrcode`
// package.
//
// Reference: ISO/IEC 18004:2015, §6 + §7.

const ECL_L = 0;
const ECL_M = 1;
const ECL_Q = 2;
const ECL_H = 3;

// All codewords (data + error correction) per version 1..40 (Table 1).
const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

// Error-correction blocks and EC codewords per block, per ECL (L, M, Q, H)
// and version 1..40 (Table 9). Data codewords split as evenly as possible:
// the last `total % blocks` blocks carry one more.
const EC_BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const EC_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const MAX_VERSION = 40;

/** [ecCodewordsPerBlock, blocksGroup1, dataCodewordsGroup1Block,
 *  blocksGroup2, dataCodewordsGroup2Block] for (version, ecl). */
function ecParams(version, ecl) {
  const total = TOTAL_CODEWORDS[version - 1];
  const blocks = EC_BLOCKS[ecl][version - 1];
  const ecPer = EC_PER_BLOCK[ecl][version - 1];
  const b2 = total % blocks;
  const d1 = Math.floor(total / blocks) - ecPer;
  return [ecPer, blocks - b2, d1, b2, d1 + 1];
}

function dataCapacity(version, ecl) {
  return TOTAL_CODEWORDS[version - 1] - EC_BLOCKS[ecl][version - 1] * EC_PER_BLOCK[ecl][version - 1];
}

function pickVersion(text, ecl) {
  const bytes = new TextEncoder().encode(text);
  for (let v = 1; v <= MAX_VERSION; v++) {
    const cap = dataCapacity(v, ecl);
    // Mode (4 bits) + length (8 bits for v1..v9, 16 bits for v10+)
    const lenBits = v >= 10 ? 16 : 8;
    const headerBytes = Math.ceil((4 + lenBits) / 8);
    if (bytes.length + headerBytes <= cap) return v;
  }
  throw new Error("QR text too long for version <= 40");
}

// ---- Bit stream ----

class BitStream {
  constructor() {
    this.bits = [];
  }
  pushBits(value, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.bits.push((value >> i) & 1);
    }
  }
  byteLength() { return Math.ceil(this.bits.length / 8); }
  toBytes() {
    const out = new Uint8Array(this.byteLength());
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    }
    return out;
  }
}

// ---- Reed-Solomon over GF(2^8) with QR's primitive 0x11D ----

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const out = new Uint8Array(data.length + ecLen);
  out.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = out[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      out[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return out.slice(data.length);
}

// ---- Module placement ----

function makeMatrix(size) {
  const m = [];
  for (let y = 0; y < size; y++) m.push(new Int8Array(size).fill(-1)); // -1 = unset
  return m;
}

function placeFinder(m, x0, y0) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= m.length || y >= m.length) continue;
      let on = 0;
      if (dx === -1 || dx === 7 || dy === -1 || dy === 7) on = 0;
      else if (dx === 0 || dx === 6 || dy === 0 || dy === 6) on = 1;
      else if (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) on = 1;
      else on = 0;
      m[y][x] = on;
    }
  }
}

function placeTiming(m) {
  const N = m.length;
  for (let i = 8; i < N - 8; i++) {
    if (m[6][i] === -1) m[6][i] = i % 2 === 0 ? 1 : 0;
    if (m[i][6] === -1) m[i][6] = i % 2 === 0 ? 1 : 0;
  }
}

function reserveFormat(m) {
  const N = m.length;
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][N - 1 - i] === -1) m[8][N - 1 - i] = 0;
    if (m[N - 1 - i][8] === -1) m[N - 1 - i][8] = 0;
  }
  m[N - 8][8] = 1; // dark module
}

/** Alignment-pattern centre rows/columns (Annex E): 6, the last at size-7,
 *  evenly spaced (even steps) between; version 32 is the table's exception. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = 17 + version * 4;
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const pos = [size - 7];
  for (let i = 1; i < count - 1; i++) pos.push(pos[i - 1] - step);
  pos.push(6);
  return pos.reverse();
}

// Version information (versions 7+): the version in 6 bits plus a BCH(18,6)
// remainder, in the two 6×3 blocks beside the top-right and bottom-left finders.
const VERSION_GEN = 0b1111100100101;
function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= VERSION_GEN << (i - 12);
  }
  return (version << 12) | rem;
}

function placeVersion(m, version) {
  if (version < 7) return;
  const N = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + N - 11;
    m[a][b] = bit;
    m[b][a] = bit;
  }
}

function placeAlignment(m, version) {
  const pos = alignmentPositions(version);
  if (pos.length === 0) return;
  for (const cy of pos) {
    for (const cx of pos) {
      // Skip if overlapping a finder.
      if ((cx === 6 && cy === 6) ||
          (cx === 6 && cy === pos[pos.length - 1]) ||
          (cx === pos[pos.length - 1] && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx, y = cy + dy;
          let on;
          if (dx === 0 && dy === 0) on = 1;
          else if (Math.abs(dx) === 2 || Math.abs(dy) === 2) on = 1;
          else on = 0;
          m[y][x] = on;
        }
      }
    }
  }
}

function placeData(m, bytes) {
  const N = m.length;
  let bitIdx = 0;
  let up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing
    for (let i = 0; i < N; i++) {
      const y = up ? N - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (m[y][x] === -1) {
          const bit = bitIdx < bytes.length * 8
            ? (bytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1
            : 0;
          m[y][x] = bit;
          bitIdx++;
        }
      }
    }
    up = !up;
  }
}

const MASK_FNS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, dataModules, maskIdx) {
  const fn = MASK_FNS[maskIdx];
  const out = m.map((row) => Int8Array.from(row));
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (dataModules[y][x] && fn(x, y)) {
        out[y][x] ^= 1;
      }
    }
  }
  return out;
}

const FORMAT_GEN = 0b10100110111;
function formatBits(ecl, mask) {
  const eclBits = [1, 0, 3, 2][ecl]; // L=01, M=00, Q=11, H=10
  let data = (eclBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= FORMAT_GEN << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function writeFormat(m, ecl, mask) {
  const N = m.length;
  const bits = formatBits(ecl, mask);
  for (let i = 0; i < 6; i++) m[i][8] = (bits >> i) & 1;
  m[7][8] = (bits >> 6) & 1;
  m[8][8] = (bits >> 7) & 1;
  m[8][7] = (bits >> 8) & 1;
  for (let i = 9; i < 15; i++) m[8][14 - i] = (bits >> i) & 1;

  for (let i = 0; i < 8; i++) m[8][N - 1 - i] = (bits >> i) & 1;
  for (let i = 8; i < 15; i++) m[N - 15 + i][8] = (bits >> i) & 1;
  m[N - 8][8] = 1;
}

function scoreMatrix(m) {
  const N = m.length;
  let s = 0;
  // Adjacent same-color
  for (let y = 0; y < N; y++) {
    let run = 1;
    for (let x = 1; x < N; x++) {
      if (m[y][x] === m[y][x - 1]) {
        run++;
        if (run === 5) s += 3;
        else if (run > 5) s += 1;
      } else run = 1;
    }
  }
  for (let x = 0; x < N; x++) {
    let run = 1;
    for (let y = 1; y < N; y++) {
      if (m[y][x] === m[y - 1][x]) {
        run++;
        if (run === 5) s += 3;
        else if (run > 5) s += 1;
      } else run = 1;
    }
  }
  return s;
}

// ---- Public API ----

export function encodeQr(text, eclLetter = "L") {
  const ecl = { L: ECL_L, M: ECL_M, Q: ECL_Q, H: ECL_H }[eclLetter] ?? ECL_L;
  const version = pickVersion(text, ecl);
  const size = 17 + version * 4;
  const [ecPerBlock, b1, d1, b2, d2] = ecParams(version, ecl);
  const totalData = dataCapacity(version, ecl);

  const bytes = new TextEncoder().encode(text);
  const bs = new BitStream();
  bs.pushBits(0b0100, 4); // byte mode
  bs.pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) bs.pushBits(b, 8);
  bs.pushBits(0, Math.min(4, totalData * 8 - bs.bits.length));
  while (bs.bits.length % 8 !== 0) bs.pushBits(0, 1);
  const filled = bs.toBytes();
  const data = new Uint8Array(totalData);
  data.set(filled);
  for (let i = filled.length, pad = 0; i < totalData; i++) {
    data[i] = pad === 0 ? 0xEC : 0x11;
    pad = 1 - pad;
  }

  // Split into blocks + interleave.
  const blocks = [];
  let off = 0;
  for (let i = 0; i < b1; i++) {
    const slice = data.slice(off, off + d1);
    blocks.push({ data: slice, ec: rsEncode(slice, ecPerBlock) });
    off += d1;
  }
  for (let i = 0; i < b2; i++) {
    const slice = data.slice(off, off + d2);
    blocks.push({ data: slice, ec: rsEncode(slice, ecPerBlock) });
    off += d2;
  }
  const interleavedData = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) {
      if (i < blk.data.length) interleavedData.push(blk.data[i]);
    }
  }
  const interleavedEc = [];
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of blocks) interleavedEc.push(blk.ec[i]);
  }
  const all = new Uint8Array(interleavedData.length + interleavedEc.length);
  all.set(interleavedData, 0);
  all.set(interleavedEc, interleavedData.length);

  // Build matrix.
  const m = makeMatrix(size);
  placeFinder(m, 0, 0);
  placeFinder(m, size - 7, 0);
  placeFinder(m, 0, size - 7);
  placeAlignment(m, version);
  placeTiming(m);
  reserveFormat(m);
  placeVersion(m, version);

  // Track which modules are data (vs function-pattern).
  const dataMask = m.map((row) => row.map((v) => v === -1 ? 1 : 0));
  placeData(m, all);

  // Try all 8 masks; pick lowest penalty.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(m, dataMask, mask);
    writeFormat(masked, ecl, mask);
    const s = scoreMatrix(masked);
    if (!best || s < best.score) best = { mask: masked, score: s };
  }
  return best.mask.map((row) => Array.from(row));
}

export function renderQrSvg(text, opts = {}) {
  const ecl = opts.ecl || "L";
  const size = opts.size || 240;
  const fg = opts.foreground || "#000";
  const bg = opts.background || "transparent";
  const matrix = encodeQr(text, ecl);
  const N = matrix.length;
  const quiet = 2;
  const totalCells = N + quiet * 2;
  const cell = size / totalCells;
  let rects = "";
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (matrix[y][x] === 1) {
        const px = (x + quiet) * cell;
        const py = (y + quiet) * cell;
        rects += `<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${fg}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code">` +
    (bg !== "transparent" ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : "") +
    rects +
    `</svg>`;
}

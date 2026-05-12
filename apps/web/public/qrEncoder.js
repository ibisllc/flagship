// Minimal QR code encoder — byte-mode, error-correction level L,
// auto-sized to fit. Returns an inline SVG string.
//
// Why hand-roll: every npm QR lib pulls in 30-60 KB of polyfills and
// historical baggage. The single use case here is encoding a short
// URL (well under 100 chars) into a scannable SVG that can be rendered
// at a fixed size. The algorithm below covers exactly that path and
// nothing more.
//
// Implementation is a tight port of the QR ISO/IEC 18004 byte-mode
// path. ~300 lines, no dependencies, deterministic output.
//
// Reference: ISO/IEC 18004:2015, §6 + §7.

const ECL_L = 0;
const ECL_M = 1;
const ECL_Q = 2;
const ECL_H = 3;

// Total data codeword capacity per (version, ECL).
// Indexed: CAPACITY_BYTES[version - 1][ecl].
const CAPACITY_BYTES = [
  [19, 16, 13, 9],
  [34, 28, 22, 16],
  [55, 44, 34, 26],
  [80, 64, 48, 36],
  [108, 86, 62, 46],
  [136, 108, 76, 60],
  [156, 124, 88, 66],
  [194, 154, 110, 86],
  [232, 182, 132, 100],
  [274, 216, 154, 122],
];

// Number of error-correction codewords per block, per (version, ECL),
// followed by block counts. From Annex D of the standard.
// [ecCodewordsPerBlock, blocksGroup1, dataCodewordsGroup1Block,
//  blocksGroup2, dataCodewordsGroup2Block]
const EC_PARAMS = {
  // Only versions 1..10 included; that's plenty for a join-URL.
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
};

const ECL_LETTER = ["L", "M", "Q", "H"];

function pickVersion(text, ecl) {
  const bytes = new TextEncoder().encode(text);
  for (let v = 1; v <= 10; v++) {
    const cap = CAPACITY_BYTES[v - 1][ecl];
    // Mode (4 bits) + length (8 bits for v1..v9, 16 bits for v10+)
    const lenBits = v >= 10 ? 16 : 8;
    const headerBytes = Math.ceil((4 + lenBits) / 8);
    if (bytes.length + headerBytes <= cap) return v;
  }
  throw new Error("QR text too long for version <= 10");
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

const ALIGNMENT_POSITIONS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function placeAlignment(m, version) {
  const pos = ALIGNMENT_POSITIONS[version];
  if (!pos) return;
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

  for (let i = 0; i < 8; i++) m[N - 1 - i][8] = (bits >> i) & 1;
  for (let i = 8; i < 15; i++) m[8][N - 15 + i] = (bits >> i) & 1;
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
  const ecParams = EC_PARAMS[version][ECL_LETTER[ecl]];
  const [ecPerBlock, b1, d1, b2, d2] = ecParams;
  const totalData = CAPACITY_BYTES[version - 1][ecl];

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

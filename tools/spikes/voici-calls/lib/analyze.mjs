// Turns per-frame [seq, sentAt, arrivedAt] records into delay stats and a simulated adaptive playout buffer,
// the same simulation for both options, so A and B are compared on equal terms (A also reports Chrome's own NetEq).
const q = (s, p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
export function delayStats(got) {
  const d = got.map((g) => g[2] - g[1]).sort((a, b) => a - b);
  if (!d.length) return null;
  return { n: d.length, p50: +q(d, 0.5).toFixed(1), p95: +q(d, 0.95).toFixed(1), p99: +q(d, 0.99).toFixed(1), max: +d[d.length - 1].toFixed(1) };
}
// Adaptive buffer: target = max(p95 of the last 3 s, max of the last 0.5 s) + 10 ms, never below 20 ms.
// A frame that arrives after its play time, or never, is concealed.
export function playout(got, sentCount) {
  const bySeq = new Map(got.map((g) => [g[0], g[2] - g[1]]));
  const maxSeq = Math.max(sentCount - 1, ...got.map((g) => g[0]));
  const hist = []; let concealed = 0, events = 0, run = 0, longest = 0; const targets = [];
  const warm = 50; // first second: let the buffer settle, not counted
  for (let k = 0; k <= maxSeq; k++) {
    let D = 60;
    if (hist.length >= 10) {
      const w = hist.slice(-150).sort((a, b) => a - b);
      D = Math.max(q(w, 0.95), Math.max(...hist.slice(-25))) + 10;
    }
    D = Math.max(20, D);
    const d = bySeq.get(k);
    const late = d === undefined || d > D;
    if (k >= warm) {
      targets.push(D);
      if (late) { concealed++; if (run === 0) events++; run++; longest = Math.max(longest, run); } else run = 0;
    }
    if (d !== undefined) hist.push(d);
  }
  const counted = Math.max(1, maxSeq + 1 - warm);
  const ts = targets.sort((a, b) => a - b);
  return { concealedPct: +((100 * concealed) / counted).toFixed(2), concealEvents: events, longestGapMs: longest * 20,
    bufferMeanMs: +(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(1), bufferP95Ms: +q(ts, 0.95).toFixed(1) };
}
export function neteq(inb) {
  if (!inb) return null;
  const ms = (x, n) => (n ? +((1000 * x) / n).toFixed(1) : null);
  return {
    packetsReceived: inb.packetsReceived, packetsLost: inb.packetsLost,
    concealedPct: inb.totalSamplesReceived ? +((100 * inb.concealedSamples) / inb.totalSamplesReceived).toFixed(2) : null,
    concealmentEvents: inb.concealmentEvents,
    jitterBufferMeanMs: ms(inb.jitterBufferDelay, inb.jitterBufferEmittedCount),
    jitterBufferTargetMeanMs: ms(inb.jitterBufferTargetDelay, inb.jitterBufferEmittedCount),
    stretchedPct: inb.totalSamplesReceived ? +((100 * ((inb.insertedSamplesForDeceleration ?? 0) + (inb.removedSamplesForAcceleration ?? 0))) / inb.totalSamplesReceived).toFixed(2) : null,
  };
}

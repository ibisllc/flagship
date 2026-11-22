// packages/protocol/test-vectors/voici-image-edit (tools/voici-image-edit-vectors.mjs): the voi.ci photo editor's
// turns, flip and square crop, replayed by the webapp, iOS and Android. Here: the file is what the tool writes, and
// every case is self-consistent (the crop lies inside the turned picture, and the output map sends the crop square
// onto the 512 × 512 output exactly).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const V = JSON.parse(readFileSync(join(ROOT, "packages/protocol/test-vectors/voici-image-edit/vectors.json"), "utf8"));

type M = [number, number, number, number, number, number];
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const invertOrient = (m: M, x: number, y: number) => {
  const det = m[0] * m[3] - m[1] * m[2];
  const dx = x - m[4];
  const dy = y - m[5];
  return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
};

describe("voici-image-edit vectors", () => {
  it("are what the tool writes", () => {
    execFileSync(process.execPath, [join(ROOT, "tools/voici-image-edit-vectors.mjs"), "--check"]);
  });

  for (const c of V.cases) {
    it(c.name, () => {
      const x = c.expect;
      const { x: cx, y: cy, side } = x.crop;
      expect(cx).toBeGreaterThanOrEqual(-1e-6);
      expect(cy).toBeGreaterThanOrEqual(-1e-6);
      expect(cx + side).toBeLessThanOrEqual(x.displayWidth + 1e-6);
      expect(cy + side).toBeLessThanOrEqual(x.displayHeight + 1e-6);
      expect(x.turns % 2 === 0 ? [x.displayWidth, x.displayHeight] : [x.displayHeight, x.displayWidth]).toEqual([c.width, c.height]);
      // The crop's corners, taken back to source pixels, land on the output square's corners.
      const corners: [number, number, number, number][] = [
        [cx, cy, 0, 0],
        [cx + side, cy, 512, 0],
        [cx, cy + side, 0, 512],
        [cx + side, cy + side, 512, 512],
      ];
      for (const [dx, dy, ox, oy] of corners) {
        const [sx, sy] = invertOrient(x.orient as M, dx, dy);
        expect(sx).toBeGreaterThanOrEqual(-1e-6);
        expect(sy).toBeGreaterThanOrEqual(-1e-6);
        expect(sx).toBeLessThanOrEqual(c.width + 1e-6);
        expect(sy).toBeLessThanOrEqual(c.height + 1e-6);
        const [px, py] = apply(x.output512 as M, sx, sy);
        expect(px).toBeCloseTo(ox, 4);
        expect(py).toBeCloseTo(oy, 4);
      }
    });
  }
});

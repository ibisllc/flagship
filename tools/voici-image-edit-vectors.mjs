#!/usr/bin/env node
// Writes packages/protocol/test-vectors/voici-image-edit/vectors.json from the webapp's editor rules
// (apps/web/public/webapp/lib/voiciImageEdit.js). iOS (VoiciImageEditTests) and Android (VoiciImageEditTest) replay it.
//   node tools/voici-image-edit-vectors.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cropOf, displaySize, flip, newEdit, orientMatrix, outputMatrix, pan, rotate, setZoom } from "../apps/web/public/webapp/lib/voiciImageEdit.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages/protocol/test-vectors/voici-image-edit/vectors.json");
const r = (v) => Math.round(v * 1e9) / 1e9 + 0;

const scripts = [
  { name: "landscape, untouched", width: 4032, height: 3024, ops: [] },
  { name: "portrait, zoomed and panned to a corner", width: 1377, height: 1721, ops: [["zoom", 2.5], ["pan", 400, 400, 300]] },
  { name: "rotate once", width: 4032, height: 3024, ops: [["zoom", 2], ["pan", -50, 20, 320], ["rotate"]] },
  { name: "rotate four times returns", width: 800, height: 600, ops: [["zoom", 1.5], ["pan", 30, -10, 300], ["rotate"], ["rotate"], ["rotate"], ["rotate"]] },
  { name: "flip then rotate", width: 1000, height: 500, ops: [["zoom", 3], ["pan", 100, 0, 300], ["flip"], ["rotate"]] },
  { name: "rotate then flip", width: 1000, height: 500, ops: [["rotate"], ["flip"], ["zoom", 2], ["pan", 0, 80, 250]] },
  { name: "flip twice returns", width: 640, height: 480, ops: [["zoom", 2], ["pan", 60, 0, 200], ["flip"], ["flip"]] },
  { name: "zoom is capped", width: 3000, height: 2000, ops: [["zoom", 100]] },
  { name: "a small picture zooms only to the 64-pixel crop", width: 90, height: 120, ops: [["zoom", 4], ["pan", 50, 50, 100]] },
  { name: "three turns", width: 1200, height: 900, ops: [["rotate"], ["rotate"], ["rotate"], ["zoom", 2], ["pan", -500, -500, 300]] },
];

const cases = scripts.map((s) => {
  let e = newEdit(s.width, s.height);
  for (const op of s.ops) {
    if (op[0] === "rotate") e = rotate(e);
    else if (op[0] === "flip") e = flip(e);
    else if (op[0] === "zoom") e = setZoom(e, op[1]);
    else if (op[0] === "pan") e = pan(e, op[1], op[2], op[3]);
  }
  const [dw, dh] = displaySize(e);
  const c = cropOf(e);
  return {
    ...s,
    expect: {
      turns: e.turns,
      flipped: e.flipped,
      zoom: r(e.zoom),
      displayWidth: dw,
      displayHeight: dh,
      crop: { x: r(c.x), y: r(c.y), side: r(c.side) },
      orient: orientMatrix(e).map(r),
      output512: outputMatrix(e, 512).map(r),
    },
  };
});

const text = JSON.stringify({ description: "voi.ci photo editor: turns, flip, square crop (docs/voici-and-messages.md §2.3)", tolerance: 1e-6, cases }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("voici-image-edit vectors are stale: run node tools/voici-image-edit-vectors.mjs");
    process.exit(1);
  }
} else writeFileSync(OUT, text);

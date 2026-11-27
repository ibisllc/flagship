// The welcome art must read as a drawing on the welcome screen itself: no square, no border, no fringe where the
// painting meets the screen (owner, 2026-11-27). Each picture is laid over the background colour it is shown on, and
// along every edge the paper and the fade must match that colour and change only smoothly: a border or a square is a
// step along a whole edge. Only paper and fade pixels count (the drawing reaches the edge band here and there).
// Fix a failure with tools/welcome-art/match-paper.swift, never by drawing a frame around the picture.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const DAY_BG = [0xf7, 0xf6, 0xf2]; // --canvas, FSColors light bg, Tokens.kt LightColors.bg
const NIGHT_BG = [0x0a, 0x0a, 0x09]; // the dark canvas on all three

const PICTURES = [
  { file: "apps/mobile/ios/App/Resources/Assets.xcassets/WelcomeArt.imageset/welcome-day.png", bg: DAY_BG },
  { file: "apps/mobile/ios/App/Resources/Assets.xcassets/WelcomeArt.imageset/welcome-night.png", bg: NIGHT_BG },
  { file: "apps/web/public/webapp/welcome-day.png", bg: DAY_BG },
  { file: "apps/web/public/webapp/welcome-night.png", bg: NIGHT_BG },
  { file: "apps/mobile/android/app/src/main/res/drawable-nodpi/welcome_day.webp", bg: DAY_BG },
  { file: "apps/mobile/android/app/src/main/res/drawable-nodpi/welcome_night.webp", bg: NIGHT_BG },
];

function hasDwebp(): boolean {
  try {
    execFileSync("dwebp", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function decode(file: string): PNG {
  if (file.endsWith(".png")) return PNG.sync.read(readFileSync(join(ROOT, file)));
  const dir = mkdtempSync(join(tmpdir(), "welcome-art-"));
  try {
    const out = join(dir, "art.png");
    execFileSync("dwebp", ["-quiet", join(ROOT, file), "-o", out]);
    return PNG.sync.read(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Per edge line of the outer fifth: the median distance of the composited paper/fade pixels from the background. */
export function edgeProfile(png: PNG, bg: number[]): { name: string; medians: number[] }[] {
  const { width: w, height: h, data } = png;
  const at = (x: number, y: number): number | null => {
    const i = (y * w + x) * 4;
    const a = data[i + 3]!;
    const c = [data[i]!, data[i + 1]!, data[i + 2]!];
    // The drawing: opaque and far from the background. It is not what this test is about.
    if (a === 255 && Math.max(...c.map((v, k) => Math.abs(v - bg[k]!))) >= 24) return null;
    const comp = c.map((v, k) => Math.round((v * a + bg[k]! * (255 - a)) / 255));
    return Math.max(...comp.map((v, k) => Math.abs(v - bg[k]!)));
  };
  const median = (v: (number | null)[]): number => {
    const s = v.filter((x): x is number => x !== null).sort((p, q) => p - q);
    return s.length ? s[s.length >> 1]! : 0;
  };
  const band = Math.floor(Math.min(w, h) * 0.2);
  const sides = [
    { name: "top", line: (k: number) => Array.from({ length: w }, (_, x) => at(x, k)) },
    { name: "bottom", line: (k: number) => Array.from({ length: w }, (_, x) => at(x, h - 1 - k)) },
    { name: "left", line: (k: number) => Array.from({ length: h }, (_, y) => at(k, y)) },
    { name: "right", line: (k: number) => Array.from({ length: h }, (_, y) => at(w - 1 - k, y)) },
  ];
  return sides.map((s) => ({ name: s.name, medians: Array.from({ length: band }, (_, k) => median(s.line(k))) }));
}

describe("welcome art blends into the welcome screen", () => {
  const dwebp = hasDwebp();
  for (const p of PICTURES) {
    const run = p.file.endsWith(".webp") && !dwebp ? it.skip : it;
    run(`${p.file.split("/").pop()} (${p.file.split("/")[2]}): no border, no square`, () => {
      expect(existsSync(join(ROOT, p.file))).toBe(true);
      const png = decode(p.file);
      for (const side of edgeProfile(png, p.bg)) {
        // Where the art meets the screen it is the screen.
        expect(Math.max(...side.medians.slice(0, 8)), `${side.name} edge`).toBeLessThanOrEqual(1);
        // No step anywhere along the edge band: a border or a square shows as a jump between neighbouring lines.
        const steps = side.medians.slice(1).map((m, k) => Math.abs(m - side.medians[k]!));
        expect(Math.max(...steps), `${side.name} step`).toBeLessThanOrEqual(2);
      }
    });
  }

  it("the day picture's paper is the day background (no square however faint)", () => {
    const png = decode(PICTURES[0]!.file);
    for (const side of edgeProfile(png, DAY_BG)) expect(Math.max(...side.medians), side.name).toBeLessThanOrEqual(2);
  });

  it("the app shows the picture with no frame around it", () => {
    const ios = readFileSync(join(ROOT, "apps/mobile/ios/Sources/FlagshipUI/Screens/WelcomeScreen.swift"), "utf8");
    const art = ios.slice(ios.indexOf("private struct WelcomeArt"));
    expect(art.slice(0, art.indexOf("\n}\n"))).not.toMatch(/\.(border|overlay|background|clipShape|shadow|cornerRadius)\(/);
    const android = readFileSync(
      join(ROOT, "apps/mobile/android/app/src/main/java/com/flagshipserver/app/ui/screens/WelcomeScreen.kt"),
      "utf8",
    );
    const fn = android.slice(android.indexOf("private fun WelcomeArt"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toMatch(/\.(border|background|clip|shadow)\(/);
    const contents = JSON.parse(
      readFileSync(join(ROOT, "apps/mobile/ios/App/Resources/Assets.xcassets/WelcomeArt.imageset/Contents.json"), "utf8"),
    );
    // Lossy asset compression (HEVC) turns the soft fade into a hard-edged square.
    expect(contents.properties["compression-type"]).toBe("lossless");
  });
});

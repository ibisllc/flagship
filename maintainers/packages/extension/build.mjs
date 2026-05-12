#!/usr/bin/env node
/**
 * Build the browser extension into dist/chrome/ and dist/firefox/.
 *
 * Three entry points are bundled:
 *  - content-script.ts → dist/<target>/content-script.js
 *  - background.ts     → dist/<target>/background.js
 *  - popup/popup.ts    → dist/<target>/popup/popup.js
 *
 * Plus we copy:
 *  - manifest.<target>.json → dist/<target>/manifest.json
 *  - src/popup/popup.html, popup.css → dist/<target>/popup/
 *  - icons/*.png → dist/<target>/icons/  (created on first build if absent)
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const args = process.argv.slice(2);
const targets = [];
for (const a of args) {
  if (a === "--target=chrome") targets.push("chrome");
  else if (a === "--target=firefox") targets.push("firefox");
}
if (targets.length === 0) targets.push("chrome", "firefox");

for (const target of targets) await buildOne(target);

async function buildOne(target) {
  const outDir = resolve(ROOT, "dist", target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(resolve(outDir, "popup"), { recursive: true });
  await mkdir(resolve(outDir, "icons"), { recursive: true });

  const entries = [
    { in: "src/content-script.ts", out: "content-script" },
    { in: "src/background.ts", out: "background" },
    { in: "src/popup/popup.ts", out: "popup/popup" },
  ];
  await build({
    entryPoints: entries.map((e) => ({ in: resolve(ROOT, e.in), out: e.out })),
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    outdir: outDir,
    sourcemap: "inline",
    minify: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info",
  });

  // Static files
  await cp(resolve(ROOT, "src/popup/popup.html"), resolve(outDir, "popup/popup.html"));
  await cp(resolve(ROOT, "src/popup/popup.css"), resolve(outDir, "popup/popup.css"));

  // Manifest
  const manifest = await readFile(resolve(ROOT, `manifest.${target}.json`), "utf8");
  await writeFile(resolve(outDir, "manifest.json"), manifest);

  // Icons — write tiny placeholder PNGs if none exist. The user can
  // overwrite these later.
  for (const size of [16, 48, 128]) {
    try {
      await cp(resolve(ROOT, `icons/icon-${size}.png`), resolve(outDir, `icons/icon-${size}.png`));
    } catch {
      // Generate a 1x1 transparent PNG as a placeholder.
      const png1x1 = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100ed1d0c8c0000000049454e44ae426082",
        "hex",
      );
      await writeFile(resolve(outDir, `icons/icon-${size}.png`), png1x1);
    }
  }

  console.log(`[extension] built target=${target} → ${outDir}`);
}

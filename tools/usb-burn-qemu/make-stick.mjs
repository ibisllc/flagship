// Composes a burned stick the way the phone does (docs/iso-seed-and-on-device-burn.md): the seed ISO
// written verbatim, then the GPT-registered FLAGSHIP FAT16 partition overwritten with the per-recipe
// preseed.cfg. The preseed is the REAL generated one (partman, late_command, the signed InstallBlob
// carrier) with only the first-boot bootstrap swapped for a harness that proves it ran, and the
// progress beacons pointed at a closed local port so nothing reaches production.
// usage: node make-stick.mjs <seed.iso> <out.img>     (needs `npx tsc -b packages/flagship-builder`, mtools)
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "flagship-builder");
const { buildDebianPreseed } = await import(`${W}/dist/index.js`);
const { optionsFromRecipeJson } = await import(`${W}/dist/preseedEngine.js`);
const [seed, out] = process.argv.slice(2);
if (!seed || !out) throw new Error("usage: make-stick.mjs <seed.iso> <out.img>");

const vec = JSON.parse(readFileSync(`${W}/engine/golden/preseed-vectors.json`, "utf8")).vectors.find((v) => v.name === "luks-default");
let preseed = buildDebianPreseed(optionsFromRecipeJson(vec.recipeJson, {}));

const bootstrap = `#!/bin/bash
{
echo "[stick] BOOTSTRAP-RAN blob=$(wc -c < /var/flagship/install-blob.json) luks-key=$([ -s /var/flagship/luks-burn.key ] && echo present || echo missing)"
} 2>&1 | tee /dev/console
`;
const re = /(echo ')([A-Za-z0-9+/=]+)(' \| base64 -d > \/target\/usr\/local\/sbin\/flagship-bootstrap\.sh)/;
if (!re.test(preseed)) throw new Error("bootstrap payload not found");
preseed = preseed.replace(re, `$1${Buffer.from(bootstrap).toString("base64")}$3`);
const before = preseed.split("https://flagshipserver.com").length - 1;
if (before < 1) throw new Error("expected the production beacons to be present");
preseed = preseed.replaceAll("https://flagshipserver.com", "http://127.0.0.1:9");

copyFileSync(seed, out);

// The FLAGSHIP partition: by its GPT name, else the highest first LBA (what GptReader.kt does).
const fd = openSync(out, "r");
const read = (pos, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b; };
const hdr = read(512, 92);
if (hdr.toString("ascii", 0, 8) !== "EFI PART") throw new Error("the seed has no GPT");
const entriesLba = Number(hdr.readBigUInt64LE(72));
const count = hdr.readUInt32LE(80);
const size = hdr.readUInt32LE(84);
let best = null;
for (let i = 0; i < count; i++) {
  const e = read(entriesLba * 512 + i * size, size);
  if (e.every((x) => x === 0)) continue;
  const first = Number(e.readBigUInt64LE(32));
  const name = e.toString("utf16le", 56, 56 + 72).replace(/\0.*$/, "");
  if (name === "FLAGSHIP" || !best || (best.name !== "FLAGSHIP" && first > best.first)) best = { first, name };
}
closeSync(fd);
if (!best) throw new Error("no partitions in the seed's GPT");

const tmp = `${out}.preseed.cfg`;
writeFileSync(tmp, preseed);
const target = `${out}@@${best.first * 512}`;
execFileSync("mcopy", ["-o", "-i", target, tmp, "::preseed.cfg"]);
const label = execFileSync("minfo", ["-i", target, "::"], { encoding: "utf8" });
console.log(`stick ${out}: FLAGSHIP partition at LBA ${best.first} (${best.name || "unnamed"}), preseed ${preseed.length} bytes`);
if (!/FLAGSHIP/i.test(execFileSync("mlabel", ["-s", "-i", target, "::"], { encoding: "utf8" }))) throw new Error("the partition isn't labelled FLAGSHIP:\n" + label);

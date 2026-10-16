import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { backupBundleFileName, backupBundleHeader, parseBackupBundleHeader } from "../src/serverBackup.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/server-backup-bundle/vectors.json"), "utf8"),
) as {
  headers: Array<{ metaLength: number; headerHex: string }>;
  example: { metaHex: string; dataHex: string; bundleHex: string; metaLength: number; dataOffset: number };
  invalid: Array<{ why: string; headHex: string; fileBytes: number }>;
};
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("the one-file backup (test-vectors/server-backup-bundle/vectors.json)", () => {
  it.each(V.headers.map((c) => [c.metaLength, c] as const))("header for %i", (_l, c) => {
    expect(hex(backupBundleHeader(c.metaLength))).toBe(c.headerHex);
    expect(parseBackupBundleHeader(fromHex(c.headerHex), 16 + c.metaLength + 1)).toEqual({
      metaOffset: 16,
      metaLength: c.metaLength,
      dataOffset: 16 + c.metaLength,
      dataLength: 1,
    });
  });
  it("splits back into the two parts", () => {
    const b = fromHex(V.example.bundleHex);
    const h = parseBackupBundleHeader(b.subarray(0, 16), b.length);
    expect(hex(b.subarray(h.metaOffset, h.metaOffset + h.metaLength))).toBe(V.example.metaHex);
    expect(hex(b.subarray(h.dataOffset))).toBe(V.example.dataHex);
  });
  it.each(V.invalid.map((c) => [c.why, c] as const))("refuses: %s, with a sentence", (_w, c) => {
    expect(() => parseBackupBundleHeader(fromHex(c.headHex), c.fileBytes)).toThrow(/backup|file/);
  });
  it("names the one file after the parts", () => {
    expect(backupBundleFileName("home-2026-10-16.flagship-data")).toBe("home-2026-10-16.flagship");
    expect(backupBundleFileName("home-2026-10-16-0300.flagship-backup")).toBe("home-2026-10-16-0300.flagship");
  });
  it("the shell recipe in the docs splits it with head/tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-split-"));
    const f = join(dir, "home.flagship");
    writeFileSync(f, fromHex(V.example.bundleHex));
    // docs/server-backup-and-clone.md, "The one file".
    const recipe = `
      L=$(dd if="$1" bs=1 skip=8 count=8 2>/dev/null | od -An -tu1 | awk '{for(i=1;i<=NF;i++) n=n*256+$i} END{print n}')
      tail -c +17 "$1" | head -c "$L" > "$2/meta.flagship-backup"
      tail -c +$((17 + L)) "$1" > "$2/data.flagship-data"`;
    execFileSync("bash", ["-c", recipe, "split", f, dir]);
    expect(hex(readFileSync(join(dir, "meta.flagship-backup")))).toBe(V.example.metaHex);
    expect(hex(readFileSync(join(dir, "data.flagship-data")))).toBe(V.example.dataHex);
  });
});

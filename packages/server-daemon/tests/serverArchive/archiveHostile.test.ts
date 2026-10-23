import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealDataFile } from "../../src/serverArchive/format.js";
import { checkArchiveContents } from "../../src/serverArchive/restore.js";
import { ArchiveLimits } from "../../src/serverArchive/limits.js";

const KEY = Buffer.alloc(32, 9);
const ID = "arch-1";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "archive-hostile-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Entry = { name: string; body?: Buffer; type?: "file" | "symlink" | "directory"; linkname?: string };

async function archiveOf(entries: Entry[]): Promise<string> {
  const pack = tar.pack();
  for (const e of entries) {
    pack.entry({ name: e.name, type: e.type ?? "file", ...(e.linkname ? { linkname: e.linkname } : {}), size: e.type && e.type !== "file" ? 0 : (e.body ?? Buffer.alloc(0)).length }, e.type && e.type !== "file" ? undefined : (e.body ?? Buffer.alloc(0)));
  }
  pack.finalize();
  const out = join(dir, `a-${Math.random().toString(16).slice(2)}.data`);
  await sealDataFile(Readable.from(pack), KEY, ID, out);
  return out;
}

const manifest = Buffer.from(JSON.stringify({ v: 1, archiveId: ID, apps: [] }));

describe("a hostile archive is refused while it streams", () => {
  it("accepts a plain empty manifest", async () => {
    const f = await archiveOf([{ name: "manifest.json", body: manifest }]);
    await expect(checkArchiveContents(f, KEY, ID)).resolves.toEqual({ apps: 0 });
  });

  it("refuses the same name twice", async () => {
    const f = await archiveOf([{ name: "manifest.json", body: manifest }, { name: "manifest.json", body: manifest }]);
    await expect(checkArchiveContents(f, KEY, ID)).rejects.toThrow(/twice/);
  });

  it("refuses a symlink, a directory, a traversal and a name outside the allowlist", async () => {
    for (const e of [
      { name: "manifest.json", type: "symlink" as const, linkname: "/etc/passwd" },
      { name: "apps/", type: "directory" as const },
      { name: "../manifest.json", body: manifest },
      { name: "apps/a--b/../../x", body: manifest },
      { name: "/manifest.json", body: manifest },
      { name: "apps/a--b/other.bin", body: manifest },
      { name: "manifest.json ", body: manifest },
    ]) {
      const f = await archiveOf([e]);
      await expect(checkArchiveContents(f, KEY, ID), e.name).rejects.toThrow(/unexpected/);
    }
  });

  it("refuses an oversize manifest or meta file before keeping it", async () => {
    const f = await archiveOf([{ name: "manifest.json", body: Buffer.alloc(3 * 1024 * 1024, 0x20) }]);
    await expect(checkArchiveContents(f, KEY, ID)).rejects.toThrow(/larger than it may be/);
  });

  it("refuses too many parts and an archive that expands past its cap", async () => {
    const f = await archiveOf([{ name: "manifest.json", body: manifest }, { name: "apps/a--b/meta.json", body: Buffer.from("{}") }, { name: "apps/a--b/source.json", body: Buffer.from("{}") }]);
    await expect(checkArchiveContents(f, KEY, ID, new ArchiveLimits({ entries: 2 }))).rejects.toThrow(/too many parts/);
    await expect(checkArchiveContents(f, KEY, ID, new ArchiveLimits({ total: 10 }))).rejects.toThrow(/expands to more/);
  });
});

describe("ArchiveLimits", () => {
  it("tracks entries, duplicates and bytes", () => {
    const l = new ArchiveLimits({ entries: 2, small: 4, total: 6 });
    expect(l.enter("a", true)).toBe(4);
    expect(l.enter("b", false)).toBe(Number.POSITIVE_INFINITY);
    expect(() => l.enter("a", true)).toThrow(/twice/);
    expect(() => l.enter("c", true)).toThrow(/too many/);
    l.chunk(3, 3, 4);
    expect(() => l.chunk(2, 5, 4)).toThrow(/larger/);
  });
});

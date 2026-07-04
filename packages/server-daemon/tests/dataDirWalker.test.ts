import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkDataDir } from "../src/dataDirWalker.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tree(): string {
  dir = mkdtempSync(join(tmpdir(), "walker-"));
  return dir;
}

const dec = new TextDecoder();

describe("walkDataDir", () => {
  it("returns a deterministic, sorted, relative-path file set", async () => {
    const root = tree();
    mkdirSync(join(root, "app-state/notes"), { recursive: true });
    mkdirSync(join(root, "app-clones"), { recursive: true });
    writeFileSync(join(root, "app-state/notes/db.json"), "notes");
    writeFileSync(join(root, "app-clones/repo.txt"), "repo");
    writeFileSync(join(root, "top.txt"), "top");

    const a = await walkDataDir(root);
    const b = await walkDataDir(root);
    expect(a.map((f) => f.path)).toEqual([
      "app-clones/repo.txt",
      "app-state/notes/db.json",
      "top.txt",
    ]);
    expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path));
    expect(dec.decode(a[2]!.content)).toBe("top");
  });

  it("NEVER includes key material / identity / dotfiles / tmp droppings", async () => {
    const root = tree();
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "swk.hex"), "deadbeef");
    writeFileSync(join(root, "server.key"), "priv");
    writeFileSync(join(root, "cert.pem"), "pem");
    writeFileSync(join(root, "identity.json"), "id");
    writeFileSync(join(root, "sub/box-identity-backup"), "id2");
    writeFileSync(join(root, ".env"), "secret");
    writeFileSync(join(root, "sub/file.restore-tmp"), "partial");
    writeFileSync(join(root, "sub/scratch.tmp"), "tmp");
    writeFileSync(join(root, "sub/data.bin"), "ok");

    const files = await walkDataDir(root);
    expect(files.map((f) => f.path)).toEqual(["sub/data.bin"]);
  });

  it("never follows symlinks (no escape from the root)", async () => {
    const root = tree();
    const outside = mkdtempSync(join(tmpdir(), "walker-outside-"));
    writeFileSync(join(outside, "secret.txt"), "outside");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/real.txt"), "inside");
    symlinkSync(join(outside, "secret.txt"), join(root, "sub/link.txt"));
    symlinkSync(outside, join(root, "linkdir"));

    const files = await walkDataDir(root);
    expect(files.map((f) => f.path)).toEqual(["sub/real.txt"]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("skips oversize files (whole-file chunker) and honors the caller exclusion", async () => {
    const root = tree();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(2048, 1));
    writeFileSync(join(root, "small.bin"), Buffer.alloc(16, 2));
    writeFileSync(join(root, "cache.bin"), "cache");
    const logs: string[] = [];
    const files = await walkDataDir(root, {
      maxFileBytes: 1024,
      exclude: (rel) => rel.startsWith("cache"),
      onLog: (m) => logs.push(m),
    });
    expect(files.map((f) => f.path)).toEqual(["small.bin"]);
    expect(logs.some((l) => l.includes("oversize big.bin"))).toBe(true);
  });

  it("a missing root yields an empty set (never throws)", async () => {
    const root = tree();
    const files = await walkDataDir(join(root, "does-not-exist"));
    expect(files).toEqual([]);
  });

  it("large-tree sanity: hundreds of nested files all land, once each", async () => {
    const root = tree();
    for (let d = 0; d < 10; d++) {
      mkdirSync(join(root, `d${d}/nested`), { recursive: true });
      for (let f = 0; f < 20; f++) {
        writeFileSync(join(root, `d${d}/nested/f${f}.dat`), `${d}-${f}`);
      }
    }
    const files = await walkDataDir(root);
    expect(files).toHaveLength(200);
    expect(new Set(files.map((f) => f.path)).size).toBe(200);
  });
});

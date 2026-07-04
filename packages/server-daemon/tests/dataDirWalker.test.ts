import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkDataDir } from "../src/dataDirWalker.js";
import { isDumpSubtree, isRawDataMount } from "../src/volumeDump.js";

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

  // ── volume-aware backup: raw data mounts excluded, `_dumps/**` ride ──
  it("excludes the raw data-store bind mounts, ships only the `_dumps/` subtree", async () => {
    const root = tree();
    // Live bind mounts the walker would otherwise descend into + tear.
    mkdirSync(join(root, "postgres/base/1"), { recursive: true });
    mkdirSync(join(root, "minio/.minio.sys/buckets"), { recursive: true });
    mkdirSync(join(root, "redis"), { recursive: true });
    mkdirSync(join(root, "forgejo/data"), { recursive: true });
    mkdirSync(join(root, "chromium/profile"), { recursive: true });
    writeFileSync(join(root, "postgres/base/1/PG_VERSION"), "16");
    writeFileSync(join(root, "postgres/postmaster.pid"), "123");
    writeFileSync(join(root, "minio/.minio.sys/buckets/x"), "sys");
    writeFileSync(join(root, "redis/dump.rdb"), "live-rdb");
    writeFileSync(join(root, "forgejo/data/forgejo.db"), "live-sqlite");
    writeFileSync(join(root, "chromium/profile/Cookies"), "cookie");
    // The consistent logical dumps written by dumpDataVolumes.
    mkdirSync(join(root, "_dumps/postgres"), { recursive: true });
    mkdirSync(join(root, "_dumps/minio/bucket"), { recursive: true });
    mkdirSync(join(root, "_dumps/redis"), { recursive: true });
    mkdirSync(join(root, "_dumps/forgejo"), { recursive: true });
    writeFileSync(join(root, "_dumps/postgres/all.dump"), "SQL");
    writeFileSync(join(root, "_dumps/minio/bucket/obj"), "obj");
    writeFileSync(join(root, "_dumps/redis/dump.rdb"), "snap-rdb");
    writeFileSync(join(root, "_dumps/forgejo/forgejo.db"), "snap-sqlite");
    // A non-store data file still rides normally.
    writeFileSync(join(root, "app-state.json"), "state");

    const files = await walkDataDir(root, {
      exclude: isRawDataMount,
      raiseCapFor: isDumpSubtree,
    });
    expect(files.map((f) => f.path)).toEqual([
      "_dumps/forgejo/forgejo.db",
      "_dumps/minio/bucket/obj",
      "_dumps/postgres/all.dump",
      "_dumps/redis/dump.rdb",
      "app-state.json",
    ]);
    // Not one byte of a live mount rode.
    expect(files.some((f) => f.path.startsWith("postgres/"))).toBe(false);
    expect(files.some((f) => f.path.startsWith("minio/"))).toBe(false);
    expect(files.some((f) => f.path.startsWith("chromium/"))).toBe(false);
  });

  it("raises the whole-file cap for `_dumps/**` while the default cap still bounds the rest", async () => {
    const root = tree();
    // A big consistent dump (would be truncated by the 64 MiB default cap in prod).
    mkdirSync(join(root, "_dumps/postgres"), { recursive: true });
    writeFileSync(join(root, "_dumps/postgres/all.dump"), Buffer.alloc(4096, 7));
    // A big NON-dump file still hits the default cap and is skipped.
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(4096, 9));
    const logs: string[] = [];
    const files = await walkDataDir(root, {
      maxFileBytes: 1024,
      raiseCapFor: isDumpSubtree,
      raisedCapBytes: 1024 * 1024,
      exclude: isRawDataMount,
      onLog: (m) => logs.push(m),
    });
    expect(files.map((f) => f.path)).toEqual(["_dumps/postgres/all.dump"]);
    expect(logs.some((l) => l.includes("oversize huge.bin"))).toBe(true);
    expect(logs.some((l) => l.includes("_dumps/postgres/all.dump"))).toBe(false);
  });
});

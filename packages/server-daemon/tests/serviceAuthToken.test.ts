import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileAppAuthTokens,
  InMemoryAppAuthTokens,
  type AppAuthTokens,
} from "../src/serviceAuthToken.js";

function runContractTests(name: string, factory: () => Promise<AppAuthTokens>): void {
  describe(`${name} — interface contract`, () => {
    let store: AppAuthTokens;
    beforeEach(async () => {
      store = await factory();
    });

    it("mint returns a non-empty token unique per app", async () => {
      const a = await store.mint("alice-game1");
      const b = await store.mint("alice-game2");
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).not.toBe(b);
    });

    it("resolve maps a token back to its serviceId", async () => {
      const t = await store.mint("alice-game1");
      expect(await store.resolve(t)).toBe("alice-game1");
    });

    it("resolve returns null for unknown tokens", async () => {
      expect(await store.resolve("definitely-not-a-token")).toBeNull();
    });

    it("re-minting overrides the previous token (old token is rejected)", async () => {
      const t1 = await store.mint("alice-game1");
      const t2 = await store.mint("alice-game1");
      expect(t1).not.toBe(t2);
      expect(await store.resolve(t1)).toBeNull();
      expect(await store.resolve(t2)).toBe("alice-game1");
    });

    it("forget removes the token; resolve returns null afterwards", async () => {
      const t = await store.mint("alice-game1");
      await store.forget("alice-game1");
      expect(await store.resolve(t)).toBeNull();
      expect(await store.tokenForApp("alice-game1")).toBeNull();
    });

    it("forget on a never-minted app is idempotent (no throw)", async () => {
      await expect(store.forget("never-existed")).resolves.toBeUndefined();
    });

    it("tokenForApp returns the current token", async () => {
      const t = await store.mint("alice-game1");
      expect(await store.tokenForApp("alice-game1")).toBe(t);
    });
  });
}

runContractTests("InMemoryAppAuthTokens", async () => new InMemoryAppAuthTokens());

describe("FileAppAuthTokens — extras (persistence + perms)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagship-tokens-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists tokens to disk and survives a reload", async () => {
    const s1 = new FileAppAuthTokens(dir);
    const t = await s1.mint("alice-game1");

    const s2 = new FileAppAuthTokens(dir);
    await s2.load();
    expect(await s2.resolve(t)).toBe("alice-game1");
    expect(await s2.tokenForApp("alice-game1")).toBe(t);
  });

  it("forget removes the on-disk file", async () => {
    const s = new FileAppAuthTokens(dir);
    await s.mint("alice-game1");
    await s.forget("alice-game1");
    const s2 = new FileAppAuthTokens(dir);
    await s2.load();
    expect(await s2.tokenForApp("alice-game1")).toBeNull();
  });

  it("token file is mode 0600 (not world-readable)", async () => {
    const s = new FileAppAuthTokens(dir);
    await s.mint("alice-game1");
    const { stat } = await import("node:fs/promises");
    const st = await stat(join(dir, "alice-game1.token"));
    expect(st.mode & 0o077).toBe(0); // no group/other bits
  });

  it("load is tolerant of unreadable / non-token files in the dir", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "garbage.bin"), "not a token, ignored");
    const s = new FileAppAuthTokens(dir);
    await expect(s.load()).resolves.toBeUndefined();
  });

  it("load on a non-existent dir is a no-op (fresh-box first boot)", async () => {
    await rm(dir, { recursive: true, force: true });
    const s = new FileAppAuthTokens(dir);
    await expect(s.load()).resolves.toBeUndefined();
  });

  it("on-disk file content matches the returned token", async () => {
    const s = new FileAppAuthTokens(dir);
    const t = await s.mint("alice-game1");
    const onDisk = (await readFile(join(dir, "alice-game1.token"), "utf8")).trim();
    expect(onDisk).toBe(t);
  });
});

runContractTests("FileAppAuthTokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flagship-tokens-c-"));
  return new FileAppAuthTokens(dir);
});

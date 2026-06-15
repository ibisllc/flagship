import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileMcpKeyStore,
  InMemoryMcpKeyStore,
  type McpKeyStore,
} from "../src/buildmodes/mcpKeyStore.js";

const SWK = new Uint8Array(32).fill(7);
let seed = 0;
const rand = () => {
  seed++;
  return new Uint8Array(24).fill(seed % 251);
};

function suite(name: string, make: () => McpKeyStore) {
  describe(name, () => {
    it("mints a prefixed key and resolves it to the build", async () => {
      const s = make();
      const rec = await s.mint("b1", "cursor on laptop");
      expect(rec.key.startsWith("fmcp_")).toBe(true);
      expect(rec.label).toBe("cursor on laptop");
      expect(await s.resolve(rec.key)).toBe("b1");
    });

    it("resolve returns null for an unknown / wrong key", async () => {
      const s = make();
      await s.mint("b1");
      expect(await s.resolve("fmcp_deadbeef")).toBeNull();
      expect(await s.resolve("")).toBeNull();
    });

    it("re-minting replaces the old key (old key stops resolving)", async () => {
      const s = make();
      const first = await s.mint("b1");
      const second = await s.mint("b1");
      expect(first.key).not.toBe(second.key);
      expect(await s.resolve(first.key)).toBeNull();
      expect(await s.resolve(second.key)).toBe("b1");
    });

    it("revoke invalidates the key", async () => {
      const s = make();
      const rec = await s.mint("b1");
      await s.revoke("b1");
      expect(await s.resolve(rec.key)).toBeNull();
      expect(await s.get("b1")).toBeNull();
    });

    it("list never leaks key material", async () => {
      const s = make();
      await s.mint("b1", "lbl");
      const list = await s.list();
      expect(list[0]!.buildId).toBe("b1");
      expect(JSON.stringify(list)).not.toContain("fmcp_");
    });

    it("keys bind to ONE build (a key for b1 never resolves b2)", async () => {
      const s = make();
      const k1 = await s.mint("b1");
      await s.mint("b2");
      expect(await s.resolve(k1.key)).toBe("b1");
    });
  });
}

suite("InMemoryMcpKeyStore", () => new InMemoryMcpKeyStore(() => 1, rand));

suite("FileMcpKeyStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpkey-"));
  return new FileMcpKeyStore(dir, SWK, () => 1, rand);
});

describe("FileMcpKeyStore persistence", () => {
  it("a key minted before restart still resolves + re-displays after load()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpkey-"));
    const a = new FileMcpKeyStore(dir, SWK, () => 1, rand);
    const rec = await a.mint("persist", "ide");

    const b = new FileMcpKeyStore(dir, SWK, () => 1, rand);
    await b.load();
    expect(await b.resolve(rec.key)).toBe("persist");
    expect((await b.get("persist"))!.key).toBe(rec.key);
  });
});

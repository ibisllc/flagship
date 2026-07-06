import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadProviders() {
  const path = resolve(__dirname, "..", "public", "webapp", "providers.js");
  return import(pathToFileURL(path).href);
}

describe("webapp providers — wrap/unwrap interop with the UMK-derived KEK", () => {
  it("PROMO_ID and SUPPORTED_PROVIDERS are stable", async () => {
    const p = await loadProviders();
    expect(p.PROMO_ID).toBe("flagship-promo");
    expect(p.SUPPORTED_PROVIDERS).toEqual([
      "anthropic",
      "flagship",
      "google",
      "ollama",
      "openai",
      "openrouter",
    ]);
  });

  it("isValidEntry rejects unsupported providers, malformed labels, and over-long keys", async () => {
    const { _testing } = await loadProviders();
    const valid = (over = {}) => ({
      id: "abc",
      provider: "anthropic",
      label: "personal",
      apiKey: "sk-test",
      ...over,
    });
    expect(_testing.isValidEntry(valid())).toBe(true);
    expect(_testing.isValidEntry(valid({ provider: "fake-provider" }))).toBe(false);
    expect(_testing.isValidEntry(valid({ label: "" }))).toBe(false);
    expect(_testing.isValidEntry(valid({ apiKey: "x".repeat(2000) }))).toBe(false);
    expect(_testing.isValidEntry(valid({ baseUrl: "x".repeat(300) }))).toBe(false);
    expect(_testing.isValidEntry(null)).toBe(false);
    // The flagship (free-credits) provider + its promo source tag are valid.
    expect(_testing.isValidEntry(valid({ provider: "flagship", source: "promo" }))).toBe(true);
    expect(_testing.isValidEntry(valid({ source: "bogus" }))).toBe(false);
  });

  it("wrap → unwrap roundtrips the providers list under a UMK-derived AES-GCM key", async () => {
    const p = await loadProviders();
    const seed = new Uint8Array(32).fill(0x42);
    const list = {
      activeId: "abc",
      entries: [
        { id: "abc", provider: "anthropic", label: "personal", apiKey: "sk-x" },
        { id: "def", provider: "openai", label: "work", apiKey: "sk-y", defaultModel: "gpt-4" },
      ],
    };
    const wrapped = await p._testing.wrapList(seed, list);
    expect(wrapped.version).toBe(1);
    expect(wrapped.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(wrapped.ciphertext).toMatch(/^[0-9a-f]+$/);
    const back = await p._testing.unwrapList(seed, wrapped);
    expect(back).toEqual(list);
  });

  it("wrong UMK seed cannot unwrap (AES-GCM tag mismatch — providers can't be opened cross-device)", async () => {
    const p = await loadProviders();
    const seedA = new Uint8Array(32).fill(1);
    const seedB = new Uint8Array(32).fill(2);
    const wrapped = await p._testing.wrapList(seedA, {
      activeId: "x",
      entries: [{ id: "x", provider: "anthropic", label: "p", apiKey: "k" }],
    });
    await expect(p._testing.unwrapList(seedB, wrapped)).rejects.toBeDefined();
  });

  it("each wrap uses a fresh nonce so re-wrapping the same list produces different ciphertext", async () => {
    const p = await loadProviders();
    const seed = new Uint8Array(32).fill(7);
    const list = {
      activeId: "x",
      entries: [{ id: "x", provider: "openai", label: "p", apiKey: "k" }],
    };
    const a = await p._testing.wrapList(seed, list);
    const b = await p._testing.wrapList(seed, list);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

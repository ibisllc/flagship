/**
 * Transient BYOK credential store — sealed at rest, survives restart,
 * never leaks the apiKey value on disk in plaintext.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import {
  FileBuildCredentialStore,
  InMemoryBuildCredentialStore,
  type BuildCredentialStore,
} from "../../src/llm/buildCredentialStore.js";

const swk = deriveSWK({ seed: new Uint8Array(32).fill(9) }, "srv-cred");
const otherSwk = deriveSWK({ seed: new Uint8Array(32).fill(1) }, "srv-cred");

const SECRET = "sk-LIVE-do-not-leak-7a3f";

function runContract(name: string, make: () => Promise<BuildCredentialStore>) {
  describe(`${name} — contract`, () => {
    it("seal/unseal roundtrip preserves provider + apiKey + baseUrl", async () => {
      const s = await make();
      await s.put("b1", { provider: "anthropic", apiKey: SECRET, baseUrl: "https://api.example" });
      const got = await s.get("b1");
      expect(got).toEqual({ provider: "anthropic", apiKey: SECRET, baseUrl: "https://api.example" });
    });

    it("has() + providerName() report the non-secret surface only", async () => {
      const s = await make();
      expect(s.has("b1")).toBe(false);
      expect(s.providerName("b1")).toBeNull();
      await s.put("b1", { provider: "openai", apiKey: SECRET });
      expect(s.has("b1")).toBe(true);
      // providerName surfaces the NAME only — never the key.
      expect(s.providerName("b1")).toBe("openai");
    });

    it("forget() clears the credential (idempotent)", async () => {
      const s = await make();
      await s.put("b1", { provider: "openai", apiKey: SECRET });
      await s.forget("b1");
      expect(await s.get("b1")).toBeNull();
      expect(s.has("b1")).toBe(false);
      await s.forget("b1"); // idempotent
    });
  });
}

runContract("InMemoryBuildCredentialStore", async () => new InMemoryBuildCredentialStore());

describe("FileBuildCredentialStore — sealed at rest + restart", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cred-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runContract("FileBuildCredentialStore", async () => {
    const d = await mkdtemp(join(tmpdir(), "cred-c-"));
    const s = new FileBuildCredentialStore(d, swk);
    await s.load();
    return s;
  });

  it("survives a restart (re-load from disk repopulates the cache)", async () => {
    const a = new FileBuildCredentialStore(dir, swk);
    await a.put("build-7", { provider: "google", apiKey: SECRET, baseUrl: "https://g.example" });
    const b = new FileBuildCredentialStore(dir, swk);
    await b.load();
    expect(await b.get("build-7")).toEqual({
      provider: "google",
      apiKey: SECRET,
      baseUrl: "https://g.example",
    });
    expect(b.has("build-7")).toBe(true);
    expect(b.providerName("build-7")).toBe("google");
  });

  it("NEVER writes the apiKey value to disk in plaintext", async () => {
    const s = new FileBuildCredentialStore(dir, swk);
    await s.put("b9", { provider: "anthropic", apiKey: SECRET });
    const files = await readdir(dir);
    expect(files).toContain("b9.cred");
    for (const f of files) {
      const raw = await readFile(join(dir, f), "utf8");
      expect(raw).not.toContain(SECRET);
      // The on-disk form is hex of (nonce || ciphertext) — nothing else.
      expect(raw).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("a wrong SWK cannot unseal a stored credential (drops it, never crashes)", async () => {
    const a = new FileBuildCredentialStore(dir, swk);
    await a.put("b1", { provider: "openai", apiKey: SECRET });
    const wrong = new FileBuildCredentialStore(dir, otherSwk);
    await wrong.load();
    expect(await wrong.get("b1")).toBeNull();
  });

  it("rejects a malformed credential on put", async () => {
    const s = new FileBuildCredentialStore(dir, swk);
    // @ts-expect-error — deliberately wrong shape
    await expect(s.put("bx", { provider: "openai" })).rejects.toThrow();
  });
});

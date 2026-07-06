/**
 * Transient BYOK credential store — sealed at rest, survives restart,
 * never leaks the apiKey value on disk in plaintext.
 */

import type { Dirent } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import { swkOps } from "../helpers/keyCustody.js";
import {
  FileBuildCredentialStore,
  InMemoryBuildCredentialStore,
  type BuildCredentialStore,
} from "../../src/llm/buildCredentialStore.js";

const swk = swkOps(deriveSWK({ seed: new Uint8Array(32).fill(9) }, "srv-cred"));
const otherSwk = swkOps(deriveSWK({ seed: new Uint8Array(32).fill(1) }, "srv-cred"));

const SECRET = "sk-LIVE-do-not-leak-7a3f";

// Mint-shaped build ids: the orchestrator mints `randomBytes(8).toString("hex")`
// = 16 lowercase hex. The File store now validates against exactly this shape,
// so the contract exercises real ids.
const ID = "0123456789abcdef";
const ID2 = "fedcba9876543210";

function runContract(name: string, make: () => Promise<BuildCredentialStore>) {
  describe(`${name} — contract`, () => {
    it("seal/unseal roundtrip preserves provider + apiKey + baseUrl", async () => {
      const s = await make();
      await s.put(ID, { provider: "anthropic", apiKey: SECRET, baseUrl: "https://api.example" });
      const got = await s.get(ID);
      expect(got).toEqual({ provider: "anthropic", apiKey: SECRET, baseUrl: "https://api.example" });
    });

    it("roundtrips a promo-sourced credential (source pins the daemon SSRF guard)", async () => {
      const s = await make();
      await s.put(ID, {
        provider: "flagship",
        apiKey: "scoped-token",
        baseUrl: "https://coder.runpod.example.com",
        source: "promo",
      });
      const got = await s.get(ID);
      expect(got).toEqual({
        provider: "flagship",
        apiKey: "scoped-token",
        baseUrl: "https://coder.runpod.example.com",
        source: "promo",
      });
    });

    it("has() + providerName() report the non-secret surface only", async () => {
      const s = await make();
      expect(s.has(ID)).toBe(false);
      expect(s.providerName(ID)).toBeNull();
      await s.put(ID, { provider: "openai", apiKey: SECRET });
      expect(s.has(ID)).toBe(true);
      // providerName surfaces the NAME only — never the key.
      expect(s.providerName(ID)).toBe("openai");
    });

    it("forget() clears the credential (idempotent)", async () => {
      const s = await make();
      await s.put(ID, { provider: "openai", apiKey: SECRET });
      await s.forget(ID);
      expect(await s.get(ID)).toBeNull();
      expect(s.has(ID)).toBe(false);
      await s.forget(ID); // idempotent
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
    await a.put(ID, { provider: "google", apiKey: SECRET, baseUrl: "https://g.example" });
    const b = new FileBuildCredentialStore(dir, swk);
    await b.load();
    expect(await b.get(ID)).toEqual({
      provider: "google",
      apiKey: SECRET,
      baseUrl: "https://g.example",
    });
    expect(b.has(ID)).toBe(true);
    expect(b.providerName(ID)).toBe("google");
  });

  it("NEVER writes the apiKey value to disk in plaintext", async () => {
    const s = new FileBuildCredentialStore(dir, swk);
    await s.put(ID, { provider: "anthropic", apiKey: SECRET });
    const files = await readdir(dir);
    expect(files).toContain(`${ID}.cred`);
    for (const f of files) {
      const raw = await readFile(join(dir, f), "utf8");
      expect(raw).not.toContain(SECRET);
      // The on-disk form is hex of (nonce || ciphertext) — nothing else.
      expect(raw).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("a wrong SWK cannot unseal a stored credential (drops it, never crashes)", async () => {
    const a = new FileBuildCredentialStore(dir, swk);
    await a.put(ID, { provider: "openai", apiKey: SECRET });
    const wrong = new FileBuildCredentialStore(dir, otherSwk);
    await wrong.load();
    expect(await wrong.get(ID)).toBeNull();
  });

  it("rejects a malformed credential on put", async () => {
    const s = new FileBuildCredentialStore(dir, swk);
    // @ts-expect-error — deliberately wrong shape
    await expect(s.put(ID, { provider: "openai" })).rejects.toThrow();
  });
});

describe("FileBuildCredentialStore — path-traversal safety", () => {
  let dir: string;
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "cred-traversal-"));
    // The store dir is a CHILD of `parent`, so a `..` escape lands a file in
    // `parent` (or below) — observable, and asserted against.
    dir = join(parent, "store");
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  // A few shapes a hostile / non-mint URL-derived id could take. The HTTP
  // layer URL-decodes the path segment before it ever reaches the store, so
  // these are the DECODED ids the store must refuse.
  const HOSTILE_IDS = [
    "../../etc/cron.d/x",
    "..%2F..%2Fx", // a still-encoded id (no second decode happens, but the `.`/`%` must still be refused)
    "a/b",
    "a\\b",
    "with\0null",
    "..",
    "", // empty
    "ABCDEF0123456789", // uppercase — not the lowercase-hex mint shape
    "0123456789abcde", // 15 chars — wrong length
    "0123456789abcdef0", // 17 chars — wrong length
  ];

  it("put() rejects a non-mint-shaped id and writes nothing outside the store dir", async () => {
    const s = new FileBuildCredentialStore(dir, swk);
    for (const id of HOSTILE_IDS) {
      await expect(s.put(id, { provider: "anthropic", apiKey: SECRET })).rejects.toThrow(/invalid build id/);
      expect(s.has(id)).toBe(false);
    }
    // Nothing escaped: `parent` holds ONLY the (possibly absent) store dir, no
    // stray `.cred` (or `.cred.tmp`) files anywhere in the tree.
    await assertNoCredEscaped(parent, dir);
  });

  it("forget() is a no-op for a non-mint-shaped id (idempotent, traversal-safe)", async () => {
    // Pre-seed a real file in `parent` that a `..` escape could target, to
    // prove forget() never deletes outside the store via a crafted id.
    const victim = join(parent, "victim.cred");
    await writeFile(victim, "keep me", "utf8");
    const s = new FileBuildCredentialStore(dir, swk);
    for (const id of HOSTILE_IDS) {
      await expect(s.forget(id)).resolves.toBeUndefined(); // never throws, never deletes
    }
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("a valid mint-shaped id still writes inside the store dir only", async () => {
    const s = new FileBuildCredentialStore(dir, swk);
    await s.put(ID, { provider: "anthropic", apiKey: SECRET });
    expect(await s.get(ID)).toEqual({ provider: "anthropic", apiKey: SECRET });
    const files = await readdir(dir);
    expect(files).toEqual([`${ID}.cred`]);
    // The escape-scan confirms the only `.cred` is the legit one inside `dir`.
    await assertNoCredEscaped(parent, dir);
  });
});

/**
 * Walk `root` and assert that every `.cred` / `.cred.tmp` file lives strictly
 * inside `storeDir` — i.e. none escaped via a traversal id.
 */
async function assertNoCredEscaped(root: string, storeDir: string): Promise<void> {
  const stray: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // dir may not exist (store never created) — fine
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith(".cred") || e.name.endsWith(".cred.tmp")) {
        const insideStore = full === join(storeDir, e.name);
        if (!insideStore) stray.push(full);
      }
    }
  }
  await walk(root);
  expect(stray).toEqual([]);
}

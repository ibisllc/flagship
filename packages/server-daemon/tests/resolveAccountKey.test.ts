/**
 * Tests for resolveAccountKey — the helper that gates the ACME account
 * key on daemon boot. The most important property is that a
 * `saveAccountKey()` failure becomes a hard boot error rather than a
 * silent fallback. A silent fallback would burn a fresh LE account on
 * every restart and ultimately exhaust LE's per-IP issuance cap.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveAccountKey } from "../src/runtime.js";

function fakeStore(overrides: {
  load?: () => Promise<string | null>;
  save?: (pem: string) => Promise<void>;
}): {
  loadAccountKey(): Promise<string | null>;
  saveAccountKey(pem: string): Promise<void>;
} {
  return {
    loadAccountKey: overrides.load ?? (async () => null),
    saveAccountKey: overrides.save ?? (async () => {}),
  };
}

describe("resolveAccountKey", () => {
  it("returns explicitPem unchanged when supplied (env-var path)", async () => {
    const r = await resolveAccountKey({
      explicitPem: "-----BEGIN PRIVATE KEY-----\nenv-key\n-----END PRIVATE KEY-----\n",
      store: null,
      createPrivateKey: async () => {
        throw new Error("should not mint when explicit is supplied");
      },
    });
    expect(r).toMatch(/env-key/);
  });

  it("loads from disk when a store is configured and the file exists", async () => {
    const store = fakeStore({
      load: async () => "-----disk-key-----",
      save: async () => {
        throw new Error("should not save when load hit");
      },
    });
    const r = await resolveAccountKey({
      explicitPem: undefined,
      store,
      createPrivateKey: async () => {
        throw new Error("should not mint when disk hit");
      },
    });
    expect(r).toBe("-----disk-key-----");
  });

  it("mints + persists a fresh key when disk + env are both empty", async () => {
    const saves: string[] = [];
    const generated: string[] = [];
    const store = fakeStore({
      load: async () => null,
      save: async (pem) => {
        saves.push(pem);
      },
    });
    const r = await resolveAccountKey({
      explicitPem: undefined,
      store,
      createPrivateKey: async () => "-----fresh-key-----",
      onGenerated: (pem) => generated.push(pem),
    });
    expect(r).toBe("-----fresh-key-----");
    expect(saves).toEqual(["-----fresh-key-----"]);
    expect(generated).toEqual(["-----fresh-key-----"]);
  });

  it("throws a clear error when saveAccountKey fails — boot MUST refuse", async () => {
    // The whole point of Task #19: a saveAccountKey failure that
    // silently fell back to in-memory would burn a fresh LE account on
    // every daemon crash. Make sure the failure surfaces.
    const onGenerated = vi.fn();
    const store = fakeStore({
      load: async () => null,
      save: async () => {
        throw new Error("EACCES: permission denied, write '/var/flagship/acme/account.pem.tmp'");
      },
    });
    await expect(
      resolveAccountKey({
        explicitPem: undefined,
        store,
        createPrivateKey: async () => "-----fresh-key-----",
        onGenerated,
      }),
    ).rejects.toThrow(/failed to persist fresh ACME account key/);
    await expect(
      resolveAccountKey({
        explicitPem: undefined,
        store,
        createPrivateKey: async () => "-----fresh-key-----",
        onGenerated,
      }),
    ).rejects.toThrow(/EACCES/);
    // onGenerated must NOT be called when the persistence step failed —
    // otherwise observers think we successfully minted a key when in
    // fact we're about to lose it.
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("works without a store (in-memory mode for tests / dev): no save, no load, just mint", async () => {
    const generated: string[] = [];
    const r = await resolveAccountKey({
      explicitPem: undefined,
      store: null,
      createPrivateKey: async () => "-----in-mem-key-----",
      onGenerated: (pem) => generated.push(pem),
    });
    expect(r).toBe("-----in-mem-key-----");
    expect(generated).toEqual(["-----in-mem-key-----"]);
  });

  it("preserves the underlying error via the `cause` chain (for log forensics)", async () => {
    const underlying = new Error("EIO: i/o error");
    const store = fakeStore({
      load: async () => null,
      save: async () => {
        throw underlying;
      },
    });
    try {
      await resolveAccountKey({
        explicitPem: undefined,
        store,
        createPrivateKey: async () => "x",
      });
      expect.fail("expected resolveAccountKey to throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/EIO/);
      expect((e as Error & { cause?: unknown }).cause).toBe(underlying);
    }
  });
});

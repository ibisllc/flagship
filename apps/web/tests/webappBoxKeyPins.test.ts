// The browser pins each server's box key the first time it learns it and
// refuses to seal anything to another key `.com` later lists for that server
// (lib/boxKeyPins.js; shared vectors in packages/protocol/test-vectors/box-key-pin).
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveIRK, deriveSTK, sealForEd25519Recipient } from "@flagship/protocol";
import {
  BoxKeyChangedError,
  acceptBootKeyBinding,
  canonicalBootKeyBinding,
  decideBoxKeyPin,
  observePods,
  pinnedBootKey,
  pinnedBoxKey,
  repinBoxKey,
  requirePinnedBoxKey,
  verifyBootKeyBinding,
} from "../public/webapp/lib/boxKeyPins.js";
import { enableLongLived } from "../public/webapp/lib/leases.js";

const v = JSON.parse(readFileSync(join(__dirname, "../../../packages/protocol/test-vectors/box-key-pin/vectors.json"), "utf8"));
const U = "plucky-avocet";
const D = v.serverDomain as string;
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, val: string) => void m.set(k, val) };
};

describe("box key pins: shared vectors", () => {
  it("decides first / match / mismatch / invalid", () => {
    for (const d of v.decisions) expect(decideBoxKeyPin(d.pinned, d.reported)).toBe(d.verdict);
  });

  it("verifies a boot-key binding only under the pinned STK and for its server", async () => {
    const b = v.bootKeyBinding;
    expect(new TextDecoder().decode(canonicalBootKeyBinding(b.binding))).toBe(b.canonical);
    const stk = unhex(v.stkPubHex);
    expect(await verifyBootKeyBinding(b.binding, unhex(b.signatureHex), stk, D)).toBe(b.expect.signatureUnderPinnedStk);
    expect(await verifyBootKeyBinding(b.binding, unhex(b.signedByOtherKeyHex), stk, D)).toBe(b.expect.signedByOtherKeyUnderPinnedStk);
    expect(await verifyBootKeyBinding(b.binding, unhex(b.signatureHex), unhex(v.otherPubHex), D)).toBe(b.expect.signatureUnderOtherKey);
    expect(await verifyBootKeyBinding(b.binding, unhex(b.signatureHex), stk, b.expect.otherServerDomain)).toBe(b.expect.signatureForOtherServer);
  });
});

describe("box key pins", () => {
  it("pins on first sight, passes the same key, refuses a substituted one", () => {
    const deps = { pinStorage: memStorage() };
    expect(requirePinnedBoxKey(U, D, v.stkPubHex, deps)).toBe(v.stkPubHex);
    expect(requirePinnedBoxKey(U, D.toUpperCase(), v.stkPubHex.toUpperCase(), deps)).toBe(v.stkPubHex);
    let caught: unknown;
    try { requirePinnedBoxKey(U, D, v.otherPubHex, deps); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BoxKeyChangedError);
    expect((caught as Error).message).toMatch(/identity key changed/);
    expect(pinnedBoxKey(U, D, deps)).toBe(v.stkPubHex);
  });

  it("re-pinning (a reinstall here, or Trust its new key) moves the pin and drops the old boot key", async () => {
    const deps = { pinStorage: memStorage() };
    requirePinnedBoxKey(U, D, v.stkPubHex, deps);
    const b = v.bootKeyBinding;
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signatureHex, deps)).toBe(b.binding.bootPubHex);
    repinBoxKey(U, D, v.otherPubHex, deps);
    expect(requirePinnedBoxKey(U, D, v.otherPubHex, deps)).toBe(v.otherPubHex);
    expect(() => requirePinnedBoxKey(U, D, v.stkPubHex, deps)).toThrow(BoxKeyChangedError);
    expect(pinnedBootKey(U, D, deps)).toBeNull();
  });

  it("takes a boot key only from a binding the pinned STK signed", async () => {
    const deps = { pinStorage: memStorage() };
    const b = v.bootKeyBinding;
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signatureHex, deps)).toBeNull();
    requirePinnedBoxKey(U, D, v.stkPubHex, deps);
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signedByOtherKeyHex, deps)).toBeNull();
    expect(pinnedBootKey(U, D, deps)).toBeNull();
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signatureHex, deps)).toBe(b.binding.bootPubHex);
  });

  it("observing /pods pins new servers but never moves an existing pin", () => {
    const deps = { pinStorage: memStorage() };
    observePods(U, [{ serverDomain: D, identityPubKey: v.stkPubHex }], deps);
    observePods(U, [{ serverDomain: D, identityPubKey: v.otherPubHex }], deps);
    expect(pinnedBoxKey(U, D, deps)).toBe(v.stkPubHex);
  });

  it("an auto-unlock lease is never sealed to a substituted key", async () => {
    const pinStorage = memStorage();
    const umkSeed = new Uint8Array(32).fill(7);
    const irk = deriveIRK({ seed: umkSeed });
    const real = deriveSTK(new Uint8Array(32).fill(9));
    const rogue = deriveSTK(new Uint8Array(32).fill(10));
    repinBoxKey(U, D, hex(real.publicKey), { pinStorage });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/sealed-luks-key")) {
        return new Response(JSON.stringify({ sealedKey: hex(sealForEd25519Recipient(new Uint8Array(32).fill(1), irk.publicKey)) }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    await expect(
      enableLongLived(D, 1000, {
        session: { umk: umkSeed, username: U },
        fetch,
        pinStorage,
        signWithIrk: async (_u: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, irk.privateKey),
        boxStk: async () => hex(rogue.publicKey),
        readSuspension: async () => ({ suspended: false, epoch: 0, seq: 0 }),
        deadMan: null,
      }),
    ).rejects.toBeInstanceOf(BoxKeyChangedError);
    expect(fetch.mock.calls.some(([u]) => String(u).includes("sealed-luks-key") || String(u).includes("lease-v2"))).toBe(false);
  });
});

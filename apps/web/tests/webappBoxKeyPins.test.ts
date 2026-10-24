// The browser seals only to the key it pinned at first contact (lib/serverPins.js, the one pin
// store) and refuses another key `.com` later lists for that server; nothing pins a key because
// `.com` lists it (lib/boxKeyPins.js; shared vectors in packages/protocol/test-vectors/box-key-pin).
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { _test as pinsTest, pinServerKey, pinnedStk, serverKeyChanged } from "../public/webapp/lib/serverPins.js";

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
  beforeEach(() => {
    vi.stubGlobal("localStorage", memStorage());
    pinsTest.reset();
  });

  it("never pins on first sight: an unpinned server gets nothing sealed", () => {
    let caught: unknown;
    try { requirePinnedBoxKey(U, D, v.stkPubHex); } catch (e) { caught = e; }
    expect((caught as { code?: string }).code).toBe("server-not-pinned");
    expect(pinnedBoxKey(U, D)).toBeNull();
    expect(pinnedStk(D)).toBeNull();
  });

  it("passes the key first contact pinned and refuses a substituted one", () => {
    pinServerKey(D, v.stkPubHex, "proof");
    expect(requirePinnedBoxKey(U, D, v.stkPubHex)).toBe(v.stkPubHex);
    expect(requirePinnedBoxKey(U, D.toUpperCase(), v.stkPubHex.toUpperCase())).toBe(v.stkPubHex);
    let caught: unknown;
    try { requirePinnedBoxKey(U, D, v.otherPubHex); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BoxKeyChangedError);
    expect((caught as Error).message).toBe("This server's key changed. If you did not rebuild it, do not approve anything for it.");
    expect(serverKeyChanged(D)).toBe(true);
    expect(pinnedBoxKey(U, D)).toBe(v.stkPubHex);
  });

  it("re-pinning (the owner's explicit re-trust) moves the pin and drops the old boot key", async () => {
    pinServerKey(D, v.stkPubHex, "proof");
    const b = v.bootKeyBinding;
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signatureHex)).toBe(b.binding.bootPubHex);
    expect(pinnedBootKey(U, D)).toBe(b.binding.bootPubHex);
    repinBoxKey(U, D, v.otherPubHex);
    expect(requirePinnedBoxKey(U, D, v.otherPubHex)).toBe(v.otherPubHex);
    expect(() => requirePinnedBoxKey(U, D, v.stkPubHex)).toThrow(BoxKeyChangedError);
    expect(pinnedBootKey(U, D)).toBeNull();
  });

  it("takes a boot key only from a binding the pinned STK signed, kept in the one pin store", async () => {
    const b = v.bootKeyBinding;
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signatureHex)).toBeNull();
    pinServerKey(D, v.stkPubHex, "proof");
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signedByOtherKeyHex)).toBeNull();
    expect(pinnedBootKey(U, D)).toBeNull();
    expect(await acceptBootKeyBinding(U, D, b.binding, b.signatureHex)).toBe(b.binding.bootPubHex);
    const stored = JSON.parse(localStorage.getItem("flagship.serverPins.v1")!);
    expect(stored[D.toLowerCase()]).toMatchObject({ stk: v.stkPubHex, boot: b.binding.bootPubHex });
    pinServerKey(D, v.stkPubHex, "proof");
    expect(pinnedBootKey(U, D)).toBe(b.binding.bootPubHex);
  });

  it("observing /pods never pins, and notes a key that differs from the pin", () => {
    observePods(U, [{ serverDomain: D, identityPubKey: v.stkPubHex }]);
    expect(pinnedBoxKey(U, D)).toBeNull();
    pinServerKey(D, v.stkPubHex, "proof");
    observePods(U, [{ serverDomain: D, identityPubKey: v.otherPubHex }]);
    expect(pinnedBoxKey(U, D)).toBe(v.stkPubHex);
    expect(serverKeyChanged(D)).toBe(true);
  });

  it("an auto-unlock lease is never sealed to a substituted key", async () => {
    const umkSeed = new Uint8Array(32).fill(7);
    const irk = deriveIRK({ seed: umkSeed });
    const real = deriveSTK(new Uint8Array(32).fill(9));
    const rogue = deriveSTK(new Uint8Array(32).fill(10));
    pinServerKey(D, hex(real.publicKey), "proof");
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
        signWithIrk: async (_u: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, irk.privateKey),
        boxStk: async () => hex(rogue.publicKey),
        readSuspension: async () => ({ suspended: false, epoch: 0, seq: 0 }),
        deadMan: null,
      }),
    ).rejects.toBeInstanceOf(BoxKeyChangedError);
    expect(fetch.mock.calls.some(([u]) => String(u).includes("sealed-luks-key") || String(u).includes("lease-v2"))).toBe(false);
  });
});

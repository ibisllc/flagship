// Tier-1 "Lock with PIN code" — webapp crypto + store (lib/pinLock.js).
//
// We exercise the REAL shipping module against an in-memory KV + a fixed
// "device pepper" via the module's dependency seam (so the test needs no
// IndexedDB / non-extractable CryptoKey — just WebCrypto + argon2id, both
// present in Node). The roundtrip, the 5-try lockout-then-wipe, the
// device-binding (a different pepper can't unwrap), and the
// passphrase-reset contract are all real, not mocked.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MOD_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/pinLock.js"),
).href;

async function loadPin() {
  return import(MOD_URL);
}

/** In-memory KV mirroring keystore.js kvGet/kvPut/kvDel. */
function makeKv() {
  const m = new Map<string, unknown>();
  return {
    map: m,
    get: async (k: string) => m.get(k),
    put: async (k: string, v: unknown) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
  };
}

const PEPPER_A = new Uint8Array(32).fill(0xa1);
const PEPPER_B = new Uint8Array(32).fill(0xb2);

function seedOf(byte: number) {
  return new Uint8Array(32).fill(byte);
}

function deps(kv = makeKv(), pepper = PEPPER_A) {
  return { kv, pepper, profileId: "test" };
}

describe("pinLock — validation", () => {
  it("accepts 4–6 digit numeric PINs, rejects the rest", async () => {
    const pin = await loadPin();
    expect(pin.isValidPin("1234")).toBe(true);
    expect(pin.isValidPin("123456")).toBe(true);
    expect(pin.isValidPin("123")).toBe(false); // too short
    expect(pin.isValidPin("1234567")).toBe(false); // too long
    expect(pin.isValidPin("12a4")).toBe(false); // non-numeric
    expect(pin.isValidPin("")).toBe(false);
  });
});

describe("pinLock — set / unlock roundtrip", () => {
  it("unlocks with the correct PIN and returns the same seed", async () => {
    const pin = await loadPin();
    const d = deps();
    const seed = seedOf(7);
    await pin.setPin("1234", seed, d);
    expect(await pin.hasPin(d)).toBe(true);
    const got = await pin.unlockWithPin("1234", d);
    expect(Array.from(got)).toEqual(Array.from(seed));
  });

  it("setPin rejects a non-32-byte seed and an invalid PIN", async () => {
    const pin = await loadPin();
    const d = deps();
    await expect(pin.setPin("1234", new Uint8Array(16), d)).rejects.toThrow();
    await expect(pin.setPin("12", seedOf(1), d)).rejects.toThrow();
  });
});

describe("pinLock — brute-force lockout", () => {
  it("counts down on wrong PINs, then on the 5th wipes the PIN", async () => {
    const pin = await loadPin();
    const d = deps();
    await pin.setPin("1234", seedOf(9), d);

    // 4 wrong tries → remaining decrements, PIN still set.
    for (let i = 1; i <= 4; i++) {
      await expect(pin.unlockWithPin("0000", d)).rejects.toMatchObject({
        remaining: pin.MAX_ATTEMPTS - i,
      });
    }
    expect(await pin.hasPin(d)).toBe(true);

    // 5th wrong try → lockout + PIN wiped.
    await expect(pin.unlockWithPin("0000", d)).rejects.toMatchObject({ lockedOut: true });
    expect(await pin.hasPin(d)).toBe(false);
  });

  it("a correct unlock resets the attempt counter", async () => {
    const pin = await loadPin();
    const d = deps();
    await pin.setPin("1234", seedOf(3), d);
    await expect(pin.unlockWithPin("0000", d)).rejects.toMatchObject({ remaining: 4 });
    await pin.unlockWithPin("1234", d); // correct → reset
    expect(await pin.remainingAttempts(d)).toBe(pin.MAX_ATTEMPTS);
  });
});

describe("pinLock — verifyPin (Change-PIN gate)", () => {
  it("returns true only for the correct PIN and never touches the counter", async () => {
    const pin = await loadPin();
    const d = deps();
    await pin.setPin("4321", seedOf(5), d);
    expect(await pin.verifyPin("0000", d)).toBe(false);
    expect(await pin.verifyPin("0000", d)).toBe(false);
    expect(await pin.remainingAttempts(d)).toBe(pin.MAX_ATTEMPTS); // unchanged
    expect(await pin.verifyPin("4321", d)).toBe(true);
  });
});

describe("pinLock — device binding (the pepper)", () => {
  it("a PIN wrapped under one device pepper cannot be unwrapped under another", async () => {
    const pin = await loadPin();
    const kv = makeKv();
    // Wrap with pepper A...
    await pin.setPin("1234", seedOf(8), { kv, pepper: PEPPER_A, profileId: "test" });
    // ...unwrapping with the SAME correct PIN but a DIFFERENT pepper fails
    // (proves brute force can't proceed without the non-extractable key).
    await expect(
      pin.unlockWithPin("1234", { kv, pepper: PEPPER_B, profileId: "test" }),
    ).rejects.toBeDefined();
    // And the correct pepper still works.
    const got = await pin.unlockWithPin("1234", { kv, pepper: PEPPER_A, profileId: "test" });
    expect(got.length).toBe(32);
  });
});

describe("pinLock — clearPin (the reset rule)", () => {
  it("removes the PIN and its counter; hasPin goes false", async () => {
    const pin = await loadPin();
    const d = deps();
    await pin.setPin("1234", seedOf(2), d);
    await expect(pin.unlockWithPin("0000", d)).rejects.toMatchObject({ remaining: 4 });
    await pin.clearPin(d);
    expect(await pin.hasPin(d)).toBe(false);
    expect(await pin.remainingAttempts(d)).toBe(pin.MAX_ATTEMPTS);
    // After clear, unlocking throws the no-PIN signal.
    await expect(pin.unlockWithPin("1234", d)).rejects.toMatchObject({ noPin: true });
  });
});

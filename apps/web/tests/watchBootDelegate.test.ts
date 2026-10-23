import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  buildWatchBootDeposit,
  canonicalWatchBootDelegate,
  openWatchBootKey,
  WATCH_BOOT_MAX_MS,
} from "../public/webapp/lib/watchBootDelegate.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/watch-boot-delegate/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("web watch-boot-delegate", () => {
  it("matches the shared vector: canonical bytes, signature, sealed copy", async () => {
    const bytes = canonicalWatchBootDelegate(v.deposit);
    expect(new TextDecoder().decode(bytes)).toBe(v.canonical);
    expect(ed25519.verify(hex(v.deposit.signatureHex), bytes, hex(v.accountPubHex))).toBe(true);
    expect(toHex((await openWatchBootKey(v.deposit, hex(v.decryptPrivHex)))!)).toBe(v.diskKeyHex);
  });

  it("every other server, watch key, digest or window fails the same signature", () => {
    for (const bad of v.invalid) {
      const bytes = canonicalWatchBootDelegate(bad.delegate);
      expect(new TextDecoder().decode(bytes), bad.name).toBe(bad.canonical);
      expect(ed25519.verify(hex(v.deposit.signatureHex), bytes, hex(v.accountPubHex)), bad.name).toBe(false);
    }
  });

  it("a built deposit opens with the matching key only; a longer window is refused", async () => {
    const acct = crypto.getRandomValues(new Uint8Array(32));
    const dec = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", dec.privateKey));
    const priv = pkcs8.slice(pkcs8.length - 32);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", dec.publicKey));
    const disk = new Uint8Array(32).fill(0x42);
    const dep = await buildWatchBootDeposit(
      { serverDomain: "Kitchen.Alice.flagship.services", diskKey: disk, delegatePub: new Uint8Array(32).fill(7), decryptPub: pub, issuedAt: 1000, expiresAt: 61000 },
      (b: Uint8Array) => ed25519.sign(b, acct),
    );
    expect(dep.serverDomain).toBe("kitchen.alice.flagship.services");
    expect(ed25519.verify(hex(dep.signatureHex), canonicalWatchBootDelegate(dep), ed25519.getPublicKey(acct))).toBe(true);
    expect(await openWatchBootKey(dep, priv)).toEqual(disk);
    expect(await openWatchBootKey(dep, new Uint8Array(32).fill(1))).toBeNull();
    await expect(buildWatchBootDeposit(
      { serverDomain: "k.a.flagship.services", diskKey: disk, delegatePub: new Uint8Array(32), decryptPub: pub, issuedAt: 0, expiresAt: WATCH_BOOT_MAX_MS + 1 },
      () => new Uint8Array(64),
    )).rejects.toThrow();
  });
});

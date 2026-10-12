import { describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
import { importX25519Private } from "../public/webapp/lib/x25519.js";

describe("X25519 private keys reach WebCrypto as PKCS#8", () => {
  it("derives the same shared secret as Node's own X25519", async () => {
    const mine = generateKeyPairSync("x25519");
    const peer = generateKeyPairSync("x25519");
    // The raw 32-byte scalar, as the webapp derives it from its Ed25519 seed.
    const der = mine.privateKey.export({ format: "der", type: "pkcs8" });
    const scalar = new Uint8Array(der.subarray(der.length - 32));
    const key = await importX25519Private(scalar);
    const peerRaw = new Uint8Array(peer.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const peerKey = await crypto.subtle.importKey("raw", peerRaw, "X25519", false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peerKey }, key, 256));
    const expected = diffieHellman({ privateKey: createPrivateKey(mine.privateKey.export({ format: "pem", type: "pkcs8" })), publicKey: createPublicKey(peer.publicKey.export({ format: "pem", type: "spki" })) });
    expect(Buffer.from(shared).equals(expected)).toBe(true);
  });

  it("is the only way the webapp imports an X25519 private key", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../public/webapp/lib");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "x25519.js")) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/importKey\(\s*"raw",[^)]*"X25519",\s*false,\s*\["deriveBits"\]/);
    }
  });
});

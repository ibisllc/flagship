import { describe, expect, it } from "vitest";
import { ed, parseAuthTime, verifyAuthTime, type CaTrustChain } from "@flagship/protocol";
import { handleAuthTime } from "../src/pubkeyCert.js";

const priv = new Uint8Array(32).fill(5);
const ca = { keypair: { privateKey: priv, publicKey: ed.getPublicKey(priv) }, issuer: "flagship-ca" };
const chain = { authorizedCaKeys: () => [Buffer.from(ca.keypair.publicKey).toString("hex")] } as unknown as CaTrustChain;
const NONCE = "00112233445566778899aabbccddeeff";

describe("GET /api/auth-time", () => {
  it("signs the caller's nonce with the current time and says not to cache it", async () => {
    const r = await handleAuthTime({ ca, now: () => 1_760_000_000_000 }, NONCE);
    expect(r.status).toBe(200);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const stamp = parseAuthTime((r.body as { stamp: unknown }).stamp)!;
    expect(stamp.nowMs).toBe(1_760_000_000_000);
    expect(verifyAuthTime(stamp, NONCE, chain, "ab".repeat(32))).toEqual({ ok: true });
  });

  it("refuses a missing or malformed nonce", async () => {
    expect((await handleAuthTime({ ca }, null)).status).toBe(400);
    expect((await handleAuthTime({ ca }, "short")).status).toBe(400);
    expect((await handleAuthTime({ ca }, NONCE.toUpperCase())).status).toBe(400);
  });

  it("refuses to sign when the CA gate is enforced and the key is not authorized", async () => {
    const r = await handleAuthTime({ ca, caGate: { caTrustChain: null, enforce: true, log: () => {} } }, NONCE);
    expect(r.status).toBe(403);
  });
});

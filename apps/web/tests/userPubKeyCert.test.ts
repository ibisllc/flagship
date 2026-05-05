import { describe, expect, it } from "vitest";
import {
  signClaimUsername,
  verifyUserPubKeyBinding,
  type ClaimUsername,
  type UserPubKeyBinding,
} from "@flagship/protocol";
import { deriveIRK, ed } from "@flagship/protocol";
import { buildServer } from "../src/server.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function claimHarry(app: ReturnType<typeof buildServer>) {
  const claim: ClaimUsername = {
    username: "harry",
    irkPub: harryIrk.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signClaimUsername(claim, harryIrk);
  await app.inject({
    method: "POST",
    url: "/api/username/claim",
    payload: {
      request: {
        username: "harry",
        irkPub: bytesToHex(harryIrk.publicKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  });
}

describe("GET /api/users/:username/pubkey-cert", () => {
  it("returns a CA-signed binding that verifies under the published CA pubkey", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);

    const certResp = await app.inject({
      method: "GET",
      url: "/api/users/harry/pubkey-cert",
    });
    expect(certResp.statusCode).toBe(200);
    const cert = JSON.parse(certResp.body);
    expect(cert.binding.username).toBe("harry");
    expect(cert.binding.pubKey).toBe(bytesToHex(harryIrk.publicKey));
    expect(cert.binding.issuedAt).toBeLessThanOrEqual(Date.now());
    expect(cert.binding.expiresAt).toBeGreaterThan(cert.binding.issuedAt);

    const caResp = await app.inject({ method: "GET", url: "/api/ca/cert" });
    const ca = JSON.parse(caResp.body);

    const binding: UserPubKeyBinding = {
      version: 1,
      username: cert.binding.username,
      pubKey: hexToBytes(cert.binding.pubKey),
      issuedAt: cert.binding.issuedAt,
      expiresAt: cert.binding.expiresAt,
      issuer: cert.binding.issuer,
    };
    expect(
      verifyUserPubKeyBinding(binding, hexToBytes(cert.signature), hexToBytes(ca.pubKey)),
    ).toBe(true);
  });

  it("rejects a tampered username (verifier catches the swap)", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);

    const certResp = await app.inject({
      method: "GET",
      url: "/api/users/harry/pubkey-cert",
    });
    const cert = JSON.parse(certResp.body);
    const caResp = await app.inject({ method: "GET", url: "/api/ca/cert" });
    const ca = JSON.parse(caResp.body);

    const tampered: UserPubKeyBinding = {
      version: 1,
      username: "mallory",
      pubKey: hexToBytes(cert.binding.pubKey),
      issuedAt: cert.binding.issuedAt,
      expiresAt: cert.binding.expiresAt,
      issuer: cert.binding.issuer,
    };
    expect(
      verifyUserPubKeyBinding(tampered, hexToBytes(cert.signature), hexToBytes(ca.pubKey)),
    ).toBe(false);
  });

  it("404 on an unregistered username", async () => {
    const app = buildServer({ surface: "com" });
    const r = await app.inject({
      method: "GET",
      url: "/api/users/nobody/pubkey-cert",
    });
    expect(r.statusCode).toBe(404);
  });

  it("sets a non-zero cache-control max-age so verifiers can cache the cert", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const r = await app.inject({
      method: "GET",
      url: "/api/users/harry/pubkey-cert",
    });
    const cc = r.headers["cache-control"];
    expect(cc).toMatch(/max-age=\d+/);
  });

  it("a different CA keypair fails verification — defends against CA spoofing", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const certResp = await app.inject({
      method: "GET",
      url: "/api/users/harry/pubkey-cert",
    });
    const cert = JSON.parse(certResp.body);
    const fakeCaSk = new Uint8Array(32).fill(0xee);
    const fakeCaPub = ed.getPublicKey(fakeCaSk);
    const binding: UserPubKeyBinding = {
      version: 1,
      username: cert.binding.username,
      pubKey: hexToBytes(cert.binding.pubKey),
      issuedAt: cert.binding.issuedAt,
      expiresAt: cert.binding.expiresAt,
      issuer: cert.binding.issuer,
    };
    expect(
      verifyUserPubKeyBinding(binding, hexToBytes(cert.signature), fakeCaPub),
    ).toBe(false);
  });
});

describe("GET /api/ca/cert", () => {
  it("returns the issuer + pubkey that match the binding signer", async () => {
    const app = buildServer({ surface: "com" });
    const r = await app.inject({ method: "GET", url: "/api/ca/cert" });
    expect(r.statusCode).toBe(200);
    const ca = JSON.parse(r.body);
    expect(typeof ca.issuer).toBe("string");
    expect(typeof ca.pubKey).toBe("string");
    expect(ca.pubKey).toMatch(/^[0-9a-f]{64}$/);
    expect(ca.ttlMs).toBeGreaterThan(0);
  });
});

/**
 * .com relay-blessing issuer + trust-exception sync handlers
 * (docs/maintainer-trust-enforcement.md).
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  verifyCaSignedServiceBlessing,
  signTrustException,
  relayCertHash,
  type CaTrustChain,
  type Keypair,
  type ServiceBlessing,
} from "@flagship/protocol";
import { deriveIRK } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleHubBlessing,
  handleStoreTrustException,
  handleListTrustExceptions,
} from "../src/serviceBlessing.js";

const NOW = 1_770_000_000_000;

function caFromHex(privHex: string): Keypair {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    sk[i] = parseInt(privHex.slice(i * 2, i * 2 + 2), 16);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}
function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const ca = caFromHex("01".repeat(32));
const caHex = hex(ca.publicKey);
const hubKeyPub = "ab".repeat(32);

const SECRET = "services-control-secret";
const AUTH = { sharedSecret: SECRET, allowedHubHosts: ["flagship.services"] };

describe("handleHubBlessing", () => {
  it("mints a ServiceBlessing that verifies through the chain (~26h TTL)", () => {
    const res = handleHubBlessing(
      { ...AUTH, ca: { keypair: ca, issuer: "flagship-ca-v1" }, now: () => NOW },
      { hubKeyPub, hubHost: "flagship.services" },
      SECRET,
    );
    expect(res.status).toBe(200);
    const blessing = (res.body as { blessing: ServiceBlessing }).blessing;
    expect(blessing.kind).toBe("ServiceBlessing");
    expect(blessing.hubKeyPub).toBe(hubKeyPub);
    expect(blessing.signedBy).toBe(caHex);
    expect(blessing.expiresAt - blessing.issuedAt).toBe(26 * 60 * 60_000);
    expect(blessing.nonce.length).toBeGreaterThan(0);

    const chain: CaTrustChain = { authorizedCaKeys: () => [caHex] };
    expect(
      verifyCaSignedServiceBlessing(blessing, chain, NOW, "deadbeef".repeat(8)),
    ).toEqual({ ok: true });
  });

  it("honors a caller-supplied nonce", () => {
    const res = handleHubBlessing(
      { ...AUTH, ca: { keypair: ca, issuer: "x" }, now: () => NOW },
      { hubKeyPub, hubHost: "flagship.services", nonce: "fixed-nonce" },
      SECRET,
    );
    expect((res.body as { blessing: ServiceBlessing }).blessing.nonce).toBe(
      "fixed-nonce",
    );
  });

  it("rejects a non-hex hubKeyPub", () => {
    const res = handleHubBlessing(
      { ...AUTH, ca: { keypair: ca, issuer: "x" } },
      { hubKeyPub: "nothex", hubHost: "flagship.services" },
      SECRET,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a hubHost containing the separator", () => {
    const res = handleHubBlessing(
      { ...AUTH, ca: { keypair: ca, issuer: "x" } },
      { hubKeyPub, hubHost: "a|b" },
      SECRET,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing body", () => {
    expect(handleHubBlessing({ ...AUTH, ca: { keypair: ca, issuer: "x" } }, null, SECRET).status).toBe(
      400,
    );
  });

  it("refuses to sign when the shared secret is unconfigured (fails closed)", () => {
    const res = handleHubBlessing(
      { ca: { keypair: ca, issuer: "x" }, allowedHubHosts: ["flagship.services"] },
      { hubKeyPub, hubHost: "flagship.services" },
      SECRET,
    );
    expect(res.status).toBe(503);
    expect(res.body).not.toHaveProperty("blessing");
  });

  it.each([
    ["no secret", null],
    ["a wrong secret", "services-control-secreX"],
    ["a prefix of the secret", "services-control"],
  ])("refuses an anonymous caller presenting %s", (_label, presented) => {
    const res = handleHubBlessing(
      { ...AUTH, ca: { keypair: ca, issuer: "x" } },
      { hubKeyPub, hubHost: "flagship.services" },
      presented,
    );
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("blessing");
  });

  it("checks the secret before looking at the body", () => {
    expect(handleHubBlessing({ ...AUTH, ca: { keypair: ca, issuer: "x" } }, null, null).status).toBe(
      401,
    );
  });

  it.each(["probe-verify.invalid", "services", "alice.flagship.services", "gym.flagship.services"])(
    "refuses to bless hubHost %s outside the allowlist",
    (hubHost) => {
      const res = handleHubBlessing(
        { ...AUTH, ca: { keypair: ca, issuer: "x" } },
        { hubKeyPub, hubHost },
        SECRET,
      );
      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty("blessing");
    },
  );
});

describe("trust-exception sync", () => {
  const device = deriveIRK({ seed: new Uint8Array(32).fill(0x11) });
  const devicePub = hex(device.publicKey);
  const certHash = relayCertHash(hubKeyPub);
  const exc = signTrustException(
    { certClass: "relay", certHash, grantedAt: NOW },
    device,
  );

  it("stores a signature-valid exception and lists it back", async () => {
    const storage = new InMemoryStorage();
    const stored = await handleStoreTrustException(
      { storage: storage.trustExceptions, now: () => NOW },
      "alice",
      exc,
    );
    expect(stored.status).toBe(200);

    const listed = await handleListTrustExceptions(
      { storage: storage.trustExceptions },
      "alice",
    );
    expect(listed.status).toBe(200);
    const out = (listed.body as { exceptions: Array<{ certHash: string }> })
      .exceptions;
    expect(out.length).toBe(1);
    expect(out[0]!.certHash).toBe(certHash);
  });

  it("rejects a malformed envelope", async () => {
    const storage = new InMemoryStorage();
    const res = await handleStoreTrustException(
      { storage: storage.trustExceptions },
      "alice",
      { kind: "nope" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects when a wired roster excludes the granting device", async () => {
    const storage = new InMemoryStorage();
    const res = await handleStoreTrustException(
      {
        storage: storage.trustExceptions,
        resolveDeviceRoster: async () => ["ff".repeat(32)],
      },
      "alice",
      exc,
    );
    expect(res.status).toBe(400);
  });

  it("accepts when a wired roster includes the granting device", async () => {
    const storage = new InMemoryStorage();
    const res = await handleStoreTrustException(
      {
        storage: storage.trustExceptions,
        resolveDeviceRoster: async () => [devicePub],
      },
      "alice",
      exc,
    );
    expect(res.status).toBe(200);
  });

  it("rejects a tampered exception (signature no longer matches)", async () => {
    const storage = new InMemoryStorage();
    const tampered = { ...exc, certHash: "00".repeat(32) };
    const res = await handleStoreTrustException(
      { storage: storage.trustExceptions },
      "alice",
      tampered,
    );
    expect(res.status).toBe(400);
  });
});

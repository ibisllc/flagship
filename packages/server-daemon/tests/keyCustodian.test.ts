import { describe, expect, it } from "vitest";
import {
  ed,
  deriveServiceSecret,
  deriveBackupManifestKey,
  encryptChunk,
  decryptChunk,
  sealLlmPayload,
  openLlmPayload,
  sealGossip,
  openGossip,
  signSecretRequest,
  signInstallService,
  sealForEd25519Recipient,
  openSealedFromEd25519Recipient,
  type SecretRequest,
  type InstallServiceRequest,
} from "@flagship/protocol";
import { KeyCustodian } from "../src/keyCustodian.js";
import { deriveTlsKey } from "../src/acme.js";

// Fixed vectors so parity is deterministic.
const IDENTITY = new Uint8Array(32).fill(3);
const SWK = new Uint8Array(32).fill(7);
const CGK = new Uint8Array(32).fill(9);
const IDENTITY_KP = { privateKey: IDENTITY, publicKey: ed.getPublicKey(IDENTITY) };

function custodian(): KeyCustodian {
  return new KeyCustodian({ identityPriv: IDENTITY, swk: SWK, cgk: CGK });
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("KeyCustodian — box-signer parity", () => {
  it("boxPublicKey equals ed.getPublicKey(seed)", () => {
    expect(hex(custodian().boxPublicKey())).toBe(hex(IDENTITY_KP.publicKey));
  });

  it("signAsBox is byte-identical to a direct ed.sign", () => {
    const msg = new TextEncoder().encode("flagship/inject/v1|svc|anon|anon|123");
    expect(hex(custodian().signAsBox(msg))).toBe(hex(ed.sign(msg, IDENTITY)));
  });

  it("signSecretRequest matches the protocol function", () => {
    const req: SecretRequest = {
      serverDomain: "home.alice.flagship.services",
      stkPub: IDENTITY_KP.publicKey,
      purpose: "entitlement",
      nonce: new Uint8Array(32).fill(1),
      issuedAt: 42,
    };
    expect(hex(custodian().signSecretRequest(req))).toBe(hex(signSecretRequest(req, IDENTITY_KP)));
  });

  it("signInstallService matches the protocol function", () => {
    const req: InstallServiceRequest = {
      serverId: "home.alice.flagship.services",
      creator: "alice",
      slug: "app",
      manifestJson: '{"name":"app"}',
      addOwnerToMembership: true,
      issuedAt: 99,
    };
    expect(hex(custodian().signInstallService(req))).toBe(hex(signInstallService(req, IDENTITY_KP)));
  });

  it("unsealToBox opens a blob sealed to the box identity (round-trips the plaintext)", () => {
    const pt = new TextEncoder().encode("a sealed secret");
    const sealed = sealForEd25519Recipient(pt, IDENTITY_KP.publicKey);
    expect(hex(custodian().unsealToBox(sealed))).toBe(hex(pt));
    // …and matches the direct protocol open.
    expect(hex(custodian().unsealToBox(sealed))).toBe(hex(openSealedFromEd25519Recipient(sealed, IDENTITY)));
  });
});

describe("KeyCustodian — SWK-op parity", () => {
  it("deriveServiceSecret matches the protocol function", () => {
    expect(hex(custodian().deriveServiceSecret("alice--app"))).toBe(hex(deriveServiceSecret(SWK, "alice--app")));
  });

  it("deriveTlsKey matches acme.deriveTlsKey", () => {
    expect(hex(custodian().deriveTlsKey("srv-1"))).toBe(hex(deriveTlsKey(SWK, "srv-1")));
  });

  it("deriveBackupManifestKey matches the protocol function", () => {
    expect(hex(custodian().deriveBackupManifestKey())).toBe(hex(deriveBackupManifestKey(SWK)));
  });

  it("sealWithSwk/openWithSwk round-trip, and open the direct protocol seal", () => {
    const pt = new TextEncoder().encode("env value");
    const c = custodian();
    const blob = c.sealWithSwk(pt);
    expect(hex(c.openWithSwk(blob))).toBe(hex(pt));
    // A payload sealed directly with the raw SWK opens through the custodian.
    const direct = sealLlmPayload(pt, SWK);
    expect(hex(c.openWithSwk(direct))).toBe(hex(openLlmPayload(direct, SWK)));
  });

  it("encryptChunkWithSwk/decryptChunkWithSwk round-trip, and interop with the raw ops", () => {
    const pt = new TextEncoder().encode("backup chunk bytes");
    const c = custodian();
    const chunk = c.encryptChunkWithSwk(pt);
    expect(hex(c.decryptChunkWithSwk(chunk))).toBe(hex(pt));
    // A chunk encrypted with the raw SWK decrypts through the custodian and vice-versa.
    const rawChunk = encryptChunk(pt, SWK);
    expect(hex(c.decryptChunkWithSwk(rawChunk))).toBe(hex(decryptChunk(rawChunk, SWK)));
  });
});

describe("KeyCustodian — gossip-op parity", () => {
  it("sealGossip/openGossip round-trip, and interop with the raw CGK ops", () => {
    const pt = new TextEncoder().encode("gossip announcement");
    const c = custodian();
    const sealed = c.sealGossip(pt);
    expect(hex(c.openGossip(sealed))).toBe(hex(pt));
    // A blob sealed with the raw CGK opens through the custodian.
    const raw = sealGossip(pt, CGK);
    expect(hex(c.openGossip(raw))).toBe(hex(openGossip(raw, CGK)));
  });
});

describe("KeyCustodian — guards + hygiene", () => {
  it("rejects a non-32-byte identity seed", () => {
    expect(() => new KeyCustodian({ identityPriv: new Uint8Array(16) })).toThrow(/32 bytes/);
  });

  it("SwkOps throw when no SWK is provisioned (and hasSwk reflects it)", () => {
    const c = new KeyCustodian({ identityPriv: IDENTITY });
    expect(c.hasSwk).toBe(false);
    expect(() => c.deriveServiceSecret("x")).toThrow(/no SWK/);
    expect(() => c.sealWithSwk(new Uint8Array(1))).toThrow(/no SWK/);
    // The box-signer half still works without an SWK.
    expect(hex(c.boxPublicKey())).toBe(hex(IDENTITY_KP.publicKey));
  });

  it("GossipOps throw when no CGK is provisioned (and hasCgk reflects it)", () => {
    const c = new KeyCustodian({ identityPriv: IDENTITY, swk: SWK });
    expect(c.hasCgk).toBe(false);
    expect(() => c.sealGossip(new Uint8Array(1))).toThrow(/no CGK/);
  });

  it("copies the seed so a later mutation of the caller's buffer can't change what it signs", () => {
    const seed = new Uint8Array(32).fill(5);
    const c = new KeyCustodian({ identityPriv: seed });
    const before = hex(c.boxPublicKey());
    seed.fill(0xff); // mutate the caller's buffer after construction
    expect(hex(c.boxPublicKey())).toBe(before);
  });
});

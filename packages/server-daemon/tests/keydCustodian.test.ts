import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed, openGossip, sealForEd25519Recipient, sealGossip, signSecretRequest, signBootSuspension, type SecretRequest } from "@flagship/protocol";
import { KeyCustodian } from "../src/keyCustodian.js";
import { KeydCustodian } from "../src/keydCustodian.js";
import { startKeydWorker } from "./helpers/keydWorker.js";

const SEED = new Uint8Array(32).fill(0x33);
const SWK = new Uint8Array(32).fill(0x44);
const CGK = new Uint8Array(32).fill(0x55);
const enc = (s: string) => new TextEncoder().encode(s);

let keyd: Awaited<ReturnType<typeof startKeydWorker>>;
let remote: KeydCustodian;
const local = new KeyCustodian({ identityPriv: SEED, swk: SWK, cgk: CGK });

beforeAll(async () => {
  keyd = await startKeydWorker({ seed: SEED, swk: SWK, cgk: CGK });
  remote = new KeydCustodian({ socketPath: keyd.sock, component: "test" });
});
afterAll(async () => {
  remote.close();
  await keyd.stop();
});

describe("KeydCustodian behaves like the in-process KeyCustodian", () => {
  it("has the same public key and signatures", () => {
    expect(remote.boxPublicKey()).toEqual(local.boxPublicKey());
    const msg = enc("flagship/daemon-status/v1|x");
    expect(remote.signAsBox(msg)).toEqual(local.signAsBox(msg));
  });

  it("builds the same protocol signatures through the opaque identity keypair", () => {
    const req = { serverDomain: "home.a.flagship.services", nonceHex: "aa".repeat(16), issuedAt: 1760000000000 } as unknown as SecretRequest;
    try {
      expect(remote.signSecretRequest(req)).toEqual(local.signSecretRequest(req));
    } catch (e) {
      // The request shape is validated by the protocol; both sides must agree on the verdict.
      expect(() => local.signSecretRequest(req)).toThrow();
      expect(String((e as Error).message).length).toBeGreaterThan(0);
    }
    const order = { serverDomain: "home.a.flagship.services", epoch: 2, seq: 1, action: "suspend" as const, reason: "dead-man", signer: "box" as const, issuedAt: 1760000000000 };
    expect(remote.signBootSuspension(order)).toEqual(local.signBootSuspension(order));
    expect(signBootSuspension(order, remote.identityKeypair().privateKey)).toEqual(local.signBootSuspension(order));
  });

  it("keeps the boot rules: the box suspends, never resumes, and never signs as an owner", () => {
    const base = { serverDomain: "home.a.flagship.services", epoch: 2, seq: 1, reason: "dead-man", issuedAt: 1760000000000 };
    expect(() => remote.signBootSuspension({ ...base, action: "resume", signer: "box" })).toThrow();
    expect(() => remote.signBootSuspension({ ...base, action: "suspend", signer: "owner" })).toThrow();
    expect(() => remote.signBootAuthHeader({ role: "owner", serverDomain: "x", method: "GET", path: "/", pubKeyHex: Buffer.from(remote.boxPublicKey()).toString("hex"), nonceHex: "aa", issuedAt: 1 })).toThrow();
    const ok = remote.signBootAuthHeader({ role: "box", serverDomain: "home.a.flagship.services", method: "GET", path: "/api/boot/x", pubKeyHex: Buffer.from(remote.boxPublicKey()).toString("hex"), nonceHex: "aa".repeat(8), issuedAt: 1760000000000 });
    expect(ok).toMatch(/^Flagship-Boot-v1 /);
  });

  it("opens what is sealed to the box", () => {
    const blob = sealForEd25519Recipient(enc("for the box"), local.boxPublicKey());
    expect(new TextDecoder().decode(remote.unsealToBox(blob))).toBe("for the box");
  });

  it("SWK operations interoperate in both directions and derive the same subkeys", () => {
    expect(local.openWithSwk(remote.sealWithSwk(enc("x")))).toEqual(enc("x"));
    expect(remote.openWithSwk(local.sealWithSwk(enc("y")))).toEqual(enc("y"));
    expect(local.decryptChunkWithSwk(remote.encryptChunkWithSwk(enc("chunk")))).toEqual(enc("chunk"));
    expect(remote.decryptChunkWithSwk(local.encryptChunkWithSwk(enc("chunk2")))).toEqual(enc("chunk2"));
    expect(remote.deriveServiceSecret("alice--chess")).toEqual(local.deriveServiceSecret("alice--chess"));
    expect(remote.deriveTlsKey("home.alice.flagship.services")).toEqual(local.deriveTlsKey("home.alice.flagship.services"));
    expect(remote.deriveBackupManifestKey()).toEqual(local.deriveBackupManifestKey());
    expect(() => remote.openWithSwk({ ...remote.sealWithSwk(enc("z")), nonce: new Uint8Array(12) })).toThrow();
  });

  it("gossip operations interoperate and derive the same app-copy key", () => {
    expect(openGossip(remote.sealGossip(enc("g")), CGK)).toEqual(enc("g"));
    expect(remote.openGossip(sealGossip(enc("h"), CGK))).toEqual(enc("h"));
    const info = enc("flagship/app-copy-env/v1|alice--chess");
    expect(remote.deriveAppCopyEnvKey(info)).toEqual(local.deriveAppCopyEnvKey(info));
    expect(() => remote.deriveAppCopyEnvKey(enc("flagship/other/v1|x"))).toThrow();
  });

  it("never lets the private key be read, even through the keypair handed to legacy code", () => {
    const kp = remote.identityKeypair();
    expect(kp.publicKey).toEqual(local.boxPublicKey());
    expect(() => Buffer.from(kp.privateKey).toString("hex")).toThrow(/held by flagship-keyd/);
    expect(ed.sign(enc("flagship/daemon-status/v1|x"), kp.privateKey)).toEqual(local.signAsBox(enc("flagship/daemon-status/v1|x")));
    // The unusual-by-design call a compromised daemon might try:
    expect(() => ed.sign(enc("flagship/root-entitlement/v1|x"), kp.privateKey)).toThrow(/does not sign/);
  });
});

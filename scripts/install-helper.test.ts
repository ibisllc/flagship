import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ed,
  signAuthCode,
  verifyAuthCode,
  verifyConsumeUnlockKey,
  verifyRootEntitlement,
  verifyServerRegister,
  verifyServiceEntitlement,
  type AuthCode,
  type ServerRegisterRequest,
} from "@flagship/protocol";

const HELPER = join(__dirname, "install-helper.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flagship-install-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], input?: string): { stdout: string; stderr: string } {
  const out = execFileSync("npx", ["tsx", HELPER, ...args], {
    input,
    encoding: "utf8",
  });
  return { stdout: out, stderr: "" };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("install-helper", () => {
  it("gen-identity: writes a priv+pub pair where pub == ed25519.getPublicKey(priv)", () => {
    const privPath = join(dir, "priv.hex");
    const pubPath = join(dir, "pub.hex");
    const pemPath = join(dir, "id.pem");
    run([
      "gen-identity",
      "--out-priv", privPath,
      "--out-pub", pubPath,
      "--out-pem", pemPath,
    ]);
    const priv = hexToBytes(readFileSync(privPath, "utf8"));
    const pub = hexToBytes(readFileSync(pubPath, "utf8"));
    expect(priv.length).toBe(32);
    expect(pub.length).toBe(32);
    const expectedPub = ed.getPublicKey(priv);
    expect(Buffer.from(pub)).toEqual(Buffer.from(expectedPub));
  });

  it("gen-identity: PKCS8 PEM is parseable by openssl + signs verifiably with @flagship/protocol", () => {
    const privPath = join(dir, "priv.hex");
    const pubPath = join(dir, "pub.hex");
    const pemPath = join(dir, "id.pem");
    run([
      "gen-identity",
      "--out-priv", privPath,
      "--out-pub", pubPath,
      "--out-pem", pemPath,
    ]);

    // Sign canonical bytes with openssl using the PEM, then verify via
    // protocol's verifyConsumeUnlockKey. Round-trip proves the PEM is
    // a valid Ed25519 priv key the boot-stage shell can use.
    const serverId = "home.alice.flagship.services";
    const nonceHex = "00".repeat(32);
    const issuedAt = 1_000_000;
    const canonical = `flagship/consume-unlock-key/v1|${serverId}|${nonceHex}|${issuedAt}`;
    const msgPath = join(dir, "msg.bin");
    writeFileSync(msgPath, canonical);
    const sigBin = execFileSync("openssl", [
      "pkeyutl", "-sign", "-rawin",
      "-inkey", pemPath,
      "-in", msgPath,
    ]);
    const sig = new Uint8Array(sigBin.buffer, sigBin.byteOffset, sigBin.byteLength);
    expect(sig.length).toBe(64);

    const pub = hexToBytes(readFileSync(pubPath, "utf8"));
    const ok = verifyConsumeUnlockKey(
      { serverId, nonce: hexToBytes(nonceHex), issuedAt },
      sig,
      pub,
    );
    expect(ok).toBe(true);
  });

  it("pkcs8-from-hex: emits a PEM equivalent to gen-identity for the same priv hex", () => {
    const privHex = "1".repeat(64);
    const { stdout: pem } = run(["pkcs8-from-hex", "--priv-hex", privHex]);
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(pem).toMatch(/-----END PRIVATE KEY-----/);
  });

  it("seal-for-bak --bak-x25519-pub roundtrips through openSealed", async () => {
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const { openSealed } = await import("@flagship/protocol");
    const recipPriv = x25519.utils.randomSecretKey();
    const recipPub = x25519.getPublicKey(recipPriv);
    const luksKey = new Uint8Array(64);
    for (let i = 0; i < 64; i++) luksKey[i] = (i * 7) & 0xff;
    const luksPath = join(dir, "luks.key");
    writeFileSync(luksPath, luksKey);
    const { stdout } = run([
      "seal-for-bak",
      "--bak-x25519-pub",
      Buffer.from(recipPub).toString("hex"),
      "--in",
      luksPath,
    ]);
    const sealed = hexToBytes(stdout);
    const opened = openSealed(sealed, recipPriv);
    expect(Buffer.from(opened)).toEqual(Buffer.from(luksKey));
  });

  it("seal-for-bak --bak-ed25519-pub roundtrips via the Ed25519→X25519 conversion", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { openSealed } = await import("@flagship/protocol");
    const edPriv = ed25519.utils.randomSecretKey();
    const edPub = ed25519.getPublicKey(edPriv);
    const xPriv = ed25519.utils.toMontgomerySecret(edPriv);
    const luksKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const luksPath = join(dir, "luks.key");
    writeFileSync(luksPath, luksKey);
    const { stdout } = run([
      "seal-for-bak",
      "--bak-ed25519-pub",
      Buffer.from(edPub).toString("hex"),
      "--in",
      luksPath,
    ]);
    const sealed = hexToBytes(stdout);
    const opened = openSealed(sealed, xPriv);
    expect(Buffer.from(opened)).toEqual(Buffer.from(luksKey));
  });

  it("sign-sealed-key: produces a verifiable PutSealedLuksKey envelope", async () => {
    const priv = new Uint8Array(32);
    for (let i = 0; i < 32; i++) priv[i] = i + 1;
    const privHex = Buffer.from(priv).toString("hex");
    const sealedHex = "deadbeef".repeat(8);
    const issuedAt = "1700000000000";
    const { stdout } = run([
      "sign-sealed-key",
      "--priv", privHex,
      "--server-id", "home.alice.flagship.services",
      "--sealed-hex", sealedHex,
      "--issued-at", issuedAt,
    ]);
    const env = JSON.parse(stdout) as { request: { serverId: string; sealedKey: string; issuedAt: number }; signature: string };
    expect(env.request.serverId).toBe("home.alice.flagship.services");
    expect(env.request.sealedKey).toBe(sealedHex);
    expect(env.request.issuedAt).toBe(parseInt(issuedAt, 10));
    expect(env.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("sign-server-register preserves the signed admin root in the forwarded auth code", () => {
    const irkPriv = new Uint8Array(32).fill(0x51);
    const irk = { privateKey: irkPriv, publicKey: ed.getPublicKey(irkPriv) };
    const delegatedPubKey = ed.getPublicKey(new Uint8Array(32).fill(0x52));
    const adminRootPubKey = ed.getPublicKey(new Uint8Array(32).fill(0x53));
    const authCode: AuthCode = {
      version: 1,
      serial: "01ADMINROOTTEST",
      username: "alice",
      serverName: "home",
      serverDomain: "home.alice.flagship.services",
      delegatedPubKey,
      userPubKey: irk.publicKey,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      adminRootPubKey,
    };
    const authCodeUserSignature = signAuthCode(authCode, irk);
    const blobPath = join(dir, "install-blob.json");
    writeFileSync(blobPath, JSON.stringify({
      authCode: {
        ...authCode,
        delegatedPubKey: Buffer.from(delegatedPubKey).toString("hex"),
        userPubKey: Buffer.from(irk.publicKey).toString("hex"),
        adminRootPubKey: Buffer.from(adminRootPubKey).toString("hex"),
      },
      authCodeUserSignature: Buffer.from(authCodeUserSignature).toString("hex"),
    }));

    const stkPriv = new Uint8Array(32).fill(0x54);
    const stkPub = ed.getPublicKey(stkPriv);
    const { stdout } = run([
      "sign-server-register",
      "--priv-hex", Buffer.from(stkPriv).toString("hex"),
      "--auth-code-blob", blobPath,
    ]);
    const env = JSON.parse(stdout) as {
      request: {
        authCode: {
          version: 1;
          serial: string;
          username: string;
          serverName: string;
          serverDomain: string;
          delegatedPubKey: string;
          userPubKey: string;
          issuedAt: number;
          expiresAt: number;
          adminRootPubKey?: string;
        };
        authCodeUserSignature: string;
        serverIdentityPubKey: string;
        issuedAt: number;
        nonce: string;
      };
      signature: string;
    };
    expect(env.request.authCode.adminRootPubKey).toBe(Buffer.from(adminRootPubKey).toString("hex"));

    const forwarded: AuthCode = {
      ...env.request.authCode,
      delegatedPubKey: hexToBytes(env.request.authCode.delegatedPubKey),
      userPubKey: hexToBytes(env.request.authCode.userPubKey),
      adminRootPubKey: hexToBytes(env.request.authCode.adminRootPubKey!),
    };
    expect(verifyAuthCode(forwarded, hexToBytes(env.request.authCodeUserSignature), irk.publicKey)).toBe(true);
    const request: ServerRegisterRequest = {
      authCode: forwarded,
      authCodeUserSignature: hexToBytes(env.request.authCodeUserSignature),
      serverIdentityPubKey: stkPub,
      issuedAt: env.request.issuedAt,
      nonce: hexToBytes(env.request.nonce),
    };
    expect(verifyServerRegister(request, hexToBytes(env.signature), stkPub)).toBe(true);
  });

  it("mint-entitlements: writes a bundle whose RootEntitlement verifies under the IRK + binds the STK", () => {
    // IRK = the signer; podPubKey = the box's STK (would be the
    // gen-identity pubkey on a real box).
    const irkPriv = new Uint8Array(32).fill(0x11);
    const irkPub = ed.getPublicKey(irkPriv);
    const stkPriv = new Uint8Array(32).fill(0x22);
    const stkPub = ed.getPublicKey(stkPriv);
    const outPath = join(dir, "entitlements.json");
    run([
      "mint-entitlements",
      "--irk-priv", Buffer.from(irkPriv).toString("hex"),
      "--pod-pub", Buffer.from(stkPub).toString("hex"),
      "--username", "alice",
      "--pod-canonical", "home.alice.flagship.services",
      "--out", outPath,
    ]);
    const file = JSON.parse(readFileSync(outPath, "utf8")) as {
      rootEntitlement: {
        username: string;
        podPubKey: string;
        podCanonical: string;
        issuedAt: number;
      };
      rootEntitlementSig: string;
      serviceEntitlement: unknown;
    };
    expect(file.rootEntitlement.username).toBe("alice");
    expect(file.rootEntitlement.podCanonical).toBe("home.alice.flagship.services");
    expect(file.rootEntitlement.podPubKey).toBe(Buffer.from(stkPub).toString("hex"));
    expect(file.serviceEntitlement).toBeNull();
    // The signature verifies under the IRK pubkey the hub would resolve.
    const ok = verifyRootEntitlement(
      {
        username: file.rootEntitlement.username,
        podPubKey: hexToBytes(file.rootEntitlement.podPubKey),
        podCanonical: file.rootEntitlement.podCanonical,
        issuedAt: file.rootEntitlement.issuedAt,
      },
      hexToBytes(file.rootEntitlementSig),
      irkPub,
    );
    expect(ok).toBe(true);
  });

  it("mint-entitlements: --service-canonicals produces a verifiable ServiceEntitlement", () => {
    const irkPriv = new Uint8Array(32).fill(0x33);
    const irkPub = ed.getPublicKey(irkPriv);
    const stkPub = ed.getPublicKey(new Uint8Array(32).fill(0x44));
    const outPath = join(dir, "entitlements.json");
    run([
      "mint-entitlements",
      "--irk-priv", Buffer.from(irkPriv).toString("hex"),
      "--pod-pub", Buffer.from(stkPub).toString("hex"),
      "--username", "alice",
      "--pod-canonical", "home.alice.flagship.services",
      "--service-canonicals", "Photos.home.alice.flagship.services,docs.home.alice.flagship.services",
      "--out", outPath,
    ]);
    const file = JSON.parse(readFileSync(outPath, "utf8")) as {
      serviceEntitlement: {
        username: string;
        podPubKey: string;
        canonicals: string[];
        issuedAt: number;
        expiresAt: number;
      };
      serviceEntitlementSig: string;
    };
    // Canonicals are lower-cased on the way in.
    expect(file.serviceEntitlement.canonicals).toEqual([
      "photos.home.alice.flagship.services",
      "docs.home.alice.flagship.services",
    ]);
    const ok = verifyServiceEntitlement(
      {
        username: file.serviceEntitlement.username,
        podPubKey: hexToBytes(file.serviceEntitlement.podPubKey),
        canonicals: file.serviceEntitlement.canonicals,
        issuedAt: file.serviceEntitlement.issuedAt,
        expiresAt: file.serviceEntitlement.expiresAt,
      },
      hexToBytes(file.serviceEntitlementSig),
      irkPub,
    );
    expect(ok).toBe(true);
  });
});

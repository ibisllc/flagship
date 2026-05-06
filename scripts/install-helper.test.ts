import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, verifyConsumeUnlockKey } from "@flagship/protocol";

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
});

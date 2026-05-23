// THE GATE. This is the authoritative wire-compat check for the flagship-unseal
// static boot helper: it seals secrets with the REAL @flagship/protocol and
// asserts the BUILT Go binary recovers them byte-for-byte. A protocol change
// that breaks the boot-unlock wire format fails here — which is the whole point,
// because a wire mismatch in production would BRICK a server's LUKS unlock.
//
// It covers both paths the box uses pre-unlock:
//   - raw sealForEd25519Recipient (AutoUnlockLeaseV2.sealedKey shape)
//   - SealedSecretResponse (the phone's nonce/purpose-bound reply)
// plus tamper cases that MUST fail (flipped ciphertext, wrong identity key,
// wrong nonce/purpose context), and a PINNED vector frozen from a known
// protocol so future drift is caught even if the live builders change.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fromHex,
  makeRawVector,
  makeResponseVector,
  toHex,
} from "../src/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const helperDir = join(repoRoot, "installer", "unseal-helper");

// Build a NATIVE binary for the test host. The shipped artifact is
// linux/amd64 (see the Makefile / README) but the wire crypto is
// architecture-independent, so a host-native build exercises the exact same
// code paths the static linux binary runs in the initramfs.
let bin: string;

function findGo(): string {
  for (const c of ["go", "/opt/homebrew/bin/go", "/usr/local/go/bin/go", "/usr/local/bin/go"]) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("go toolchain not found on PATH; install Go to run the unseal cross-check");
}

beforeAll(() => {
  const go = findGo();
  const outDir = mkdtempSync(join(tmpdir(), "flagship-unseal-"));
  bin = join(outDir, "flagship-unseal");
  execFileSync(go, ["build", "-o", bin, "."], {
    cwd: helperDir,
    stdio: "pipe",
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  expect(existsSync(bin)).toBe(true);
}, 120_000);

/** Run the binary; return { stdout, code }. Never throws on non-zero exit. */
function runBin(args: string[], stdin?: string): { stdout: string; code: number; stderr: string } {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      input: stdin,
    });
    return { stdout, code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      stdout: err.stdout?.toString() ?? "",
      code: err.status ?? -1,
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

const SEED_HEX = "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0";

describe("TS->Go unseal cross-check (raw sealForEd25519Recipient)", () => {
  it("recovers a freshly-sealed secret", () => {
    const secret = fromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const v = makeRawVector(SEED_HEX, secret);
    const r = runBin(["--identity-priv-hex", v.identityPrivHex, "--sealed-hex", v.sealedHex]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(v.expectedSecretHex);
  });

  it("recovers a non-32-byte secret (length-independent)", () => {
    const secret = new TextEncoder().encode("the disk key can be any length, even odd");
    const v = makeRawVector(SEED_HEX, secret);
    const r = runBin(["--identity-priv-hex", v.identityPrivHex, "--sealed-hex", v.sealedHex]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(v.expectedSecretHex);
  });

  it("--raw emits the secret bytes verbatim", () => {
    const secret = fromHex("deadbeefcafef00d");
    const v = makeRawVector(SEED_HEX, secret);
    const out = execFileSync(bin, [
      "--identity-priv-hex",
      v.identityPrivHex,
      "--sealed-hex",
      v.sealedHex,
      "--raw",
    ]);
    expect(toHex(new Uint8Array(out))).toBe(v.expectedSecretHex);
  });

  it("FAILS on a flipped ciphertext byte (GCM tag mismatch)", () => {
    const secret = fromHex("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    const v = makeRawVector(SEED_HEX, secret);
    const tampered = fromHex(v.sealedHex);
    // flip a byte well inside the ciphertext (past the 44-byte header)
    tampered[50] ^= 0x01;
    const r = runBin(["--identity-priv-hex", v.identityPrivHex, "--sealed-hex", toHex(tampered)]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("gcm");
  });

  it("FAILS with the wrong identity key", () => {
    const secret = fromHex("0102030405060708");
    const v = makeRawVector(SEED_HEX, secret);
    const wrong = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const r = runBin(["--identity-priv-hex", wrong, "--sealed-hex", v.sealedHex]);
    expect(r.code).not.toBe(0);
  });

  it("FAILS on a too-short blob", () => {
    const r = runBin(["--identity-priv-hex", SEED_HEX, "--sealed-hex", "00112233"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("too short");
  });

  it("FAILS on a malformed identity key length", () => {
    const secret = fromHex("0102030405060708");
    const v = makeRawVector(SEED_HEX, secret);
    const r = runBin(["--identity-priv-hex", "abcd", "--sealed-hex", v.sealedHex]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("32 bytes");
  });
});

describe("TS->Go unseal cross-check (SealedSecretResponse)", () => {
  const nonce = fromHex("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");

  it("recovers the secret when (nonce, purpose) match", () => {
    const secret = fromHex("5555555555555555aaaaaaaaaaaaaaaa5555555555555555aaaaaaaaaaaaaaaa");
    const v = makeResponseVector(SEED_HEX, secret, {
      serverDomain: "kitchen.bob.flagship.services",
      purpose: "unlock-key",
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    const r = runBin([
      "--identity-priv-hex",
      v.identityPrivHex,
      "--sealed-hex",
      v.sealedHex,
      "--response",
      "--nonce-hex",
      v.nonceHex,
      "--purpose",
      v.purpose,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(v.expectedSecretHex);
  });

  it("recovers via --response-json on stdin", () => {
    const secret = fromHex("1234567890abcdef1234567890abcdef");
    const v = makeResponseVector(SEED_HEX, secret, {
      serverDomain: "kitchen.bob.flagship.services",
      purpose: "entitlement",
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    const reply = JSON.stringify({
      serverDomain: v.serverDomain,
      requestNonceHex: v.requestNonceHex,
      purpose: v.purpose,
      sealedHex: v.sealedHex,
      issuedAt: 1_700_000_000_000,
    });
    const r = runBin(
      ["--identity-priv-hex", v.identityPrivHex, "--response-json", "-"],
      reply,
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(v.expectedSecretHex);
  });

  it("recovers via --response-json from a file", () => {
    const secret = fromHex("cafecafecafecafe");
    const v = makeResponseVector(SEED_HEX, secret, {
      serverDomain: "kitchen.bob.flagship.services",
      purpose: "unlock-key",
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    const dir = mkdtempSync(join(tmpdir(), "flagship-unseal-json-"));
    const path = join(dir, "reply.json");
    writeFileSync(
      path,
      JSON.stringify({
        serverDomain: v.serverDomain,
        requestNonceHex: v.requestNonceHex,
        purpose: v.purpose,
        sealedHex: v.sealedHex,
        issuedAt: 1_700_000_000_000,
      }),
    );
    const r = runBin(["--identity-priv-hex", v.identityPrivHex, "--response-json", path]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(v.expectedSecretHex);
  });

  it("FAILS when the bound nonce does not match the request", () => {
    const secret = fromHex("9999888877776666");
    const v = makeResponseVector(SEED_HEX, secret, {
      serverDomain: "kitchen.bob.flagship.services",
      purpose: "unlock-key",
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    const wrongNonce = fromHex(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    const r = runBin([
      "--identity-priv-hex",
      v.identityPrivHex,
      "--sealed-hex",
      v.sealedHex,
      "--response",
      "--nonce-hex",
      toHex(wrongNonce),
      "--purpose",
      "unlock-key",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("different (nonce, purpose)");
  });

  it("FAILS when the bound purpose does not match the request", () => {
    const secret = fromHex("9999888877776666");
    const v = makeResponseVector(SEED_HEX, secret, {
      serverDomain: "kitchen.bob.flagship.services",
      purpose: "unlock-key",
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    const r = runBin([
      "--identity-priv-hex",
      v.identityPrivHex,
      "--sealed-hex",
      v.sealedHex,
      "--response",
      "--nonce-hex",
      v.nonceHex,
      "--purpose",
      "entitlement",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("different (nonce, purpose)");
  });

  it("FAILS on a flipped ciphertext byte in the response", () => {
    const secret = fromHex("9999888877776666");
    const v = makeResponseVector(SEED_HEX, secret, {
      serverDomain: "kitchen.bob.flagship.services",
      purpose: "unlock-key",
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    const tampered = fromHex(v.sealedHex);
    tampered[60] ^= 0x01;
    const r = runBin([
      "--identity-priv-hex",
      v.identityPrivHex,
      "--sealed-hex",
      toHex(tampered),
      "--response",
      "--nonce-hex",
      v.nonceHex,
      "--purpose",
      v.purpose,
    ]);
    expect(r.code).not.toBe(0);
  });
});

describe("PINNED protocol vector (frozen wire format)", () => {
  const pinned = JSON.parse(
    readFileSync(join(here, "pinned-vector.json"), "utf8"),
  ) as {
    raw: { identityPrivHex: string; sealedHex: string; expectedSecretHex: string };
    response: {
      identityPrivHex: string;
      sealedHex: string;
      nonceHex: string;
      purpose: string;
      expectedSecretHex: string;
    };
  };

  it("Go binary reproduces the pinned RAW secret", () => {
    const r = runBin([
      "--identity-priv-hex",
      pinned.raw.identityPrivHex,
      "--sealed-hex",
      pinned.raw.sealedHex,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pinned.raw.expectedSecretHex);
  });

  it("Go binary reproduces the pinned RESPONSE secret", () => {
    const r = runBin([
      "--identity-priv-hex",
      pinned.response.identityPrivHex,
      "--sealed-hex",
      pinned.response.sealedHex,
      "--response",
      "--nonce-hex",
      pinned.response.nonceHex,
      "--purpose",
      pinned.response.purpose,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pinned.response.expectedSecretHex);
  });
});

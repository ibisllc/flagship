// Boot-stage RELAY-path wire-compat gate.
//
// installer/boot-stage.sh's `unlock_via_relay` does, in pure shell, the
// crypto the daemon does in TS. This test exercises THOSE shell primitives
// against the REAL @flagship/protocol + the BUILT Go unseal helper, so a
// drift between the shell path and the protocol is caught before it bricks
// a box's LUKS unlock:
//
//   1. seed/pub extraction from the on-/boot PKCS8 PEM
//        (openssl pkey -outform DER | tail -c 64) MUST equal ed.getPublicKey.
//   2. the SecretRequest canonical bytes the script builds + signs with
//        `openssl pkeyutl -sign` MUST verify under protocol verifySecretRequest.
//   3. the `.com` secret-response JSON ({...,"sealed":...}) transformed to the
//        helper's `{...,"sealedHex":...}` shape (the script's sed rename) MUST
//        unseal to the LUKS key under the box STK.
//
// openssl + go are required; both are present in CI (the ISO build needs them).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSealedSecretResponse,
  ed,
  signSecretRequest,
  verifySecretRequest,
  type SecretRequest,
} from "@flagship/protocol";
import { fromHex, toHex } from "../src/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const helperDir = join(repoRoot, "installer", "unseal-helper");

let bin: string;
let workDir: string;

function findGo(): string {
  for (const c of ["go", "/opt/homebrew/bin/go", "/usr/local/go/bin/go", "/usr/local/bin/go"]) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("go toolchain not found on PATH");
}

/** Wrap a 32-byte Ed25519 seed in PKCS8 PEM — the exact form
 *  scripts/install-helper.ts writes to /boot/identity.pem. Fixed 16-byte
 *  ASN.1 prefix + the 32-byte seed. */
function pkcs8PemFromSeed(seed: Uint8Array): string {
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const der = new Uint8Array(prefix.length + 32);
  der.set(prefix, 0);
  der.set(seed, prefix.length);
  const b64 = Buffer.from(der).toString("base64");
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

/** boot-stage.sh identity_seed_hex(): last 32 bytes of the PKCS8 DER. */
function extractSeedHex(pemPath: string): string {
  const der = execFileSync("openssl", ["pkey", "-in", pemPath, "-outform", "DER"]);
  return toHex(new Uint8Array(der)).slice(-64);
}

/** boot-stage.sh identity_pub_hex(): last 32 bytes of the SPKI DER. */
function extractPubHex(pemPath: string): string {
  const der = execFileSync("openssl", ["pkey", "-in", pemPath, "-pubout", "-outform", "DER"]);
  return toHex(new Uint8Array(der)).slice(-64);
}

/** boot-stage.sh sign_canonical(): openssl pkeyutl -sign -rawin over the bytes. */
function opensslSign(pemPath: string, canonical: string): Uint8Array {
  const msgFile = join(workDir, "canonical.bin");
  writeFileSync(msgFile, canonical);
  const sig = execFileSync("openssl", [
    "pkeyutl", "-sign", "-rawin", "-inkey", pemPath, "-in", msgFile,
  ]);
  return new Uint8Array(sig);
}

const SEED_HEX = "03070a111825222936313e3d4a47545163666d6a77827e8b888d9a97a4a1aebb";
const SERVER_DOMAIN = "home.alice.flagship.services";

beforeAll(() => {
  const go = findGo();
  workDir = mkdtempSync(join(tmpdir(), "flagship-bootstage-"));
  bin = join(workDir, "flagship-unseal");
  execFileSync(go, ["build", "-o", bin, "."], {
    cwd: helperDir,
    stdio: "pipe",
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  expect(existsSync(bin)).toBe(true);
}, 120_000);

describe("boot-stage relay: identity extraction from /boot/identity.pem", () => {
  it("seed + pub extracted via openssl match the protocol keypair", () => {
    const seed = fromHex(SEED_HEX);
    const pemPath = join(workDir, "identity.pem");
    writeFileSync(pemPath, pkcs8PemFromSeed(seed));

    expect(extractSeedHex(pemPath)).toBe(SEED_HEX);
    expect(extractPubHex(pemPath)).toBe(toHex(ed.getPublicKey(seed)));
  });
});

describe("boot-stage relay: SecretRequest canonical signing (openssl)", () => {
  it("the script's canonical + openssl signature verifies under the protocol", () => {
    const seed = fromHex(SEED_HEX);
    const pub = ed.getPublicKey(seed);
    const pemPath = join(workDir, "identity-sign.pem");
    writeFileSync(pemPath, pkcs8PemFromSeed(seed));

    const nonceHex = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const issuedAt = 1_700_000_000_000;
    // EXACT canonical the shell builds:
    //   flagship/secret-request/v1|<serverDomain>|<hex-stkpub>|unlock-key|<hex-nonce>|<issuedAt>
    const canonical =
      `flagship/secret-request/v1|${SERVER_DOMAIN}|${toHex(pub)}|unlock-key|${nonceHex}|${issuedAt}`;
    const sig = opensslSign(pemPath, canonical);

    const request: SecretRequest = {
      serverDomain: SERVER_DOMAIN,
      stkPub: pub,
      purpose: "unlock-key",
      nonce: fromHex(nonceHex),
      issuedAt,
    };
    expect(verifySecretRequest(request, sig, pub)).toBe(true);
    // Cross-check: the protocol's own signer produces a verifying sig too.
    expect(
      verifySecretRequest(request, signSecretRequest(request, { privateKey: seed, publicKey: pub }), pub),
    ).toBe(true);
  });
});

describe("boot-stage relay: .com response → helper JSON → LUKS key", () => {
  it("recovers the LUKS key from the transformed (sealed→sealedHex) reply", () => {
    const seed = fromHex(SEED_HEX);
    const pub = ed.getPublicKey(seed);
    const nonce = fromHex(
      "1122334455667788991122334455667788991122334455667788991122334455",
    );
    const issuedAt = 1_700_000_000_000;
    const request: SecretRequest = {
      serverDomain: SERVER_DOMAIN,
      stkPub: pub,
      purpose: "unlock-key",
      nonce,
      issuedAt,
    };
    const luksKey = fromHex(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    const sealed = buildSealedSecretResponse(luksKey, request);

    // What `.com`'s GET /secret-response returns (key is `sealed`):
    const comResponse = {
      serverDomain: sealed.serverDomain,
      requestNonceHex: sealed.requestNonceHex,
      purpose: sealed.purpose,
      sealed: toHex(sealed.sealed),
      issuedAt: sealed.issuedAt,
    };

    // boot-stage.sh extracts `sealed` with sed, then writes the helper's
    // JSON shape (key `sealedHex`, with the SAME nonce/purpose it sent):
    const sealedExtracted = comResponse.sealed; // sed -n 's/.*"sealed":"\(...\)".*/\1/p'
    const helperJson = {
      serverDomain: SERVER_DOMAIN,
      requestNonceHex: toHex(nonce),
      purpose: "unlock-key",
      sealedHex: sealedExtracted,
      issuedAt: 0,
    };
    const helperPath = join(workDir, "unseal-input.json");
    writeFileSync(helperPath, JSON.stringify(helperJson));

    const out = execFileSync(bin, [
      "--identity-priv-hex", SEED_HEX,
      "--response-json", helperPath,
    ]).toString().trim();
    expect(out).toBe(toHex(luksKey));
  });

  it("a reply bound to a DIFFERENT nonce is rejected (replay protection)", () => {
    const seed = fromHex(SEED_HEX);
    const pub = ed.getPublicKey(seed);
    const sentNonce = fromHex(
      "1122334455667788991122334455667788991122334455667788991122334455",
    );
    const request: SecretRequest = {
      serverDomain: SERVER_DOMAIN,
      stkPub: pub,
      purpose: "unlock-key",
      nonce: sentNonce,
      issuedAt: 1_700_000_000_000,
    };
    const sealed = buildSealedSecretResponse(fromHex("0011223344556677"), request);

    // The box transforms the reply but stamps the WRONG nonce into the helper
    // JSON (simulating a replayed reply matched to a different request).
    const helperJson = {
      serverDomain: SERVER_DOMAIN,
      requestNonceHex:
        "0000000000000000000000000000000000000000000000000000000000000000",
      purpose: "unlock-key",
      sealedHex: toHex(sealed.sealed),
      issuedAt: 0,
    };
    const helperPath = join(workDir, "unseal-bad.json");
    writeFileSync(helperPath, JSON.stringify(helperJson));

    let failed = false;
    try {
      execFileSync(bin, ["--identity-priv-hex", SEED_HEX, "--response-json", helperPath], {
        stdio: "pipe",
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

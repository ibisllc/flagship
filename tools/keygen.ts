#!/usr/bin/env tsx
/**
 * Dev helper: emit a fresh UMK and the derived BAK/IRK pubkeys + a sample
 * BuildSpec the bootkey-builder can consume. Useful for smoke-testing the
 * build flow end to end without a real phone.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { deriveBAK, deriveIRK, deriveSWK, generateUMK } from "@flagship/protocol";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function main(): Promise<void> {
  const umk = generateUMK();
  const serverId = `srv-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const userId = `user-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const bak = deriveBAK(umk, serverId);
  const irk = deriveIRK(umk);
  const swk = deriveSWK(umk, serverId);
  const swkProvisioningTokenHash = sha256(swk);

  const fixture = {
    // SECRET — would live only on the phone in production.
    umk: bytesToHex(umk.seed),
    bakPrivateKey: bytesToHex(bak.privateKey),
    irkPrivateKey: bytesToHex(irk.privateKey),
    swk: bytesToHex(swk),

    // PUBLIC — these go into the server image / control plane.
    serverId,
    userId,
    bakPublicKey: bytesToHex(bak.publicKey),
    irkPublicKey: bytesToHex(irk.publicKey),
    swkProvisioningTokenHash: bytesToHex(swkProvisioningTokenHash),
  };

  const buildSpec = {
    userId,
    newServerId: serverId,
    irkPublicKey: fixture.irkPublicKey,
    bakPublicKey: fixture.bakPublicKey,
    swkProvisioningTokenHash: fixture.swkProvisioningTokenHash,
    wifi: { ssid: "ExampleWiFi", psk: "example-psk-rotate-me" },
    shareRatio: 0.5,
    totalDiskGb: 256,
    issuedAt: Date.now(),
  };

  const outDir = resolve("test-vectors");
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "fixture.json"), JSON.stringify(fixture, null, 2) + "\n");
  await writeFile(resolve(outDir, "example-spec.json"), JSON.stringify(buildSpec, null, 2) + "\n");

  console.log(`Wrote ${outDir}/fixture.json (contains SECRETS — do not commit)`);
  console.log(`Wrote ${outDir}/example-spec.json`);
  console.log(`\nServer:  ${serverId}`);
  console.log(`User:    ${userId}`);
  console.log(`BAK pub: ${fixture.bakPublicKey}`);
  console.log(`IRK pub: ${fixture.irkPublicKey}`);
  console.log(`\nNext: npm --workspace=@flagship/bootkey-builder run start -- --spec test-vectors/example-spec.json --out build-out`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

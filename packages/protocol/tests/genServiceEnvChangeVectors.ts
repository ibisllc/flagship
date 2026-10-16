// Regenerates test-vectors/service-env-change/vectors.json:
//   npx tsx packages/protocol/tests/genServiceEnvChangeVectors.ts
// Every input is fixed, so the output is byte-stable (Ed25519 is deterministic).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  serviceEnvChangeCanonicalBytes,
  serviceEnvValueSha256,
  signServiceEnvChange,
  type ServiceEnvChange,
} from "../src/serviceEnvChange.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const umkSeedHex = "3c".repeat(32);
const irk = deriveIRK({ seed: fromHex(umkSeedHex) });
const SERVER = "home.alice.flagship.services";
const values: Record<string, string> = {
  OPENAI_API_KEY: "sk-test-1234567890",
  // Any character may be in a value, the separator included: only its hash is signed.
  DATABASE_URL: "postgres://u:p@db/x?opt=a|b",
  GREETING: "héllo wörld ✓",
};
const set = (name: string, issuedAt: number, nonce: string): ServiceEnvChange => ({
  serverId: SERVER,
  serviceId: "alice--weatherbot",
  op: "set",
  name,
  valueSha256: serviceEnvValueSha256(values[name]!),
  issuedAt,
  nonce,
});
const changes: Array<{ change: ServiceEnvChange; value?: string }> = [
  { change: set("OPENAI_API_KEY", 1792000000000, "0123456789abcdef0123456789abcdef"), value: values.OPENAI_API_KEY },
  { change: set("DATABASE_URL", 1792000000001, "fedcba9876543210fedcba9876543210"), value: values.DATABASE_URL },
  { change: set("GREETING", 1792000000002, "00112233445566778899aabbccddeeff"), value: values.GREETING },
  {
    change: {
      serverId: SERVER,
      serviceId: "alice--weatherbot",
      op: "unset",
      name: "OPENAI_API_KEY",
      valueSha256: "",
      issuedAt: 1792000000003,
      nonce: "ffeeddccbbaa99887766554433221100",
    },
  },
];
const ok = changes[0]!.change;
const out = {
  about:
    "flagship/service-env-change/v1: one change to an app's environment variables, signed by the IRK. Canonical: tag|serverId|serviceId|op|name|valueSha256|issuedAt|nonce. op is set (valueSha256 = lowercase hex SHA-256 of the value's UTF-8) or unset (valueSha256 empty). name matches ^[A-Za-z_][A-Za-z0-9_]{0,127}$ and never starts with FLAGSHIP_; serviceId is creator--slug; nonce is 32 lowercase hex. Key: the protocol IRK derived from the UMK seed.",
  umkSeedHex,
  pub: hex(irk.publicKey),
  cases: changes.map(({ change, value }) => ({
    change,
    ...(value !== undefined ? { value } : {}),
    canonical: new TextDecoder().decode(serviceEnvChangeCanonicalBytes(change)),
    signature: hex(signServiceEnvChange(change, irk)),
  })),
  // Each must be refused by every implementation's canonical builder.
  invalid: [
    { ...ok, serverId: "" },
    { ...ok, serviceId: "alice-weatherbot" },
    { ...ok, op: "replace" },
    { ...ok, name: "my-key" },
    { ...ok, name: "1KEY" },
    { ...ok, name: "FLAGSHIP_APP_ID" },
    { ...ok, valueSha256: "" },
    { ...ok, valueSha256: ok.valueSha256.toUpperCase() },
    { ...ok, op: "unset" },
    { ...ok, nonce: "0123" },
    { ...ok, nonce: "0123456789ABCDEF0123456789ABCDEF" },
    { ...ok, issuedAt: -1 },
  ],
};
const path = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/service-env-change/vectors.json");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");

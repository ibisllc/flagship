// packages/protocol/test-vectors/irk-lineage (tools/irk-lineage-vectors.mjs): the protocol's IRK
// is the vectors' "web" scheme, so demo accounts (provisioned by `.com` with deriveIRK) and webapp
// accounts hold the same key, and every client's import finds it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveIRK } from "../src/index.js";

const v = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/irk-lineage/vectors.json"), "utf8"),
);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("irk-lineage vectors", () => {
  it("deriveIRK is the web scheme at v1", () => {
    const umk = { seed: Uint8Array.from(Buffer.from(v.umkSeedHex, "hex")) };
    const web1 = v.keys.find((k: { scheme: string; version: number }) => k.scheme === "web" && k.version === 1);
    expect(hex(deriveIRK(umk).publicKey)).toBe(web1.pubHex);
  });

  it("every import rotates past the registered version", () => {
    for (const c of v.imports) {
      for (const own of ["web", "ios", "android"]) expect(c.importer[own].newVersion).toBe(c.registered.version + 1);
    }
  });
});

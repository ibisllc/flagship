// scripts/gpu-catalog.mjs: the matrix → payload build (receipts only), k-of-n signing with the
// release signers' Ed25519 keys, the PQ companion once pinned, and the box's verification rules.
// The Rust side verifies a catalog this tool signed (flagship-gpu tests/trust.rs fixture).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSignature, buildPayload, SCHEMA, verifyEnvelope } from "./gpu-catalog.mjs";
import { loadEd25519Signer } from "./pq-release-key.mjs";

const D = "a".repeat(64);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gpucat-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(id: string) {
  return {
    id,
    backend: "nvidia-cuda",
    pciDeviceIds: ["0x2684"],
    model: "RTX 4090",
    kernels: ["6.12.48+deb13-amd64"],
    moduleSigningRequired: true,
    drivers: ["580.95.05"],
    toolkits: ["13.0"],
    cdiGenerators: ["nvidia-ctk 1.18.0"],
    runsc: ["20260921.0"],
    isolation: ["gvisor-nvproxy"],
    capabilities: ["compute"],
    images: [{ purpose: "cuda", reference: `nvcr.io/nvidia/cuda@sha256:${D}` }],
    driverPackages: [{ name: "nvidia-driver", version: "580.95.05-1", arch: "amd64", sha256: D }],
  };
}

async function signer(seedHex: string) {
  const f = join(dir, `${seedHex.slice(0, 4)}.hex`);
  writeFileSync(f, seedHex);
  return loadEd25519Signer(`file:${f}`);
}

describe("gpu-catalog", () => {
  it("builds only receipted, exact profiles", () => {
    writeFileSync(join(dir, "H1-a.md"), "# receipt\n");
    const matrix = {
      schema: "flagship/gpu-qualification-matrix/v1",
      profiles: [
        { receiptIds: ["H1-a"], entry: entry("good") },
        { receiptIds: ["H1-missing"], entry: entry("no-receipt") },
        { receiptIds: ["H1-a"], entry: { ...entry("vague"), pciDeviceIds: [] } },
        { receiptIds: [], entry: entry("none") },
      ],
    };
    const { payload, skipped } = buildPayload(matrix, dir, 7, "2026-10-24T00:00:00Z");
    expect(payload.entries.map((e: { id: string }) => e.id)).toEqual(["good"]);
    expect(payload.entries[0].receipts).toEqual([{ id: "H1-a", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(skipped.map((s: { id: string }) => s.id)).toEqual(["no-receipt", "vague", "none"]);
  });

  it("verifies k-of-n release signers and the PQ companion once pinned", async () => {
    const a = await signer("11".repeat(32));
    const b = await signer("22".repeat(32));
    const payload = JSON.stringify({ schema: SCHEMA, serial: 4, issuedAt: "x", entries: [entry("good")], advisories: [] });
    let env = { schema: SCHEMA, serial: 4, payload, signatures: [], pqBindings: [] };
    const trust2 = { schema: 1, threshold: 2, keys: [a.pubHex, b.pubHex], pq: { keyIds: [] } };
    env = await addSignature(env, a);
    expect(verifyEnvelope(env, trust2).ok).toBe(false);
    env = await addSignature(env, b);
    expect(verifyEnvelope(env, trust2)).toMatchObject({ ok: true, signers: 2 });
    expect(verifyEnvelope({ ...env, payload: payload.replace("580.95.05", "580.95.06") }, trust2).ok).toBe(false);

    const seed = Uint8Array.from(Buffer.from("33".repeat(32), "hex"));
    const pq = await addSignature({ schema: SCHEMA, serial: 4, payload, signatures: [], pqBindings: [] }, a, seed);
    const keyId = pq.signatures[0].pq.keyId;
    const pinned = { schema: 1, threshold: 1, keys: [a.pubHex], pq: { keyIds: [keyId] } };
    expect(verifyEnvelope(pq, pinned)).toMatchObject({ ok: true });
    const classicalOnly = await addSignature({ schema: SCHEMA, serial: 4, payload, signatures: [], pqBindings: [] }, a);
    expect(verifyEnvelope(classicalOnly, pinned).errors).toEqual([expect.stringMatching(/pq-missing/)]);
    expect(verifyEnvelope({ ...pq, pqBindings: [] }, pinned).ok).toBe(false);
  });
});

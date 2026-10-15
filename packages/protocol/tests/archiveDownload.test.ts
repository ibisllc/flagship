import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  archiveDownloadCanonicalBytes,
  archiveDownloadCode,
  parseArchiveDownloadApproval,
  signArchiveDownloadApproval,
  verifyArchiveDownloadApproval,
  type ArchiveDownloadApproval,
} from "../src/archiveDownload.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/archive-download/vectors.json"), "utf8"),
) as {
  umkSeedHex: string;
  pub: string;
  cases: Array<ArchiveDownloadApproval & { canonical: string; code: string; signature: string }>;
  invalid: ArchiveDownloadApproval[];
};
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

describe("archive-download vectors (test-vectors/archive-download/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });
  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    const a = { serverDomain: c.serverDomain, archiveId: c.archiveId, requestId: c.requestId, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(archiveDownloadCanonicalBytes(a))).toBe(c.canonical);
    expect(archiveDownloadCode(a.requestId)).toBe(c.code);
    expect(hex(signArchiveDownloadApproval(a, irk))).toBe(c.signature);
    expect(verifyArchiveDownloadApproval(a, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(verifyArchiveDownloadApproval({ ...a, requestId: "11".repeat(16) }, fromHex(c.signature), irk.publicKey)).toBe(false);
    expect(parseArchiveDownloadApproval(a)).toEqual(a);
  });
  it.each(V.invalid.map((c, i) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(parseArchiveDownloadApproval(c)).toBeNull();
    expect(() => archiveDownloadCanonicalBytes(c)).toThrow();
  });
});

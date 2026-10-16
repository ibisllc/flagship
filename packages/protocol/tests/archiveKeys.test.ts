import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  archiveKeysCanonicalBytes,
  archiveKeysDigest,
  mintArchiveKeys,
  parseArchiveKeys,
  parseArchiveKeysDeposit,
  signArchiveKeysDeposit,
  verifyArchiveKeysDeposit,
  type ArchiveKey,
  type ArchiveKeysDeposit,
} from "../src/archiveKeys.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK, deriveServerArchiveKey } from "../src/keys.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/server-archive-keys/vectors.json"), "utf8"),
) as {
  umkSeedHex: string;
  pub: string;
  cases: Array<{ serverDomain: string; issuedAt: number; keys: ArchiveKey[]; digest: string; canonical: string; signature: string }>;
  invalid: ArchiveKeysDeposit[];
};
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const umk = { seed: fromHex(V.umkSeedHex) };
const irk = deriveIRK(umk);

describe("server-archive-keys vectors (test-vectors/server-archive-keys/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });
  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    for (const k of c.keys) expect(hex(deriveServerArchiveKey(umk, k.archiveId))).toBe(k.kekHex);
    expect(archiveKeysDigest(c.keys)).toBe(c.digest);
    const d = { serverDomain: c.serverDomain, count: c.keys.length, digest: c.digest, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(archiveKeysCanonicalBytes(d))).toBe(c.canonical);
    expect(hex(signArchiveKeysDeposit(d, irk))).toBe(c.signature);
    expect(verifyArchiveKeysDeposit(d, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(verifyArchiveKeysDeposit({ ...d, count: d.count + 1 }, fromHex(c.signature), irk.publicKey)).toBe(false);
    expect(parseArchiveKeysDeposit(d)).toEqual(d);
    expect(parseArchiveKeys(c.keys)).toEqual(c.keys);
  });
  it.each(V.invalid.map((c, i) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(parseArchiveKeysDeposit(c)).toBeNull();
    expect(() => archiveKeysCanonicalBytes(c)).toThrow();
  });
});

describe("archive keys", () => {
  it("mints distinct ids whose keys are the account slot keys", () => {
    let n = 0;
    const keys = mintArchiveKeys(umk, 3, (len) => new Uint8Array(len).fill(++n));
    expect(new Set(keys.map((k) => k.archiveId)).size).toBe(3);
    for (const k of keys) expect(k.kekHex).toBe(hex(deriveServerArchiveKey(umk, k.archiveId)));
  });
  it("the digest depends on order and content", () => {
    const keys = V.cases[1]!.keys;
    expect(archiveKeysDigest([...keys].reverse())).not.toBe(archiveKeysDigest(keys));
  });
  it("refuses repeated ids and malformed keys", () => {
    const k = V.cases[0]!.keys[0]!;
    expect(parseArchiveKeys([k, k])).toBeNull();
    expect(parseArchiveKeys([{ archiveId: k.archiveId, kekHex: "zz" }])).toBeNull();
    expect(parseArchiveKeys([])).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  boxProxyCredentialsError,
  canonicalBoxProxy,
  deriveIRK,
  normalizeBoxProxyHost,
  parseBoxProxyCredentials,
  parseSignedBoxProxy,
  signBoxProxy,
  verifyBoxProxy,
  type BoxProxy,
} from "../src/index.js";

const V = JSON.parse(
  readFileSync(new URL("../test-vectors/box-proxy/vectors.json", import.meta.url), "utf8"),
);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("box proxy vectors", () => {
  const irk = deriveIRK({ seed: bytes(V.keys.umkSeedHex) });

  it("derives the pinned IRK", () => {
    expect(Buffer.from(irk.publicKey).toString("hex")).toBe(V.keys.irkPubHex);
  });

  it("reproduces every case's canonical string and signature, and rejects a flipped one", () => {
    for (const c of V.cases) {
      const p = c.fields as BoxProxy;
      expect(new TextDecoder().decode(canonicalBoxProxy(p)), c.name).toBe(c.canonical);
      expect(signBoxProxy(p, irk), c.name).toBe(c.signatureHex);
      expect(verifyBoxProxy(p, c.signatureHex, irk.publicKey), c.name).toBe(true);
      expect(verifyBoxProxy(p, c.rejectSignatureHex, irk.publicKey), c.name).toBe(false);
    }
  });

  it("refuses every refuse case", () => {
    for (const r of V.refuse) expect(() => canonicalBoxProxy(r.fields), r.why).toThrow();
  });

  it("normalizes typed hosts", () => {
    for (const n of V.normalize) expect(normalizeBoxProxyHost(n.input)).toBe(n.host);
  });

  it("checks credentials the same way everywhere", () => {
    for (const c of V.credentials.accept) expect(boxProxyCredentialsError(c)).toBeNull();
    for (const c of V.credentials.refuse) expect(boxProxyCredentialsError(c), c.why).not.toBeNull();
    expect(parseBoxProxyCredentials(V.credentials.accept[0])).toEqual(V.credentials.accept[0]);
    expect(parseBoxProxyCredentials({ username: "a" })).toBeNull();
  });

  it("parses the wire form and drops a malformed one", () => {
    const c = V.cases[0];
    expect(parseSignedBoxProxy(c.wire)?.proxy).toEqual(c.fields);
    expect(parseSignedBoxProxy({ proxy: { ...c.fields, port: 0 }, signature: c.signatureHex })).toBeNull();
    expect(parseSignedBoxProxy({ proxy: c.fields })).toBeNull();
    expect(parseSignedBoxProxy({ proxy: { ...c.fields, auth: "1" }, signature: c.signatureHex })).toBeNull();
  });
});

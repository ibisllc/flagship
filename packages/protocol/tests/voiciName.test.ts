import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  canonicalVoiciNameOrder,
  parseSignedVoiciNameOrder,
  verifyVoiciNameOrder,
  voiciNameKey,
  voiciNameProblem,
} from "../src/voiciName.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/voici-name/vectors.json"), "utf8"),
);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const pub = bytes(V.keys.pubHex);

describe("voici-name vectors", () => {
  it("derives the public key from the seed", () => {
    expect(Buffer.from(ed.getPublicKey(bytes(V.keys.seedHex))).toString("hex")).toBe(V.keys.pubHex);
  });

  for (const which of ["set", "clear"] as const) {
    it(`${which}: canonical bytes and signature`, () => {
      const c = V[which];
      expect(new TextDecoder().decode(canonicalVoiciNameOrder(c.fields))).toBe(c.canonical);
      expect(verifyVoiciNameOrder(c.fields, bytes(c.signatureHex), pub)).toBe(true);
    });
  }

  it("refuses a signature that no longer matches its order", () => {
    for (const r of V.reject) expect(verifyVoiciNameOrder(r.order, bytes(r.signatureHex), pub), r.why).toBe(false);
  });

  it("the name rules give the pinned answers", () => {
    for (const n of V.names) {
      expect(voiciNameProblem(n.typed), n.typed).toBe(n.problem);
      if (n.problem === null) expect(voiciNameKey(n.typed), n.typed).toBe(n.key);
    }
  });
});

describe("parseSignedVoiciNameOrder", () => {
  const ok = { order: V.set.fields, signature: V.set.signatureHex };
  it("accepts the vector and the clear form", () => {
    expect(parseSignedVoiciNameOrder(ok)?.order.name).toBe("halloweenparty");
    expect(parseSignedVoiciNameOrder({ order: V.clear.fields, signature: V.clear.signatureHex })?.order.op).toBe("clear");
  });
  it("refuses a set with no name, a clear with a name, bad hex and junk", () => {
    expect(parseSignedVoiciNameOrder({ ...ok, order: { ...ok.order, name: "" } })).toBeNull();
    expect(parseSignedVoiciNameOrder({ ...ok, order: { ...ok.order, op: "clear" } })).toBeNull();
    expect(parseSignedVoiciNameOrder({ ...ok, signature: "zz" })).toBeNull();
    expect(parseSignedVoiciNameOrder({ ...ok, order: { ...ok.order, nonce: "ab" } })).toBeNull();
    expect(parseSignedVoiciNameOrder(null)).toBeNull();
    expect(parseSignedVoiciNameOrder("x")).toBeNull();
  });
});

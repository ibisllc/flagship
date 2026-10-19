import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptRelayHint,
  canonicalRelayHint,
  parseRelayHint,
  relayHintAddresses,
  relayHintProblem,
  verifyRelayHint,
  type RelayHintStore,
} from "../src/relayHint.js";
import { buildRelayHintVectors } from "./genRelayHintVectors.js";

// The shared file: Swift and Kotlin read the same one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/relay-hint/vectors.json"), "utf8")) as any;
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const auth = V.keys.authorityPubHex as string;

describe("relay-hint vectors", () => {
  it("the file is what the generator writes", () => {
    expect(V).toEqual(JSON.parse(JSON.stringify(buildRelayHintVectors())));
  });

  it("reproduces every canonical string and verifies every positive", () => {
    for (const p of V.positive) {
      const h = parseRelayHint(p.hint);
      expect(h, p.name).not.toBeNull();
      expect(text(canonicalRelayHint(h!, h!.signedBy)), p.name).toBe(p.canonical);
      expect(verifyRelayHint(h!, [auth]), p.name).toEqual({ ok: true });
    }
  });

  it("refuses every reject with its reason", () => {
    for (const r of V.reject) {
      const h = parseRelayHint(r.hint);
      const got = h ? verifyRelayHint(h, [auth]) : { ok: false, reason: "malformed" };
      expect(got, r.name).toEqual({ ok: false, reason: r.expect });
    }
  });

  it("will not build bytes for a body that breaks a rule", () => {
    for (const u of V.unsignable) expect(relayHintProblem(u.body, auth), u.name).toBe(u.code);
    expect(V.unsignable.every((u: { code: string }) => u.code !== "NONE")).toBe(true);
  });

  it("folds candidates into the store as the table says", () => {
    for (const a of V.accept) {
      const got = acceptRelayHint(a.from as RelayHintStore, a.candidate, [auth]);
      expect(got.refused, a.name).toBe(a.refused);
      expect(got.store.highestSeq, a.name).toBe(a.highestSeq);
    }
  });

  it("orders the addresses to try as the table says", () => {
    for (const a of V.addresses) {
      expect(relayHintAddresses(a.store, a.authority, a.seed, a.now), a.name).toEqual(a.expect);
    }
  });

  it("puts the hint before the seed and never repeats an address", () => {
    const row = V.addresses.find((a: { name: string }) => a.name === "hint-first-then-seed");
    expect(row.expect).toEqual(["203.0.113.7", "149.248.216.86", "2a09:8280:1::110:d2b6:0"]);
  });
});

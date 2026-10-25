// The webapp's port of the rescue messages (apps/web/public/webapp/lib/rescue.js) against the shared
// vectors in packages/protocol/test-vectors/rescue: the hello and session bytes, the discovery id,
// the offline-control orders and their refusals, and the post-quantum gate over all three (with the
// webapp's own verifyCriticalSignature). No screen: a browser cannot do a LAN rescue.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const read = (f: string) => JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/rescue", f), "utf8"));
const V = read("vectors.json");
const OC = read("offline-control.json");
const PQ = read("pq-vectors.json");
const hex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("rescue hello and session (test-vectors/rescue/vectors.json)", () => {
  it.each(V.cases.map((c: any, i: number) => [i, c]))("case #%i", async (_i, c: any) => {
    const r = await load("lib/rescue.js");
    const x = { serverDomain: c.serverDomain, clientNonce: c.clientNonce, boxNonce: c.boxNonce, certSha256: c.certSha256, issuedAt: c.issuedAt };
    expect(text(r.rescueHelloCanonical(x))).toBe(c.helloCanonical);
    expect(text(r.rescueSessionCanonical(x))).toBe(c.sessionCanonical);
    expect(await r.verifyRescueSignature(r.rescueHelloCanonical(x), hex(c.helloSignature), hex(c.stkPub))).toBe(true);
    expect(await r.verifyRescueSignature(r.rescueSessionCanonical(x), hex(c.sessionSignature), hex(V.irkPub))).toBe(true);
    // A hello's signature is not a session order's.
    expect(await r.verifyRescueSignature(r.rescueSessionCanonical(x), hex(c.helloSignature), hex(c.stkPub))).toBe(false);
    expect(await r.rescueDiscoveryId(hex(c.stkPub), c.serverDomain)).toBe(c.discoveryId);
    expect(await r.rescueDiscoveryId(hex(c.stkPub), c.serverDomain.toUpperCase())).toBe(c.discoveryId);
  });
  it.each(V.invalid.map((c: any, i: number) => [i, c]))("refuses invalid #%i", async (_i, c: any) => {
    const r = await load("lib/rescue.js");
    expect(() => r.rescueSessionCanonical(c)).toThrow();
  });
});

describe("offline-control orders (test-vectors/rescue/offline-control.json)", () => {
  it.each(OC.cases.map((c: any) => [c.name, c]))("%s", async (_n, c: any) => {
    const r = await load("lib/rescue.js");
    const bytes = r.offlineControlCanonical(c.order);
    expect(text(bytes)).toBe(c.canonical);
    expect(await r.verifyRescueSignature(bytes, hex(c.signature), hex(OC.irkPub))).toBe(true);
    expect(await r.verifyRescueSignature(r.offlineControlCanonical({ ...c.order, issuedAt: c.order.issuedAt + 1 }), hex(c.signature), hex(OC.irkPub))).toBe(false);
  });
  it.each(OC.refused.map((c: any) => [c.name, c]))("refuses %s", async (_n, c: any) => {
    const r = await load("lib/rescue.js");
    expect(() => r.offlineControlCanonical(c.order)).toThrow();
  });
});

describe("the post-quantum gate over the rescue messages (test-vectors/rescue/pq-vectors.json)", () => {
  it("builds the same bytes the gate cases sign", async () => {
    const r = await load("lib/rescue.js");
    expect(toHex(r.rescueSessionCanonical(PQ.exchange))).toBe(PQ.gate.find((g: any) => g.name === "session-strict-hybrid").messageHex);
    expect(toHex(r.rescueHelloCanonical(PQ.exchange))).toBe(PQ.gate.find((g: any) => g.name === "hello-strict-hybrid").messageHex);
    expect(toHex(r.offlineControlCanonical(PQ.controlOrder))).toBe(PQ.gate.find((g: any) => g.name === "control-strict-hybrid").messageHex);
  });
  it.each(PQ.gate.map((g: any) => [g.name, g]))("%s", async (_n, g: any) => {
    const pq = await load("lib/pqBinding.js");
    const bound = new Map(PQ.bindings.valid.map((b: any) => [b.name, pq.verifyPqKeyBinding(b.wire, b.expect)]));
    let got: any;
    try {
      const v = pq.verifyCriticalSignature({
        message: hex(g.messageHex),
        expectedPurpose: g.expectedPurpose,
        envelope: g.envelope,
        signerEd25519PubHex: g.signerEd25519PubHex,
        binding: g.binding ? bound.get(g.binding) : null,
        policy: g.policy,
      });
      got = { ok: true, suite: v.suite, strict: v.strict };
    } catch (e: any) {
      got = { ok: false, code: e.code };
    }
    expect(got).toEqual(g.expect);
  });
});

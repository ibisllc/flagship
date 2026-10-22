import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appListScopeCanonicalBytes,
  parseAppListScopeOrder,
  signAppListScope,
  verifyAppListScope,
  type AppListScopeOrder,
} from "../src/appListScope.js";
import {
  canonicalPlanAttestation,
  isProTier,
  parsePlanAttestation,
  signPlanAttestation,
  verifyCaSignedPlanAttestation,
  type PlanAttestation,
  type PlanAttestationBody,
} from "../src/planAttestation.js";
import { hex } from "../src/canonicalBase.js";
import { ed } from "../src/edSync.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "../test-vectors/app-list-scope/vectors.json"), "utf8"));
const P = JSON.parse(readFileSync(join(here, "../test-vectors/plan-attestation/vectors.json"), "utf8"));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const kp = (seedHex: string) => {
  const s = fromHex(seedHex);
  return { privateKey: s, publicKey: ed.getPublicKey(s) };
};
const signer = kp(V.signerSeedHex);
const other = kp("11".repeat(32));
const PIN = "ab".repeat(32);

describe("app-list-scope vectors", () => {
  it("signer pub matches", () => {
    expect(hex(signer.publicKey)).toBe(V.signerPub);
  });

  it.each(V.cases.map((c: AppListScopeOrder & { canonical: string; signature: string }, i: number) => [i, c]))(
    "case #%i",
    (_i, c) => {
      const o: AppListScopeOrder = { serviceRef: c.serviceRef, scope: c.scope, issuedAt: c.issuedAt };
      expect(new TextDecoder().decode(appListScopeCanonicalBytes(o))).toBe(c.canonical);
      expect(hex(signAppListScope(o, signer))).toBe(c.signature);
      expect(verifyAppListScope(o, fromHex(c.signature), signer.publicKey)).toBe(true);
      expect(verifyAppListScope(o, fromHex(c.signature), other.publicKey)).toBe(false);
      expect(verifyAppListScope({ ...o, scope: o.scope === "server" ? "account" : "server" }, fromHex(c.signature), signer.publicKey)).toBe(false);
      expect(parseAppListScopeOrder(JSON.parse(JSON.stringify(o)))).toEqual(o);
    },
  );

  it.each(V.rejects.map((c: AppListScopeOrder & { why: string }) => [c.why, c]))("refuses %s", (_why, c) => {
    const o = { serviceRef: c.serviceRef, scope: c.scope, issuedAt: c.issuedAt } as AppListScopeOrder;
    expect(() => appListScopeCanonicalBytes(o)).toThrow();
    expect(parseAppListScopeOrder(o)).toBeNull();
    expect(verifyAppListScope(o, new Uint8Array(64), signer.publicKey)).toBe(false);
  });

  it("refuses an order that names a server", () => {
    expect(parseAppListScopeOrder({ serviceRef: "harry--chess-club", scope: "server", issuedAt: 1, serverId: "x" })).toBeNull();
  });
});

describe("plan-attestation vectors", () => {
  const ca = kp(P.caSeedHex);
  const chain = { authorizedCaKeys: () => [P.caPub as string] };

  it("CA pub matches", () => {
    expect(hex(ca.publicKey)).toBe(P.caPub);
  });

  it.each(P.cases.map((c: PlanAttestationBody & { canonical: string; attestation: PlanAttestation }, i: number) => [i, c]))(
    "case #%i",
    (_i, c) => {
      const body: PlanAttestationBody = {
        username: c.username,
        tier: c.tier,
        paidUntil: c.paidUntil,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
      };
      expect(new TextDecoder().decode(canonicalPlanAttestation(body))).toBe(c.canonical);
      expect(signPlanAttestation(body, ca)).toEqual(c.attestation);
      const parsed = parsePlanAttestation(JSON.parse(JSON.stringify(c.attestation)))!;
      expect(parsed).toEqual(c.attestation);
      expect(verifyCaSignedPlanAttestation(parsed, chain, c.issuedAt + 1, PIN)).toEqual({ ok: true });
    },
  );

  const base = P.cases[0].attestation as PlanAttestation;

  it("fails closed without a pin, a chain or an authorized key", () => {
    expect(verifyCaSignedPlanAttestation(base, chain, base.issuedAt + 1, "")).toEqual({ ok: false, reason: "pin-unconfigured" });
    expect(verifyCaSignedPlanAttestation(base, null, base.issuedAt + 1, PIN)).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
    expect(
      verifyCaSignedPlanAttestation(base, { authorizedCaKeys: () => [hex(other.publicKey)] }, base.issuedAt + 1, PIN),
    ).toEqual({ ok: false, reason: "signature-unverified" });
  });

  it("refuses an expired or not yet issued attestation", () => {
    expect(verifyCaSignedPlanAttestation(base, chain, base.expiresAt, PIN)).toEqual({ ok: false, reason: "artifact-expired" });
    expect(verifyCaSignedPlanAttestation(base, chain, base.issuedAt - 1, PIN)).toEqual({ ok: false, reason: "artifact-expired" });
  });

  it("refuses an edited attestation", () => {
    for (const edit of [{ tier: "maker" }, { paidUntil: base.paidUntil + 1 }, { username: "mallory" }, { expiresAt: base.expiresAt + 1 }]) {
      expect(verifyCaSignedPlanAttestation({ ...base, ...edit } as PlanAttestation, chain, base.issuedAt + 1, PIN).ok).toBe(false);
    }
  });

  it("refuses a signature by an authorized key that isn't the named signer", () => {
    const forged = signPlanAttestation({ ...base, tier: "maker" }, other);
    const claim = { ...forged, signedBy: P.caPub };
    const both = { authorizedCaKeys: () => [P.caPub as string, hex(other.publicKey)] };
    expect(verifyCaSignedPlanAttestation(claim, both, base.issuedAt + 1, PIN).ok).toBe(false);
  });

  it("parses only well-formed attestations", () => {
    expect(parsePlanAttestation({ ...base, tier: "gold" })).toBeNull();
    expect(parsePlanAttestation({ ...base, kind: "Other" })).toBeNull();
    expect(parsePlanAttestation({ ...base, expiresAt: base.issuedAt })).toBeNull();
    expect(parsePlanAttestation(null)).toBeNull();
  });

  it("counts Pro and Pro Max as Pro", () => {
    expect(isProTier("hobby")).toBe(true);
    expect(isProTier("maker")).toBe(true);
    expect(isProTier("free")).toBe(false);
  });
});

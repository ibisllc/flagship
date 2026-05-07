import { describe, expect, it } from "vitest";
import {
  appEntitlementCertId,
  rootEntitlementCertId,
  signAppEntitlement,
  signEntitlementRevocationList,
  signRootEntitlement,
  verifyAppEntitlement,
  verifyEntitlementRevocationList,
  verifyRootEntitlement,
  type AppEntitlement,
  type EntitlementRevocationList,
  type Keypair,
  type RootEntitlement,
  ed,
} from "../src/index.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const USER = "john";
const POD_CANONICAL = "kitchen.john.flagship.services";

describe("RootEntitlement", () => {
  it("round-trips: sign + verify with the right IRK", () => {
    const irk = makeKey();
    const pod = makeKey();
    const cert: RootEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      podCanonical: POD_CANONICAL,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRootEntitlement(cert, irk);
    expect(verifyRootEntitlement(cert, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a signature from a different IRK", () => {
    const real = makeKey();
    const other = makeKey();
    const pod = makeKey();
    const cert: RootEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      podCanonical: POD_CANONICAL,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRootEntitlement(cert, other);
    expect(verifyRootEntitlement(cert, sig, real.publicKey)).toBe(false);
  });

  it("certId is deterministic + 64-hex-chars", async () => {
    const irk = makeKey();
    const pod = makeKey();
    void irk;
    const cert: RootEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      podCanonical: POD_CANONICAL,
      issuedAt: 1_700_000_000_000,
    };
    const id1 = await rootEntitlementCertId(cert);
    const id2 = await rootEntitlementCertId(cert);
    expect(id1).toEqual(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("certId changes when any field changes", async () => {
    const pod = makeKey();
    const base: RootEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      podCanonical: POD_CANONICAL,
      issuedAt: 1_700_000_000_000,
    };
    const id0 = await rootEntitlementCertId(base);
    const id1 = await rootEntitlementCertId({ ...base, username: "jane" });
    const id2 = await rootEntitlementCertId({ ...base, issuedAt: 1 });
    const id3 = await rootEntitlementCertId({ ...base, podCanonical: "garage.john.flagship.services" });
    expect(new Set([id0, id1, id2, id3]).size).toBe(4);
  });
});

describe("AppEntitlement", () => {
  it("round-trips with multiple canonicals (order-independent)", () => {
    const irk = makeKey();
    const pod = makeKey();
    const certA: AppEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      canonicals: [
        "messenger-facebook.kitchen.john.flagship.services",
        "shittygame.woodshed.john.flagship.services",
      ],
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 90 * 24 * 60 * 60 * 1000,
    };
    const certB: AppEntitlement = {
      ...certA,
      canonicals: [...certA.canonicals].reverse(),
    };
    const sig = signAppEntitlement(certA, irk);
    expect(verifyAppEntitlement(certA, sig, irk.publicKey)).toBe(true);
    // Order shouldn't break verification (canonical bytes sort the list).
    expect(verifyAppEntitlement(certB, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a signature from a different IRK", () => {
    const real = makeKey();
    const other = makeKey();
    const pod = makeKey();
    const cert: AppEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      canonicals: ["x.kitchen.john.flagship.services"],
      issuedAt: 1,
      expiresAt: 2,
    };
    const sig = signAppEntitlement(cert, other);
    expect(verifyAppEntitlement(cert, sig, real.publicKey)).toBe(false);
  });

  it("certId differs from RootEntitlement of the same fields (different TAG prefix)", async () => {
    const pod = makeKey();
    const root: RootEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      podCanonical: POD_CANONICAL,
      issuedAt: 1,
    };
    const app: AppEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      canonicals: [POD_CANONICAL],
      issuedAt: 1,
      expiresAt: 2,
    };
    const a = await rootEntitlementCertId(root);
    const b = await appEntitlementCertId(app);
    expect(a).not.toEqual(b);
  });

  it("canonicals are case-normalized in the certId computation", async () => {
    const pod = makeKey();
    const lower: AppEntitlement = {
      username: USER,
      podPubKey: pod.publicKey,
      canonicals: ["x.kitchen.john.flagship.services"],
      issuedAt: 1,
      expiresAt: 2,
    };
    const upper: AppEntitlement = {
      ...lower,
      canonicals: ["X.KITCHEN.JOHN.flagship.services"],
    };
    expect(await appEntitlementCertId(lower)).toEqual(await appEntitlementCertId(upper));
  });
});

describe("EntitlementRevocationList", () => {
  it("round-trips and is order-independent in certIds", () => {
    const irk = makeKey();
    const a: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32), "bb".repeat(32)],
      issuedAt: 1,
    };
    const b: EntitlementRevocationList = {
      ...a,
      certIds: [...a.certIds].reverse(),
    };
    const sig = signEntitlementRevocationList(a, irk);
    expect(verifyEntitlementRevocationList(a, sig, irk.publicKey)).toBe(true);
    expect(verifyEntitlementRevocationList(b, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a tampered list", () => {
    const irk = makeKey();
    const a: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32)],
      issuedAt: 1,
    };
    const sig = signEntitlementRevocationList(a, irk);
    const tampered: EntitlementRevocationList = { ...a, certIds: ["cc".repeat(32)] };
    expect(verifyEntitlementRevocationList(tampered, sig, irk.publicKey)).toBe(false);
  });
});

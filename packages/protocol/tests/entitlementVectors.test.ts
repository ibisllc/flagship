import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  canonicalEntitlementRevocationList,
  canonicalRootEntitlement,
  canonicalServiceEntitlement,
  canonicalServiceGrant,
  canonicalTunnelHelloV2,
  serviceGrantActiveAt,
  serviceGrantAuthorizesPod,
  type ServiceGrant,
} from "../src/entitlements.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/entitlements/vectors.json", import.meta.url), "utf8"));
const b = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const text = (x: Uint8Array): string => Buffer.from(x).toString("utf8");

function canon(kind: string, i: any): Uint8Array {
  switch (kind) {
    case "root":
      return canonicalRootEntitlement({ username: i.username, podPubKey: b(i.podPubKeyHex), podCanonical: i.podCanonical, issuedAt: i.issuedAt });
    case "service":
      return canonicalServiceEntitlement({ username: i.username, podPubKey: b(i.podPubKeyHex), canonicals: i.canonicals, issuedAt: i.issuedAt, expiresAt: i.expiresAt });
    case "hello":
      return canonicalTunnelHelloV2({ serverId: i.serverId, rootEntitlementCertId: i.rootEntitlementCertId, serviceEntitlementCertId: i.serviceEntitlementCertId, nonce: b(i.nonceHex), issuedAt: i.issuedAt });
    case "revocation":
      return canonicalEntitlementRevocationList({ username: i.username, certIds: i.certIds, issuedAt: i.issuedAt });
    default:
      return canonicalServiceGrant(grant(i));
  }
}

function grant(i: any): ServiceGrant {
  return { ...i, serverIdentities: i.serverIdentitiesHex.map(b) } as ServiceGrant;
}

describe("entitlement vectors", () => {
  for (const c of V.cases) {
    it(c.name, () => {
      if (c.canonical === null) {
        expect(() => canon(c.kind, c.input)).toThrow();
        return;
      }
      const bytes = canon(c.kind, c.input);
      expect(text(bytes)).toBe(c.canonical);
      if (c.signatureHex) expect(ed.verify(b(c.signatureHex), bytes, b(c.signerPubHex))).toBe(c.verifies);
    });
  }
  it("grant windows and pod authorisation", () => {
    const g = grant(V.grantWindow.grant);
    for (const w of V.grantWindow.checks) expect(serviceGrantActiveAt(g, w.at)).toBe(w.active);
    for (const p of V.grantWindow.pods) expect(serviceGrantAuthorizesPod(g, b(p.podPubKeyHex))).toBe(p.authorized);
  });
});

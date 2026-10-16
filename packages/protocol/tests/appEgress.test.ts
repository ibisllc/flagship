import { describe, expect, it } from "vitest";
import {
  appEgressGrantCanonicalBytes,
  parseAppEgressGrant,
  signAppEgressGrant,
  verifyAppEgressGrant,
  type AppEgressGrant,
} from "../src/appEgress.js";
import { signDebugAccessRevoke } from "../src/debugAccess.js";
import { hex as bytesToHex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

// Golden vector for the iOS / Android / webapp ports. Hosts go in unsorted;
// the canonical form sorts them.
const GRANT: AppEgressGrant = {
  serverDomain: "home.harry.flagship.services",
  serviceId: "harry-weather",
  hosts: ["api.open-meteo.com", "*.tile.openstreetmap.org", "api.github.com"],
  issuedAt: 1_700_000_000_000,
};
const CANONICAL =
  "flagship/app-egress/v1|home.harry.flagship.services|harry-weather|*.tile.openstreetmap.org,api.github.com,api.open-meteo.com|1700000000000";
const REVOKE_CANONICAL = "flagship/app-egress/v1|home.harry.flagship.services|harry-weather||1700000000000";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(42) });

describe("AppEgressGrant (owner approval of a live app's internet hosts)", () => {
  it("has the pinned canonical bytes, hosts sorted", () => {
    expect(new TextDecoder().decode(appEgressGrantCanonicalBytes(GRANT))).toBe(CANONICAL);
    expect(new TextDecoder().decode(appEgressGrantCanonicalBytes({ ...GRANT, hosts: [] }))).toBe(REVOKE_CANONICAL);
  });

  it("has the pinned signatures under the fixture IRK", () => {
    expect(bytesToHex(irk.publicKey)).toBe(GOLDEN_PUB);
    expect(bytesToHex(signAppEgressGrant(GRANT, irk))).toBe(GOLDEN_SIG);
    expect(bytesToHex(signAppEgressGrant({ ...GRANT, hosts: [] }, irk))).toBe(GOLDEN_REVOKE_SIG);
  });

  it("is independent of the order hosts are given in", () => {
    const sig = signAppEgressGrant(GRANT, irk);
    expect(verifyAppEgressGrant({ ...GRANT, hosts: [...GRANT.hosts].reverse() }, sig, irk.publicKey)).toBe(true);
  });

  it("verifies under the signer and nothing else", () => {
    const sig = signAppEgressGrant(GRANT, irk);
    expect(verifyAppEgressGrant(GRANT, sig, irk.publicKey)).toBe(true);
    const other = deriveIRK({ seed: new Uint8Array(32).fill(0xff) });
    expect(verifyAppEgressGrant(GRANT, sig, other.publicKey)).toBe(false);
    expect(verifyAppEgressGrant({ ...GRANT, serverDomain: "media.harry.flagship.services" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppEgressGrant({ ...GRANT, serviceId: "harry-notes" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppEgressGrant({ ...GRANT, hosts: [...GRANT.hosts, "evil.example.com"] }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppEgressGrant({ ...GRANT, hosts: GRANT.hosts.slice(1) }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppEgressGrant({ ...GRANT, issuedAt: GRANT.issuedAt + 1 }, sig, irk.publicKey)).toBe(false);
  });

  it("an approval is not a revoke and vice versa", () => {
    const approve = signAppEgressGrant(GRANT, irk);
    const revoke = signAppEgressGrant({ ...GRANT, hosts: [] }, irk);
    expect(verifyAppEgressGrant({ ...GRANT, hosts: [] }, approve, irk.publicKey)).toBe(false);
    expect(verifyAppEgressGrant(GRANT, revoke, irk.publicKey)).toBe(false);
  });

  it("never accepts another envelope's signature", () => {
    const debug = signDebugAccessRevoke({ serverDomain: GRANT.serverDomain, issuedAt: GRANT.issuedAt }, irk);
    expect(verifyAppEgressGrant(GRANT, debug, irk.publicKey)).toBe(false);
  });

  it("refuses to canonicalize ambiguous or invalid grants", () => {
    const bad: AppEgressGrant[] = [
      { ...GRANT, hosts: ["a.example.com", "a.example.com"] },
      { ...GRANT, hosts: ["a.example.com,b.example.com"] },
      { ...GRANT, hosts: ["A.example.com"] },
      { ...GRANT, hosts: ["1.2.3.4"] },
      { ...GRANT, serviceId: "harry|weather" },
      { ...GRANT, serviceId: "" },
      { ...GRANT, serverDomain: "" },
      { ...GRANT, issuedAt: 1.5 },
    ];
    for (const g of bad) {
      expect(() => appEgressGrantCanonicalBytes(g)).toThrow();
      expect(verifyAppEgressGrant(g, signAppEgressGrant(GRANT, irk), irk.publicKey)).toBe(false);
      expect(parseAppEgressGrant(g)).toBeNull();
    }
  });

  it("parses a JSON grant", () => {
    expect(parseAppEgressGrant(JSON.parse(JSON.stringify(GRANT)))).toEqual(GRANT);
    expect(parseAppEgressGrant({ ...GRANT, hosts: "api.github.com" })).toBeNull();
    expect(parseAppEgressGrant({ ...GRANT, issuedAt: "1700000000000" })).toBeNull();
    expect(parseAppEgressGrant(null)).toBeNull();
  });
});

const GOLDEN_PUB = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4";
const GOLDEN_SIG =
  "a3788a82b718af70e81db6b319229d1d469944a999dd7fbe1b77fa1da58c22bcc0d58241d7cbdd9c8954234d03f8d8cdf1e42ef24510eb100a373fdb1ba8f703";
const GOLDEN_REVOKE_SIG =
  "332195add8c4f75eb5c472500c8b4d253c5024b58fab3dc81b7e84261fabd9f278c5b348991d20e08b7c4799e950b6ece4af2018cd897797de35e8aa3e6e3901";

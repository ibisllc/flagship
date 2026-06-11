import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ed,
  parseTier2ServiceFqdn,
  serviceCertAuthorityValidAt,
  SERVICE_CERT_AUTHORITY_MAX_TTL_MS,
  signServiceCertAuthority,
  signServiceCertExport,
  signServiceCertInstall,
  signServiceCertMint,
  verifyServiceCertAuthority,
  verifyServiceCertExport,
  verifyServiceCertInstall,
  verifyServiceCertMint,
  type Keypair,
  type ServiceCertAuthority,
  type ServiceCertExportRequest,
  type ServiceCertInstall,
  type ServiceCertMintRequest,
} from "../src/index.js";

function kp(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const irk = kp(7);
const otherKey = kp(9);

const NOW = 1_770_000_000_000;
const USER = "harry1";
const SERVICE_FQDN = "chat.harry1.flagship.services";
const BOX = "abc5.harry1.flagship.services";

const authority: ServiceCertAuthority = {
  username: USER,
  serviceFqdn: SERVICE_FQDN,
  boxServerId: BOX,
  issuedAt: NOW,
  expiresAt: NOW + 60 * 60_000,
};

const mint: ServiceCertMintRequest = {
  username: USER,
  serviceFqdn: SERVICE_FQDN,
  serverId: BOX,
  issuedAt: NOW,
};

const exportReq: ServiceCertExportRequest = {
  username: USER,
  serviceFqdn: SERVICE_FQDN,
  serverId: BOX,
  issuedAt: NOW,
};

const certSha = sha256(new TextEncoder().encode("CERTPEM"));
const keySha = sha256(new TextEncoder().encode("KEYPEM"));
const install: ServiceCertInstall = {
  username: USER,
  serviceFqdn: SERVICE_FQDN,
  serverId: BOX,
  certPemSha256: certSha,
  keyPemSha256: keySha,
  notAfter: NOW + 90 * 24 * 60 * 60_000,
  issuedAt: NOW,
};

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

describe("service-cert envelopes — sign/verify", () => {
  it("ServiceCertAuthority roundtrips and rejects the wrong key", () => {
    const sig = signServiceCertAuthority(authority, irk);
    expect(verifyServiceCertAuthority(authority, sig, irk.publicKey)).toBe(true);
    expect(verifyServiceCertAuthority(authority, sig, otherKey.publicKey)).toBe(false);
  });

  it("ServiceCertAuthority rejects field tampering", () => {
    const sig = signServiceCertAuthority(authority, irk);
    expect(
      verifyServiceCertAuthority(
        { ...authority, boxServerId: "evil.harry1.flagship.services" },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
    expect(
      verifyServiceCertAuthority(
        { ...authority, serviceFqdn: "other.harry1.flagship.services" },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
    expect(
      verifyServiceCertAuthority({ ...authority, expiresAt: authority.expiresAt + 1 }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("ServiceCertMintRequest roundtrips and binds the serverId", () => {
    const sig = signServiceCertMint(mint, irk);
    expect(verifyServiceCertMint(mint, sig, irk.publicKey)).toBe(true);
    expect(
      verifyServiceCertMint({ ...mint, serverId: "other.harry1.flagship.services" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("ServiceCertExportRequest roundtrips and is not interchangeable with mint", () => {
    const sig = signServiceCertExport(exportReq, irk);
    expect(verifyServiceCertExport(exportReq, sig, irk.publicKey)).toBe(true);
    // A mint signature must not verify as an export (distinct tags).
    const mintSig = signServiceCertMint(mint, irk);
    expect(verifyServiceCertExport(exportReq, mintSig, irk.publicKey)).toBe(false);
  });

  it("ServiceCertInstall commits to the PEM hashes", () => {
    const sig = signServiceCertInstall(install, irk);
    expect(verifyServiceCertInstall(install, sig, irk.publicKey)).toBe(true);
    const swapped = { ...install, certPemSha256: sha256(new TextEncoder().encode("EVIL")) };
    expect(verifyServiceCertInstall(swapped, sig, irk.publicKey)).toBe(false);
    const swappedKey = { ...install, keyPemSha256: sha256(new TextEncoder().encode("EVIL")) };
    expect(verifyServiceCertInstall(swappedKey, sig, irk.publicKey)).toBe(false);
  });

  it("refuses fields containing the canonical separator", () => {
    expect(() =>
      signServiceCertAuthority({ ...authority, username: "a|b" }, irk),
    ).toThrow(/separator/);
    expect(() =>
      signServiceCertMint({ ...mint, serviceFqdn: "x|y.flagship.services" }, irk),
    ).toThrow(/separator/);
  });
});

describe("service-cert envelopes — canonical vectors (pinned wire format)", () => {
  // Cross-implementation pins: any client (Swift/Kotlin) must produce these
  // EXACT bytes for the same fields or signatures will not interop.
  it("authority canonical bytes", () => {
    const expected =
      `flagship/service-cert-authority/v1|${USER}|${SERVICE_FQDN}|${BOX}|${NOW}|${NOW + 3_600_000}`;
    const sig = signServiceCertAuthority(authority, irk);
    const manual = ed.sign(new TextEncoder().encode(expected), irk.privateKey);
    expect(hex(sig)).toBe(hex(manual));
  });

  it("mint canonical bytes", () => {
    const expected = `flagship/service-cert-mint/v1|${USER}|${SERVICE_FQDN}|${BOX}|${NOW}`;
    const sig = signServiceCertMint(mint, irk);
    const manual = ed.sign(new TextEncoder().encode(expected), irk.privateKey);
    expect(hex(sig)).toBe(hex(manual));
  });

  it("export canonical bytes", () => {
    const expected = `flagship/service-cert-export/v1|${USER}|${SERVICE_FQDN}|${BOX}|${NOW}`;
    const sig = signServiceCertExport(exportReq, irk);
    const manual = ed.sign(new TextEncoder().encode(expected), irk.privateKey);
    expect(hex(sig)).toBe(hex(manual));
  });

  it("install canonical bytes", () => {
    const expected =
      `flagship/service-cert-install/v1|${USER}|${SERVICE_FQDN}|${BOX}|${hex(certSha)}|${hex(keySha)}|${install.notAfter}|${NOW}`;
    const sig = signServiceCertInstall(install, irk);
    const manual = ed.sign(new TextEncoder().encode(expected), irk.privateKey);
    expect(hex(sig)).toBe(hex(manual));
  });
});

describe("parseTier2ServiceFqdn", () => {
  it("accepts <service>.<user>.flagship.services", () => {
    expect(parseTier2ServiceFqdn("chat.harry1.flagship.services")).toEqual({
      service: "chat",
      username: "harry1",
    });
  });

  it("normalizes case", () => {
    expect(parseTier2ServiceFqdn("Chat.Harry1.Flagship.Services", "flagship.services")).toEqual({
      service: "chat",
      username: "harry1",
    });
  });

  it("rejects the user-zone apex, deep names, and foreign apexes", () => {
    expect(parseTier2ServiceFqdn("harry1.flagship.services")).toBeNull();
    expect(parseTier2ServiceFqdn("x.abc5.harry1.flagship.services")).toBeNull();
    expect(parseTier2ServiceFqdn("chat.harry1.evil.example")).toBeNull();
    expect(parseTier2ServiceFqdn("flagship.services")).toBeNull();
  });

  it("rejects bad labels", () => {
    expect(parseTier2ServiceFqdn("-chat.harry1.flagship.services")).toBeNull();
    expect(parseTier2ServiceFqdn("ch_at.harry1.flagship.services")).toBeNull();
  });
});

describe("serviceCertAuthorityValidAt", () => {
  it("accepts a live grant", () => {
    expect(serviceCertAuthorityValidAt(authority, NOW + 10_000)).toBe(true);
  });

  it("rejects an expired grant", () => {
    expect(serviceCertAuthorityValidAt(authority, authority.expiresAt + 1)).toBe(false);
  });

  it("rejects a not-yet-issued grant beyond skew", () => {
    expect(serviceCertAuthorityValidAt(authority, NOW - 6 * 60_000)).toBe(false);
    // Within skew is fine.
    expect(serviceCertAuthorityValidAt(authority, NOW - 4 * 60_000)).toBe(true);
  });

  it("rejects a grant whose TTL exceeds the maximum", () => {
    const tooLong = {
      ...authority,
      expiresAt: authority.issuedAt + SERVICE_CERT_AUTHORITY_MAX_TTL_MS + 1,
    };
    expect(serviceCertAuthorityValidAt(tooLong, NOW)).toBe(false);
  });

  it("rejects inverted/non-finite windows", () => {
    expect(serviceCertAuthorityValidAt({ ...authority, expiresAt: authority.issuedAt }, NOW)).toBe(false);
    expect(serviceCertAuthorityValidAt({ ...authority, expiresAt: Number.NaN }, NOW)).toBe(false);
  });
});

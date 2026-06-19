import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
} from "../src/keys.js";
import {
  serviceInviteId,
  serviceInviteSecretHash,
  sealInviteBundle,
  openInviteBundle,
  signCreateServiceInvite,
  verifyCreateServiceInvite,
  signRedeemServiceInvite,
  verifyRedeemServiceInvite,
  signRevokeServiceInvite,
  verifyRevokeServiceInvite,
  signSetServiceAccessMode,
  verifySetServiceAccessMode,
  signServiceVisitProof,
  verifyServiceVisitProof,
  signKnockAuthorization,
  verifyKnockAuthorization,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type SetServiceAccessMode,
  type ServiceVisitProof,
  type KnockAuthorization,
} from "../src/serviceInvite.js";

const authorUmk = { seed: new Uint8Array(32).fill(11) };
const friendUmk = { seed: new Uint8Array(32).fill(22) };
const authorIrk = deriveIRK(authorUmk);
const authorAid = deriveAccountId(authorUmk);
const authorDevice = deriveIRK(authorUmk); // device key the inviteId binds
const friendAid = deriveAccountId(friendUmk);
const householdKey = deriveHouseholdKey(authorUmk);

describe("serviceInviteId", () => {
  it("is a pinned, deterministic 64-hex digest", () => {
    expect(serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0)).toBe(
      "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890",
    );
    expect(serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 1)).toBe(
      "d598c933945705dbd1889989ceee5f2a50c8a62533ff9a5d9186190c49d00d7b",
    );
  });

  it("is monotonic per (account, device) — counter changes the id", () => {
    const a = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
    const b = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 1);
    expect(a).not.toBe(b);
  });

  it("differs by author AID and by device pub (attribution)", () => {
    const base = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
    const otherAuthor = serviceInviteId(friendAid.publicKey, authorDevice.publicKey, 0);
    const otherDevice = serviceInviteId(authorAid.publicKey, friendAid.publicKey, 0);
    expect(otherAuthor).not.toBe(base);
    expect(otherDevice).not.toBe(base);
  });

  it("rejects a negative / non-integer counter", () => {
    expect(() => serviceInviteId(authorAid.publicKey, authorDevice.publicKey, -1)).toThrow();
    expect(() => serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 1.5)).toThrow();
  });
});

describe("serviceInviteSecretHash", () => {
  it("is the pinned SHA-256 hex of the secret", () => {
    expect(serviceInviteSecretHash(new Uint8Array(32).fill(7))).toBe(
      "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0",
    );
  });
});

describe("invite bundle (household-key sealed, value-blind to .com)", () => {
  const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);

  it("seals + opens a name-only bundle", () => {
    const sealed = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    expect(openInviteBundle(sealed, householdKey, inviteId)).toEqual({ name: "Alex" });
  });

  it("seals + opens a name+photo bundle", () => {
    const bundle = { name: "Alex", photo: "data:image/png;base64,AAAA" };
    const sealed = sealInviteBundle(bundle, householdKey, inviteId);
    expect(openInviteBundle(sealed, householdKey, inviteId)).toEqual(bundle);
  });

  it("a sibling device (same UMK → same household key) can open it", () => {
    const siblingHouseholdKey = deriveHouseholdKey({ seed: Uint8Array.from(authorUmk.seed) });
    const sealed = sealInviteBundle({ name: "Bo" }, householdKey, inviteId);
    expect(openInviteBundle(sealed, siblingHouseholdKey, inviteId)).toEqual({ name: "Bo" });
  });

  it("a different account's household key CANNOT open it (.com holds no UMK)", () => {
    const otherKey = deriveHouseholdKey(friendUmk);
    const sealed = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    expect(() => openInviteBundle(sealed, otherKey, inviteId)).toThrow();
  });

  it("is AAD-bound to the inviteId — can't be lifted onto another invite", () => {
    const other = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 1);
    const sealed = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    expect(() => openInviteBundle(sealed, householdKey, other)).toThrow();
  });

  it("uses a random nonce — two seals of the same bundle differ", () => {
    const a = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    const b = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    expect(a).not.toBe(b);
  });

  it("rejects a non-32-byte household key", () => {
    expect(() => sealInviteBundle({ name: "x" }, new Uint8Array(16), inviteId)).toThrow();
  });
});

describe("create envelope (IRK-signed by the author)", () => {
  const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: authorAid.publicKey,
    serviceRef: "alice-notes",
    secretHash: serviceInviteSecretHash(new Uint8Array(32).fill(7)),
    encryptedBundle: sealInviteBundle({ name: "Alex" }, householdKey, inviteId),
    issuedAt: 1_700_000_000_000,
  };

  it("signs + verifies under the author IRK", () => {
    const sig = signCreateServiceInvite(create, authorIrk);
    expect(verifyCreateServiceInvite(create, sig, authorIrk.publicKey)).toBe(true);
  });

  it("does NOT verify under the author AID (create is IRK-signed, not AID-signed)", () => {
    const sig = signCreateServiceInvite(create, authorIrk);
    expect(verifyCreateServiceInvite(create, sig, authorAid.publicKey)).toBe(false);
  });

  it("rejects a tampered serviceRef (escalating to another service)", () => {
    const sig = signCreateServiceInvite(create, authorIrk);
    expect(
      verifyCreateServiceInvite({ ...create, serviceRef: "alice-secret" }, sig, authorIrk.publicKey),
    ).toBe(false);
  });

  it("rejects a swapped authorAID", () => {
    const sig = signCreateServiceInvite(create, authorIrk);
    expect(
      verifyCreateServiceInvite({ ...create, authorAID: friendAid.publicKey }, sig, authorIrk.publicKey),
    ).toBe(false);
  });

  it("rejects a separator-injecting serviceRef at sign time", () => {
    expect(() => signCreateServiceInvite({ ...create, serviceRef: "a|b" }, authorIrk)).toThrow();
  });
});

describe("redeem envelope (AID-signed by the friend)", () => {
  const redeem: RedeemServiceInvite = {
    secretHash: serviceInviteSecretHash(new Uint8Array(32).fill(7)),
    visitorAID: friendAid.publicKey,
    redeemedAt: 1_700_000_500_000,
  };

  it("signs + verifies under the friend's AID", () => {
    const sig = signRedeemServiceInvite(redeem, friendAid);
    expect(verifyRedeemServiceInvite(redeem, sig, friendAid.publicKey)).toBe(true);
  });

  it("does NOT verify under the friend's IRK (redeem is AID-signed)", () => {
    const friendIrk = deriveIRK(friendUmk);
    const sig = signRedeemServiceInvite(redeem, friendAid);
    expect(verifyRedeemServiceInvite(redeem, sig, friendIrk.publicKey)).toBe(false);
  });

  it("a forged visitorAID (signed by a different key) fails", () => {
    // Attacker signs with their own AID but claims the victim's visitorAID.
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(99) });
    const sig = signRedeemServiceInvite(redeem, attacker);
    expect(verifyRedeemServiceInvite(redeem, sig, redeem.visitorAID)).toBe(false);
  });

  it("rejects a tampered secretHash", () => {
    const sig = signRedeemServiceInvite(redeem, friendAid);
    expect(
      verifyRedeemServiceInvite({ ...redeem, secretHash: "00".repeat(32) }, sig, friendAid.publicKey),
    ).toBe(false);
  });
});

describe("revoke envelope (IRK-signed by the author)", () => {
  const revoke: RevokeServiceInvite = {
    inviteId: serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0),
    issuedAt: 1_700_001_000_000,
  };

  it("signs + verifies under the author IRK", () => {
    const sig = signRevokeServiceInvite(revoke, authorIrk);
    expect(verifyRevokeServiceInvite(revoke, sig, authorIrk.publicKey)).toBe(true);
  });

  it("rejects a swapped inviteId", () => {
    const sig = signRevokeServiceInvite(revoke, authorIrk);
    expect(
      verifyRevokeServiceInvite(
        { ...revoke, inviteId: serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 1) },
        sig,
        authorIrk.publicKey,
      ),
    ).toBe(false);
  });

  it("does not verify under a stranger's key", () => {
    const sig = signRevokeServiceInvite(revoke, authorIrk);
    const stranger = deriveIRK(friendUmk);
    expect(verifyRevokeServiceInvite(revoke, sig, stranger.publicKey)).toBe(false);
  });
});

describe("set-access-mode envelope (owner-IRK-signed)", () => {
  const base: SetServiceAccessMode = {
    serverId: "home.alice.flagship.services",
    serviceRef: "alice-notes",
    mode: "restricted",
    issuedAt: 1_700_002_000_000,
  };

  it("signs + verifies under the owner IRK for both modes", () => {
    for (const mode of ["open", "restricted"] as const) {
      const s = { ...base, mode };
      const sig = signSetServiceAccessMode(s, authorIrk);
      expect(verifySetServiceAccessMode(s, sig, authorIrk.publicKey)).toBe(true);
    }
  });

  it("rejects a tampered mode (open↔restricted swap)", () => {
    const sig = signSetServiceAccessMode(base, authorIrk);
    expect(verifySetServiceAccessMode({ ...base, mode: "open" }, sig, authorIrk.publicKey)).toBe(false);
  });

  it("rejects a tampered serviceRef", () => {
    const sig = signSetServiceAccessMode(base, authorIrk);
    expect(
      verifySetServiceAccessMode({ ...base, serviceRef: "alice-secret" }, sig, authorIrk.publicKey),
    ).toBe(false);
  });

  it("does not verify under a stranger key", () => {
    const sig = signSetServiceAccessMode(base, authorIrk);
    expect(verifySetServiceAccessMode(base, sig, friendAid.publicKey)).toBe(false);
  });

  it("rejects an invalid mode at sign time", () => {
    expect(() =>
      signSetServiceAccessMode({ ...base, mode: "weird" as unknown as "open" }, authorIrk),
    ).toThrow();
  });
});

describe("service-visit proof (AID-signed by the friend)", () => {
  const visit: ServiceVisitProof = {
    serverId: "home.alice.flagship.services",
    serviceRef: "alice-notes",
    visitorAID: friendAid.publicKey,
    issuedAt: 1_700_003_000_000,
  };

  it("signs + verifies under the friend's AID", () => {
    const sig = signServiceVisitProof(visit, friendAid);
    expect(verifyServiceVisitProof(visit, sig, friendAid.publicKey)).toBe(true);
  });

  it("does not verify under the friend's IRK (visit is AID-signed)", () => {
    const friendIrk = deriveIRK(friendUmk);
    const sig = signServiceVisitProof(visit, friendAid);
    expect(verifyServiceVisitProof(visit, sig, friendIrk.publicKey)).toBe(false);
  });

  it("rejects a proof bound to a different serviceRef", () => {
    const sig = signServiceVisitProof(visit, friendAid);
    expect(
      verifyServiceVisitProof({ ...visit, serviceRef: "alice-secret" }, sig, friendAid.publicKey),
    ).toBe(false);
  });

  it("a forged visitorAID (signed by another key) fails", () => {
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(77) });
    const sig = signServiceVisitProof(visit, attacker);
    expect(verifyServiceVisitProof(visit, sig, visit.visitorAID)).toBe(false);
  });
});

describe("knock authorization (AID-signed by the phone; binds the pageId)", () => {
  const knock: KnockAuthorization = {
    serverId: "home.alice.flagship.services",
    serviceRef: "alice-notes",
    pageId: "cb2421036efeb738c6017d8ee92e7b89",
    visitorAID: friendAid.publicKey,
    issuedAt: 1_700_004_000_000,
  };

  it("signs + verifies under the friend's AID", () => {
    const sig = signKnockAuthorization(knock, friendAid);
    expect(verifyKnockAuthorization(knock, sig, friendAid.publicKey)).toBe(true);
  });

  it("the pageId is IN the signature — a different pageId fails (no replay onto another page)", () => {
    const sig = signKnockAuthorization(knock, friendAid);
    expect(
      verifyKnockAuthorization({ ...knock, pageId: "00000000000000000000000000000000" }, sig, friendAid.publicKey),
    ).toBe(false);
  });

  it("rejects a different serverId / serviceRef", () => {
    const sig = signKnockAuthorization(knock, friendAid);
    expect(verifyKnockAuthorization({ ...knock, serverId: "evil.bob.flagship.services" }, sig, friendAid.publicKey)).toBe(false);
    expect(verifyKnockAuthorization({ ...knock, serviceRef: "alice-secret" }, sig, friendAid.publicKey)).toBe(false);
  });

  it("does not verify under the friend's IRK (knock is AID-signed)", () => {
    const friendIrk = deriveIRK(friendUmk);
    const sig = signKnockAuthorization(knock, friendAid);
    expect(verifyKnockAuthorization(knock, sig, friendIrk.publicKey)).toBe(false);
  });

  it("a forged visitorAID (signed by a stranger) fails", () => {
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(88) });
    const sig = signKnockAuthorization(knock, attacker);
    expect(verifyKnockAuthorization(knock, sig, knock.visitorAID)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveContactAccountId,
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
  signRemoveServiceAllow,
  verifyRemoveServiceAllow,
  signAcceptServiceInvite,
  verifyAcceptServiceInvite,
  randomServiceInviteId,
  type AcceptServiceInvite,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type SetServiceAccessMode,
  type ServiceVisitProof,
  type KnockAuthorization,
  type RemoveServiceAllow,
} from "../src/serviceInvite.js";

const authorUmk = { seed: new Uint8Array(32).fill(11) };
const friendUmk = { seed: new Uint8Array(32).fill(22) };
const authorIrk = deriveIRK(authorUmk);
const authorAid = deriveAccountId(authorUmk);
const authorDevice = deriveIRK(authorUmk); // device key the inviteId binds
const friendAid = deriveAccountId(friendUmk);
const householdKey = deriveHouseholdKey(authorUmk);
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

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

describe("remove-from-allow-list (owner-IRK-signed prune)", () => {
  const remove: RemoveServiceAllow = {
    serverId: "home.alice.flagship.services",
    serviceRef: "alice-notes",
    aid: hexOf(friendAid.publicKey),
    issuedAt: 1_700_005_000_000,
  };

  it("signs + verifies under the owner IRK", () => {
    const sig = signRemoveServiceAllow(remove, authorIrk);
    expect(verifyRemoveServiceAllow(remove, sig, authorIrk.publicKey)).toBe(true);
  });

  it("rejects a different serviceRef / aid / serverId (each is in the signature)", () => {
    const sig = signRemoveServiceAllow(remove, authorIrk);
    expect(verifyRemoveServiceAllow({ ...remove, serviceRef: "alice-secret" }, sig, authorIrk.publicKey)).toBe(false);
    expect(verifyRemoveServiceAllow({ ...remove, aid: "00".repeat(32) }, sig, authorIrk.publicKey)).toBe(false);
    expect(verifyRemoveServiceAllow({ ...remove, serverId: "evil.bob.flagship.services" }, sig, authorIrk.publicKey)).toBe(false);
  });

  it("does not verify under a stranger key (only the owner IRK can prune)", () => {
    const sig = signRemoveServiceAllow(remove, authorIrk);
    expect(verifyRemoveServiceAllow(remove, sig, friendAid.publicKey)).toBe(false);
  });
});

describe("v2 — pairwise contact AID (deriveContactAccountId)", () => {
  it("is stable per (consumer, author) and matches the pinned vector", () => {
    const c1 = deriveContactAccountId(friendUmk, authorAid.publicKey);
    const c2 = deriveContactAccountId(friendUmk, authorAid.publicKey);
    expect(hexOf(c1.publicKey)).toBe(hexOf(c2.publicKey));
    expect(hexOf(c1.publicKey)).toBe(
      "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a",
    );
  });

  it("is UNLINKABLE across authors (same friend, different author ⇒ different id)", () => {
    const author2 = deriveAccountId({ seed: new Uint8Array(32).fill(0x0c) });
    const a = hexOf(deriveContactAccountId(friendUmk, authorAid.publicKey).publicKey);
    const b = hexOf(deriveContactAccountId(friendUmk, author2.publicKey).publicKey);
    expect(a).not.toBe(b);
  });

  it("differs from the friend's global AID (the consumer presents a pseudonym, not their account id)", () => {
    const contact = deriveContactAccountId(friendUmk, authorAid.publicKey);
    expect(hexOf(contact.publicKey)).not.toBe(hexOf(friendAid.publicKey));
  });
});

describe("v2 — manual-approve acceptance (AID-signed by the friend's contact AID)", () => {
  const contact = deriveContactAccountId(friendUmk, authorAid.publicKey);
  const accept: AcceptServiceInvite = {
    inviteId: "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890",
    serviceRef: "alice-notes",
    contactAID: contact.publicKey,
    acceptedAt: 1700006000000,
  };

  it("signs + verifies under the contact AID + matches the pinned vector", () => {
    const sig = signAcceptServiceInvite(accept, contact);
    expect(verifyAcceptServiceInvite(accept, sig, contact.publicKey)).toBe(true);
    expect(hexOf(sig)).toBe(
      "1c54021039b6698f5d8d9d5b002c0528f5f82d90fb2de05ecde79082a9f5838c445e23907f4826ec53a061cec8581baaf0fc7fb7ee5234873bfe18ebea81f808",
    );
  });

  it("rejects a different inviteId / serviceRef (both are in the signature)", () => {
    const sig = signAcceptServiceInvite(accept, contact);
    expect(verifyAcceptServiceInvite({ ...accept, inviteId: "00".repeat(32) }, sig, contact.publicKey)).toBe(false);
    expect(verifyAcceptServiceInvite({ ...accept, serviceRef: "alice-secret" }, sig, contact.publicKey)).toBe(false);
  });

  it("does not verify under a stranger key", () => {
    const sig = signAcceptServiceInvite(accept, contact);
    expect(verifyAcceptServiceInvite(accept, sig, friendAid.publicKey)).toBe(false);
  });
});

describe("v2 — create maxN/expiry (group links, backward-compatible bytes)", () => {
  const base: CreateServiceInvite = {
    inviteId: "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890",
    authorAID: authorAid.publicKey,
    serviceRef: "alice-notes",
    secretHash: "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0",
    encryptedBundle: "00",
    issuedAt: 1700000000000,
  };

  it("a create WITHOUT maxN/exp signs byte-identically to the v1 create vector", () => {
    expect(hexOf(signCreateServiceInvite(base, authorIrk))).toBe(
      "90359a5a49f1da7272850e991b03e2533b12d42b90dd26cf62cd77a0dcae23464d683d3d92aa4374a476b4029e0639a63864ed10104b4ffd2f0a2f9fba780700",
    );
  });

  it("a create WITH maxN+exp matches the pinned createMaxN vector", () => {
    const grp: CreateServiceInvite = { ...base, maxRedemptions: 10, expiresAt: 1700009999999 };
    const sig = signCreateServiceInvite(grp, authorIrk);
    expect(verifyCreateServiceInvite(grp, sig, authorIrk.publicKey)).toBe(true);
    expect(hexOf(sig)).toBe(
      "785641620cb5378afa127819a19f4e1ff110c0bea35678da3365327cf539aa3e148e3eab2246245c9ede4270dec85c4e166b88887a9988fa065f5d7ded06ce02",
    );
  });

  it("a maxN-bearing sig does NOT verify against the no-maxN create (the cap is signed)", () => {
    const grp: CreateServiceInvite = { ...base, maxRedemptions: 10, expiresAt: 1700009999999 };
    const sig = signCreateServiceInvite(grp, authorIrk);
    expect(verifyCreateServiceInvite(base, sig, authorIrk.publicKey)).toBe(false);
  });

  it("rejects a negative / non-integer maxRedemptions at sign time", () => {
    expect(() => signCreateServiceInvite({ ...base, maxRedemptions: -1 }, authorIrk)).toThrow();
  });
});

describe("v2 — randomServiceInviteId", () => {
  it("is 64-char lowercase hex and unique per call", () => {
    const a = randomServiceInviteId();
    const b = randomServiceInviteId();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

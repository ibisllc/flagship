import { describe, expect, it } from "vitest";
import {
  signBootApproval,
  signInvite,
  signInviteAcceptance,
  signMembershipMutation,
  signMigrationRequest,
  signRebuildRequest,
  signRegisterServer,
  signRevocation,
  verifyBootApproval,
  verifyInvite,
  verifyInviteAcceptance,
  verifyMembershipMutation,
  verifyMigrationRequest,
  verifyRebuildRequest,
  verifyRegisterServer,
  verifyRevocation,
  type BootChallenge,
  type ImageRebuildRequest,
  type MembershipMutation,
  type MigrationRequest,
  type RegisterServer,
  type ServerRevocation,
} from "../src/auth.js";
import { deriveBAK, deriveIRK, deriveSWK, deriveSTK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(42) };

describe("BAK boot authorization", () => {
  it("phone-signed approval verifies on the server", () => {
    const bak = deriveBAK(umk, "srv-1");
    const challenge: BootChallenge = {
      serverId: "srv-1",
      nonce: new Uint8Array(32).fill(1),
      issuedAt: 1_700_000_000_000,
    };
    const sig = signBootApproval(challenge, bak);
    expect(verifyBootApproval(challenge, sig, bak.publicKey)).toBe(true);
  });

  it("rejects approval signed by a different server's BAK", () => {
    const bakA = deriveBAK(umk, "srv-A");
    const bakB = deriveBAK(umk, "srv-B");
    const challenge: BootChallenge = {
      serverId: "srv-A",
      nonce: new Uint8Array(32).fill(1),
      issuedAt: 1000,
    };
    const sig = signBootApproval(challenge, bakA);
    expect(verifyBootApproval(challenge, sig, bakB.publicKey)).toBe(false);
  });

  it("rejects tampered challenge (nonce changed)", () => {
    const bak = deriveBAK(umk, "srv-1");
    const challenge: BootChallenge = {
      serverId: "srv-1",
      nonce: new Uint8Array(32).fill(1),
      issuedAt: 1000,
    };
    const sig = signBootApproval(challenge, bak);
    const tampered: BootChallenge = { ...challenge, nonce: new Uint8Array(32).fill(2) };
    expect(verifyBootApproval(tampered, sig, bak.publicKey)).toBe(false);
  });

  it("rejects tampered challenge (issuedAt changed)", () => {
    const bak = deriveBAK(umk, "srv-1");
    const challenge: BootChallenge = {
      serverId: "srv-1",
      nonce: new Uint8Array(32).fill(1),
      issuedAt: 1000,
    };
    const sig = signBootApproval(challenge, bak);
    const tampered: BootChallenge = { ...challenge, issuedAt: 9999 };
    expect(verifyBootApproval(tampered, sig, bak.publicKey)).toBe(false);
  });
});

describe("IRK image rebuild", () => {
  const req: ImageRebuildRequest = {
    userId: "user-1",
    newServerId: "srv-new",
    wifiSsid: "MyWifi",
    wifiPskHash: new Uint8Array(32).fill(3),
    shareRatio: 0.5,
    issuedAt: 1_700_000_000_000,
  };

  it("phone-signed rebuild request verifies at the control plane", () => {
    const irk = deriveIRK(umk);
    const sig = signRebuildRequest(req, irk);
    expect(verifyRebuildRequest(req, sig, irk.publicKey)).toBe(true);
  });

  it("compartmentalization: BAK signature does NOT validate as a rebuild request", () => {
    const bak = deriveBAK(umk, "srv-1");
    const irk = deriveIRK(umk);
    const sig = signRebuildRequest(req, bak);
    expect(verifyRebuildRequest(req, sig, irk.publicKey)).toBe(false);
  });

  it("rejects rebuild request when shareRatio tampered", () => {
    const irk = deriveIRK(umk);
    const sig = signRebuildRequest(req, irk);
    const tampered = { ...req, shareRatio: 0.9 };
    expect(verifyRebuildRequest(tampered, sig, irk.publicKey)).toBe(false);
  });
});

describe("IRK server revocation", () => {
  it("revocation signed with IRK verifies", () => {
    const irk = deriveIRK(umk);
    const rev: ServerRevocation = {
      userId: "user-1",
      revokedServerId: "srv-stolen",
      reason: "stolen",
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRevocation(rev, irk);
    expect(verifyRevocation(rev, sig, irk.publicKey)).toBe(true);
  });

  it("a stolen-server BAK cannot self-revoke (BAK != IRK)", () => {
    const irk = deriveIRK(umk);
    const stolenBak = deriveBAK(umk, "srv-stolen");
    const rev: ServerRevocation = {
      userId: "user-1",
      revokedServerId: "srv-stolen",
      reason: "stolen",
      issuedAt: 1000,
    };
    const sig = signRevocation(rev, stolenBak);
    expect(verifyRevocation(rev, sig, irk.publicKey)).toBe(false);
  });
});

describe("IRK membership mutation", () => {
  const sarahIrkPub = deriveIRK({ seed: new Uint8Array(32).fill(33) }).publicKey;
  const m: MembershipMutation = {
    appId: "habit-tracker",
    targetIrkPub: sarahIrkPub,
    role: "parent",
    issuedAt: 1_700_000_000_000,
  };

  it("owner-signed membership mutation verifies", () => {
    const irk = deriveIRK(umk);
    const sig = signMembershipMutation(m, irk);
    expect(verifyMembershipMutation(m, sig, irk.publicKey)).toBe(true);
  });

  it("rejects when role is tampered (parent → admin)", () => {
    const irk = deriveIRK(umk);
    const sig = signMembershipMutation(m, irk);
    const tampered: MembershipMutation = { ...m, role: "admin" };
    expect(verifyMembershipMutation(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects when target IRK pubkey is tampered (cannot redirect to attacker)", () => {
    const irk = deriveIRK(umk);
    const sig = signMembershipMutation(m, irk);
    const attackerPub = deriveIRK({ seed: new Uint8Array(32).fill(0xff) }).publicKey;
    const tampered: MembershipMutation = { ...m, targetIrkPub: attackerPub };
    expect(verifyMembershipMutation(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("removal mutation (role=null) is signable and verifiable", () => {
    const irk = deriveIRK(umk);
    const removal: MembershipMutation = { ...m, role: null };
    const sig = signMembershipMutation(removal, irk);
    expect(verifyMembershipMutation(removal, sig, irk.publicKey)).toBe(true);
  });

  it("compartmentalization: BAK signature does NOT validate as membership", () => {
    const bak = deriveBAK(umk, "srv-1");
    const irk = deriveIRK(umk);
    const sig = signMembershipMutation(m, bak);
    expect(verifyMembershipMutation(m, sig, irk.publicKey)).toBe(false);
  });
});

describe("invite tokens (capability-based, no directory)", () => {
  const appId = "habit-tracker";

  it("owner-signed invite verifies; acceptance binds it to recipient's IRK", () => {
    const ownerIrk = deriveIRK(umk);
    const accepter = deriveIRK({ seed: new Uint8Array(32).fill(55) });
    const nonce = new Uint8Array(32).fill(7);
    const issuedAt = 1_700_000_000_000;
    const expiresAt = issuedAt + 14 * 24 * 60 * 60_000;

    const token = { appId, role: "parent", nonce, issuedAt, expiresAt };
    const inviteSig = signInvite(token, ownerIrk);
    expect(verifyInvite(token, inviteSig, ownerIrk.publicKey)).toBe(true);

    const acceptance = {
      inviteNonce: nonce,
      accepterIrkPub: accepter.publicKey,
      acceptedAt: issuedAt + 60_000,
    };
    const accSig = signInviteAcceptance(acceptance, accepter);
    expect(verifyInviteAcceptance(acceptance, accSig, accepter.publicKey)).toBe(true);
  });

  it("rejects an invite signed by anyone other than the named owner IRK", () => {
    const ownerIrk = deriveIRK(umk);
    const attackerIrk = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const token = {
      appId,
      role: "admin",
      nonce: new Uint8Array(32).fill(7),
      issuedAt: 1000,
      expiresAt: 2000,
    };
    const sig = signInvite(token, attackerIrk);
    expect(verifyInvite(token, sig, ownerIrk.publicKey)).toBe(false);
  });

  it("rejects an acceptance whose accepterIrkPub doesn't match the supplied verification key", () => {
    const accepter = deriveIRK({ seed: new Uint8Array(32).fill(55) });
    const other = deriveIRK({ seed: new Uint8Array(32).fill(66) });
    const acceptance = {
      inviteNonce: new Uint8Array(32).fill(1),
      accepterIrkPub: accepter.publicKey,
      acceptedAt: 1000,
    };
    const sig = signInviteAcceptance(acceptance, accepter);
    expect(verifyInviteAcceptance(acceptance, sig, other.publicKey)).toBe(false);
  });

  it("rejects role tamper after signing (parent → admin)", () => {
    const ownerIrk = deriveIRK(umk);
    const token = {
      appId,
      role: "parent",
      nonce: new Uint8Array(32).fill(7),
      issuedAt: 1000,
      expiresAt: 2000,
    };
    const sig = signInvite(token, ownerIrk);
    const tampered = { ...token, role: "admin" };
    expect(verifyInvite(tampered, sig, ownerIrk.publicKey)).toBe(false);
  });

  it("rejects expiry tamper (extending the deadline)", () => {
    const ownerIrk = deriveIRK(umk);
    const token = {
      appId,
      role: "parent",
      nonce: new Uint8Array(32).fill(7),
      issuedAt: 1000,
      expiresAt: 2000,
    };
    const sig = signInvite(token, ownerIrk);
    const tampered = { ...token, expiresAt: 9_999_999 };
    expect(verifyInvite(tampered, sig, ownerIrk.publicKey)).toBe(false);
  });

  it("acceptance does not validate if attacker swaps in their own IRK pubkey", () => {
    const accepter = deriveIRK({ seed: new Uint8Array(32).fill(55) });
    const attacker = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const realAcceptance = {
      inviteNonce: new Uint8Array(32).fill(1),
      accepterIrkPub: accepter.publicKey,
      acceptedAt: 1000,
    };
    const sig = signInviteAcceptance(realAcceptance, accepter);

    // Attacker tries to redirect by swapping in their own pubkey but reusing the signature.
    const swapped = { ...realAcceptance, accepterIrkPub: attacker.publicKey };
    expect(verifyInviteAcceptance(swapped, sig, attacker.publicKey)).toBe(false);
    expect(verifyInviteAcceptance(swapped, sig, accepter.publicKey)).toBe(false);
  });

  it("BAK signature does NOT validate as an invite (compartmentalization)", () => {
    const ownerIrk = deriveIRK(umk);
    const ownerBak = deriveBAK(umk, "srv-1");
    const token = {
      appId,
      role: "member",
      nonce: new Uint8Array(32).fill(1),
      issuedAt: 1000,
      expiresAt: 2000,
    };
    const sig = signInvite(token, ownerBak);
    expect(verifyInvite(token, sig, ownerIrk.publicKey)).toBe(false);
  });
});

describe("IRK migration request", () => {
  const m: MigrationRequest = {
    appId: "habit-tracker",
    fromUser: "harry",
    toUser: "sarah",
    mode: "cut",
    withData: true,
    issuedAt: 1_700_000_000_000,
  };

  it("sender-signed migration request verifies", () => {
    const irk = deriveIRK(umk);
    const sig = signMigrationRequest(m, irk);
    expect(verifyMigrationRequest(m, sig, irk.publicKey)).toBe(true);
  });

  it("rejects mode tamper (cut → copy)", () => {
    const irk = deriveIRK(umk);
    const sig = signMigrationRequest(m, irk);
    const tampered: MigrationRequest = { ...m, mode: "copy" };
    expect(verifyMigrationRequest(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects withData tamper", () => {
    const irk = deriveIRK(umk);
    const sig = signMigrationRequest(m, irk);
    const tampered: MigrationRequest = { ...m, withData: false };
    expect(verifyMigrationRequest(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects toUser tamper (cannot redirect to attacker)", () => {
    const irk = deriveIRK(umk);
    const sig = signMigrationRequest(m, irk);
    const redirected: MigrationRequest = { ...m, toUser: "attacker" };
    expect(verifyMigrationRequest(redirected, sig, irk.publicKey)).toBe(false);
  });
});

describe("IRK server registration", () => {
  const irk = deriveIRK(umk);
  const swk = deriveSWK(umk, "srv-1");
  const stk = deriveSTK(swk);
  const reg: RegisterServer = {
    userId: "harry",
    serverId: "srv-1",
    stkPub: stk.publicKey,
    issuedAt: 1735689600000,
  };

  it("phone IRK-signed registration verifies", () => {
    const sig = signRegisterServer(reg, irk);
    expect(verifyRegisterServer(reg, sig, irk.publicKey)).toBe(true);
  });

  it("rejects when serverId is changed (cannot redirect to attacker server)", () => {
    const sig = signRegisterServer(reg, irk);
    const tampered: RegisterServer = { ...reg, serverId: "attacker-srv" };
    expect(verifyRegisterServer(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects when stkPub is swapped (cannot bind a different key)", () => {
    const sig = signRegisterServer(reg, irk);
    const tampered: RegisterServer = { ...reg, stkPub: new Uint8Array(32).fill(0xff) };
    expect(verifyRegisterServer(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects with the wrong signer's IRK pubkey", () => {
    const sig = signRegisterServer(reg, irk);
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    expect(verifyRegisterServer(reg, sig, otherIrk.publicKey)).toBe(false);
  });
});

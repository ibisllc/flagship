import { describe, expect, it } from "vitest";
import {
  signDemoDirective,
  verifyDemoDirective,
  signSetCustomDomain,
  verifySetCustomDomain,
  signInvite,
  signInviteAcceptance,
  signMembershipMutation,
  signMigrationRequest,
  signRebuildRequest,
  signRegisterServer,
  signRevocation,
  verifyInvite,
  verifyInviteAcceptance,
  verifyMembershipMutation,
  verifyMigrationRequest,
  verifyRebuildRequest,
  verifyRegisterServer,
  verifyRevocation,
  type DemoDirective,
  type SetCustomDomain,
  type ImageRebuildRequest,
  type MembershipMutation,
  type MigrationRequest,
  type RegisterServer,
  type ServerRevocation,
} from "../src/auth.js";
import { deriveBAK, deriveIRK, deriveSWK, deriveSTK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(42) };

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
    serviceId: "habit-tracker",
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
  const serviceId = "habit-tracker";

  it("owner-signed invite verifies; acceptance binds it to recipient's IRK", () => {
    const ownerIrk = deriveIRK(umk);
    const accepter = deriveIRK({ seed: new Uint8Array(32).fill(55) });
    const nonce = new Uint8Array(32).fill(7);
    const issuedAt = 1_700_000_000_000;
    const expiresAt = issuedAt + 14 * 24 * 60 * 60_000;

    const token = { serviceId, role: "parent", nonce, issuedAt, expiresAt };
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
      serviceId,
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
      serviceId,
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
      serviceId,
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
      serviceId,
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
    serviceId: "habit-tracker",
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

describe("BackupToggle signatures (per-server)", () => {
  const irk = deriveIRK(umk);

  it("phone-signed toggle verifies with the matching IRK pubkey", async () => {
    const { signBackupToggle, verifyBackupToggle } = await import("../src/auth.js");
    const r = { serverId: "home-box", enabled: true, issuedAt: 1735689600000 };
    expect(verifyBackupToggle(r, signBackupToggle(r, irk), irk.publicKey)).toBe(true);
  });

  it("rejects when the signed serverId is changed (no replay across servers)", async () => {
    const { signBackupToggle, verifyBackupToggle } = await import("../src/auth.js");
    const r = { serverId: "home-box", enabled: true, issuedAt: 1735689600000 };
    const sig = signBackupToggle(r, irk);
    expect(verifyBackupToggle({ ...r, serverId: "chillout" }, sig, irk.publicKey)).toBe(false);
  });

  it("rejects when enabled is flipped (a captured 'enable' can't be reused as 'disable')", async () => {
    const { signBackupToggle, verifyBackupToggle } = await import("../src/auth.js");
    const r = { serverId: "home-box", enabled: true, issuedAt: 1735689600000 };
    const sig = signBackupToggle(r, irk);
    expect(verifyBackupToggle({ ...r, enabled: false }, sig, irk.publicKey)).toBe(false);
  });
});

describe("LLM promo issuance signatures (one-shot — flagshipserver.com is never in the prompt path)", () => {
  const irk = deriveIRK(umk);

  it("issue-start: signature commits to method + identityHash so the user can't swap numbers between start/complete", async () => {
    const { signLlmPromoIssueStart, verifyLlmPromoIssueStart } = await import("../src/auth.js");
    const r = {
      userId: "harry",
      method: "phone-otp" as const,
      identityHash: new Uint8Array(32).fill(0x42),
      issuedAt: 1735689600000,
    };
    const sig = signLlmPromoIssueStart(r, irk);
    expect(verifyLlmPromoIssueStart(r, sig, irk.publicKey)).toBe(true);
    expect(verifyLlmPromoIssueStart(
      { ...r, identityHash: new Uint8Array(32).fill(0xff) },
      sig,
      irk.publicKey,
    )).toBe(false);
    expect(verifyLlmPromoIssueStart(
      { ...r, method: "stripe-zero-auth" as const },
      sig,
      irk.publicKey,
    )).toBe(false);
  });

  it("issue-complete: signature commits to (ticket, otpHash) — OTP can't be swapped after signing", async () => {
    const { signLlmPromoIssueComplete, verifyLlmPromoIssueComplete } = await import("../src/auth.js");
    const r = {
      userId: "harry",
      ticket: "tk-abc123",
      otpHash: new Uint8Array(32).fill(0x77),
      issuedAt: 1735689600000,
    };
    const sig = signLlmPromoIssueComplete(r, irk);
    expect(verifyLlmPromoIssueComplete(r, sig, irk.publicKey)).toBe(true);
    expect(verifyLlmPromoIssueComplete(
      { ...r, otpHash: new Uint8Array(32).fill(0x88) },
      sig,
      irk.publicKey,
    )).toBe(false);
    expect(verifyLlmPromoIssueComplete(
      { ...r, ticket: "tk-different" },
      sig,
      irk.publicKey,
    )).toBe(false);
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(0xaa) });
    expect(verifyLlmPromoIssueComplete(r, sig, otherIrk.publicKey)).toBe(false);
  });
});

describe("UpdatePullRequest — server-identity-signed app update pull", () => {
  const irk = deriveIRK(umk);
  // The puller's identity key is just an ed25519 keypair; reuse IRK as a stand-in.
  const pullerIdentity = irk;

  it("round-trips sign/verify with the puller's server identity pubkey", async () => {
    const { signUpdatePull, verifyUpdatePull } = await import("../src/auth.js");
    const r = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "deadbeefcafef00d",
      issuedAt: 1735689600000,
    };
    const sig = signUpdatePull(r, pullerIdentity);
    expect(verifyUpdatePull(r, sig, pullerIdentity.publicKey)).toBe(true);
  });

  it("rejects when (creator, slug, since) differ — replay against a different app or revision fails", async () => {
    const { signUpdatePull, verifyUpdatePull } = await import("../src/auth.js");
    const r = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "abc123",
      issuedAt: 1000,
    };
    const sig = signUpdatePull(r, pullerIdentity);
    expect(verifyUpdatePull({ ...r, slug: "game2" }, sig, pullerIdentity.publicKey)).toBe(false);
    expect(verifyUpdatePull({ ...r, creator: "carol" }, sig, pullerIdentity.publicKey)).toBe(false);
    expect(verifyUpdatePull({ ...r, since: "different" }, sig, pullerIdentity.publicKey)).toBe(false);
    expect(verifyUpdatePull({ ...r, pullerServerId: "home.eve.flagship.services" }, sig, pullerIdentity.publicKey)).toBe(false);
  });

  it("rejects under a different identity pubkey", async () => {
    const { signUpdatePull, verifyUpdatePull } = await import("../src/auth.js");
    const otherIdentity = deriveIRK({ seed: new Uint8Array(32).fill(0x99) });
    const r = {
      pullerServerId: "home.bob.flagship.services",
      creator: "alice",
      slug: "game1",
      since: "",
      issuedAt: 1,
    };
    const sig = signUpdatePull(r, pullerIdentity);
    expect(verifyUpdatePull(r, sig, otherIdentity.publicKey)).toBe(false);
  });
});

describe("SetServiceEnvRequest — IRK-signed per-app env (names+values both signed)", () => {
  const irk = deriveIRK(umk);

  it("round-trips sign/verify under the host IRK", async () => {
    const { signSetServiceEnv, verifySetServiceEnv } = await import("../src/auth.js");
    const r = {
      serverId: "home.alice.flagship.services",
      creator: "alice",
      slug: "weatherbot",
      env: { OPENAI_API_KEY: "sk-secret-xyz", APP_REGION: "us" },
      issuedAt: 1735689600000,
    };
    const sig = signSetServiceEnv(r, irk);
    expect(verifySetServiceEnv(r, sig, irk.publicKey)).toBe(true);
  });

  it("is order-independent over env keys (canonical sorts keys)", async () => {
    const { signSetServiceEnv, verifySetServiceEnv } = await import("../src/auth.js");
    const r1 = {
      serverId: "home.alice.flagship.services",
      creator: "alice",
      slug: "weatherbot",
      env: { B: "2", A: "1" },
      issuedAt: 1,
    };
    const sig = signSetServiceEnv(r1, irk);
    const r2 = { ...r1, env: { A: "1", B: "2" } };
    expect(verifySetServiceEnv(r2, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a swapped value — a MITM cannot change a value against a captured sig", async () => {
    const { signSetServiceEnv, verifySetServiceEnv } = await import("../src/auth.js");
    const r = {
      serverId: "home.alice.flagship.services",
      creator: "alice",
      slug: "weatherbot",
      env: { OPENAI_API_KEY: "sk-real" },
      issuedAt: 1,
    };
    const sig = signSetServiceEnv(r, irk);
    expect(
      verifySetServiceEnv({ ...r, env: { OPENAI_API_KEY: "sk-attacker" } }, sig, irk.publicKey),
    ).toBe(false);
    expect(
      verifySetServiceEnv({ ...r, env: { OPENAI_API_KEY: "sk-real", EXTRA: "x" } }, sig, irk.publicKey),
    ).toBe(false);
    expect(verifySetServiceEnv({ ...r, slug: "other" }, sig, irk.publicKey)).toBe(false);
  });

  it("rejects under a different signer pubkey (wrong-signer)", async () => {
    const { signSetServiceEnv, verifySetServiceEnv } = await import("../src/auth.js");
    const other = deriveIRK({ seed: new Uint8Array(32).fill(0x77) });
    const r = {
      serverId: "home.alice.flagship.services",
      creator: "alice",
      slug: "weatherbot",
      env: { K: "v" },
      issuedAt: 1,
    };
    const sig = signSetServiceEnv(r, irk);
    expect(verifySetServiceEnv(r, sig, other.publicKey)).toBe(false);
  });
});

describe("PhoneOrder browser-input-response — PSK-signed input from phone", () => {
  const psk = deriveBAK(umk, "srv-browser-test");

  it("round-trips sign/verify with the per-server PSK", async () => {
    const { signPhoneOrder, verifyPhoneOrder } = await import("../src/auth.js");
    const order = {
      type: "browser-input-response" as const,
      serverId: "home.alice.flagship.services",
      tabId: "tab-deadbeef",
      inputKind: "password" as const,
      value: "hunter2!@#",
      screenshotRef: "shot-1",
      issuedAt: 1735689600000,
    };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder(order, sig, psk.publicKey)).toBe(true);
  });

  it("rejects when value is tampered (canonical-bytes covers value)", async () => {
    const { signPhoneOrder, verifyPhoneOrder } = await import("../src/auth.js");
    const order = {
      type: "browser-input-response" as const,
      serverId: "home.alice.flagship.services",
      tabId: "tab-1",
      inputKind: "password" as const,
      value: "original",
      screenshotRef: "s1",
      issuedAt: 1,
    };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder({ ...order, value: "tampered" }, sig, psk.publicKey)).toBe(false);
  });

  it("rejects when tabId or screenshotRef differ — sig pins them too", async () => {
    const { signPhoneOrder, verifyPhoneOrder } = await import("../src/auth.js");
    const order = {
      type: "browser-input-response" as const,
      serverId: "home.alice.flagship.services",
      tabId: "tab-1",
      inputKind: "otp" as const,
      value: "123456",
      screenshotRef: "s1",
      issuedAt: 1,
    };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder({ ...order, tabId: "different-tab" }, sig, psk.publicKey)).toBe(false);
    expect(verifyPhoneOrder({ ...order, screenshotRef: "different" }, sig, psk.publicKey)).toBe(false);
    expect(verifyPhoneOrder({ ...order, inputKind: "password" }, sig, psk.publicKey)).toBe(false);
  });

  it("rejects under a different PSK (cross-server replay defense)", async () => {
    const { signPhoneOrder, verifyPhoneOrder } = await import("../src/auth.js");
    const otherPsk = deriveBAK(umk, "srv-different");
    const order = {
      type: "browser-input-response" as const,
      serverId: "home.alice.flagship.services",
      tabId: "t",
      inputKind: "text" as const,
      value: "v",
      screenshotRef: "s",
      issuedAt: 1,
    };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder(order, sig, otherPsk.publicKey)).toBe(false);
  });
});

describe("AutoUnlockLease — IRK-signed unlock-key deposit / long-lived lease", () => {
  const irk = deriveIRK(umk);

  it("round-trips sign/verify for a one-shot lease (multiUse=false)", async () => {
    const { signAutoUnlockLease, verifyAutoUnlockLease } = await import("../src/auth.js");
    const lease = {
      serverId: "home.alice.flagship.services",
      leaseId: "0123456789abcdef",
      expiresAt: 1_700_000_600_000,
      unlockKey: new Uint8Array(64).fill(0xa5),
      multiUse: false,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signAutoUnlockLease(lease, irk);
    expect(verifyAutoUnlockLease(lease, sig, irk.publicKey)).toBe(true);
  });

  it("round-trips sign/verify for a long-lived lease (multiUse=true)", async () => {
    const { signAutoUnlockLease, verifyAutoUnlockLease } = await import("../src/auth.js");
    const lease = {
      serverId: "home.alice.flagship.services",
      leaseId: "feedfacecafebeef",
      expiresAt: 1_700_604_800_000,
      unlockKey: new Uint8Array(64).fill(0x5a),
      multiUse: true,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signAutoUnlockLease(lease, irk);
    expect(verifyAutoUnlockLease(lease, sig, irk.publicKey)).toBe(true);
  });

  it("multiUse is part of canonical-bytes — flipping it invalidates the signature", async () => {
    // This is the most important assertion: a one-shot lease can NOT be
    // upgraded to multi-use by anyone other than the IRK holder. If
    // multiUse weren't in the canonical bytes, .com would have to trust
    // the field separately, which is a privilege escalation.
    const { signAutoUnlockLease, verifyAutoUnlockLease } = await import("../src/auth.js");
    const lease = {
      serverId: "home.alice.flagship.services",
      leaseId: "abc",
      expiresAt: 1000,
      unlockKey: new Uint8Array(32).fill(1),
      multiUse: false,
      issuedAt: 500,
    };
    const sig = signAutoUnlockLease(lease, irk);
    expect(verifyAutoUnlockLease({ ...lease, multiUse: true }, sig, irk.publicKey)).toBe(false);
  });

  it("rejects when leaseId / expiresAt / unlockKey / serverId / issuedAt are tampered", async () => {
    const { signAutoUnlockLease, verifyAutoUnlockLease } = await import("../src/auth.js");
    const lease = {
      serverId: "srv-A",
      leaseId: "id-1",
      expiresAt: 1000,
      unlockKey: new Uint8Array(32).fill(1),
      multiUse: false,
      issuedAt: 500,
    };
    const sig = signAutoUnlockLease(lease, irk);
    expect(verifyAutoUnlockLease({ ...lease, serverId: "srv-B" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAutoUnlockLease({ ...lease, leaseId: "id-2" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAutoUnlockLease({ ...lease, expiresAt: 2000 }, sig, irk.publicKey)).toBe(false);
    expect(verifyAutoUnlockLease({ ...lease, issuedAt: 600 }, sig, irk.publicKey)).toBe(false);
    const tamperedKey = new Uint8Array(32).fill(2);
    expect(verifyAutoUnlockLease({ ...lease, unlockKey: tamperedKey }, sig, irk.publicKey)).toBe(false);
  });

  it("rejects under a different IRK (cross-account isolation)", async () => {
    const { signAutoUnlockLease, verifyAutoUnlockLease } = await import("../src/auth.js");
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const lease = {
      serverId: "srv-A",
      leaseId: "id",
      expiresAt: 1,
      unlockKey: new Uint8Array(32),
      multiUse: false,
      issuedAt: 0,
    };
    const sig = signAutoUnlockLease(lease, irk);
    expect(verifyAutoUnlockLease(lease, sig, otherIrk.publicKey)).toBe(false);
  });

  it("revoke-lease envelope round-trips and pins (serverId, leaseId)", async () => {
    const { signRevokeAutoUnlockLease, verifyRevokeAutoUnlockLease } = await import(
      "../src/auth.js"
    );
    const r = { serverId: "srv-A", leaseId: "lease-xyz", issuedAt: 1_700_000_000_000 };
    const sig = signRevokeAutoUnlockLease(r, irk);
    expect(verifyRevokeAutoUnlockLease(r, sig, irk.publicKey)).toBe(true);
    expect(
      verifyRevokeAutoUnlockLease({ ...r, leaseId: "other" }, sig, irk.publicKey),
    ).toBe(false);
    expect(
      verifyRevokeAutoUnlockLease({ ...r, serverId: "srv-B" }, sig, irk.publicKey),
    ).toBe(false);
  });
});

describe("UploadRecoveryRecord — IRK-signed cloud-shard recovery upload", () => {
  const irk = deriveIRK(umk);

  it("round-trips sign/verify against the user's IRK", async () => {
    const { signUploadRecoveryRecord, verifyUploadRecoveryRecord } = await import(
      "../src/auth.js"
    );
    const r = {
      username: "alice",
      credentialIdHex: "deadbeef".repeat(8),
      wrappedUmkHashHex: "ab".repeat(32),
      issuedAt: 1_700_000_000_000,
    };
    const sig = signUploadRecoveryRecord(r, irk);
    expect(verifyUploadRecoveryRecord(r, sig, irk.publicKey)).toBe(true);
  });

  it("pins all four fields — tampering with any invalidates the signature", async () => {
    const { signUploadRecoveryRecord, verifyUploadRecoveryRecord } = await import(
      "../src/auth.js"
    );
    const r = {
      username: "alice",
      credentialIdHex: "1111".repeat(8),
      wrappedUmkHashHex: "2222".repeat(8),
      issuedAt: 100,
    };
    const sig = signUploadRecoveryRecord(r, irk);
    expect(verifyUploadRecoveryRecord({ ...r, username: "bob" }, sig, irk.publicKey)).toBe(false);
    expect(
      verifyUploadRecoveryRecord({ ...r, credentialIdHex: "3333".repeat(8) }, sig, irk.publicKey),
    ).toBe(false);
    expect(
      verifyUploadRecoveryRecord({ ...r, wrappedUmkHashHex: "4444".repeat(8) }, sig, irk.publicKey),
    ).toBe(false);
    expect(verifyUploadRecoveryRecord({ ...r, issuedAt: 200 }, sig, irk.publicKey)).toBe(false);
  });

  it("rejects under a different IRK (cross-account)", async () => {
    const { signUploadRecoveryRecord, verifyUploadRecoveryRecord } = await import(
      "../src/auth.js"
    );
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(7) });
    const r = {
      username: "alice",
      credentialIdHex: "11".repeat(16),
      wrappedUmkHashHex: "22".repeat(32),
      issuedAt: 1,
    };
    const sig = signUploadRecoveryRecord(r, irk);
    expect(verifyUploadRecoveryRecord(r, sig, otherIrk.publicKey)).toBe(false);
  });
});

describe("DemoDirective (#84)", () => {
  const ca = deriveIRK({ seed: new Uint8Array(32).fill(0xca) });
  const d: DemoDirective = {
    version: 1,
    username: "demo",
    useMockRecovery: true,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_900_000,
    issuer: "flagship-ca-v1",
  };

  it("a CA-signed directive verifies under the CA pubkey", () => {
    const sig = signDemoDirective(d, ca);
    expect(verifyDemoDirective(d, sig, ca.publicKey)).toBe(true);
  });

  it("a client cannot self-elect demo mode (non-CA signer is rejected)", () => {
    const notCa = deriveIRK({ seed: new Uint8Array(32).fill(0x11) });
    const sig = signDemoDirective(d, notCa);
    expect(verifyDemoDirective(d, sig, ca.publicKey)).toBe(false);
  });

  it("rejects a flipped useMockRecovery (can't downgrade a live account to mock or vice versa)", () => {
    const sig = signDemoDirective(d, ca);
    const tampered: DemoDirective = { ...d, useMockRecovery: false };
    expect(verifyDemoDirective(tampered, sig, ca.publicKey)).toBe(false);
  });

  it("rejects a re-targeted username (a directive minted for one user can't be replayed onto another)", () => {
    const sig = signDemoDirective(d, ca);
    const tampered: DemoDirective = { ...d, username: "victim" };
    expect(verifyDemoDirective(tampered, sig, ca.publicKey)).toBe(false);
  });

  it("rejects a stretched expiry (can't extend a captured directive's lifetime)", () => {
    const sig = signDemoDirective(d, ca);
    const tampered: DemoDirective = { ...d, expiresAt: d.expiresAt + 1 };
    expect(verifyDemoDirective(tampered, sig, ca.publicKey)).toBe(false);
  });
});

describe("SetCustomDomain (#79A)", () => {
  const irk = deriveIRK(umk);
  const base: SetCustomDomain = {
    username: "harry",
    serviceId: "harry-game1",
    fqdn: "shop.example.com",
    issuedAt: 1_700_000_000_000,
  };

  it("IRK-signed request verifies under the user's IRK", () => {
    const sig = signSetCustomDomain(base, irk);
    expect(verifySetCustomDomain(base, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a different signer (only the account IRK can attach)", () => {
    const other = deriveIRK({ seed: new Uint8Array(32).fill(8) });
    const sig = signSetCustomDomain(base, other);
    expect(verifySetCustomDomain(base, sig, irk.publicKey)).toBe(false);
  });

  it("rejects a tampered fqdn (can't redirect the claim to another domain)", () => {
    const sig = signSetCustomDomain(base, irk);
    expect(verifySetCustomDomain({ ...base, fqdn: "evil.example.com" }, sig, irk.publicKey)).toBe(false);
  });

  it("rejects a tampered serviceId", () => {
    const sig = signSetCustomDomain(base, irk);
    expect(verifySetCustomDomain({ ...base, serviceId: "harry-other" }, sig, irk.publicKey)).toBe(false);
  });

  it("fqdn is case-normalized in canonical bytes (signer/verifier agree on case)", () => {
    const sig = signSetCustomDomain({ ...base, fqdn: "Shop.Example.COM" }, irk);
    expect(verifySetCustomDomain({ ...base, fqdn: "shop.example.com" }, sig, irk.publicKey)).toBe(true);
  });
});

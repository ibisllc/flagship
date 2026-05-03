import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  newInviteNonce,
  signInvite,
  signInviteAcceptance,
  signMembershipMutation,
  type InviteAcceptance,
  type InviteToken,
  type MembershipMutation,
} from "@flagship/protocol";
import {
  AppMembership,
  InviteStore,
  MembershipStore,
} from "../src/membership.js";

const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const sarahUmk = { seed: new Uint8Array(32).fill(33) };
const attackerUmk = { seed: new Uint8Array(32).fill(99) };

const ownerIrk = deriveIRK(ownerUmk);
const sarahIrk = deriveIRK(sarahUmk);
const attackerIrk = deriveIRK(attackerUmk);
const swk = deriveSWK(ownerUmk, "srv-1");

const APP = "habit-tracker";
const OWNER = "harry";

function mut(targetIrkPub: Uint8Array, role: string | null, issuedAt: number): MembershipMutation {
  return { appId: APP, targetIrkPub, role, issuedAt };
}

describe("MembershipStore — IRK-keyed", () => {
  it("adds a member when owner signs", () => {
    const store = new MembershipStore(APP, OWNER, ownerIrk.publicKey);
    const m = mut(sarahIrk.publicKey, "parent", Date.now());
    const sig = signMembershipMutation(m, ownerIrk);
    expect(store.applySignedMutation(m, sig)).toEqual({ ok: true, effect: "added" });
    expect(store.getRole(sarahIrk.publicKey)).toBe("parent");
    expect(store.isMember(sarahIrk.publicKey)).toBe(true);
  });

  it("rejects mutation signed by anyone other than the owner's IRK", () => {
    const store = new MembershipStore(APP, OWNER, ownerIrk.publicKey);
    const m = mut(sarahIrk.publicKey, "admin", Date.now());
    const sig = signMembershipMutation(m, attackerIrk);
    expect(store.applySignedMutation(m, sig)).toEqual({ ok: false, reason: "invalid-signature" });
  });

  it("rejects replay with same issuedAt", () => {
    const store = new MembershipStore(APP, OWNER, ownerIrk.publicKey);
    const ts = Date.now();
    const m = mut(sarahIrk.publicKey, "parent", ts);
    const sig = signMembershipMutation(m, ownerIrk);
    expect(store.applySignedMutation(m, sig).ok).toBe(true);
    expect(store.applySignedMutation(m, sig)).toEqual({ ok: false, reason: "replay" });
  });

  it("rejects stale mutations", () => {
    const store = new MembershipStore(APP, OWNER, ownerIrk.publicKey, { maxAgeMs: 1000 });
    const old = mut(sarahIrk.publicKey, "parent", Date.now() - 60_000);
    const sig = signMembershipMutation(old, ownerIrk);
    expect(store.applySignedMutation(old, sig)).toEqual({ ok: false, reason: "stale" });
  });

  it("removes by signing with role: null", () => {
    const store = new MembershipStore(APP, OWNER, ownerIrk.publicKey);
    const ts = Date.now();
    const add = mut(sarahIrk.publicKey, "parent", ts);
    store.applySignedMutation(add, signMembershipMutation(add, ownerIrk));
    const remove = mut(sarahIrk.publicKey, null, ts + 1);
    expect(
      store.applySignedMutation(remove, signMembershipMutation(remove, ownerIrk)),
    ).toEqual({ ok: true, effect: "removed" });
    expect(store.isMember(sarahIrk.publicKey)).toBe(false);
  });

  it("rejects app-id mismatch", () => {
    const store = new MembershipStore(APP, OWNER, ownerIrk.publicKey);
    const m: MembershipMutation = {
      appId: "other-app",
      targetIrkPub: sarahIrk.publicKey,
      role: "parent",
      issuedAt: Date.now(),
    };
    const sig = signMembershipMutation(m, ownerIrk);
    expect(store.applySignedMutation(m, sig)).toEqual({ ok: false, reason: "app-mismatch" });
  });
});

function makeInvite(role: string, expiresIn = 60 * 60_000): {
  token: InviteToken;
  inviteSig: Uint8Array;
  acceptance: InviteAcceptance;
  acceptanceSig: Uint8Array;
} {
  const nonce = newInviteNonce();
  const issuedAt = Date.now();
  const token: InviteToken = {
    appId: APP,
    role,
    nonce,
    issuedAt,
    expiresAt: issuedAt + expiresIn,
  };
  const inviteSig = signInvite(token, ownerIrk);
  const acceptance: InviteAcceptance = {
    inviteNonce: nonce,
    accepterIrkPub: sarahIrk.publicKey,
    acceptedAt: issuedAt + 60_000,
  };
  const acceptanceSig = signInviteAcceptance(acceptance, sarahIrk);
  return { token, inviteSig, acceptance, acceptanceSig };
}

describe("InviteStore — single-use signed-capability flow", () => {
  it("redeems a fresh invite once, then refuses replay", () => {
    const store = new InviteStore(APP, ownerIrk.publicKey);
    const { token, inviteSig, acceptance, acceptanceSig } = makeInvite("parent");
    expect(store.redeem(token, inviteSig, acceptance, acceptanceSig).ok).toBe(true);
    expect(store.redeem(token, inviteSig, acceptance, acceptanceSig)).toEqual({
      ok: false,
      reason: "already-redeemed",
    });
  });

  it("rejects an expired invite", () => {
    let now = 1_000_000;
    const store = new InviteStore(APP, ownerIrk.publicKey, { now: () => now });
    const { token, inviteSig, acceptance, acceptanceSig } = makeInvite("member", -1);
    // expiresIn negative means expiresAt < issuedAt: already expired.
    now = token.expiresAt + 1;
    expect(store.redeem(token, inviteSig, acceptance, acceptanceSig)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects an invite whose nonce doesn't match the acceptance", () => {
    const store = new InviteStore(APP, ownerIrk.publicKey);
    const { token, inviteSig, acceptanceSig } = makeInvite("member");
    const wrongAcceptance: InviteAcceptance = {
      inviteNonce: new Uint8Array(32).fill(0xff),
      accepterIrkPub: sarahIrk.publicKey,
      acceptedAt: Date.now(),
    };
    expect(store.redeem(token, inviteSig, wrongAcceptance, acceptanceSig)).toEqual({
      ok: false,
      reason: "nonce-mismatch",
    });
  });

  it("rejects an invite signature from anyone but the owner", () => {
    const store = new InviteStore(APP, ownerIrk.publicKey);
    const { token, acceptance, acceptanceSig } = makeInvite("member");
    const badSig = signInvite(token, attackerIrk);
    expect(store.redeem(token, badSig, acceptance, acceptanceSig)).toEqual({
      ok: false,
      reason: "invalid-invite-signature",
    });
  });

  it("rejects when the acceptance signature is wrong", () => {
    const store = new InviteStore(APP, ownerIrk.publicKey);
    const { token, inviteSig, acceptance } = makeInvite("member");
    // Attacker signs the (genuine) acceptance bytes — wrong key.
    const badAcceptanceSig = signInviteAcceptance(acceptance, attackerIrk);
    expect(store.redeem(token, inviteSig, acceptance, badAcceptanceSig)).toEqual({
      ok: false,
      reason: "invalid-acceptance-signature",
    });
  });

  it("rejects app-id mismatch", () => {
    const store = new InviteStore("other-app", ownerIrk.publicKey);
    const { token, inviteSig, acceptance, acceptanceSig } = makeInvite("member");
    expect(store.redeem(token, inviteSig, acceptance, acceptanceSig)).toEqual({
      ok: false,
      reason: "app-mismatch",
    });
  });
});

describe("AppMembership — combined invite redemption + membership", () => {
  it("happy path: redeem creates a membership and yields a per-app stable id", () => {
    const app = new AppMembership(APP, OWNER, ownerIrk.publicKey, swk);
    const { token, inviteSig, acceptance, acceptanceSig } = makeInvite("parent");
    const r = app.redeemInvite(token, inviteSig, acceptance, acceptanceSig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("parent");
    expect(r.stableId).toMatch(/^[0-9a-f]{32}$/);
    expect(app.members.isMember(sarahIrk.publicKey)).toBe(true);
    expect(app.members.getRole(sarahIrk.publicKey)).toBe("parent");
  });

  it("two different apps yield DIFFERENT stable ids for the same person (privacy)", () => {
    const appA = new AppMembership("habit-tracker", OWNER, ownerIrk.publicKey, swk);
    const appB = new AppMembership("photos", OWNER, ownerIrk.publicKey, swk);
    expect(appA.stableIdFor(sarahIrk.publicKey)).not.toEqual(
      appB.stableIdFor(sarahIrk.publicKey),
    );
  });

  it("removal mutation works after a redeem-based add", () => {
    const app = new AppMembership(APP, OWNER, ownerIrk.publicKey, swk);
    const { token, inviteSig, acceptance, acceptanceSig } = makeInvite("parent");
    app.redeemInvite(token, inviteSig, acceptance, acceptanceSig);

    const remove: MembershipMutation = {
      appId: APP,
      targetIrkPub: sarahIrk.publicKey,
      role: null,
      issuedAt: Date.now(),
    };
    const sig = signMembershipMutation(remove, ownerIrk);
    expect(app.applyMutation(remove, sig)).toEqual({ ok: true, effect: "removed" });
    expect(app.members.isMember(sarahIrk.publicKey)).toBe(false);
  });
});

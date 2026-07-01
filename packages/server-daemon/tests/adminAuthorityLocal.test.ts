/**
 * Slice D — Phase 1 box-daemon enforcement (docs/device-admin-tier-spec.md §2, §3).
 *
 * Every box-side SENSITIVE op now routes its signature check through the shared
 * `authorizeSensitiveOrder` gate. These tests pin the GATED TRANSITION contract
 * for the gate itself and for each representative sensitive op:
 *
 *   (a) with `adminRootPub` PRESENT: an admin-master-root-signed order is
 *       ACCEPTED and an owner-IRK-signed order is REJECTED (the membership IRK is
 *       never a master admin);
 *   (b) with `adminRootPub` ABSENT: the legacy owner-IRK path still works
 *       unchanged (a strict no-op on every pre-wipe box).
 */

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ed,
  mintDevEntitlements,
  newInviteNonce,
  signInvite,
  signInviteAcceptance,
  signMembershipMutation,
  signPhoneOrder,
  signServerDecommission,
  signServersSelfDelete,
  signSetDeadManPolicy,
  signSetLeader,
  type InviteAcceptance,
  type InviteToken,
  type Keypair,
  type MembershipMutation,
  type PhoneOrder,
  type ServerDecommission,
  type ServersSelfDelete,
  type SetDeadManPolicy,
  type SetLeaderVote,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../src/adminAuthorityLocal.js";
import { decodeAndVerifySelfDeleteCarrier } from "../src/selfDeleteConsumer.js";
import { decodeAndVerifyDecommissionOrder } from "../src/decommissionConsumer.js";
import { decodeAndVerifySetLeaderCarrier } from "../src/setLeaderConsumer.js";
import { decodeAndVerifyEntitlementCarrier } from "../src/entitlementRelay.js";
import { DeadManController, type AutoUnlockSuppressor, type HostPowerRunner } from "../src/deadMan.js";
import { buildPowerHttp } from "../src/deadManHttp.js";
import { buildFrontPageHttp, FrontPageStore } from "../src/frontPage.js";
import { InviteStore, MembershipStore } from "../src/membership.js";
import { serializeEntitlementBundle } from "../src/entitlementBundleStore.js";

const USERNAME = "alice";
const DOMAIN = "home.alice.flagship.services";

function key(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function utf8ToHex(s: string): string {
  return hex(new TextEncoder().encode(s));
}

// The three account roots at play everywhere below.
const OWNER_IRK = key(0x11); // UMK-derived membership root (legacy anchor)
const ADMIN_ROOT = key(0x22); // the NEW authority root
const NOT_ADMIN = key(0x33); // some other key that is neither

describe("authorizeSensitiveOrder — the shared gate", () => {
  const order = { hello: "world" } as const;
  const sig = new Uint8Array(64).fill(1);
  // A trivial verifier: "verifies" iff `pub` matches a designated key. Lets us
  // simulate an order signed by a given key without a real signature.
  const verifyBy = (signer: Keypair) => (_o: unknown, _s: Uint8Array, pub: Uint8Array) =>
    hex(pub) === hex(signer.publicKey);

  it("(b) admin root ABSENT → legacy owner-IRK path (no-op)", () => {
    expect(
      authorizeSensitiveOrder({
        order,
        signature: sig,
        verify: verifyBy(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        username: USERNAME,
      }),
    ).toBe(true);
    // A non-owner signature is still rejected on the legacy path.
    expect(
      authorizeSensitiveOrder({
        order,
        signature: sig,
        verify: verifyBy(NOT_ADMIN),
        ownerIrkPub: OWNER_IRK.publicKey,
        username: USERNAME,
      }),
    ).toBe(false);
  });

  it("(a) admin root PRESENT → bare admin root ACCEPTED, owner IRK REJECTED", () => {
    // Order signed by the admin master root.
    expect(
      authorizeSensitiveOrder({
        order,
        signature: sig,
        verify: verifyBy(ADMIN_ROOT),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        username: USERNAME,
        activeGrants: [],
      }),
    ).toBe(true);
    // The SAME order signed by the membership IRK is NOT authority anymore.
    expect(
      authorizeSensitiveOrder({
        order,
        signature: sig,
        verify: verifyBy(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        username: USERNAME,
        activeGrants: [],
      }),
    ).toBe(false);
  });
});

// ── selfDelete ───────────────────────────────────────────────────────────────
describe("selfDeleteConsumer — admin-gated content wipe", () => {
  function carrier(irk: Keypair): string {
    const order: ServersSelfDelete = { username: USERNAME, issuedAt: 1_000 };
    return utf8ToHex(
      JSON.stringify({
        request: { username: USERNAME, issuedAt: 1_000 },
        signature: hex(signServersSelfDelete(order, irk)),
      }),
    );
  }
  it("(a) admin present: admin-root ACCEPTED, owner-IRK REJECTED", () => {
    expect(
      decodeAndVerifySelfDeleteCarrier({
        sealedHex: carrier(ADMIN_ROOT),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        username: USERNAME,
      }).username,
    ).toBe(USERNAME);
    expect(() =>
      decodeAndVerifySelfDeleteCarrier({
        sealedHex: carrier(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        username: USERNAME,
      }),
    ).toThrow(/is not authorized/);
  });
  it("(b) admin absent: legacy owner-IRK still works", () => {
    expect(
      decodeAndVerifySelfDeleteCarrier({
        sealedHex: carrier(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        username: USERNAME,
      }).username,
    ).toBe(USERNAME);
  });
});

// ── decommission ─────────────────────────────────────────────────────────────
describe("decommissionConsumer — admin-gated eviction", () => {
  const stkHex = hex(key(0x44).publicKey);
  function order(): ServerDecommission {
    return {
      podCanonical: DOMAIN,
      retiredStkPubHex: stkHex,
      finalBackup: false,
      diskDisposition: "keep",
      backupEpoch: 1,
      nonce: "abc",
      issuedAt: 2_000,
    };
  }
  const decode = (irk: Keypair, adminRootPub?: Uint8Array) =>
    decodeAndVerifyDecommissionOrder({
      orderJson: JSON.stringify(order()),
      orderSignatureHex: hex(signServerDecommission(order(), irk)),
      ownerIrkPub: OWNER_IRK.publicKey,
      ...(adminRootPub ? { adminRootPub } : {}),
      username: USERNAME,
    });
  it("(a) admin present: admin-root ACCEPTED, owner-IRK REJECTED", () => {
    expect(decode(ADMIN_ROOT, ADMIN_ROOT.publicKey).podCanonical).toBe(DOMAIN);
    expect(() => decode(OWNER_IRK, ADMIN_ROOT.publicKey)).toThrow(/is not authorized/);
  });
  it("(b) admin absent: legacy owner-IRK still works", () => {
    expect(decode(OWNER_IRK).podCanonical).toBe(DOMAIN);
  });
});

// ── setLeader ────────────────────────────────────────────────────────────────
describe("setLeaderConsumer — admin-gated preferred-server vote", () => {
  const prefStk = hex(key(0x55).publicKey);
  function carrier(irk: Keypair): string {
    const vote: SetLeaderVote = {
      user: USERNAME,
      preferredStkPubHex: prefStk,
      issuedAt: 3_000,
      nonce: "n1",
    };
    return utf8ToHex(JSON.stringify({ vote, signature: hex(signSetLeader(vote, irk)) }));
  }
  it("(a) admin present: admin-root ACCEPTED, owner-IRK REJECTED", () => {
    expect(
      decodeAndVerifySetLeaderCarrier({
        sealedHex: carrier(ADMIN_ROOT),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        user: USERNAME,
      }),
    ).not.toBeNull();
    expect(
      decodeAndVerifySetLeaderCarrier({
        sealedHex: carrier(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        user: USERNAME,
      }),
    ).toBeNull();
  });
  it("(b) admin absent: legacy owner-IRK still works", () => {
    expect(
      decodeAndVerifySetLeaderCarrier({
        sealedHex: carrier(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        user: USERNAME,
      }),
    ).not.toBeNull();
  });
});

// ── RootEntitlement issuance ─────────────────────────────────────────────────
describe("entitlementRelay — admin-gated box-online authorization", () => {
  const stk = key(0x66);
  function carrier(irk: Keypair): string {
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    // The bundle's on-disk JSON, hex-encoded (exactly the delivered carrier).
    return utf8ToHex(serializeEntitlementBundle(bundle));
  }
  it("(a) admin present: admin-root ACCEPTED, owner-IRK REJECTED", () => {
    expect(
      decodeAndVerifyEntitlementCarrier({
        sealedHex: carrier(ADMIN_ROOT),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }).rootEntitlement.podCanonical,
    ).toBe(DOMAIN);
    expect(() =>
      decodeAndVerifyEntitlementCarrier({
        sealedHex: carrier(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        adminRootPub: ADMIN_ROOT.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }),
    ).toThrow(/is not authorized/);
  });
  it("(b) admin absent: legacy owner-IRK still works", () => {
    expect(
      decodeAndVerifyEntitlementCarrier({
        sealedHex: carrier(OWNER_IRK),
        ownerIrkPub: OWNER_IRK.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }).rootEntitlement.podCanonical,
    ).toBe(DOMAIN);
  });
});

// ── dead-man policy ──────────────────────────────────────────────────────────
describe("DeadManController.applyPolicy — admin-gated", () => {
  const suppressor: AutoUnlockSuppressor = { suppress: async () => {} };
  const runner: HostPowerRunner = { power: async () => {} };
  function policy(): SetDeadManPolicy {
    return {
      serverId: DOMAIN,
      enabled: true,
      windowMs: 60_000,
      graceMs: 0,
      lockoutMode: "off",
      issuedAt: 4_000,
    };
  }
  function controller(adminRootPub?: Uint8Array) {
    return new DeadManController({
      serverId: DOMAIN,
      irkPub: OWNER_IRK.publicKey,
      ...(adminRootPub ? { adminRootPub } : {}),
      username: USERNAME,
      suppressor,
      runner,
      statePath: join(tmpdir(), `deadman-${Math.random().toString(36).slice(2)}.json`),
      now: () => 4_000,
    });
  }
  it("(a) admin present: admin-root ACCEPTED, owner-IRK REJECTED", async () => {
    expect(await controller(ADMIN_ROOT.publicKey).applyPolicy(policy(), signSetDeadManPolicy(policy(), ADMIN_ROOT))).toBe(
      true,
    );
    expect(await controller(ADMIN_ROOT.publicKey).applyPolicy(policy(), signSetDeadManPolicy(policy(), OWNER_IRK))).toBe(
      false,
    );
  });
  it("(b) admin absent: legacy owner-IRK still works", async () => {
    expect(await controller().applyPolicy(policy(), signSetDeadManPolicy(policy(), OWNER_IRK))).toBe(true);
  });
});

// ── manual power-off HTTP ────────────────────────────────────────────────────
describe("buildPowerHttp — admin-gated", () => {
  const NOW = 5_000_000;
  const suppressor: AutoUnlockSuppressor = { suppress: async () => {} };
  const runner: HostPowerRunner = { power: async () => {} };
  function handler(adminRootPub?: Uint8Array) {
    return buildPowerHttp({
      serverId: DOMAIN,
      ownerIrkPub: OWNER_IRK.publicKey,
      ...(adminRootPub ? { adminRootPub } : {}),
      username: USERNAME,
      suppressor,
      runner,
      now: () => NOW,
    });
  }
  function req(irk: Keypair) {
    const order: PhoneOrder = { type: "power-off", serverId: DOMAIN, mode: "off", issuedAt: NOW };
    return {
      method: "POST",
      path: "/api/power",
      headers: { "content-type": "application/json" },
      body: Buffer.from(
        JSON.stringify({ request: order, signature: hex(signPhoneOrder(order, irk)) }),
      ),
    };
  }
  it("(a) admin present: admin-root 200, owner-IRK 403", async () => {
    expect((await handler(ADMIN_ROOT.publicKey)(req(ADMIN_ROOT)))!.status).toBe(200);
    expect((await handler(ADMIN_ROOT.publicKey)(req(OWNER_IRK)))!.status).toBe(403);
  });
  it("(b) admin absent: legacy owner-IRK 200", async () => {
    expect((await handler()(req(OWNER_IRK)))!.status).toBe(200);
  });
});

// ── set-front-page HTTP ──────────────────────────────────────────────────────
describe("buildFrontPageHttp — admin-gated", () => {
  const NOW = 6_000_000;
  function handler(adminRootPub?: Uint8Array) {
    return buildFrontPageHttp({
      serverId: DOMAIN,
      ownerIrkPub: OWNER_IRK.publicKey,
      ...(adminRootPub ? { adminRootPub } : {}),
      username: USERNAME,
      store: new FrontPageStore(join(tmpdir(), `front-page-${Math.random().toString(36).slice(2)}.json`)),
      resolveLabel: () => true,
      now: () => NOW,
    });
  }
  function req(irk: Keypair) {
    const order: PhoneOrder = { type: "set-front-page", serverId: DOMAIN, label: "blog", issuedAt: NOW };
    return {
      method: "POST",
      path: "/api/front-page",
      headers: { "content-type": "application/json" },
      body: Buffer.from(
        JSON.stringify({ request: order, signature: hex(signPhoneOrder(order, irk)) }),
      ),
    };
  }
  it("(a) admin present: admin-root 200, owner-IRK 403", async () => {
    expect((await handler(ADMIN_ROOT.publicKey)(req(ADMIN_ROOT)))!.status).toBe(200);
    expect((await handler(ADMIN_ROOT.publicKey)(req(OWNER_IRK)))!.status).toBe(403);
  });
  it("(b) admin absent: legacy owner-IRK 200", async () => {
    expect((await handler()(req(OWNER_IRK)))!.status).toBe(200);
  });
});

// ── service-collaborator membership (D-2 — now SENSITIVE) ────────────────────
describe("membership (D-2) — admin-gated invite + mutation", () => {
  const APP = "habit-tracker";
  const member = key(0x77);
  function invite(irk: Keypair) {
    const nonce = newInviteNonce();
    const issuedAt = 7_000;
    const token: InviteToken = { serviceId: APP, role: "parent", nonce, issuedAt, expiresAt: issuedAt + 600_000 };
    const inviteSig = signInvite(token, irk);
    const acceptance: InviteAcceptance = {
      inviteNonce: nonce,
      accepterIrkPub: member.publicKey,
      acceptedAt: issuedAt + 100,
    };
    const acceptanceSig = signInviteAcceptance(acceptance, member);
    return { token, inviteSig, acceptance, acceptanceSig, issuedAt };
  }
  function mutation(irk: Keypair, at: number) {
    const m: MembershipMutation = { serviceId: APP, targetIrkPub: member.publicKey, role: "parent", issuedAt: at };
    return { m, sig: signMembershipMutation(m, irk) };
  }

  it("(a) admin present: invite-create admin-root ACCEPTED, owner-IRK REJECTED", () => {
    const now = 7_050;
    const adminStore = new InviteStore(APP, OWNER_IRK.publicKey, {
      now: () => now,
      adminRootPub: ADMIN_ROOT.publicKey,
      ownerUsername: USERNAME,
    });
    const good = invite(ADMIN_ROOT);
    expect(adminStore.redeem(good.token, good.inviteSig, good.acceptance, good.acceptanceSig).ok).toBe(true);
    const ownerStore = new InviteStore(APP, OWNER_IRK.publicKey, {
      now: () => now,
      adminRootPub: ADMIN_ROOT.publicKey,
      ownerUsername: USERNAME,
    });
    const bad = invite(OWNER_IRK);
    expect(ownerStore.redeem(bad.token, bad.inviteSig, bad.acceptance, bad.acceptanceSig)).toEqual({
      ok: false,
      reason: "invalid-invite-signature",
    });
  });

  it("(a) admin present: mutation admin-root ACCEPTED, owner-IRK REJECTED", () => {
    const mkStore = () =>
      new MembershipStore(APP, USERNAME, OWNER_IRK.publicKey, {
        now: () => 8_000,
        adminRootPub: ADMIN_ROOT.publicKey,
        ownerUsername: USERNAME,
      });
    const okMut = mutation(ADMIN_ROOT, 8_000);
    expect(mkStore().applySignedMutation(okMut.m, okMut.sig)).toEqual({ ok: true, effect: "added" });
    const badMut = mutation(OWNER_IRK, 8_000);
    expect(mkStore().applySignedMutation(badMut.m, badMut.sig)).toEqual({
      ok: false,
      reason: "invalid-signature",
    });
  });

  it("(b) admin absent: legacy owner-IRK invite + mutation still work", () => {
    const store = new InviteStore(APP, OWNER_IRK.publicKey, { now: () => 7_050 });
    const good = invite(OWNER_IRK);
    expect(store.redeem(good.token, good.inviteSig, good.acceptance, good.acceptanceSig).ok).toBe(true);
    const mStore = new MembershipStore(APP, USERNAME, OWNER_IRK.publicKey, { now: () => 8_000 });
    const okMut = mutation(OWNER_IRK, 8_000);
    expect(mStore.applySignedMutation(okMut.m, okMut.sig)).toEqual({ ok: true, effect: "added" });
  });
});

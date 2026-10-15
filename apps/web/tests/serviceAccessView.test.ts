// Service access gating — webapp view wiring (docs/service-access-gating.md).
//
// Structure-level tests over the EXACT static assets the production webapp
// loads (served via the Fastify app), mirroring inviteUxView.test.ts: the
// admin view + the friend redeem view register, wire the right endpoints/lib,
// and the shell (index.html + app.js) declares + inits them.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function loadServiceAccessModule() {
  // The view module imports only lib helpers that are window/IndexedDB-free at
  // load time, so it imports clean under Node (no JSDOM in the repo). Cache-bust
  // so each test gets a fresh module instance.
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const path = resolve(__dirname, "..", "public", "webapp", "views", "service-access.js");
  return await import(pathToFileURL(path).href + bust);
}

describe("service-access admin view", () => {
  it("/views/service-access.js registers a view + drives the access mode toggle and invite mgmt", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-access.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-service-access")');
    // The two-way Open to all | Members only toggle is the access-mode control.
    expect(r.body).toContain('id="sa-mode" role="radiogroup"');
    expect(r.body).toContain('const MODE_LABEL = { open: "Open to all", restricted: "Members only" }');
    expect(r.body).toContain("setServiceAccessMode");
    // Going members-only confirms how many people that leaves; a failure rolls the toggle back.
    expect(r.body).toContain("will be able to open it.");
    expect(r.body).toContain("setModeUi(current)");
    // Each member row has a rank picker that sends a signed flagship/app-rank/v1.
    expect(r.body).toContain('data-action="sa-role"');
    expect(r.body).toContain("setAppRank");
    // Account members: this account's devices and the co-managers, each with a rank.
    expect(r.body).toContain('id="sa-account-people"');
    expect(r.body).toContain('data-action="sa-acct-rank"');
    expect(r.body).toContain('data-action="sa-acct-refuse"');
    expect(r.body).toContain("fetchMembers");
    // Master wears the crown; the add card shows the app's one line per rank.
    expect(r.body).toContain("crownHtml(role)");
    expect(r.body).toContain("roleOptionsHtml(\"member\", true)");
    // Allow-list manager: add a person → mint an invite → show the link.
    expect(r.body).toContain("createInvite");
    expect(r.body).toContain("listInvites");
    expect(r.body).toContain("revokeInvite");
    // Remove must ALSO prune the bound AID on the box (the .com revoke alone
    // never reaches the box). The Remove button carries the bound AID.
    expect(r.body).toContain("removeServiceAllow");
    expect(r.body).toContain("data-aid=");
    // Identity derivations come from the keystore (AID + household).
    expect(r.body).toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("deriveHouseholdKeyFromSeed");
    // Mode, prune and rank orders sign with the admin root (the sensitive
    // signer); a non-admin device's create/revoke with its account device key;
    // the .com list query with the AID.
    expect(r.body).toContain("signWithIrk: sensitiveSigner()");
    expect(r.body).toContain("signWithAccountDeviceKey");
    expect(r.body).toContain("signWithAccountId");
    // The withdraw also goes to the box, which prunes who joined through it.
    expect(r.body).toContain("withdrawInviteOnBox");
    // The copyable share-link + an inline QR + Web Share API + clipboard fallback.
    expect(r.body).toContain("navigator.share");
    expect(r.body).toContain("navigator.clipboard");
    expect(r.body).toContain("/qrEncoder.js");
    expect(r.body).toContain("renderQrSvg");
  });

  it("/views/service-access.js adds a person (or one you approve) or a group, each with a role, + the manual accept loop", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-access.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("+ Add person");
    expect(r.body).toContain("+ Add group");
    expect(r.body).toContain('id="sa-approve"');
    expect(r.body).toContain('id="sa-new-role"');
    expect(r.body).toContain("inviteTarget(r.inviteId)");
    // Group caps surfaced + threaded onto the create.
    expect(r.body).toContain("sa-maxn");
    expect(r.body).toContain("maxRedemptions");
    expect(r.body).toContain("expiresAt");
    expect(r.body).toContain("approvalMode");
    // The manual-approve finalize (author submits the friend's acceptance).
    expect(r.body).toContain("submitAccept");
    expect(r.body).toContain("parseAcceptReply");
    expect(r.body).toContain("runFinalizeAccept");
    // The group entry shows one "k of N joined" line with a revoke.
    expect(r.body).toContain("of ${cap} joined");
    expect(r.body).toContain('isGroup ? "Revoke" : "Remove"');
    expect(r.body).toContain("boundAIDs");
  });

  it("/lib/serviceInvite.js exposes the crypto-mirror + wire surface", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/serviceInvite.js" });
    expect(r.statusCode).toBe(200);
    // Canonical-bytes tags MUST match @flagship/protocol.
    expect(r.body).toContain('"flagship/service-invite/create/v1"');
    expect(r.body).toContain('"flagship/service-invite/redeem/v1"');
    expect(r.body).toContain('"flagship/service-invite/revoke/v1"');
    expect(r.body).toContain('"flagship/service-invite/accept/v1"');
    expect(r.body).toContain('"flagship/service-access-mode/v1"');
    expect(r.body).toContain('"flagship/service-allow-remove/v1"');
    expect(r.body).toContain('"flagship/service-visit/v1"');
    expect(r.body).toContain('"flagship/service-invite-list/v1"');
    // AEAD bundle + canonical builders + wire helpers.
    expect(r.body).toContain("sealInviteBundle");
    expect(r.body).toContain("openInviteBundle");
    expect(r.body).toContain("serviceInviteId");
    expect(r.body).toContain("randomServiceInviteId");
    expect(r.body).toContain("buildInviteLink");
    expect(r.body).toContain("inviteSecretFromLocation");
    expect(r.body).toContain("inviteContextFromLocation");
    // v2 crypto surface: contact AID (re-export), accept loop, group caps.
    expect(r.body).toContain("deriveAppAccountId");
    expect(r.body).toContain("canonicalAcceptBytes");
    expect(r.body).toContain("signAcceptServiceInvite");
    expect(r.body).toContain("buildAcceptReply");
    expect(r.body).toContain("parseAcceptReply");
    expect(r.body).toContain("submitAccept");
    // .com routes for create / list / revoke.
    expect(r.body).toContain("/service-invites");
    expect(r.body).toContain("/service-invites/revoke");
    // The box redeem + owner set-mode + prune + the manual accept finalize.
    expect(r.body).toContain("/api/service-invites/redeem");
    expect(r.body).toContain("/api/service-access");
    expect(r.body).toContain("/api/service-access/allow-remove");
    expect(r.body).toContain("/api/service-access/accept");
    expect(r.body).toContain("removeServiceAllow");
  });

  it("keystore.js exposes the AID + household-key + AID-signer derivations", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/keystore.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("deriveHouseholdKeyFromSeed");
    expect(r.body).toContain("signWithAccountId");
    // The per-app identity + its signer.
    expect(r.body).toContain("deriveAppAccountIdFromSeed");
    expect(r.body).toContain("signWithAppAccountId");
    // The fixed HKDF infos (byte-identical to @flagship/protocol).
    expect(r.body).toContain("flagship/account-id/v1");
    expect(r.body).toContain("flagship/household-key/v1");
    expect(r.body).toContain("flagship/app-aid/v1");
  });
});

describe("service-access friend redeem view + deep-link", () => {
  it("/views/invite-redeem.js registers a view + redeems against the box with the AID", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-redeem.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-invite-redeem")');
    expect(r.body).toContain("redeemInvite");
    // Redeem under the per-app id (never the global AID); a link without the app is refused.
    expect(r.body).not.toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("OLD_INVITE_LINK");
    expect(r.body).toContain("deriveAppAccountIdFromSeed");
    expect(r.body).toContain("signWithAppAccountId");
    // The box (and owner AID from `a=`) is remembered so later knocks can sign with the per-app id.
    expect(r.body).toContain("rememberInviteOwner({ serverId: boxHost(), ownerAidHex: pendingAuthorAidHex");
    // Manual-approve: the friend emits an acceptance reply signed with the per-app id (+ QR).
    expect(r.body).toContain("signAcceptServiceInvite");
    expect(r.body).toContain("buildAcceptReply");
    expect(r.body).toContain("renderQrSvg");
    // Resume hooks consumed by the unlock/bootstrap detour.
    expect(r.body).toContain("hasPendingInviteRedeem");
    expect(r.body).toContain("resumePendingInviteRedeem");
  });

  it("deepLink.js resumes a pending invite redeem after the friend unlocks", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/deepLink.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("hasPendingInviteRedeem");
    expect(r.body).toContain("resumePendingInviteRedeem");
  });

  it("app.js wires the /invite#… boot-handler (with the v2 context) + inits both views", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    // v2: parse the full context (secret + author AID + inviteId) from the fragment.
    expect(r.body).toContain("inviteContextFromLocation");
    expect(r.body).toContain("enterInviteRedeem");
    expect(r.body).toContain("initServiceAccessView");
    expect(r.body).toContain("initInviteRedeemView");
    expect(r.body).toContain('"view-service-access": "apps"');
  });

  it("service-detail.js wires the 'Access control' row", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-detail.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("sd-access");
    expect(r.body).toContain("./service-access.js");
    expect(r.body).toContain("enterServiceAccess");
  });

  it("index.html declares the service-access + invite-redeem sections", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="view-service-access"');
    expect(r.body).toContain('id="service-access-content"');
    expect(r.body).toContain('id="view-invite-redeem"');
    expect(r.body).toContain('id="invite-redeem-content"');
  });
});

// ──────────────────────────────────────────────────────────────────────
// runRemovePerson — the two-leg remove behavior (dependency-injected, no DOM).
// Mirrors webappCompanionRequestsView's runApprove pattern: the view exports the
// pure-core the click handler calls so the .com revoke + box prune are testable.
// ──────────────────────────────────────────────────────────────────────
describe("service-access — runRemovePerson (revoke .com + prune box)", () => {
  const SERVICE = "alice-notes";
  const AID = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c";
  const baseDeps = () => ({
    getSession: () => ({ username: "alice", umk: new Uint8Array(32).fill(0x0b) }),
    controlApex: () => "https://flagshipserver.com",
    podBaseUrl: () => "https://home.alice.flagship.services",
    signWithIrk: async () => new Uint8Array(64),
    // The .com revoke: the admin root, or this device's key for its own invite.
    revokeSigner: async () => new Uint8Array(64),
    humanError: (e: unknown) => String((e as Error)?.message ?? e),
  });

  it("a BOUND person → revokes on .com AND fires the box prune with the right serviceRef + aid", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "inv-1", boundAID: AID },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(out).toEqual({ ok: true, prunedBox: true });
    // Leg 1: .com revoke, by inviteId, signed by the revoke signer.
    expect(revokeInvite).toHaveBeenCalledTimes(1);
    expect(revokeInvite.mock.calls[0]![0]).toMatchObject({ username: "alice", inviteId: "inv-1" });
    expect(typeof (revokeInvite.mock.calls[0]![0] as { signWithAccountId: unknown }).signWithAccountId).toBe("function");
    // Leg 3 (admin): the box prune, with the exact serviceRef + bound AID, admin-signed.
    expect(removeServiceAllow).toHaveBeenCalledTimes(1);
    const pruneArg = removeServiceAllow.mock.calls[0]![0] as { baseUrl: string; serviceRef: string; aid: string; signWithIrk: unknown };
    expect(pruneArg.serviceRef).toBe(SERVICE);
    expect(pruneArg.aid).toBe(AID);
    expect(pruneArg.baseUrl).toBe("https://home.alice.flagship.services");
    expect(typeof pruneArg.signWithIrk).toBe("function");
  });

  it("a GROUP revoke → one .com revoke AND a box prune for EVERY bound AID", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const aids = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "grp-1", boundAID: null, boundAIDs: aids, isGroup: true },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(out).toEqual({ ok: true, prunedBox: true });
    expect(revokeInvite).toHaveBeenCalledTimes(1);
    // One prune per bound member.
    expect(removeServiceAllow).toHaveBeenCalledTimes(3);
    expect(removeServiceAllow.mock.calls.map((c) => (c[0] as { aid: string }).aid)).toEqual(aids);
  });

  it("prunes on the box only the AIDs for whom this was their last grant", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const [a, b, c] = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
    const members = {
      members: [
        { aid: a, role: "member", grants: [{ inviteId: "grp-1", role: "member" }], direct: null },
        { aid: b, role: "master", grants: [{ inviteId: "grp-1", role: "member" }, { inviteId: "sam", role: "master" }], direct: null },
      ],
    };
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "grp-1", boundAID: null, boundAIDs: [a, b, c], isGroup: true, members },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(out).toEqual({ ok: true, prunedBox: true });
    // b keeps their personal invite; c isn't listed by the box (nothing to keep).
    expect(removeServiceAllow.mock.calls.map((x) => (x[0] as { aid: string }).aid)).toEqual([a, c]);
    // A person whose only other grant is elsewhere: no box prune at all.
    removeServiceAllow.mockClear();
    const solo = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "sam", boundAID: b, members },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(solo).toEqual({ ok: true, prunedBox: false });
    expect(removeServiceAllow).not.toHaveBeenCalled();
  });

  it("an UNREDEEMED invite (no boundAID) → only the .com revoke, no box prune", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "inv-2", boundAID: null },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(out).toEqual({ ok: true, prunedBox: false });
    expect(revokeInvite).toHaveBeenCalledTimes(1);
    expect(removeServiceAllow).not.toHaveBeenCalled();
  });

  it("a box-prune failure throws a tagged error (the box is what enforces — access may persist)", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => {
      const e = new Error("request failed (403): bad sig");
      throw e;
    });
    await expect(
      mod.runRemovePerson(
        { serviceRef: SERVICE, inviteId: "inv-3", boundAID: AID },
        { ...baseDeps(), revokeInvite, removeServiceAllow },
      ),
    ).rejects.toMatchObject({ code: "box-prune-failed" });
    // The .com revoke still ran (leg 1 succeeds before the box prune fails).
    expect(revokeInvite).toHaveBeenCalledTimes(1);
  });

  it("hands the box the same signed revoke as a withdraw", async () => {
    const mod = await loadServiceAccessModule();
    const revoke = { inviteId: "inv-4", issuedAt: 1_700_000_000_000 };
    const revokeInvite = vi.fn(async () => ({ revoked: true, revoke, signature: "ab".repeat(64) }));
    const withdrawInviteOnBox = vi.fn(async () => ({ ok: true, pruned: 1 }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "inv-4", boundAID: AID },
      { ...baseDeps(), revokeInvite, removeServiceAllow, withdrawInviteOnBox },
    );
    expect(out).toEqual({ ok: true, prunedBox: true });
    expect(withdrawInviteOnBox).toHaveBeenCalledWith({ baseUrl: "https://home.alice.flagship.services", revoke, signature: "ab".repeat(64) });
    expect(removeServiceAllow).toHaveBeenCalledTimes(1);
  });

  it("a non-admin device withdraws through the box only, never an allow-remove", async () => {
    const mod = await loadServiceAccessModule();
    const revoke = { inviteId: "inv-5", issuedAt: 1_700_000_000_000 };
    const revokeInvite = vi.fn(async () => ({ revoked: true, revoke, signature: "cd".repeat(64) }));
    const withdrawInviteOnBox = vi.fn(async () => ({ ok: true, pruned: 1 }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "inv-5", boundAID: AID, isAdmin: false },
      { ...baseDeps(), revokeInvite, removeServiceAllow, withdrawInviteOnBox },
    );
    expect(out).toEqual({ ok: true, prunedBox: true });
    expect(removeServiceAllow).not.toHaveBeenCalled();
    const failing = vi.fn(async () => {
      throw new Error("request failed (403): only an admin");
    });
    await expect(
      mod.runRemovePerson(
        { serviceRef: SERVICE, inviteId: "inv-5", boundAID: AID, isAdmin: false },
        { ...baseDeps(), revokeInvite, removeServiceAllow, withdrawInviteOnBox: failing },
      ),
    ).rejects.toMatchObject({ code: "box-prune-failed" });
    expect(removeServiceAllow).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// runFinalizeAccept — the MANUAL-approve author finalize core (no DOM).
// The author parses the friend's acceptance reply and submits ONLY {accept,
// acceptSig} to the box's accept endpoint; the box fetches the owner's create
// from .com by inviteId (any-device finalize — NO local create cache).
// ──────────────────────────────────────────────────────────────────────
describe("service-access — runFinalizeAccept (manual-approve finalize)", () => {
  const SERVICE = "alice-notes";
  const INVITE = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890";
  const CONTACT = "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a";
  const parsedReply = {
    serverDomain: "home.alice.flagship.services",
    accept: { inviteId: INVITE, serviceRef: SERVICE, contactAID: CONTACT, acceptedAt: 1700006000000 },
    acceptSig: "11".repeat(64),
  };

  it("parses the reply and submits ONLY {accept, acceptSig} (no create)", async () => {
    const mod = await loadServiceAccessModule();
    const submitAccept = vi.fn(async () => ({ bound: true, serviceRef: SERVICE, boundAID: CONTACT }));
    const out = await mod.runFinalizeAccept(
      { raw: ` flagship://invite-accept?server=home.alice.flagship.services&iid=${INVITE} ` },
      {
        podBaseUrl: () => "https://home.alice.flagship.services",
        parseAcceptReply: () => parsedReply,
        submitAccept,
      },
    );
    expect(out).toEqual({ ok: true, serviceRef: SERVICE, boundAID: CONTACT });
    expect(submitAccept).toHaveBeenCalledTimes(1);
    const arg = submitAccept.mock.calls[0]![0] as {
      baseUrl: string; accept: { inviteId: string }; acceptSig: string; create?: unknown; createSig?: string;
    };
    expect(arg.baseUrl).toBe("https://home.alice.flagship.services");
    expect(arg.accept.inviteId).toBe(INVITE);
    expect(arg.acceptSig).toBe(parsedReply.acceptSig);
    // No create / createSig — the box fetches the signed create from .com.
    expect(arg.create).toBeUndefined();
    expect(arg.createSig).toBeUndefined();
  });

  it("a junk reply → a tagged bad-accept error (no submit)", async () => {
    const mod = await loadServiceAccessModule();
    const submitAccept = vi.fn();
    await expect(
      mod.runFinalizeAccept(
        { raw: "garbage" },
        { podBaseUrl: () => "https://x", parseAcceptReply: () => null, submitAccept },
      ),
    ).rejects.toMatchObject({ code: "bad-accept" });
    expect(submitAccept).not.toHaveBeenCalled();
  });
});

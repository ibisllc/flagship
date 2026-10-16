// Co-manager invites on the webapp (docs/service-access-gating.md "Co-manager
// invites"): the shared server's "Invite people" flows against the real box
// share routes (buildShares + buildShareInvites over a real access store) and
// the real `.com` invite handlers, over a mocked fetch; the panel in each
// state; and how the owner's Access control names a co-manager's invites.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveAccountId,
  deriveIRK,
  deriveShareMemberKey,
  signServerShareAccept,
  signServerShareGrant,
  verifyServerShareGrant,
  verifyServerShareRevoke,
  type ServerShareGrant,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleCreateServiceInvite, handleRevokeServiceInvite } from "@flagship/control-plane";
import { ShareStore } from "../../../packages/server-daemon/src/shares/shareStore.js";
import { ActivityLog } from "../../../packages/server-daemon/src/shares/activityLog.js";
import { ShareSessionStore, buildShares } from "../../../packages/server-daemon/src/shares/sharesHttp.js";
import { ShareInviteStore, buildShareInvites } from "../../../packages/server-daemon/src/shares/shareInvites.js";
import { AccessPrincipals } from "../../../packages/server-daemon/src/accessPrincipals.js";
import { ServiceAccessStore } from "../../../packages/server-daemon/src/serviceAccess.js";

vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

import * as shares from "../public/webapp/lib/serverShares.js";
import { coInvitePanelHtml, sharedServerHtml } from "../public/webapp/views/shared-server.js";
import { invitedByText, normalizeMembers } from "../public/webapp/lib/memberRoles.js";
import { inviteTierOf } from "../public/webapp/lib/serviceInvite.js";
import { peopleRowHtml } from "../public/webapp/views/service-access.js";

const S = "home.alice.flagship.services";
const APEX = "https://flagshipserver.com";
const APP = "alice--club";
const umkA = new Uint8Array(32).fill(11);
const umkB = new Uint8Array(32).fill(22);
const ownerIrk = deriveIRK({ seed: umkA });
const ownerAid = deriveAccountId({ seed: umkA });
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(7) });
const stk = deriveIRK({ seed: new Uint8Array(32).fill(33) });
const SHARE = "ab".repeat(16);
const member = deriveShareMemberKey({ seed: umkB }, SHARE);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Init = { method?: string; headers?: Record<string, string>; body?: string };

async function world(level: "view" | "manage" = "manage") {
  const storage = new InMemoryStorage();
  await storage.usernames.put({
    username: "alice",
    irkPubHex: hex(ownerIrk.publicKey),
    aidPubHex: hex(ownerAid.publicKey),
    adminRootPubHex: hex(adminRoot.publicKey),
    claimedAt: 1,
  });
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  const comDeps = { invites: storage.serviceInvites, usernames: storage.usernames, servers: storage.servers };

  const store = new ShareStore(null, { serverDomain: S, verifyOwnerGrant: (g, sig) => verifyServerShareGrant(g, sig, adminRoot.publicKey) });
  const grant: ServerShareGrant = { serverDomain: S, shareId: SHARE, memberPubHex: hex(member.publicKey), level, unlockAtBoot: false, seeAppData: false, label: "Sam", issuedAt: Date.now() - 1000 };
  const accept = { serverDomain: S, shareId: SHARE, memberPubHex: hex(member.publicKey), acceptedAt: Date.now() - 2000 };
  const put = await store.put(grant, hex(signServerShareGrant(grant, adminRoot)), accept, hex(signServerShareAccept(accept, member)));
  expect(put.ok).toBe(true);

  const principals = new AccessPrincipals(hex(ownerAid.publicKey));
  principals.shares = () => store.list().map((h) => ({ shareId: h.grant.shareId, memberPubHex: h.grant.memberPubHex, label: h.grant.label, level: h.grant.level }));
  const access = new ServiceAccessStore(`/nonexistent-${Math.random()}/a.json`, { ownerAidHex: hex(ownerAid.publicKey), principals, serverDomain: S });
  (access as unknown as { persist: () => Promise<void> }).persist = async () => {};
  const journal: string[] = [];
  const inviteStore = new ShareInviteStore(null);

  const reply = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const comFetch = (async (input: string, init: Init = {}) => {
    const p = new URL(input).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const r =
      p === "/api/users/alice/service-invites"
        ? await handleCreateServiceInvite(comDeps, "alice", body)
        : p === "/api/users/alice/service-invites/revoke"
          ? await handleRevokeServiceInvite(comDeps, "alice", body)
          : { status: 404, body: { error: "no route" } };
    return reply(r.status, r.body);
  }) as unknown as typeof fetch;

  const invites = buildShareInvites({
    serverDomain: S,
    username: "alice",
    ownerAidHex: hex(ownerAid.publicKey),
    controlPlaneBaseUrl: APEX,
    stk,
    store: inviteStore,
    access: () => access,
    installed: (ref) => ref === APP,
    record: (_ref, e) => journal.push(e.kind),
    fetchImpl: comFetch,
  });
  const box = buildShares({
    serverDomain: S,
    store,
    sessions: new ShareSessionStore(null),
    activity: new ActivityLog(null),
    verifyOwnerRevoke: (r, sig) => verifyServerShareRevoke(r, sig, adminRoot.publicKey),
    invites,
    log: () => {},
  });

  const fetchImpl = async (input: string, init: Init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (url.host === S && url.pathname.startsWith("/api/shares/")) {
      const r = await box.handlePublic({ method, path: `${url.pathname}${url.search}`, headers, body: Buffer.from(init.body ?? "") });
      return reply(r!.status, r!.body as string);
    }
    return reply(404, { error: "unknown host" });
  };
  const entry = { entryId: "ee".repeat(16), shareId: SHARE, secretHex: "cd".repeat(32), serverDomain: S, serverName: "home", acceptedAt: 1 };
  const depsB = { fetch: fetchImpl, apex: APEX, umk: umkB, username: "bob" };
  return { storage, access, journal, inviteStore, entry, depsB };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a co-manager invites people to an app", () => {
  it("creates a Member invite the box relays to .com, lists it by name and withdraws it", async () => {
    const w = await world();
    const before = await shares.fetchShareInvites(w.entry, APP, w.depsB);
    expect(before).toEqual(expect.objectContaining({ canInvite: true, whyText: "", rank: "manager", ownerAid: hex(ownerAid.publicKey), invites: [] }));

    const made = await shares.createShareInvite(w.entry, { serviceRef: APP, ownerAid: before.ownerAid, name: "Alex" }, w.depsB);
    expect(made.link).toMatch(new RegExp(`^https://${S.replace(/\./g, "\\.")}/invite#[0-9a-f]{64}&a=${hex(ownerAid.publicKey)}&i=${made.inviteId}&s=${APP}$`));
    const row = await w.storage.serviceInvites.get(made.inviteId);
    expect([row?.creatorTier, row?.creatorPubHex, row?.serviceRef]).toEqual(["co-manager", hex(member.publicKey), APP]);
    expect(w.access.inviteTier(APP, made.inviteId)).toBe("co-manager");
    expect(w.journal).toEqual(["share"]);

    const group = await shares.createShareInvite(
      w.entry,
      { serviceRef: APP, ownerAid: before.ownerAid, name: "Chess club", group: { maxRedemptions: 5, expiresAt: Date.now() + 86_400_000 } },
      w.depsB,
    );
    const listed = await shares.fetchShareInvites(w.entry, APP, w.depsB);
    expect(listed.invites.map((i) => [i.name, i.maxRedemptions])).toEqual(
      expect.arrayContaining([["Alex", null], ["Chess club", 5]]),
    );

    // Someone joined through the personal one; withdrawing it removes them.
    await w.access.addAllowed(APP, "ff".repeat(32), made.inviteId);
    const out = await shares.withdrawShareInvite(w.entry, made.inviteId, w.depsB);
    expect(out).toEqual({ ok: true, pruned: 1, comNotified: true });
    expect(w.access.isAllowed(APP, "ff".repeat(32))).toBe(false);
    expect((await w.storage.serviceInvites.get(made.inviteId))?.revokedAt).not.toBeNull();
    expect((await shares.fetchShareInvites(w.entry, APP, w.depsB)).invites.map((i) => i.inviteId)).toEqual([group.inviteId]);
  });

  it("a demoted co-manager is told why and their create is refused with the box's sentence", async () => {
    const w = await world();
    await w.access.setAccountRank(APP, `share:${SHARE}`, "member", Date.now());
    const s = await shares.fetchShareInvites(w.entry, APP, w.depsB);
    expect([s.canInvite, s.why, s.whyText]).toEqual([false, "demoted", shares.CO_INVITE_WHY.demoted]);
    await expect(shares.createShareInvite(w.entry, { serviceRef: APP, ownerAid: s.ownerAid, name: "Alex" }, w.depsB)).rejects.toThrow(
      "An admin made you a Member of this app, so you can't invite people to it.",
    );
    expect(await w.storage.serviceInvites.listForAuthor(hex(ownerAid.publicKey))).toEqual([]);
  });

  it("a view-only share can't invite", async () => {
    const w = await world("view");
    const s = await shares.fetchShareInvites(w.entry, APP, w.depsB);
    expect([s.canInvite, s.whyText]).toEqual([false, shares.CO_INVITE_WHY["view-only"]]);
  });

  it("asks for a name first", async () => {
    const w = await world();
    await expect(shares.createShareInvite(w.entry, { serviceRef: APP, ownerAid: hex(ownerAid.publicKey), name: "  " }, w.depsB)).rejects.toThrow("Give them a name.");
  });
});

describe("the Invite people panel and the page", () => {
  const entry = { entryId: "ee".repeat(16), shareId: SHARE, secretHex: "cd".repeat(32), serverDomain: S, serverName: "home", acceptedAt: 1 };
  const detail = { serverFqdn: S, username: "alice", currentCommit: "c".repeat(40), uptimeMs: 3_600_000 };
  const apps = [{ serviceId: "notes", slug: "notes", url: "https://notes.example", status: "running" }];

  it("at Can manage every app offers Invite people; at Can view the page says why not, once", () => {
    const manage = sharedServerHtml({ entry, me: { level: "manage", unlockAtBoot: false, seeAppData: false }, detail, apps });
    expect(manage).toContain('data-invite-open="notes"');
    expect(manage).toContain(shares.CO_INVITE_OPEN);
    expect(manage).not.toContain("data-co-invite-view");
    const view = sharedServerHtml({ entry, me: { level: "view", unlockAtBoot: false, seeAppData: false }, detail, apps });
    expect(view).not.toContain("data-invite-open");
    expect(view.match(/data-co-invite-view/g)).toHaveLength(1);
    expect(view).toContain("You can view this server but not manage it, so you can't invite people to its apps.");
  });

  it("lists your invites with Withdraw while you may invite", () => {
    const html = coInvitePanelHtml(
      {
        canInvite: true,
        why: null,
        whyText: "",
        invites: [
          { inviteId: "11".repeat(32), name: "Alex", joined: 0, maxRedemptions: null, expiresAt: null },
          { inviteId: "22".repeat(32), name: null, joined: 3, maxRedemptions: 10, expiresAt: 5 },
        ],
      },
      10,
    );
    expect(html).toContain(shares.CO_INVITE_LINE);
    expect(html).toContain('data-co-add="person"');
    expect(html).toContain('data-co-add="group"');
    expect(html).toContain("Alex");
    expect(html).toContain("Not opened yet");
    expect(html).toContain("Someone");
    expect(html).toContain("3 of 10 joined · expired");
    expect(html.match(/data-co-withdraw="/g)).toHaveLength(2);
  });

  it("when demoted: the box's line, your invites without Withdraw, no add buttons", () => {
    const html = coInvitePanelHtml({
      canInvite: false,
      why: "demoted",
      whyText: shares.CO_INVITE_WHY.demoted,
      invites: [{ inviteId: "11".repeat(32), name: "Alex", joined: 1, maxRedemptions: null, expiresAt: null }],
    });
    expect(html).toContain("An admin made you a Member of this app, so you can't invite people to it.");
    expect(html).toContain("1 person joined");
    expect(html).not.toContain("data-co-add");
    expect(html).not.toContain("data-co-withdraw");
  });

  it("with no invites says so", () => {
    expect(coInvitePanelHtml({ canInvite: true, why: null, whyText: "", invites: [] })).toContain(shares.CO_INVITE_NONE);
  });
});

describe("the owner's Access control names a co-manager's invites", () => {
  const members = normalizeMembers({
    invites: [{ inviteId: "aa".repeat(32), role: "member", tier: "co-manager", creatorPub: "bb".repeat(32), creatorShareId: SHARE, creatorLabel: "Sam" }],
    accountMembers: [],
    members: [],
  });

  it("keeps the tier and the owner's label for the share", () => {
    expect(inviteTierOf("co-manager")).toBe("co-manager");
    expect(members.invites[0]).toEqual(expect.objectContaining({ tier: "co-manager", creatorShareId: SHARE, creatorLabel: "Sam" }));
  });

  it("says who invited and shows the person though their name is sealed to the co-manager", () => {
    const invite = { inviteId: "aa".repeat(32), creatorTier: "co-manager", bundle: null, boundAID: null, maxRedemptions: null };
    expect(invitedByText(invite, { deviceId: "", deviceNames: null, members })).toBe("Invited by Sam (co-manager)");
    expect(invitedByText(invite, { deviceId: "", deviceNames: null, members: null })).toBe("Invited by a co-manager");
    const html = peopleRowHtml(invite, members, () => "", { isAdmin: true, deviceId: "", devicePub: "", managerClass: true, members, deviceNames: null });
    expect(html).toContain("Someone they invited");
    expect(html).toContain("Invited by Sam (co-manager)");
    expect(html).toContain('data-action="sa-remove"');
  });
});

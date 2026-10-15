// Who can invite (docs/service-access-gating.md, "Account members, ranks and
// who may change them"): a device of the account that is manager-class in the
// app may invite someone at Member, signed with its account device key; only a
// device holding the admin root gives a higher rank, changes ranks or
// withdraws someone else's invite. Each members row says which device invited
// it, the name decrypted on this device; admins get a content-free
// invite-created push that opens the account activity.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const load = async (rel: string) =>
  import(pathToFileURL(join(WEBAPP, rel)).href + `?t=${Math.random().toString(36).slice(2)}`);

const THIS_DEVICE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PHONE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const SERVICE = "alice--notes";

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("create and revoke: signer and attribution", () => {
  async function create(deviceId: string | undefined, tier = "member") {
    const si = await load("lib/serviceInvite.js");
    const fetch = vi.fn(async () => okJson({ created: true, inviteId: "x", tier }));
    const signer = vi.fn(async () => new Uint8Array(64).fill(7));
    const r = await si.createInvite(
      {
        comBase: "https://flagshipserver.com",
        username: "alice",
        podBaseUrl: "https://home.alice.flagship.services",
        authorAID: new Uint8Array(32).fill(1),
        serviceRef: SERVICE,
        bundle: { name: "Sam" },
        householdKey: new Uint8Array(32).fill(2),
        umk: new Uint8Array(32).fill(3),
        signWithAccountId: signer,
        ...(deviceId !== undefined ? { deviceId } : {}),
      },
      { fetch, now: () => 1_700_000_000_000 },
    );
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    return { r, body, signer, si };
  }

  it("sends this device's id with the create, outside the signed bytes", async () => {
    const { r, body, signer, si } = await create(THIS_DEVICE);
    expect(body.request.deviceId).toBe(THIS_DEVICE);
    expect(body.signature).toBe("07".repeat(64));
    const signed = new TextDecoder().decode((signer.mock.calls[0] as unknown as [Uint8Array, Uint8Array])[1]);
    expect(signed.startsWith("flagship/service-invite/create/v1|")).toBe(true);
    expect(signed).not.toContain(THIS_DEVICE);
    expect(si.canonicalCreateBytes({ ...body.request, authorAID: new Uint8Array(32).fill(1) })).toBeTruthy();
    expect(r.tier).toBe("member");
  });

  it("leaves out a missing or malformed device id", async () => {
    expect((await create(undefined)).body.request).not.toHaveProperty("deviceId");
    expect((await create("")).body.request).not.toHaveProperty("deviceId");
    expect((await create("NOT-HEX")).body.request).not.toHaveProperty("deviceId");
    expect((await create(THIS_DEVICE, "admin")).r.tier).toBe("admin");
  });

  it("an admin device signs create and revoke with the admin root, any other device with its account device key", async () => {
    const { makeSensitiveSigner, SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    const si = await load("lib/serviceInvite.js");
    const deviceKey = vi.fn(async () => new Uint8Array([1]));
    const admin = vi.fn(async () => new Uint8Array([2]));
    const createBytes = si.canonicalCreateBytes({
      inviteId: "inv-1", authorAID: new Uint8Array(32), serviceRef: SERVICE, secretHash: "ab", encryptedBundle: "cd", issuedAt: 1,
    });
    const revokeBytes = si.canonicalRevokeBytes({ inviteId: "inv-1", issuedAt: 1 });
    const umk = new Uint8Array(32);

    const adminSigner = makeSensitiveSigner(new Uint8Array(32).fill(9), deviceKey, { signWithAdminRoot: admin });
    expect(await adminSigner(umk, createBytes)).toEqual(new Uint8Array([2]));
    expect(await adminSigner(umk, revokeBytes)).toEqual(new Uint8Array([2]));
    expect(deviceKey).not.toHaveBeenCalled();

    const memberSigner = makeSensitiveSigner(null, deviceKey, { signWithAdminRoot: admin });
    expect(await memberSigner(umk, createBytes)).toEqual(new Uint8Array([1]));
    expect(await memberSigner(umk, revokeBytes)).toEqual(new Uint8Array([1]));
    expect(admin).toHaveBeenCalledTimes(2);

    // Rank changes are admin-root orders too: the box refuses an IRK-signed one.
    expect(SENSITIVE_TAGS.has("flagship/app-rank/v1")).toBe(true);
  });

  it("the view signs both through the session's sensitive signer over this device's key and sends the device id", () => {
    const src = readFileSync(join(WEBAPP, "views/service-access.js"), "utf8");
    expect(src).toContain("deviceId: thisDeviceId()");
    expect(src).toContain("signWithAccountId: inviteSigner()");
    expect(src).toMatch(/function inviteSigner\(\) \{\s*return sensitiveSigner\(signWithThisDevice\);/);
    expect(src).toContain("return signWithAccountDeviceKey(umk, accountId, deviceId, bytes);");
    expect(src).toContain("revokeSigner: inviteSigner()");
  });
});

describe("list parsing", () => {
  it("reads who created each invite from .com, null on old rows", async () => {
    const si = await load("lib/serviceInvite.js");
    const fetch = vi.fn(async () =>
      okJson({
        invites: [
          { inviteId: "a", serviceRef: SERVICE, creatorTier: "member", creatorDeviceId: PHONE },
          { inviteId: "b", serviceRef: SERVICE, creatorTier: "admin", creatorDeviceId: null },
          { inviteId: "c", serviceRef: SERVICE },
          { inviteId: "d", serviceRef: SERVICE, creatorTier: "root", creatorDeviceId: "xyz" },
        ],
      }),
    );
    const rows = await si.listInvites(
      {
        comBase: "https://flagshipserver.com",
        username: "alice",
        authorAID: new Uint8Array(32),
        householdKey: null,
        serviceRef: SERVICE,
        umk: new Uint8Array(32),
        signWithAccountId: async () => new Uint8Array(64),
      },
      { fetch },
    );
    expect(rows.map((r: { creatorTier: unknown; creatorDeviceId: unknown }) => [r.creatorTier, r.creatorDeviceId])).toEqual([
      ["member", PHONE],
      ["admin", null],
      [null, null],
      [null, null],
    ]);
  });

  it("reads each invite's and grant's tier from the box", async () => {
    const mr = await load("lib/memberRoles.js");
    const members = await mr.fetchMembers(SERVICE, {
      fetchJson: async () => ({
        mode: "open",
        members: [{ aid: "aa".repeat(32), role: "member", grants: [{ inviteId: "a", role: "member", tier: "member" }, { inviteId: "z", role: "master" }] }],
        invites: [{ inviteId: "a", role: "member", set: false, tier: "member" }, { inviteId: "b", role: "master", set: true, tier: "admin" }, { inviteId: "c", role: "member", set: false, tier: null }],
      }),
    });
    expect(members.members[0].grants.map((g: { tier: unknown }) => g.tier)).toEqual(["member", null]);
    expect(mr.inviteTier("a", members)).toBe("member");
    expect(mr.inviteTier("b", members)).toBe("admin");
    expect(mr.inviteTier("c", members)).toBeNull();
    expect(mr.inviteTier("nope", members)).toBeNull();
  });
});

describe("rank picker and revoke rules", () => {
  it("a non-admin device may give only Member, with the one-line why", async () => {
    const mr = await load("lib/memberRoles.js");
    expect(mr.ADMIN_ONLY_RANK_NOTE).toBe("Only an admin device can give a higher rank");
    expect(mr.addableRoles(false)).toEqual(["member"]);
    expect(mr.addableRoles(true)).toEqual(["member", "manager", "master"]);
    expect(mr.isAdminDevice({ adminRootSeed: new Uint8Array(32) })).toBe(true);
    expect(mr.isAdminDevice({ adminRootSeed: null })).toBe(false);
    expect(mr.isAdminDevice(null)).toBe(false);

    const src = readFileSync(join(WEBAPP, "views/service-access.js"), "utf8");
    expect(src).toContain('<p id="sa-rank-locked" class="note mt-1 hidden">${escapeHtml(ADMIN_ONLY_RANK_NOTE)}</p>');
    expect(src).toContain("roleSel.disabled = !admin;");
    // No role order after a non-admin create; the box keeps it at Member.
    expect(src).toContain("if (admin && role !== (lastMembers?.defaultRole ?? null))");
  });

  it("revoke: an admin any row, others only their own member invites while manager-class", async () => {
    const mr = await load("lib/memberRoles.js");
    const own = { creatorTier: "member", creatorDeviceId: THIS_DEVICE };
    const otherMember = { creatorTier: "member", creatorDeviceId: PHONE };
    const adminInvite = { creatorTier: "admin", creatorDeviceId: THIS_DEVICE };
    const old = { creatorTier: null, creatorDeviceId: null };
    for (const row of [own, otherMember, adminInvite, old]) {
      expect(mr.canRevokeInvite(row, { isAdmin: true, deviceId: THIS_DEVICE })).toBe(true);
    }
    const manager = { isAdmin: false, deviceId: THIS_DEVICE, managerClass: true };
    expect(mr.canRevokeInvite(own, manager)).toBe(true);
    expect(mr.canRevokeInvite(otherMember, manager)).toBe(false);
    expect(mr.canRevokeInvite(adminInvite, manager)).toBe(false);
    expect(mr.canRevokeInvite(old, manager)).toBe(false);
    expect(mr.canRevokeInvite({ creatorTier: "member", creatorDeviceId: null }, { ...manager, deviceId: "" })).toBe(false);
    // Demoted below manager (or refused): no withdraw, even of its own.
    expect(mr.canRevokeInvite(own, { ...manager, managerClass: false })).toBe(false);
    // The box's record of the creating key also names it.
    const pub = "77".repeat(32);
    const members = { invites: [{ inviteId: "inv-x", creatorPub: pub, creatorDeviceId: null }] };
    const unnamed = { inviteId: "inv-x", creatorTier: "member", creatorDeviceId: null };
    expect(mr.canRevokeInvite(unnamed, { ...manager, devicePub: pub, members })).toBe(true);
    expect(mr.canRevokeInvite(unnamed, { ...manager, devicePub: "88".repeat(32), members })).toBe(false);
  });

  it("rows show the rank read-only and no rank menu on a non-admin device", async () => {
    const view = await load("views/service-access.js");
    const members = {
      defaultRole: "member",
      members: [],
      invites: [{ inviteId: "inv-sam", role: "master", set: true, tier: "admin" }, { inviteId: "inv-mine", role: "member", set: false, tier: "member" }],
    };
    const sam = { inviteId: "inv-sam", bundle: { name: "Sam" }, boundAID: null, maxRedemptions: null, creatorTier: "admin", creatorDeviceId: PHONE };
    const mine = { inviteId: "inv-mine", bundle: { name: "Lee" }, boundAID: null, maxRedemptions: null, creatorTier: "member", creatorDeviceId: THIS_DEVICE };
    const names = new Map([[PHONE, "Alice's iPhone"]]);
    const member = { isAdmin: false, deviceId: THIS_DEVICE, managerClass: true, deviceNames: names };
    const admin = { isAdmin: true, deviceId: THIS_DEVICE, deviceNames: names };
    const label = () => "";

    const samMember = view.peopleRowHtml(sam, members, label, member);
    expect(samMember).not.toContain('data-action="sa-role"');
    expect(samMember).toContain('<span class="sa-rank" data-rank="master">Master</span>');
    expect(samMember).toContain("sa-crown");
    expect(samMember).not.toContain('data-action="sa-remove"');
    expect(samMember).toContain("Invited by Alice's iPhone");

    const mineMember = view.peopleRowHtml(mine, members, label, member);
    expect(mineMember).toContain('data-action="sa-remove"');
    expect(mineMember).toContain("Invited by this device");

    const samAdmin = view.peopleRowHtml(sam, members, label, admin);
    expect(samAdmin).toContain('select data-action="sa-role"');
    expect(samAdmin).toContain('data-action="sa-remove"');
    expect(samAdmin).not.toContain("sa-rank");
  });
});

describe("Invited by", () => {
  it("names the device from the directory, with fallbacks", async () => {
    const mr = await load("lib/memberRoles.js");
    const deviceNames = new Map([[PHONE, "Kitchen iPad"]]);
    const ctx = { deviceId: THIS_DEVICE, deviceNames };
    expect(mr.invitedByText({ creatorTier: "member", creatorDeviceId: PHONE }, ctx)).toBe("Invited by Kitchen iPad");
    expect(mr.invitedByText({ creatorTier: "member", creatorDeviceId: THIS_DEVICE }, ctx)).toBe("Invited by this device");
    expect(mr.invitedByText({ creatorTier: "admin", creatorDeviceId: "0".repeat(32) }, ctx)).toBe("Invited by another device");
    expect(mr.invitedByText({ creatorTier: "admin", creatorDeviceId: null }, ctx)).toBe("Invited by another device");
    // No directory access: still this device for its own, another device otherwise.
    expect(mr.invitedByText({ creatorTier: "member", creatorDeviceId: PHONE }, { deviceId: THIS_DEVICE, deviceNames: null })).toBe("Invited by another device");
    expect(mr.invitedByText({ creatorTier: "member", creatorDeviceId: THIS_DEVICE }, { deviceId: THIS_DEVICE, deviceNames: null })).toBe("Invited by this device");
    // Rows from before creators were recorded say nothing.
    expect(mr.invitedByText({ creatorTier: null, creatorDeviceId: null }, ctx)).toBe("");
    expect(mr.invitedByText({}, ctx)).toBe("");
  });

  it("reads the directory once and falls back quietly when it can't", async () => {
    const mr = await load("lib/memberRoles.js");
    const fetchDirectory = vi.fn(async () => ({
      devices: [
        { deviceId: PHONE, displayName: "Kitchen iPad" },
        { deviceId: THIS_DEVICE, displayName: null },
      ],
    }));
    const names = mr.deviceNameResolver(fetchDirectory);
    const first = await names();
    expect(first.get(PHONE)).toBe("Kitchen iPad");
    expect(first.has(THIS_DEVICE)).toBe(false);
    expect(await names()).toBe(first);
    expect(fetchDirectory).toHaveBeenCalledTimes(1);

    const refused = vi.fn(async () => {
      throw new Error("Couldn't fetch trusted devices (403)");
    });
    const none = mr.deviceNameResolver(refused);
    expect(await none()).toBeNull();
    expect(await none()).toBeNull();
    expect(refused).toHaveBeenCalledTimes(1);

    const throwsSync = mr.deviceNameResolver(() => {
      throw new Error("unlock this account first");
    });
    expect(await throwsSync()).toBeNull();
  });

  it("the view resolves names through the account directory, cached per account and device", () => {
    const src = readFileSync(join(WEBAPP, "views/service-access.js"), "utf8");
    expect(src).toContain('import { fetchDecryptedDirectory } from "../lib/accountDirectory.js"');
    expect(src).toContain("deviceNameResolver(() => fetchDecryptedDirectory())");
    expect(src).toContain("loadDeviceNames(),");
    expect(src).toContain('class="muted-sm text-xs sa-invited-by"');
  });
});

describe("invite-created push", () => {
  function buildSandbox() {
    const listeners = new Map<string, Function[]>();
    const shown: Array<{ title: string; opts: Record<string, any> }> = [];
    const opened: string[] = [];
    const self: any = {
      location: { origin: "https://webapp.flagshipserver.com" },
      addEventListener: (type: string, cb: Function) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      skipWaiting: () => {},
      clients: {
        claim: () => {},
        matchAll: async () => [],
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
      registration: {
        showNotification: (title: string, opts: Record<string, unknown>) => {
          shown.push({ title, opts });
          return Promise.resolve();
        },
      },
      fetch: async () => new Response(null, { status: 200 }),
    };
    const ctx: any = {
      self, addEventListener: self.addEventListener, fetch: self.fetch, Response, URL, Headers, Map, Set, Date,
      Promise, Error, Array, Object, JSON, console: { log: () => {}, warn: () => {} }, setTimeout, clearTimeout,
      Request, crypto,
      caches: { open: async () => ({ put: async () => {} }), keys: async () => [], delete: async () => {}, match: async () => undefined },
    };
    vm.createContext(ctx);
    vm.runInContext(readFileSync(join(WEBAPP, "service-worker.js"), "utf8"), ctx, { filename: "service-worker.js" });
    return { listeners, shown, opened };
  }

  function fire(listeners: Map<string, Function[]>, type: string, event: Record<string, unknown>) {
    const promises: Promise<unknown>[] = [];
    const e = { ...event, waitUntil: (p: Promise<unknown>) => promises.push(p) };
    for (const cb of listeners.get(type) ?? []) cb(e);
    return Promise.all(promises);
  }

  const TEXT = "A device on your account invited someone to one of your apps.";
  const LINK = "https://flagshipserver.com/app/account/activity";

  it("shows the content-free notice and opens the account activity", async () => {
    const { listeners, shown, opened } = buildSandbox();
    const payload = { category: "invite-created", body: TEXT, kind: "invite-created", deepLink: LINK };
    await fire(listeners, "push", { data: { json: () => payload } });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Flagship");
    expect(shown[0]!.opts.body).toBe(TEXT);
    expect(shown[0]!.opts.data.kind).toBe("invite-created");
    await fire(listeners, "notificationclick", { notification: { close: () => {}, data: shown[0]!.opts.data } });
    expect(opened).toEqual(["https://webapp.flagshipserver.com/?view=account-audit"]);
  });

  it("a category-only push gets the same text", async () => {
    const { listeners, shown } = buildSandbox();
    await fire(listeners, "push", { data: { json: () => ({ category: "invite-created" }) } });
    expect(shown[0]!.opts.body).toBe(TEXT);
  });

  it("routes the app/account/activity link (https and flagship://) to the activity view", async () => {
    for (const deepLink of [LINK, "flagship://account/activity"]) {
      const { listeners, opened } = buildSandbox();
      await fire(listeners, "notificationclick", { notification: { close: () => {}, data: { deepLink } } });
      expect(opened).toEqual(["https://webapp.flagshipserver.com/?view=account-audit"]);
    }
  });

  it("the cold-start dispatcher opens the account activity for ?view=account-audit", () => {
    const src = readFileSync(join(WEBAPP, "lib/deepLink.js"), "utf8");
    expect(src).toMatch(/q\.view === "view-account-audit"[\s\S]{0,160}enterAccountAudit\(\)/);
  });
});

describe("audit log", () => {
  it("labels invite-created with an icon and shows its detail", async () => {
    const audit = await load("lib/auditLog.js");
    expect(audit.auditKindLabel("invite-created")).toBe("Someone was invited to an app");
    expect(audit.auditKindIcon("invite-created")).not.toBe("•");
    expect(
      audit.auditDisplayDetail({ eventKind: "invite-created", detail: "A device on your account invited someone to one of your apps." }),
    ).toBe("A device on your account invited someone to one of your apps.");
  });
});

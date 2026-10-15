// Account members (docs/service-access-gating.md, "Account members, ranks and
// who may change them"): the Access control screen lists this account's
// devices (names decrypted on this device) and the co-managing accounts, each
// with a rank. Admin devices get a rank menu and Refuse per row; any other
// device finds itself by its account device key and may invite (at Member)
// only while manager-class there, else it sees why. Withdraws reach the box
// too, signed with the same revoke.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveAccountDeviceKeySeed, ed, verifyRevokeServiceInvite } from "@flagship/protocol";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const load = async (rel: string) =>
  import(pathToFileURL(join(WEBAPP, rel)).href + `?t=${Math.random().toString(36).slice(2)}`);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const ACCOUNT_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const THIS_DEVICE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PHONE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const THIS_PUB = "11".repeat(32);
const PHONE_PUB = "22".repeat(32);
const SHARE = "0123456789abcdef0123456789abcdef";

function boxList(myRank: string | null, { refused = false, listed = true } = {}) {
  return {
    mode: "open",
    roles: ["member", "manager", "master"],
    defaultRole: "member",
    accountMembers: [
      ...(listed ? [{ kind: "device", deviceId: THIS_DEVICE, devicePub: THIS_PUB, tier: "member", rank: myRank, set: myRank !== "manager", refused }] : []),
      { kind: "device", deviceId: PHONE, devicePub: PHONE_PUB, tier: "admin", rank: "master", set: false, refused: false },
      { kind: "co-manager", shareId: SHARE, label: "Mum", rank: "manager", set: false, refused: false },
    ],
    members: [],
    invites: [],
  };
}

describe("finding this device and what it may do", () => {
  it("finds itself by its account device key, else its device id", async () => {
    const mr = await load("lib/memberRoles.js");
    const members = mr.normalizeMembers(boxList("manager"));
    expect(mr.myAccountMember(members, { devicePub: THIS_PUB.toUpperCase() })?.deviceId).toBe(THIS_DEVICE);
    expect(mr.myAccountMember(members, { devicePub: "", deviceId: PHONE })?.devicePub).toBe(PHONE_PUB);
    expect(mr.myAccountMember(members, { devicePub: "33".repeat(32), deviceId: "" })).toBeNull();
    expect(mr.myAccountMember(null, { devicePub: THIS_PUB })).toBeNull();
  });

  it("admin: any rank; manager-class: Member only; below manager, refused or unknown: why not", async () => {
    const mr = await load("lib/memberRoles.js");
    const me = (list: unknown) => mr.myAccountMember(mr.normalizeMembers(list), { devicePub: THIS_PUB });
    const ability = (list: ReturnType<typeof boxList> | null, isAdmin = false) =>
      mr.inviteAbility({ isAdmin, members: list ? mr.normalizeMembers(list) : null, me: list ? me(list) : null });

    expect(ability(boxList("member"), true)).toEqual({ canInvite: true, roles: ["member", "manager", "master"], why: "" });
    expect(ability(boxList("manager"))).toEqual({ canInvite: true, roles: ["member"], why: "" });
    expect(ability(boxList("master"))).toEqual({ canInvite: true, roles: ["member"], why: "" });
    // A legacy "owner" reads as master.
    expect(ability(boxList("owner")).canInvite).toBe(true);
    expect(ability(boxList("member"))).toEqual({ canInvite: false, roles: [], why: "Only an admin can let you invite people to this app." });
    expect(ability(boxList(null, { refused: true })).why).toBe(mr.INVITE_NEEDS_MANAGER_NOTE);
    expect(ability(boxList("manager", { listed: false })).why).toBe(mr.DEVICE_NOT_LISTED_NOTE);
    expect(ability(null).why).toBe(mr.RANKS_UNKNOWN_NOTE);
    expect(mr.isManagerClass("manager") && mr.isManagerClass("master") && !mr.isManagerClass("member")).toBe(true);
  });

  it("names a row from the decrypted directory, the owner's label or a generic name; never sends names", async () => {
    const mr = await load("lib/memberRoles.js");
    const [mine, phone, mum] = mr.normalizeMembers(boxList("manager")).accountMembers;
    const deviceNames = new Map([[PHONE, "Kitchen iPad"]]);
    expect(mr.accountMemberName(phone, { deviceNames })).toBe("Kitchen iPad");
    expect(mr.accountMemberName(mine, { deviceNames })).toBe("Device a1b2c3d4");
    expect(mr.accountMemberName(phone, { deviceNames: null })).toBe("Device f0e1d2c3");
    expect(mr.accountMemberName(mum, {})).toBe("Mum");
    expect(mr.accountMemberLine(mine, { devicePub: THIS_PUB })).toBe("This device · Device on your account");
    expect(mr.accountMemberLine(phone, { devicePub: THIS_PUB })).toBe("Admin device");
    expect(mr.accountMemberLine(mum, { devicePub: THIS_PUB })).toBe("Co-manages this server");
    expect(mr.accountMemberTarget(phone)).toBe(`device:${PHONE_PUB}`);
    expect(mr.accountMemberTarget(mum)).toBe(`share:${SHARE}`);
  });

  it("drops malformed account members and reads a refused one with no rank", async () => {
    const mr = await load("lib/memberRoles.js");
    const n = mr.normalizeMembers({
      accountMembers: [
        { kind: "device", deviceId: THIS_DEVICE, devicePub: "zz", rank: "manager" },
        { kind: "co-manager", shareId: "short", rank: "manager" },
        { kind: "robot", rank: "master" },
        { kind: "device", deviceId: THIS_DEVICE, devicePub: THIS_PUB, tier: "member", rank: null, set: true, refused: true },
      ],
    });
    expect(n.accountMembers).toEqual([
      { kind: "device", deviceId: THIS_DEVICE, devicePub: THIS_PUB, tier: "member", rank: null, set: true, refused: true },
    ]);
  });
});

describe("Account members rows", () => {
  const deviceNames = new Map([[PHONE, "Kitchen iPad"]]);

  it("an admin device gets a rank menu (Member, Manager, Master) and Refuse; Master wears the crown", async () => {
    const mr = await load("lib/memberRoles.js");
    const view = await load("views/service-access.js");
    const [mine, phone, mum] = mr.normalizeMembers(boxList("manager")).accountMembers;
    const ctx = { isAdmin: true, devicePub: THIS_PUB, deviceNames };
    const phoneRow = view.accountMemberRowHtml(phone, ctx);
    expect(phoneRow).toContain("Kitchen iPad");
    expect(phoneRow).toContain(`select data-action="sa-acct-rank" data-target="device:${PHONE_PUB}" data-current="master"`);
    expect(phoneRow).toContain('<option value="master" selected');
    expect(phoneRow.match(/<option /g)).toHaveLength(3);
    expect(phoneRow).not.toContain('value="owner"');
    expect(phoneRow).toContain('data-action="sa-acct-refuse"');
    expect(phoneRow).toContain("sa-crown");
    expect(view.accountMemberRowHtml(mine, ctx)).toContain("This device");
    const mumRow = view.accountMemberRowHtml(mum, ctx);
    expect(mumRow).toContain(`data-target="share:${SHARE}"`);
    expect(mumRow).toContain("Co-manages this server");
  });

  it("a refused row says Refused; an admin un-refuses by picking a rank", async () => {
    const mr = await load("lib/memberRoles.js");
    const view = await load("views/service-access.js");
    const [mine] = mr.normalizeMembers(boxList(null, { refused: true })).accountMembers;
    const admin = view.accountMemberRowHtml(mine, { isAdmin: true, devicePub: "", deviceNames });
    expect(admin).toContain('<option value="refused" selected disabled>Refused</option>');
    expect(admin).toContain('<option value="member"');
    expect(admin).not.toContain('data-action="sa-acct-refuse"');
    const member = view.accountMemberRowHtml(mine, { isAdmin: false, devicePub: THIS_PUB, deviceNames });
    expect(member).toContain('<span class="sa-rank" data-rank="refused">Refused</span>');
    expect(member).not.toContain("sa-crown");
  });

  it("other devices see every rank read-only, with no menu and no Refuse", async () => {
    const mr = await load("lib/memberRoles.js");
    const view = await load("views/service-access.js");
    const [, phone] = mr.normalizeMembers(boxList("manager")).accountMembers;
    const html = view.accountMemberRowHtml(phone, { isAdmin: false, devicePub: THIS_PUB, deviceNames });
    expect(html).toContain('<span class="sa-rank" data-rank="master">Master</span>');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("sa-acct-refuse");
  });

  it("the view gates the mode toggle, the add buttons and Refuse on the admin root", () => {
    const src = readFileSync(join(WEBAPP, "views/service-access.js"), "utf8");
    expect(src).toContain('<p id="sa-mode-locked" class="note mt-1">${escapeHtml(ADMIN_ONLY_MODE_NOTE)}</p>');
    expect(src).toContain('<p id="sa-add-why" class="note hidden"></p>');
    expect(src).toContain('$("sa-add-row")?.classList.toggle("hidden", !ability.canInvite);');
    expect(src).toContain("if (!isAdminDevice(getSession())) return;");
    expect(src).toContain("await sendRank(serviceRef, btn.getAttribute(\"data-target\"), RANK_REFUSED);");
  });
});

describe("signing with this device's key and withdrawing on the box", () => {
  it("signWithAccountDeviceKey is the account device key @flagship/protocol derives", async () => {
    const ks = await load("keystore.js");
    const umk = new Uint8Array(32).fill(0x2a);
    const bytes = new TextEncoder().encode("flagship/service-invite/revoke/v1|inv|1");
    const sig = await ks.signWithAccountDeviceKey(umk, ACCOUNT_ID, THIS_DEVICE, bytes);
    const pub = ed.getPublicKey(deriveAccountDeviceKeySeed(umk, ACCOUNT_ID, THIS_DEVICE));
    expect(ed.verify(sig, bytes, pub)).toBe(true);
    expect(hex((await ks.deriveAccountDeviceKeyFromSeed(umk, ACCOUNT_ID, THIS_DEVICE)).publicKey)).toBe(hex(pub));
  });

  it("revokeInvite resolves the signed revoke; withdrawInviteOnBox posts that same revoke to the box", async () => {
    const si = await load("lib/serviceInvite.js");
    const ks = await load("keystore.js");
    const umk = new Uint8Array(32).fill(0x2a);
    const sign = (u: Uint8Array, b: Uint8Array) => ks.signWithAccountDeviceKey(u, ACCOUNT_ID, THIS_DEVICE, b);
    const com = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ revoked: true }) }));
    const r = await si.revokeInvite(
      { comBase: "https://flagshipserver.com", username: "alice", inviteId: "inv-1", umk, signWithAccountId: sign },
      { fetch: com, now: () => 1_700_000_000_000 },
    );
    expect(r.revoke).toEqual({ inviteId: "inv-1", issuedAt: 1_700_000_000_000 });
    const pub = ed.getPublicKey(deriveAccountDeviceKeySeed(umk, ACCOUNT_ID, THIS_DEVICE));
    expect(verifyRevokeServiceInvite(r.revoke, Buffer.from(r.signature, "hex"), pub)).toBe(true);

    const sent: Array<{ url: string; body: unknown }> = [];
    const box = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ ok: true, pruned: 2 }) };
    });
    const w = await si.withdrawInviteOnBox(
      { baseUrl: "https://home.alice.flagship.services", revoke: r.revoke, signature: r.signature },
      { fetch: box },
    );
    expect(w).toEqual({ ok: true, pruned: 2 });
    expect(sent).toEqual([
      { url: "https://home.alice.flagship.services/api/service-access/invite-withdraw", body: { revoke: r.revoke, signature: r.signature } },
    ]);
    const refused = vi.fn(async () => ({ ok: false, status: 403, text: async () => "only an admin" }));
    await expect(
      si.withdrawInviteOnBox({ baseUrl: "https://home.alice.flagship.services", revoke: r.revoke, signature: r.signature }, { fetch: refused }),
    ).rejects.toMatchObject({ code: "403" });
  });
});

describe("app page on a device without the admin root", () => {
  it("Runs on says only an admin device can change where the app runs", async () => {
    const p = await load("lib/appPlacement.js");
    expect(p.runsOnHtml([], { adminOnly: true })).toContain(p.RUNS_ON_ADMIN_ONLY);
    expect(p.RUNS_ON_ADMIN_ONLY).toBe("Only an admin device can change where this app runs.");
    expect(p.runsOnHtml([], {})).toContain(p.RUNS_ON_NOTE);
  });
});

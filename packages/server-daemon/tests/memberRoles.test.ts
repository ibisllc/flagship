import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  signAppRank,
  signAppDbWriteGrant,
  type AppRankOrder,
} from "@flagship/protocol";
import { buildMemberRolesHttp, offeredRoles } from "../src/memberRoles.js";
import { ServiceAccessStore } from "../src/serviceAccess.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice-notes";
const NOW = 1_700_000_000_000;
const OWNER_AID = "0a".repeat(32);
const FRIEND = "f1".repeat(32);
const OTHER = "e2".repeat(32);

const ownerIrk = deriveIRK({ seed: new Uint8Array(32).fill(0x2a) });
const strangerIrk = deriveIRK({ seed: new Uint8Array(32).fill(0x55) });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const manifest = {
  access: {
    enabled: true as const,
    default_role: "manager" as const,
    custom_roles: ["coach"],
    role_descriptions: { member: "Plays", master: "Runs the club" },
  },
};
const noGrants = { grants: [], direct: null };

async function harness(opts: { installed?: boolean; now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "roles-"));
  const store = new ServiceAccessStore(join(dir, "service-access.json"), { ownerAidHex: OWNER_AID });
  await store.load();
  await store.addAllowed(SERVICE, FRIEND);
  const handle = buildMemberRolesHttp({
    serverDomain: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    username: "alice",
    store,
    app: (id) => (id === SERVICE && opts.installed !== false ? { manifest } : null),
    now: () => opts.now ?? NOW,
  });
  return { store, handle, dir };
}

function order(over: Partial<AppRankOrder> = {}): AppRankOrder {
  return { serviceRef: SERVICE, target: `aid:${FRIEND}`, rank: "master", issuedAt: NOW, ...over };
}

function post(o: AppRankOrder, sig: Uint8Array, service = SERVICE): HttpRequest {
  return {
    method: "POST",
    path: `/api/screens/services/${service}/members/rank`,
    headers: {},
    body: Buffer.from(JSON.stringify({ order: o, signature: hex(sig) })),
  };
}

const get: HttpRequest = { method: "GET", path: `/api/screens/services/${SERVICE}/members`, headers: {}, body: Buffer.alloc(0) };

describe("members list", () => {
  it("lists members with the app's default role, the roles on offer and the mode", async () => {
    const { handle } = await harness();
    const r = await handle(get.path, "GET", get);
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r!.body))).toEqual({
      serviceId: SERVICE,
      mode: "open",
      roles: ["member", "manager", "master"],
      defaultRole: "manager",
      descriptions: { member: "Plays", master: "Runs the club" },
      accountMembers: [],
      members: [{ aid: FRIEND, role: "manager", ...noGrants }],
      invites: [],
    });
  });

  it("offers the three ranks only (never owner or app-made roles), and gives an owner default as master", () => {
    expect(offeredRoles({ access: { enabled: true, default_role: "owner", custom_roles: ["owner", "dj"] } })).toEqual({
      roles: ["member", "manager", "master"],
      defaultRole: "master",
      descriptions: {},
    });
    expect(offeredRoles(null)).toEqual({ roles: ["member", "manager", "master"], defaultRole: "member", descriptions: {} });
  });

  it("404s an app that isn't installed here", async () => {
    const { handle } = await harness({ installed: false });
    expect((await handle(get.path, "GET", get))?.status).toBe(404);
  });
});

describe("setting a role", () => {
  it("applies an owner-signed order and the member's role follows it", async () => {
    const { handle, store } = await harness();
    const o = order();
    const r = await handle(post(o, signAppRank(o, ownerIrk)).path, "POST", post(o, signAppRank(o, ownerIrk)));
    expect(r?.status).toBe(200);
    expect(store.roleOf(SERVICE, FRIEND, "member")).toBe("master");
    const list = JSON.parse(String((await handle(get.path, "GET", get))!.body));
    expect(list.members).toEqual([{ aid: FRIEND, role: "master", grants: [], direct: "master" }]);
  });

  it("refuses anyone but the owner, another order's signature, another app, and stale orders", async () => {
    const { handle, store } = await harness();
    const o = order();
    const send = (oo: AppRankOrder, sig: Uint8Array) => handle(post(oo, sig).path, "POST", post(oo, sig));
    expect((await send(o, signAppRank(o, strangerIrk)))?.status).toBe(403);
    const dbSig = signAppDbWriteGrant(
      { serverDomain: FQDN, serviceId: SERVICE, store: "default", sqlSha256: "ab".repeat(32), issuedAt: NOW },
      ownerIrk,
    );
    expect((await send(o, dbSig))?.status).toBe(403);
    const otherApp = order({ serviceRef: "alice-chess" });
    const r = await handle(post(otherApp, signAppRank(otherApp, ownerIrk)).path.replace("alice-chess", SERVICE), "POST", post(otherApp, signAppRank(otherApp, ownerIrk)));
    expect(r?.status).toBe(400);
    const old = order({ issuedAt: NOW - 11 * 60_000 });
    expect((await send(old, signAppRank(old, ownerIrk)))?.status).toBe(403);
    expect(store.roleOf(SERVICE, FRIEND, "member")).toBeNull();
  });

  it("gives ladder roles only, never owner, and only to members", async () => {
    const { handle } = await harness();
    const send = (oo: AppRankOrder) => {
      const sig = signAppRank(oo, ownerIrk);
      return handle(post(oo, sig).path, "POST", post(oo, sig));
    };
    // A role off the ladder can't even be signed; a forged body is refused.
    expect(() => signAppRank(order({ rank: "coach" }), ownerIrk)).toThrow();
    const forged = post(order(), signAppRank(order(), ownerIrk));
    forged.body = Buffer.from(String(forged.body).replace('"master"', '"coach"'));
    expect((await handle(forged.path, "POST", forged))?.status).toBe(400);
    expect((await send(order({ rank: "manager" })))?.status).toBe(200);
    expect((await send(order({ target: `aid:${OTHER}`, issuedAt: NOW + 1 })))?.status).toBe(422);
    expect((await send(order({ target: `aid:${OWNER_AID}`, issuedAt: NOW + 2 })))?.status).toBe(422);
  });

  it("refuses a replayed or older order for the same target", async () => {
    const { handle, store } = await harness();
    const send = (oo: AppRankOrder) => {
      const sig = signAppRank(oo, ownerIrk);
      return handle(post(oo, sig).path, "POST", post(oo, sig));
    };
    expect((await send(order({ rank: "member", issuedAt: NOW + 5 })))?.status).toBe(200);
    expect((await send(order({ rank: "member", issuedAt: NOW + 5 })))?.status).toBe(409);
    expect((await send(order({ rank: "master", issuedAt: NOW + 4 })))?.status).toBe(409);
    expect(store.roleOf(SERVICE, FRIEND, "member")).toBe("member");
  });

  it("every invite is a grant; a person has the highest of their grants, and losing one leaves the others", async () => {
    const { handle, store, dir } = await harness();
    const send = (oo: AppRankOrder) => {
      const sig = signAppRank(oo, ownerIrk);
      return handle(post(oo, sig).path, "POST", post(oo, sig));
    };
    // A group link at viewer, a personal invite at admin, both for OTHER.
    expect((await send(order({ target: "invite:family", rank: "member" })))?.status).toBe(200);
    await store.addAllowed(SERVICE, OTHER, "family");
    expect(store.roleOf(SERVICE, OTHER, "member")).toBe("member");
    expect((await send(order({ target: "invite:sam-1", rank: "master", issuedAt: NOW + 1 })))?.status).toBe(200);
    await store.addAllowed(SERVICE, OTHER, "sam-1");
    expect(store.roleOf(SERVICE, OTHER, "member")).toBe("master");
    const list = JSON.parse(String((await handle(get.path, "GET", get))!.body));
    expect(list.members.find((m: { aid: string }) => m.aid === OTHER)).toEqual({
      aid: OTHER,
      role: "master",
      grants: [
        { inviteId: "family", role: "member", tier: null },
        { inviteId: "sam-1", role: "master", tier: null },
      ],
      direct: null,
    });
    // Persisted, and reloaded the same.
    const again = new ServiceAccessStore(join(dir, "service-access.json"), { ownerAidHex: OWNER_AID });
    await again.load();
    expect(again.roleOf(SERVICE, OTHER, "member")).toBe("master");
    expect(JSON.parse(readFileSync(join(dir, "service-access.json"), "utf8"))[SERVICE].roles.invites).toEqual({
      family: "member",
      "sam-1": "master",
    });
    // One person's join through the group is its own grant with its own role.
    expect((await send(order({ target: `grant:family/${OTHER}`, rank: "manager", issuedAt: NOW + 2 })))?.status).toBe(200);
    expect(store.grantRole(SERVICE, "family", OTHER, "member")).toBe("manager");
    expect(store.inviteRole(SERVICE, "family", "member")).toBe("member");
    // A grant someone doesn't hold is refused.
    expect((await send(order({ target: `grant:other-link/${OTHER}`, rank: "manager", issuedAt: NOW + 3 })))?.status).toBe(422);
    expect((await send(order({ target: `grant:family/${OTHER}`, rank: "member", issuedAt: NOW + 4 })))?.status).toBe(200);
    // Revoking the personal invite leaves the group: still a member, now viewer.
    await store.revokeGroup("sam-1", SERVICE);
    expect(store.isAllowed(SERVICE, OTHER)).toBe(true);
    expect(store.roleOf(SERVICE, OTHER, "member")).toBe("member");
    // An unset grant counts as the app's default.
    await store.addAllowed(SERVICE, OTHER, "unset-link");
    expect(store.roleOf(SERVICE, OTHER, "manager")).toBe("manager");
    // Revoking the last grants ends membership.
    await store.revokeGroup("family", SERVICE);
    await store.revokeGroup("unset-link", SERVICE);
    expect(store.isAllowed(SERVICE, OTHER)).toBe(false);
  });

  it("removing a member drops their role; revoking a group drops its role", async () => {
    const { handle, store } = await harness();
    const send = (oo: AppRankOrder) => {
      const sig = signAppRank(oo, ownerIrk);
      return handle(post(oo, sig).path, "POST", post(oo, sig));
    };
    await send(order({ rank: "master" }));
    await store.removeAllowed(SERVICE, FRIEND);
    expect(store.roleOf(SERVICE, FRIEND, "viewer")).toBeNull();
    await send(order({ target: "invite:grp-2", rank: "member", issuedAt: NOW + 1 }));
    await store.addAllowed(SERVICE, OTHER, "grp-2");
    await store.revokeGroup("grp-2", SERVICE);
    expect(store.roleOf(SERVICE, OTHER, "viewer")).toBeNull();
    expect(store.roles(SERVICE).invites).toEqual({});
    // The poller's per-AID fallback keeps someone who still holds a grant.
    await store.addAllowed(SERVICE, OTHER, "grp-3");
    expect(await store.removeIfUngranted(SERVICE, OTHER)).toBe(false);
    expect(store.isAllowed(SERVICE, OTHER)).toBe(true);
  });

  it("copies roles with the app, keeping only the copied members'", async () => {
    const { handle, store } = await harness();
    const sig = signAppRank(order(), ownerIrk);
    await handle(post(order(), sig).path, "POST", post(order(), sig));
    const exported = store.exportEntry(SERVICE)!;
    const target = new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "roles-t-")), "s.json"));
    await target.importEntry(SERVICE, { ...exported, roles: { ...exported.roles, aids: { ...exported.roles.aids, [OTHER]: "viewer" } } });
    expect(target.roleOf(SERVICE, FRIEND, "viewer")).toBe("master");
    expect(target.roleOf(SERVICE, OTHER, "viewer")).toBeNull();
    // A copy from a box without roles still imports.
    const plain = new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "roles-p-")), "s.json"));
    await plain.importEntry(SERVICE, { mode: "open", allow: [FRIEND], groups: {} });
    expect(plain.roleOf(SERVICE, FRIEND, "viewer")).toBeNull();
  });
});

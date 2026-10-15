// Access control ranks (docs/service-access-gating.md, "Account members, ranks
// and who may change them"): the webapp's admin-only access orders against THE
// reference vectors (app-rank/v1, service-access-mode/v2,
// service-allow-remove/v2, signed by a raw Ed25519 seed standing in for the
// admin root), and the helpers that place each members-list row's rank and
// "also in" line.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ed } from "@flagship/protocol";

type Rank = { serviceRef: string; target: string; rank: string; issuedAt: number };
type Mode = { serviceRef: string; mode: string; issuedAt: number };
type Remove = { serviceRef: string; aid: string; issuedAt: number };
type Signed = { canonical: string; signature: string };
const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-access-orders/vectors.json"), "utf8"),
) as {
  signerSeedHex: string;
  signerPub: string;
  rank: { cases: Array<Rank & Signed>; invalid: Array<Rank & { why: string }> };
  mode: { cases: Array<Mode & Signed>; invalid: Array<Mode & { why: string }> };
  remove: { cases: Array<Remove & Signed>; invalid: Array<Remove & { why: string }> };
};

const webapp = (...p: string[]) => pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href;
const lib = () => import(webapp("lib", "memberRoles.js"));
const invites = () => import(webapp("lib", "serviceInvite.js"));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const POD = "https://home.harry.flagship.services";

/** A fetch that records the one request and answers ok. */
function recorder(answer: unknown) {
  const sent: Array<{ url: string; body: any }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true, json: async () => answer } as Response;
  };
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe("admin access orders (webapp) vs test-vectors/app-access-orders", () => {
  const seed = fromHex(V.signerSeedHex);
  const signer = async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, seed);

  it("the signer seed is the vectors' key", () => {
    expect(toHex(ed.getPublicKey(seed))).toBe(V.signerPub);
  });

  it.each(V.rank.cases.map((c, i) => [i, c] as const))("app-rank case #%i: canonical bytes + signature", async (_i, c) => {
    const m = await lib();
    const order = { serviceRef: c.serviceRef, target: c.target, rank: c.rank, issuedAt: c.issuedAt };
    expect(text(m.canonicalAppRankBytes(order))).toBe(c.canonical);
    expect(await m.signAppRank({ ...order, umk: new Uint8Array(32), signWithIrk: signer })).toEqual({ order, signature: c.signature });
  });

  it.each(V.rank.invalid.map((c) => [c.why, c] as const))("app-rank refuses: %s", async (_why, c) => {
    const m = await lib();
    expect(() => m.canonicalAppRankBytes(c)).toThrow();
  });

  it.each(V.mode.cases.map((c, i) => [i, c] as const))("access-mode/v2 case #%i: canonical bytes, signature, wire", async (_i, c) => {
    const si = await invites();
    const order = { serviceRef: c.serviceRef, mode: c.mode, issuedAt: c.issuedAt };
    const bytes = si.canonicalSetAccessModeV2Bytes(order);
    expect(text(bytes)).toBe(c.canonical);
    expect(toHex(ed.sign(bytes, seed))).toBe(c.signature);
    const r = recorder({ ok: true });
    await si.setServiceAccessMode(
      { baseUrl: POD, serviceRef: c.serviceRef, mode: c.mode, umk: new Uint8Array(32), signWithIrk: signer },
      { fetch: r.fetch, now: () => c.issuedAt },
    );
    expect(r.sent).toEqual([{ url: `${POD}/api/service-access`, body: { request: order, signature: c.signature } }]);
  });

  it.each(V.mode.invalid.map((c) => [c.why, c] as const))("access-mode/v2 refuses: %s", async (_why, c) => {
    const si = await invites();
    expect(() => si.canonicalSetAccessModeV2Bytes(c)).toThrow();
  });

  it.each(V.remove.cases.map((c, i) => [i, c] as const))("allow-remove/v2 case #%i: canonical bytes, signature, wire", async (_i, c) => {
    const si = await invites();
    const order = { serviceRef: c.serviceRef, aid: c.aid, issuedAt: c.issuedAt };
    const bytes = si.canonicalRemoveServiceAllowV2Bytes(order);
    expect(text(bytes)).toBe(c.canonical);
    expect(toHex(ed.sign(bytes, seed))).toBe(c.signature);
    const r = recorder({ ok: true, removed: true });
    await si.removeServiceAllow(
      { baseUrl: POD, serviceRef: c.serviceRef, aid: c.aid, umk: new Uint8Array(32), signWithIrk: signer },
      { fetch: r.fetch, now: () => c.issuedAt },
    );
    expect(r.sent).toEqual([{ url: `${POD}/api/service-access/allow-remove`, body: { request: order, signature: c.signature } }]);
  });

  it.each(V.remove.invalid.map((c) => [c.why, c] as const))("allow-remove/v2 refuses: %s", async (_why, c) => {
    const si = await invites();
    expect(() => si.canonicalRemoveServiceAllowV2Bytes(c)).toThrow();
  });

  it("setAppRank posts {order, signature} to the app's members/rank route", async () => {
    const m = await lib();
    const fetchJson = vi.fn(async () => ({ ok: true }));
    const c = V.rank.cases[0]!;
    await m.setAppRank({ serviceId: c.serviceRef, target: c.target, rank: c.rank, umk: new Uint8Array(32), signWithIrk: signer, fetchJson, now: () => c.issuedAt });
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(path).toBe(`/api/screens/services/${c.serviceRef}/members/rank`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      order: { serviceRef: c.serviceRef, target: c.target, rank: c.rank, issuedAt: c.issuedAt },
      signature: c.signature,
    });
  });

  it("the admin-only orders sign with the admin root on an admin device", async () => {
    const { SENSITIVE_TAGS } = await import(webapp("lib", "adminRoot.js"));
    for (const tag of ["flagship/app-rank/v1", "flagship/service-access-mode/v2", "flagship/service-allow-remove/v2", "flagship/uninstall-service/v1"]) {
      expect(SENSITIVE_TAGS.has(tag)).toBe(true);
    }
  });
});

describe("members-list helpers", () => {
  const SAM = "ab".repeat(32);
  const OLD = "cd".repeat(32);
  const members = {
    defaultRole: "member",
    descriptions: { manager: "Runs tournaments" },
    members: [
      { aid: SAM, role: "manager", grants: [{ inviteId: "sam", role: "manager" }, { inviteId: "family", role: "member" }], direct: null },
      { aid: OLD, role: "master", grants: [], direct: "master" },
    ],
    invites: [
      { inviteId: "sam", role: "manager", set: true },
      { inviteId: "family", role: "member", set: true },
    ],
  };

  it("a person's role is their invite's, and an untracked member is addressed by their id", async () => {
    const m = await lib();
    expect(m.rowRole({ inviteId: "sam", boundAID: SAM }, members)).toBe("manager");
    expect(m.roleTargetFor({ inviteId: "sam", boundAID: SAM }, members)).toBe("invite:sam");
    expect(m.rowRole({ inviteId: "old", boundAID: OLD }, members)).toBe("master");
    expect(m.roleTargetFor({ inviteId: "old", boundAID: OLD }, members)).toBe(`aid:${OLD}`);
    // Unused invite: the default until the owner picks one.
    expect(m.rowRole({ inviteId: "new", boundAID: null }, members)).toBe("member");
    expect(m.rowRole({ inviteId: "new", boundAID: null }, {})).toBe("member");
    expect(m.roleDescription("manager", members)).toBe("Runs tournaments");
    expect(m.roleDescription("master", members)).toBe("");
    expect(m.MEMBER_ROLES.map(m.roleLabel)).toEqual(["Member", "Manager", "Master"]);
  });

  it("reads 'Sam: Manager (also in Family: Member)'", async () => {
    const m = await lib();
    const others = m.otherGrants({ inviteId: "sam", boundAID: SAM }, members, (id: string) => (id === "family" ? "Family" : ""));
    expect(m.alsoInText(others)).toBe("also in Family: Member");
    expect(m.alsoInText([])).toBe("");
  });

  it("there is no owner rank: a legacy owner reads as master, anything else is dropped", async () => {
    const m = await lib();
    expect(m.normalizeRank("owner")).toBe("master");
    expect(m.normalizeRank("viewer")).toBeNull();
    expect(m.roleLabel("owner")).toBe("owner");
    const n = m.normalizeMembers({
      roles: ["member", "manager", "master", "owner"],
      defaultRole: "owner",
      members: [{ aid: SAM, role: "owner", grants: [{ inviteId: "sam", role: "owner" }] }],
      invites: [{ inviteId: "sam", role: "owner", creatorPub: "AB".repeat(32), creatorDeviceId: "nope" }],
      accountMembers: [{ kind: "device", deviceId: "a1".repeat(16), devicePub: "11".repeat(32), tier: "admin", rank: "owner", set: false, refused: false }],
    });
    expect(n.roles).toEqual(["member", "manager", "master"]);
    expect(n.defaultRole).toBe("master");
    expect(n.members[0].role).toBe("master");
    expect(n.members[0].grants[0].role).toBe("master");
    expect(n.invites[0]).toMatchObject({ role: "master", creatorPub: "ab".repeat(32), creatorDeviceId: null });
    expect(n.accountMembers[0].rank).toBe("master");
  });
});

// Access control roles (docs/service-access-gating.md, "Open mode + members"):
// the webapp's app-member-role signer against THE reference vectors, and the
// helpers that place each members-list row's role and "also in" line.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deriveIRK, ed } from "@flagship/protocol";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-member-role/vectors.json"), "utf8"),
) as {
  umkSeedHex: string;
  pub: string;
  cases: Array<{ serverDomain: string; serviceId: string; target: string; role: string; issuedAt: number; canonical: string; signature: string }>;
  invalid: Array<{ serverDomain: string; serviceId: string; target: string; role: string; issuedAt: number; why: string }>;
};

async function lib() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "memberRoles.js");
  return await import(pathToFileURL(path).href);
}
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("app-member-role (webapp) vs test-vectors/app-member-role", () => {
  const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i: canonical bytes + signature", async (_i, c) => {
    const m = await lib();
    const order = { serverDomain: c.serverDomain, serviceId: c.serviceId, target: c.target, role: c.role, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(m.canonicalAppMemberRoleBytes(order))).toBe(c.canonical);
    const body = await m.signAppMemberRole({
      ...order,
      umk: new Uint8Array(32),
      signWithIrk: async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, irk.privateKey),
    });
    expect(body).toEqual({ order, signature: c.signature });
  });

  it.each(V.invalid.map((c) => [c.why, c] as const))("refuses: %s", async (_why, c) => {
    const m = await lib();
    expect(() => m.canonicalAppMemberRoleBytes(c)).toThrow();
  });

  it("setMemberRole posts {order, signature} to the app's members/role route", async () => {
    const m = await lib();
    const fetchJson = vi.fn(async () => ({ ok: true }));
    await m.setMemberRole({
      serverDomain: "home.harry.flagship.services",
      serviceId: "harry-weather",
      target: "invite:abc",
      role: "manager",
      umk: new Uint8Array(32),
      signWithIrk: async (_u: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, irk.privateKey),
      fetchJson,
      now: () => 1_700_000_000_000,
    });
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(path).toBe("/api/screens/services/harry-weather/members/role");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent.order).toEqual({
      serverDomain: "home.harry.flagship.services",
      serviceId: "harry-weather",
      target: "invite:abc",
      role: "manager",
      issuedAt: 1_700_000_000_000,
    });
    expect(ed.verify(fromHex(sent.signature), m.canonicalAppMemberRoleBytes(sent.order), irk.publicKey)).toBe(true);
    expect(toHex(irk.publicKey)).toBe(V.pub);
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
});

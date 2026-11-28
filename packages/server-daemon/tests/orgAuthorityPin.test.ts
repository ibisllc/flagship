import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signOrgApproval } from "@flagship/protocol";
import {
  OrgPinError,
  authorizeOrgSensitiveOrder,
  fileOrgPinStore,
  loadOrgPin,
  mergeOrgServed,
  orgSignIn,
  syncOrgAuthority,
  type OrgOffboardingHooks,
  type OrgRotationKind,
  type OrgServed,
} from "../src/orgAuthorityPin.js";
import { parseConfig } from "../src/config.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const R = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(R);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, R(x)]));
};
const chain = R(V.chains[0]);
const books = V.seatBooks.map(R);
const expected = { orgId: V.orgId as string, genesisHash: V.genesisHash as string };
const NOW = chain.now as number;
const SERVER = "home.acme.flagship.services";
const k = (n: string) => ({ ...V.keys[n], secret: Uint8Array.from(Buffer.from(V.keys[n].edSeedHex + V.keys[n].mldsaSeedHex, "hex")) });

const served = (over: Partial<OrgServed> = {}): OrgServed => ({
  entries: chain.entries.slice(0, 2),
  freezes: [],
  overturns: [],
  vetoes: [],
  grants: books[0].grants,
  revokes: [],
  ...over,
});

function hooks() {
  const calls: string[] = [];
  const h: OrgOffboardingHooks = {
    closeSessions: async (s) => void calls.push(`close:${s}`),
    dropEnrolledAppIds: async (s) => void calls.push(`apps:${s}`),
    freezeInvitesBy: async (s) => void calls.push(`invites:${s}`),
    rotate: async (kind: OrgRotationKind, s) => {
      calls.push(`rotate:${kind}:${s}`);
      return kind !== "disk-key";
    },
  };
  return { calls, h };
}

describe("org authority pin on the box", () => {
  it("parses the org pin from config only as a well-formed pair", () => {
    const base = { serverId: "s", userId: "u", bakPublicKey: "00".repeat(32), irkPublicKey: "11".repeat(32) };
    expect(parseConfig({ ...base, orgId: V.orgId, orgGenesisHash: V.genesisHash }).orgGenesisHash).toBe(V.genesisHash);
    expect(parseConfig({ ...base, orgId: V.orgId }).orgId).toBeUndefined();
  });

  it("pins, persists and reloads offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orgpin-"));
    const store = fileOrgPinStore(join(dir, "org-authority-pin.json"));
    const { h } = hooks();
    const p = await syncOrgAuthority({ ...expected, serverDomain: SERVER, store, fetchServed: async () => served(), hooks: h, now: () => NOW }, null);
    expect(p.state.current.version).toBe(1);
    const again = await loadOrgPin(store, expected, NOW);
    expect(again?.book.seats.size).toBe(2);
  });

  it("refuses a shorter chain and a fork", () => {
    const first = mergeOrgServed(null, served(), expected, NOW).pinned;
    expect(() => mergeOrgServed(first, served({ entries: chain.entries.slice(0, 1) }), expected, NOW)).toThrow(OrgPinError);
    const forked = R(V.chains.find((c: { name: string }) => c.name === "changing the bylaws with the strictest ceremony"));
    expect(() => mergeOrgServed(first, served({ entries: forked.entries }), expected, NOW)).toThrow(/differs at version 1/);
  });

  it("takes a founder removal only with the notice time .com observed, and keeps the first one it saw", () => {
    const first = mergeOrgServed(null, served(), expected, NOW).pinned;
    // Served without its observed open time, the removal is not adopted: the box keeps v1.
    const unobserved = mergeOrgServed(first, served({ entries: chain.entries.slice(0, 3) }), expected, NOW).pinned;
    expect(unobserved.state.current.version).toBe(1);
    const observed = mergeOrgServed(first, served({ entries: chain.entries.slice(0, 3), noticeOpenedAt: chain.noticeOpenedAt }), expected, NOW).pinned;
    expect(observed.state.current.version).toBe(2);
    // A later answer moving the open time cannot shift the window the box already holds.
    const [sha, at] = Object.entries(chain.noticeOpenedAt as Record<string, number>)[0]!;
    const moved = mergeOrgServed(observed, served({ entries: chain.entries.slice(0, 3), noticeOpenedAt: { [sha]: at + 3 * 86_400_000 } }), expected, NOW).pinned;
    expect(moved.file.noticeOpenedAt).toEqual({ [sha]: at });
    expect(moved.state.current.version).toBe(2);
  });

  it("keeps a revoke .com later drops", () => {
    const first = mergeOrgServed(null, served({ revokes: books[3].revokes }), expected, NOW).pinned;
    expect(first.book.seats.size).toBe(0);
    const later = mergeOrgServed(first, served({ revokes: [] }), expected, NOW).pinned;
    expect(later.book.seats.size).toBe(0);
  });

  it("offboards a departed seat and keeps unfinished rotations pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orgpin-"));
    const store = fileOrgPinStore(join(dir, "pin.json"));
    const { h, calls } = hooks();
    const deps = { ...expected, serverDomain: SERVER, store, hooks: h, now: () => NOW };
    const p1 = await syncOrgAuthority({ ...deps, fetchServed: async () => served() }, null);
    const p2 = await syncOrgAuthority({ ...deps, fetchServed: async () => served({ revokes: books[3].revokes }) }, p1);
    const s = V.keys["S scoped admin"].seatId;
    expect(calls).toContain(`close:${s}`);
    expect(calls).toContain(`rotate:cgk:${s}`);
    expect(p2.file.rotationsPending).toEqual([]);
  });

  it("decides org orders with the pinned chain and gives seats their rank", () => {
    const p = mergeOrgServed(null, served(), expected, NOW).pinned;
    const order = new TextEncoder().encode(`flagship/server-update/v1|${SERVER}|1`);
    const S = k("S scoped admin");
    const at = NOW;
    const a = signOrgApproval({ orgId: V.orgId, oarVersion: 1, order, seatId: S.seatId, adminKeyId: S.keyId, issuedAt: at, notAfter: at + 3_600_000 }, S.secret);
    expect(authorizeOrgSensitiveOrder(p, { kind: "operate", server: SERVER }, order, [a], at).ok).toBe(true);
    expect(authorizeOrgSensitiveOrder(p, { kind: "destroy" }, order, [a], at)).toEqual({ ok: false, code: "org-scope" });
    expect(authorizeOrgSensitiveOrder(null, { kind: "operate", server: SERVER }, order, [a], at).ok).toBe(false);
    expect(orgSignIn(p, V.keys["S member"].binding.ed25519PubHex, SERVER, "acme--crm", at)?.rank).toBe("master");
    expect(orgSignIn(p, V.keys["M member"].binding.ed25519PubHex, "other", "acme--crm", at)?.rank).toBe("member");
    expect(orgSignIn(p, V.keys["X outsider"].binding.ed25519PubHex, SERVER, "acme--crm", at)).toBeNull();
  });
});

describe("the sensitive-order gate on an org server", () => {
  it("decides by org approvals only", async () => {
    const { authorizeSensitiveOrder } = await import("../src/adminAuthorityLocal.js");
    const p = mergeOrgServed(null, served(), expected, NOW).pinned;
    const order = new TextEncoder().encode(`flagship/server-update/v1|${SERVER}|1`);
    const S = k("S scoped admin");
    const a = signOrgApproval({ orgId: V.orgId, oarVersion: 1, order, seatId: S.seatId, adminKeyId: S.keyId, issuedAt: NOW, notAfter: NOW + 3_600_000 }, S.secret);
    const base = { order: {}, signature: new Uint8Array(64), verify: () => true, ownerIrkPub: new Uint8Array(32), username: "acme", now: NOW };
    expect(authorizeSensitiveOrder({ ...base, org: { action: { kind: "operate", server: SERVER }, order, approvals: [a], pinned: p } })).toBe(true);
    expect(authorizeSensitiveOrder({ ...base, org: { action: { kind: "destroy" }, order, approvals: [a], pinned: p } })).toBe(false);
    expect(authorizeSensitiveOrder({ ...base, org: { action: { kind: "operate", server: SERVER }, order, approvals: [a], pinned: null } })).toBe(false);
  });
});

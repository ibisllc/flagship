/**
 * Who may sign an app-rank order on this box (admin root on a pinned box, never the owner IRK there; the IRK on a box
 * that pins no admin root), through the real gate (`buildRankEntryApplier` → `authorizeSensitiveOrder`). The cases and
 * their expected verdicts are written here; the signed file is
 * packages/protocol/test-vectors/access-enforcement/rank-orders.json (UPDATE_ACCESS_VECTORS=1 rewrites it), and
 * rust/crates/flagship-access/tests/rank_vectors.rs must agree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed, signAppRank, signDeviceCapabilityGrant, type AdminGrantView, type DeviceCapabilityGrant, type Keypair } from "@flagship/protocol";
import { buildRankEntryApplier } from "../src/memberRoles.js";

const FILE = new URL("../../protocol/test-vectors/access-enforcement/rank-orders.json", import.meta.url);
const NOW = 1_800_000_000_000;
const APP = "alice--club";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (fill: number): Keypair => {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
const irk = key(0x11);
const root = key(0x5a);
const adminDev = key(0x62);
const fakeAdmin = key(0x63);
const lapsedAdmin = key(0x64);
const plainDev = key(0x65);
const revokedAdmin = key(0x66);
const otherUser = key(0x67);
const stranger = key(0x71);

function grant(k: Keypair, id: string, signer: Keypair, signerRoot: "admin-root" | "membership", opts: { scopes?: string[]; expiresAt?: number; username?: string; revoked?: boolean } = {}) {
  const g: DeviceCapabilityGrant = {
    grantId: id,
    username: opts.username ?? "alice",
    deviceId: id.padEnd(32, "0").slice(0, 32).replace(/[^0-9a-f]/g, "0"),
    devicePubKey: k.publicKey,
    scopes: (opts.scopes ?? ["browse", "admin"]) as DeviceCapabilityGrant["scopes"],
    issuedAt: NOW - 1000,
    expiresAt: opts.expiresAt ?? NOW + 1e9,
  };
  return {
    grantId: g.grantId,
    username: g.username,
    deviceId: g.deviceId,
    devicePubHex: hex(k.publicKey),
    scopes: [...g.scopes],
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(g, signer)),
    signerRoot,
    revoked: opts.revoked === true,
  };
}
const grants = [
  grant(adminDev, "a1", root, "admin-root", { scopes: ["admin", "browse"] }),
  grant(fakeAdmin, "a2", irk, "membership"),
  grant(lapsedAdmin, "a3", root, "admin-root", { expiresAt: NOW - 1 }),
  grant(plainDev, "a4", root, "admin-root", { scopes: ["browse"] }),
  grant(revokedAdmin, "a5", root, "admin-root", { revoked: true }),
  grant(otherUser, "a6", root, "admin-root", { username: "bob" }),
];
const trusts = {
  pinned: { ownerIrk: hex(irk.publicKey), adminRoot: hex(root.publicKey), username: "alice", now: NOW, grants },
  unpinned: { ownerIrk: hex(irk.publicKey), adminRoot: null, username: "alice", now: NOW, grants: [] },
};

const order = (o: Partial<{ serviceRef: string; target: string; rank: string; issuedAt: number }> = {}) => ({
  serviceRef: APP,
  target: `aid:${"f1".repeat(32)}`,
  rank: "manager",
  issuedAt: NOW - 5,
  ...o,
});
const sign = (o: ReturnType<typeof order>, k: Keypair) => hex(signAppRank(o, k));

type Def = { name: string; trust: keyof typeof trusts; order: ReturnType<typeof order>; signer: Keypair; serviceRef?: string; installed?: boolean; tamper?: Partial<ReturnType<typeof order>>; expect: "ok" | "refused" };
const DEFS: Def[] = [
  { name: "pinned: the admin root signs", trust: "pinned", order: order(), signer: root, expect: "ok" },
  { name: "pinned: the owner IRK is refused", trust: "pinned", order: order(), signer: irk, expect: "refused" },
  { name: "pinned: a device with an admin-root admin grant signs", trust: "pinned", order: order({ rank: "master" }), signer: adminDev, expect: "ok" },
  { name: "pinned: a device whose admin grant the IRK signed is refused", trust: "pinned", order: order(), signer: fakeAdmin, expect: "refused" },
  { name: "pinned: a device whose admin grant expired is refused", trust: "pinned", order: order(), signer: lapsedAdmin, expect: "refused" },
  { name: "pinned: a device without the admin scope is refused", trust: "pinned", order: order(), signer: plainDev, expect: "refused" },
  { name: "pinned: a revoked admin device is refused", trust: "pinned", order: order(), signer: revokedAdmin, expect: "refused" },
  { name: "pinned: another account's admin grant is refused", trust: "pinned", order: order(), signer: otherUser, expect: "refused" },
  { name: "pinned: a stranger is refused", trust: "pinned", order: order(), signer: stranger, expect: "refused" },
  { name: "pinned: an order changed after signing is refused", trust: "pinned", order: order(), signer: root, tamper: { rank: "master" }, expect: "refused" },
  { name: "pinned: an order for another app is refused here", trust: "pinned", order: order({ serviceRef: "alice--blog" }), signer: root, expect: "refused" },
  { name: "pinned: an order for an app not installed here is refused", trust: "pinned", order: order(), signer: root, installed: false, expect: "refused" },
  { name: "pinned: refusing a device is an order", trust: "pinned", order: order({ target: `device:${"a2".repeat(32)}`, rank: "refused" }), signer: root, expect: "ok" },
  { name: "pinned: a co-manager's rank is an order", trust: "pinned", order: order({ target: `share:${"51".repeat(16)}`, rank: "member" }), signer: root, expect: "ok" },
  { name: "unpinned: the owner IRK signs", trust: "unpinned", order: order(), signer: irk, expect: "ok" },
  { name: "unpinned: an unknown admin root is a stranger", trust: "unpinned", order: order(), signer: root, expect: "refused" },
  { name: "unpinned: an admin device grant counts for nothing", trust: "unpinned", order: order(), signer: adminDev, expect: "refused" },
];
const MALFORMED: Array<{ name: string; order: unknown; expect: "refused" }> = [
  { name: "an invited person cannot be refused (only removed)", order: { ...order(), rank: "refused" }, expect: "refused" },
  { name: "an unknown rank is refused", order: { ...order(), rank: "owner" }, expect: "refused" },
  { name: "an upper-case target is refused", order: { ...order(), target: `aid:${"F1".repeat(32)}` }, expect: "refused" },
  { name: "a fractional time is refused", order: { ...order(), issuedAt: 1.5 }, expect: "refused" },
  { name: "a string time is refused", order: { ...order(), issuedAt: "1" }, expect: "refused" },
];

function build() {
  const cases = DEFS.map((d) => ({
    name: d.name,
    trust: d.trust,
    serviceRef: d.serviceRef ?? APP,
    installed: d.installed ?? true,
    order: { ...d.order, ...(d.tamper ?? {}) },
    signature: sign(d.order, d.signer),
    expect: d.expect,
  }));
  for (const m of MALFORMED) {
    cases.push({ name: m.name, trust: "pinned", serviceRef: APP, installed: true, order: m.order as never, signature: "00".repeat(64), expect: m.expect });
  }
  return {
    about:
      "flagship/app-rank/v1 orders handed to a box (a journal `rank` entry): ok when well formed, for this app, installed here and signed by a key " +
      "this box trusts for admin orders. trust.adminRoot null = a box that pins no admin root (the owner IRK signs); otherwise only the admin " +
      "root or a device holding an unrevoked, unexpired admin-root-signed `admin` grant for this account. TypeScript: " +
      "packages/server-daemon/tests/accessRankVectors.test.ts; Rust: rust/crates/flagship-access/tests/rank_vectors.rs.",
    trusts,
    cases,
  };
}

async function tsVerdict(c: ReturnType<typeof build>["cases"][number]): Promise<string> {
  const t = trusts[c.trust as keyof typeof trusts];
  const views: AdminGrantView[] = t.grants.map((g) => ({
    grant: { grantId: g.grantId, username: g.username, deviceId: g.deviceId, devicePubKey: Uint8Array.from(Buffer.from(g.devicePubHex, "hex")), scopes: g.scopes as DeviceCapabilityGrant["scopes"], issuedAt: g.issuedAt, expiresAt: g.expiresAt },
    signatureHex: g.signatureHex,
    signerRoot: g.signerRoot as AdminGrantView["signerRoot"],
    revokedAt: g.revoked ? NOW - 10 : null,
  }));
  let applied = false;
  const store = {
    principal: (pub: string) => (pub === "a2".repeat(32) ? { kind: "device", pub, deviceId: null, tier: "member", legacy: false } : null),
    setAccountRank: async () => ((applied = true), "ok"),
    setRole: async () => ((applied = true), "ok"),
    isOwner: () => false,
    isAllowed: () => true,
    grants: () => [],
    accountPeople: () => [],
    roles: () => ({ coManagers: {} }),
  };
  const apply = buildRankEntryApplier({
    ownerIrkPub: Uint8Array.from(Buffer.from(t.ownerIrk, "hex")),
    ...(t.adminRoot ? { adminRootPub: Uint8Array.from(Buffer.from(t.adminRoot, "hex")) } : {}),
    username: t.username,
    adminGrants: () => views,
    app: (id) => (c.installed && id === c.serviceRef ? { manifest: { access: {} } } : null),
    store: store as never,
    now: () => NOW,
  } as never);
  const r = await apply(c.serviceRef, { kind: "rank", order: c.order, signature: c.signature } as never);
  return r === "refused" ? "refused" : applied ? "ok" : `unexpected ${r}`;
}

describe("app-rank order authority vectors", () => {
  const doc = build();
  if (process.env.UPDATE_ACCESS_VECTORS === "1") writeFileSync(FILE, JSON.stringify(doc, null, 1) + "\n");
  it("the file is in step with this test", () => {
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(doc)));
  });
  for (const c of doc.cases) {
    it(c.name, async () => {
      expect(await tsVerdict(c)).toBe(c.expect);
    });
  }
});

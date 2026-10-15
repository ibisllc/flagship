/**
 * Who can invite, on the box (owner decision 2026-10-15,
 * docs/service-access-gating.md "Who can invite"): only admins grant higher
 * access; any device of the account may invite at Member.
 *
 * The box reads an invite's tier from the key that signed its create (never
 * from `.com`): on a box with a pinned admin root, the admin root makes an
 * ADMIN invite and the owner's AID or IRK (every device holds them) a MEMBER
 * invite. Every join through a member invite is capped at Member whatever the
 * manifest's `default_role` says (old `admin` maps to master, so falling back
 * to it would leak), and only an admin-root-signed role order raises it; an
 * IRK-signed role order is refused. Effective rank = highest live grant.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signAcceptServiceInvite,
  signAppMemberRole,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  type AcceptServiceInvite,
  type AppMemberRoleOrder,
  type CreateServiceInvite,
  type Keypair,
} from "@flagship/protocol";
import { buildAppSessionResolver } from "../src/appMemberSession.js";
import { buildMemberRolesHttp } from "../src/memberRoles.js";
import { buildServiceAccessHttp, ServiceAccessStore } from "../src/serviceAccess.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice--club";
const NOW = 1_700_000_000_000;
const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);
const household = deriveHouseholdKey(ownerUmk);
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(0x5a) });
const friend = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const FRIEND = Buffer.from(friend.publicKey).toString("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function signedCreate(signer: Keypair, secret: Uint8Array, inviteId = randomServiceInviteId()) {
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: ownerAid.publicKey,
    serviceRef: SERVICE,
    secretHash: serviceInviteSecretHash(secret),
    encryptedBundle: sealInviteBundle({ name: "Sam" }, household, inviteId),
    issuedAt: NOW,
  };
  return { inviteId, create: { ...create, authorAID: hex(create.authorAID) }, createSig: hex(signCreateServiceInvite(create, signer)) };
}

/** A box whose `.com` stub answers every redeem / create fetch with `carrier`. */
function box(opts: { pinned: boolean; defaultRole: string }) {
  const store = new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "tiers-")), "service-access.json"), {
    ownerAidHex: hex(ownerAid.publicKey),
  });
  let carrier: ReturnType<typeof signedCreate> | null = null;
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes("/create")) return Response.json({ create: carrier!.create, createSig: carrier!.createSig });
    return Response.json({ redeemed: true, approvalMode: "auto", firstBind: true, serviceRef: SERVICE, boundAID: FRIEND, ...carrier });
  }) as unknown as typeof fetch;
  const access = buildServiceAccessHttp({
    serverId: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    ownerAidPub: ownerAid.publicKey,
    ...(opts.pinned ? { adminRootPub: adminRoot.publicKey } : {}),
    store,
    serviceInstalled: (ref) => ref === SERVICE,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl,
    username: "alice",
    serverDomain: FQDN,
    stk: deriveIRK({ seed: new Uint8Array(32).fill(99) }),
    now: () => NOW,
  });
  const manifest = { access: { enabled: true as const, default_role: opts.defaultRole } };
  const roles = buildMemberRolesHttp({
    serverDomain: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    ...(opts.pinned ? { adminRootPub: adminRoot.publicKey } : {}),
    username: "alice",
    store,
    app: (id) => (id === SERVICE ? { manifest: manifest as never } : null),
    now: () => NOW,
  });
  // The rank the app itself sees for the friend (X-Flagship-Role).
  const resolve = buildAppSessionResolver({
    sessions: { lookup: () => ({ serviceRef: SERVICE, aid: FRIEND }) as never },
    access: store,
  });
  const app = {
    serviceId: SERVICE,
    manifest,
    membership: { stableIdFor: () => "stable", members: { getRole: () => null } },
  } as never;
  const appRole = () => resolve({ headers: { cookie: "Flagship-App-Session=t" } } as never, app)?.role;

  async function redeem(signer: Keypair, opts2: { secret?: Uint8Array } = {}) {
    const secret = opts2.secret ?? crypto.getRandomValues(new Uint8Array(32));
    carrier = signedCreate(signer, secret);
    const redeemedAt = NOW;
    const secretHash = serviceInviteSecretHash(secret);
    const aidSig = hex(signRedeemServiceInvite({ secretHash, visitorAID: friend.publicKey, redeemedAt }, friend));
    const body = Buffer.from(JSON.stringify({ secret: hex(secret), visitorAID: FRIEND, aidSig, redeemedAt }));
    const res = await access.handle({ method: "POST", path: "/api/service-invites/redeem", headers: { host: FQDN }, body });
    return { res: res!, inviteId: carrier.inviteId };
  }

  async function accept(signer: Keypair) {
    carrier = signedCreate(signer, crypto.getRandomValues(new Uint8Array(32)));
    const a: AcceptServiceInvite = { inviteId: carrier.inviteId, serviceRef: SERVICE, contactAID: friend.publicKey, acceptedAt: NOW };
    const body = Buffer.from(
      JSON.stringify({ accept: { ...a, contactAID: FRIEND }, acceptSig: hex(signAcceptServiceInvite(a, friend)) }),
    );
    const res = await access.handle({ method: "POST", path: "/api/service-access/accept", headers: { host: FQDN }, body });
    return { res: res!, inviteId: carrier.inviteId };
  }

  async function roleOrder(target: string, role: string, signer: Keypair, issuedAt = NOW) {
    const o: AppMemberRoleOrder = { serverDomain: FQDN, serviceId: SERVICE, target, role, issuedAt };
    const req: HttpRequest = {
      method: "POST",
      path: `/api/screens/services/${SERVICE}/members/role`,
      headers: {},
      body: Buffer.from(JSON.stringify({ order: o, signature: hex(signAppMemberRole(o, signer)) })),
    };
    return (await roles(req.path, "POST", req))!;
  }

  async function list() {
    const req: HttpRequest = { method: "GET", path: `/api/screens/services/${SERVICE}/members`, headers: {}, body: Buffer.alloc(0) };
    return JSON.parse(String((await roles(req.path, "GET", req))!.body));
  }

  return { store, redeem, accept, roleOrder, list, appRole };
}

describe("member-tier invites are capped at Member on an admin-pinned box", () => {
  for (const [name, signer] of [["IRK", ownerIrk], ["AID", ownerAid]] as const) {
    for (const defaultRole of ["master", "admin", "owner", "manager"]) {
      it(`${name}-signed create, manifest default_role ${defaultRole} → the join is Member`, async () => {
        const b = box({ pinned: true, defaultRole });
        const { res, inviteId } = await b.redeem(signer);
        expect(res.status).toBe(200);
        expect(JSON.parse(String(res.body)).tier).toBe("member");
        expect(b.store.inviteTier(SERVICE, inviteId)).toBe("member");
        expect(b.store.roleOf(SERVICE, FRIEND, defaultRole)).toBe("member");
        expect(b.appRole()).toBe("member");
        const l = await b.list();
        expect(l.members[0]).toMatchObject({ aid: FRIEND, role: "member", grants: [{ inviteId, role: "member", tier: "member" }] });
        expect(l.invites).toEqual([{ inviteId, role: "member", set: false, tier: "member" }]);
      });
    }
  }

  it("a manual-approve acceptance of a member invite is capped too", async () => {
    const b = box({ pinned: true, defaultRole: "master" });
    const { res, inviteId } = await b.accept(ownerIrk);
    expect(res.status).toBe(200);
    expect(b.store.inviteTier(SERVICE, inviteId)).toBe("member");
    expect(b.appRole()).toBe("member");
  });

  it("an ADMIN invite (admin-root-signed) gets the manifest default", async () => {
    const b = box({ pinned: true, defaultRole: "master" });
    const { res, inviteId } = await b.redeem(adminRoot);
    expect(JSON.parse(String(res.body)).tier).toBe("admin");
    expect(b.store.inviteTier(SERVICE, inviteId)).toBe("admin");
    expect(b.appRole()).toBe("master");
  });

  it("a box with no admin root: the owner key is the authority, no cap", async () => {
    const b = box({ pinned: false, defaultRole: "master" });
    const { inviteId } = await b.redeem(ownerIrk);
    expect(b.store.inviteTier(SERVICE, inviteId)).toBe("admin");
    expect(b.appRole()).toBe("master");
  });
});

describe("rank changes stay admin-only on an admin-pinned box", () => {
  it("an IRK-signed role order is refused, for the invite, the grant and the person", async () => {
    const b = box({ pinned: true, defaultRole: "member" });
    const { inviteId } = await b.redeem(ownerIrk);
    for (const target of [`invite:${inviteId}`, `grant:${inviteId}/${FRIEND}`, `aid:${FRIEND}`]) {
      const r = await b.roleOrder(target, "master", ownerIrk);
      expect(r.status).toBe(403);
    }
    const aidSigned = await b.roleOrder(`aid:${FRIEND}`, "master", ownerAid);
    expect(aidSigned.status).toBe(403);
    expect(b.appRole()).toBe("member");
  });

  it("an admin-root-signed role order raises a member-invited person", async () => {
    const b = box({ pinned: true, defaultRole: "member" });
    const { inviteId } = await b.redeem(ownerIrk);
    expect((await b.roleOrder(`invite:${inviteId}`, "manager", adminRoot)).status).toBe(200);
    expect(b.appRole()).toBe("manager");
    expect((await b.roleOrder(`grant:${inviteId}/${FRIEND}`, "master", adminRoot, NOW + 1)).status).toBe(200);
    expect(b.appRole()).toBe("master");
  });

  it("effective rank is the highest live grant: an admin invite lifts a member-invited person", async () => {
    const b = box({ pinned: true, defaultRole: "master" });
    const member = await b.redeem(ownerIrk);
    expect(b.appRole()).toBe("member");
    const admin = await b.redeem(adminRoot);
    expect(b.appRole()).toBe("master");
    // Revoking the admin invite drops them back to Member, not to the default.
    await b.store.revokeGroup(admin.inviteId, SERVICE);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(true);
    expect(b.appRole()).toBe("member");
    await b.store.revokeGroup(member.inviteId, SERVICE);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(false);
  });
});

describe("the tier record", () => {
  it("member is sticky (a later admin-signed create for the same id can only keep it at Member)", async () => {
    const b = box({ pinned: true, defaultRole: "master" });
    await b.store.setInviteTier(SERVICE, "inv-1", "member");
    await b.store.setInviteTier(SERVICE, "inv-1", "admin");
    expect(b.store.inviteTier(SERVICE, "inv-1")).toBe("member");
  });

  it("persists, and travels with an app copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiers-p-"));
    const a = new ServiceAccessStore(join(dir, "s.json"));
    await a.setInviteTier(SERVICE, "inv-1", "member");
    await a.addAllowed(SERVICE, FRIEND, "inv-1");
    const reloaded = new ServiceAccessStore(join(dir, "s.json"));
    await reloaded.load();
    expect(reloaded.inviteTier(SERVICE, "inv-1")).toBe("member");
    expect(reloaded.roleOf(SERVICE, FRIEND, "master")).toBe("member");
    const copy = new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "tiers-c-")), "s.json"));
    await copy.importEntry(SERVICE, reloaded.exportEntry(SERVICE)!);
    expect(copy.roleOf(SERVICE, FRIEND, "master")).toBe("member");
  });
});

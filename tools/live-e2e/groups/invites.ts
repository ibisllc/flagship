// Who can invite (owner decision 2026-10-15, docs/service-access-gating.md
// "Who can invite"): only admins grant higher access; any device of the
// account may invite at Member, and admins are told. On an admin-pinned demo
// account: the admin root creates an invite with a rank and the redeemer gets
// it; the membership key (IRK, which every device holds) creates a member
// invite that redeems at Member although the manifest's default_role is
// master; an IRK-signed rank order is refused and an admin-root one raises the
// person; the member create left its content-free trace in the account
// activity; a device withdraws its own invite but not an admin's.
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { deriveDemoPrimaryDeviceId } from "@flagship/control-plane";
import {
  appMemberRoleTargetGrant,
  appMemberRoleTargetInvite,
  deriveAppAccountId,
  deriveHouseholdKey,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signAppMemberRole,
  signCreateServiceInvite,
  signKnockAuthorization,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServiceInviteListQuery,
  type AppMemberRoleOrder,
  type CreateServiceInvite,
  type Keypair,
  type KnockAuthorization,
  type ServiceInviteListQuery,
} from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { CONTROL, KEK, assert, cookieVal, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { echoedFlagshipHeaders, installWhoami, setMode, waitServing } from "./gating.js";
import type { Group } from "./types.js";

interface Invite {
  inviteId: string;
  secret: Uint8Array;
}

export const invites: Group = {
  name: "invites",
  title: "who can invite: admin invites with a rank, any device at Member (capped on the box), admin-only ranks, admins told",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, box }) {
    const b = box("A1");
    const fqdn = b.fqdn;
    const slug = "club";
    const serviceRef = `${A.username}--${slug}`;
    const app = `https://${slug}.${fqdn}`;
    const { irk, aid, adminRoot } = A.keys;
    const household = deriveHouseholdKey({ seed: A.keys.umk });
    const deviceId = deriveDemoPrimaryDeviceId(hexToBytes(KEK), A.username);
    const friendA = deriveAppAccountId({ seed: new Uint8Array(32).fill(0xa1) }, serviceRef);
    const friendB = deriveAppAccountId({ seed: new Uint8Array(32).fill(0xb2) }, serviceRef);
    const session = await pair(A, b);

    const installed = await rec.check("install the probe app (default_role: master), members only", async () => {
      await installWhoami(A, b, slug, { enabled: true, default_role: "master" });
      await waitServing(`${app}/`);
      await setMode(A, b, serviceRef, "restricted");
      return serviceRef;
    });
    if (!installed) return;

    const create = async (signer: Keypair, label: string, withDevice: boolean) => {
      const inv: Invite = { inviteId: randomServiceInviteId(), secret: randomBytes(32) };
      const c: CreateServiceInvite = {
        inviteId: inv.inviteId,
        authorAID: aid.publicKey,
        serviceRef,
        secretHash: serviceInviteSecretHash(inv.secret),
        encryptedBundle: sealInviteBundle({ name: label }, household, inv.inviteId),
        issuedAt: Date.now(),
      };
      const r = await postJson(`https://${CONTROL}/api/users/${A.username}/service-invites`, {
        request: { ...c, authorAID: bytesToHex(aid.publicKey), ...(withDevice ? { deviceId } : {}) },
        signature: bytesToHex(signCreateServiceInvite(c, signer)),
      });
      assert(r.status === 200, `create ${r.status}: ${short(r.text)}`);
      return { inv, tier: r.json?.tier as string };
    };
    const redeem = async (inv: Invite, who: Keypair) => {
      const redeemedAt = Date.now();
      const secretHash = serviceInviteSecretHash(inv.secret);
      const r = await postJson(`https://${fqdn}/api/service-invites/redeem`, {
        secret: bytesToHex(inv.secret),
        visitorAID: bytesToHex(who.publicKey),
        aidSig: bytesToHex(signRedeemServiceInvite({ secretHash, visitorAID: who.publicKey, redeemedAt }, who)),
        redeemedAt,
      });
      assert(r.status === 200 && r.json?.boundAID === bytesToHex(who.publicKey), `redeem ${r.status}: ${short(r.text)}`);
      return r.json?.tier as string;
    };
    const roleOrder = (target: string, role: string, signer: Keypair) => {
      const order: AppMemberRoleOrder = { serverDomain: fqdn, serviceId: serviceRef, target, role, issuedAt: Date.now() };
      return postJson(
        `https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members/role`,
        { order, signature: bytesToHex(signAppMemberRole(order, signer)) },
        { "x-flagship-session": session },
      );
    };
    /** The rank the app sees for `who`, after a knock sign-in with their per-app id. */
    const appRole = async (who: Keypair): Promise<string | undefined> => {
      const k = await tryHttp(`${app}/private`, { headers: { accept: "text/html" } }, 45_000);
      const pageId = (/[?&]page=([0-9a-f]+)/.exec(k.text) || [])[1] ?? "";
      const holder = cookieVal(k.setCookies, "Flagship-Knock") ?? "";
      assert(pageId && holder, `no knock page: ${k.status} ${short(k.text, 80)}`);
      const ka: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: who.publicKey, issuedAt: Date.now() };
      const auth = await postJson(`https://${fqdn}/api/service-access/knock/authorize`, {
        authorization: { ...ka, visitorAID: bytesToHex(who.publicKey) },
        sig: bytesToHex(signKnockAuthorization(ka, who)),
      });
      assert(auth.status === 200, `authorize ${auth.status}: ${short(auth.text)}`);
      const poll = await http(`https://${fqdn}/__flagship/knock/${pageId}/status`, {
        headers: { accept: "application/json", cookie: `Flagship-Knock=${holder}` },
      });
      const cookie = cookieVal(poll.setCookies, "Flagship-App-Session");
      assert(cookie, `no session cookie: ${short(poll.json)}`);
      const g = await tryHttp(`${app}/private`, { headers: { accept: "text/html", cookie: `Flagship-App-Session=${cookie}` } }, 45_000);
      return echoedFlagshipHeaders(g.text)["x-flagship-role"];
    };
    const members = async () => {
      const r = await http(`https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members`, {
        headers: { "x-flagship-session": session },
      });
      assert(r.status === 200, `members ${r.status}: ${short(r.text)}`);
      return r.json as { members: Array<{ aid: string; role: string; grants: Array<{ inviteId: string; role: string; tier: string | null }> }> };
    };

    // ── admin invite with a rank ──────────────────────────────────────────
    let adminInv: Invite | null = null;
    await rec.check("ADMIN: the admin root creates an invite (.com says tier admin) and gives it Manager", async () => {
      const { inv, tier } = await create(adminRoot, "Gym Admin Pick", false);
      assert(tier === "admin", `tier=${tier}`);
      const r = await roleOrder(appMemberRoleTargetInvite(inv.inviteId), "manager", adminRoot);
      assert(r.status === 200, `role ${r.status}: ${short(r.text)}`);
      adminInv = inv;
      return `invite ${inv.inviteId.slice(0, 8)}… → manager`;
    });
    await rec.check("ADMIN: the redeemer joins at the invite's rank (app sees X-Flagship-Role: manager)", async () => {
      assert(adminInv, "no admin invite");
      const tier = await redeem(adminInv, friendA);
      assert(tier === "admin", `box tier=${tier}`);
      const role = await appRole(friendA);
      assert(role === "manager", `role=${role}`);
      return "manager";
    });

    // ── member invite: any device, capped at Member ───────────────────────
    let memberInv: Invite | null = null;
    await rec.check("MEMBER: the membership IRK (any device) creates an invite — accepted as tier member", async () => {
      const { inv, tier } = await create(irk, "Gym Phone Pick", true);
      assert(tier === "member", `tier=${tier}`);
      memberInv = inv;
      return `invite ${inv.inviteId.slice(0, 8)}…`;
    });
    await rec.check("MEMBER: the redeemer joins at Member although the manifest's default_role is master", async () => {
      assert(memberInv, "no member invite");
      const tier = await redeem(memberInv, friendB);
      assert(tier === "member", `box tier=${tier}`);
      const role = await appRole(friendB);
      assert(role === "member", `role=${role}`);
      const m = (await members()).members.find((x) => x.aid === bytesToHex(friendB.publicKey));
      assert(m?.role === "member" && m.grants[0]?.tier === "member", `members row ${short(m)}`);
      return "member (box tier member)";
    });
    await rec.check("RANKS: an IRK-signed rank order for the member-invited person is refused (403)", async () => {
      assert(memberInv, "no member invite");
      const r = await roleOrder(appMemberRoleTargetGrant(memberInv.inviteId, bytesToHex(friendB.publicKey)), "master", irk);
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      const inviteWide = await roleOrder(appMemberRoleTargetInvite(memberInv.inviteId), "master", irk);
      assert(inviteWide.status === 403, `invite target: expected 403, got ${inviteWide.status}`);
      return "403";
    });
    await rec.check("RANKS: an admin-root rank order raises them (app sees manager)", async () => {
      assert(memberInv, "no member invite");
      const r = await roleOrder(appMemberRoleTargetGrant(memberInv.inviteId, bytesToHex(friendB.publicKey)), "manager", adminRoot);
      assert(r.status === 200, `role ${r.status}: ${short(r.text)}`);
      await sleep(1100);
      const role = await appRole(friendB);
      assert(role === "manager", `role=${role}`);
      return "manager";
    });

    // ── admins are told; who invited is on the record ─────────────────────
    await rec.check("NOTICE: the member create left a content-free invite-created row in the account activity", async () => {
      const r = await http(`https://${CONTROL}/api/users/${A.username}/audit?since=0&limit=50`);
      assert(r.status === 200, `audit ${r.status}: ${short(r.text)}`);
      const rows = (r.json?.events ?? []) as Array<{ eventKind: string; detail: string }>;
      const hit = rows.filter((e) => e.eventKind === "invite-created");
      assert(hit.length === 1, `invite-created rows: ${hit.length} (${short(rows.map((e) => e.eventKind))})`);
      assert(!hit[0]!.detail.includes(slug) && !hit[0]!.detail.includes("Gym"), `detail leaks: ${hit[0]!.detail}`);
      return hit[0]!.detail;
    });
    await rec.check("RECORD: the owner-signed .com list shows each invite's creator tier and device id", async () => {
      const issuedAt = Date.now();
      const q: ServiceInviteListQuery = { username: A.username, authorAID: bytesToHex(aid.publicKey), scope: "list", cursor: 0, issuedAt };
      const qs = new URLSearchParams({ authorAID: q.authorAID, scope: "list", cursor: "0", issuedAt: String(issuedAt), sig: bytesToHex(signServiceInviteListQuery(q, aid)) });
      const r = await http(`https://${CONTROL}/api/users/${A.username}/service-invites?${qs}`);
      assert(r.status === 200, `list ${r.status}: ${short(r.text)}`);
      const rows = (r.json?.invites ?? []) as Array<{ inviteId: string; creatorTier: string; creatorDeviceId: string | null }>;
      const mine = rows.find((x) => x.inviteId === memberInv?.inviteId);
      const admins = rows.find((x) => x.inviteId === adminInv?.inviteId);
      assert(mine?.creatorTier === "member" && mine.creatorDeviceId === deviceId, `member row ${short(mine)}`);
      assert(admins?.creatorTier === "admin", `admin row ${short(admins)}`);
      return `member by ${deviceId.slice(0, 8)}…, admin`;
    });

    // ── revoke: a device withdraws its own, never an admin's ──────────────
    const revoke = (inviteId: string, signer: Keypair) => {
      const rv = { inviteId, issuedAt: Date.now() };
      return postJson(`https://${CONTROL}/api/users/${A.username}/service-invites/revoke`, {
        request: rv,
        signature: bytesToHex(signRevokeServiceInvite(rv, signer)),
      });
    };
    await rec.check("REVOKE: the membership key can't revoke the admin's invite (403) but withdraws its own (200)", async () => {
      assert(adminInv && memberInv, "missing invites");
      const theirs = await revoke(adminInv.inviteId, irk);
      assert(theirs.status === 403, `admin invite: expected 403, got ${theirs.status}`);
      const own = await revoke(memberInv.inviteId, irk);
      assert(own.status === 200, `own invite: ${own.status}: ${short(own.text)}`);
      return "403 / 200";
    });
    await rec.check("cleanup: the admin revokes its invite; back to open", async () => {
      assert(adminInv, "no admin invite");
      const r = await revoke(adminInv.inviteId, adminRoot);
      assert(r.status === 200, `revoke ${r.status}`);
      await setMode(A, b, serviceRef, "open");
      return "revoked";
    });
  },
};


// Account members, ranks and who may change them (owner decision 2026-10-15,
// docs/service-access-gating.md), on a live admin-pinned demo box. The box
// learns the account's devices from .com's grants and verifies them itself:
// the primary (admin) device signs in as master, a second non-admin device
// (an IRK-signed grant minted here) as manager. An admin order demotes or
// refuses a device; the IRK is refused for rank, mode and removal orders. A
// manager-class device invites at Member with its own key (the AID and IRK
// can't), its link stops letting new people in once it is demoted, and it
// withdraws its own invite (the person is out) but nobody else's.
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { deriveDemoPrimaryDeviceId } from "@flagship/control-plane";
import {
  appRankTargetDevice,
  deriveAccountDeviceKeySeed,
  deriveAppAccountId,
  deriveHouseholdKey,
  ed,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signAppMemberRole,
  signAppRank,
  signCreateServiceInvite,
  signDeviceCapabilityGrant,
  signKnockAuthorization,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServiceInviteListQuery,
  type AppMemberRoleOrder,
  type AppRankOrder,
  type CreateServiceInvite,
  type DeviceCapabilityGrant,
  type Keypair,
  type KnockAuthorization,
  type ServiceInviteListQuery,
} from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { CONTROL, KEK, assert, cookieVal, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { echoedFlagshipHeaders, installWhoami, setMode, setModeWithIrk, waitServing } from "./gating.js";
import type { Group } from "./types.js";

interface Invite {
  inviteId: string;
  secret: Uint8Array;
}

export const invites: Group = {
  name: "invites",
  title: "account members: per-device ranks on the box, admin-only orders, manager-class devices invite at Member and withdraw their own",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, box }) {
    const b = box("A1");
    const fqdn = b.fqdn;
    const slug = "club";
    const serviceRef = `${A.username}--${slug}`;
    const app = `https://${slug}.${fqdn}`;
    const { irk, aid, adminRoot, primaryDevice } = A.keys;
    const household = deriveHouseholdKey({ seed: A.keys.umk });
    const adminDeviceId = deriveDemoPrimaryDeviceId(hexToBytes(KEK), A.username);
    const phoneId = randomBytes(16).toString("hex");
    const phoneSeed = deriveAccountDeviceKeySeed(A.keys.umk, A.username, phoneId);
    const phone: Keypair = { privateKey: phoneSeed, publicKey: ed.getPublicKey(phoneSeed) };
    const friendA = deriveAppAccountId({ seed: new Uint8Array(32).fill(0xa1) }, serviceRef);
    const friendB = deriveAppAccountId({ seed: new Uint8Array(32).fill(0xb2) }, serviceRef);
    const friendC = deriveAppAccountId({ seed: new Uint8Array(32).fill(0xc3) }, serviceRef);
    const session = await pair(A, b);

    const installed = await rec.check("install the probe app (default_role: master), members only", async () => {
      await installWhoami(A, b, slug, { enabled: true, default_role: "master" });
      await waitServing(`${app}/`);
      await setMode(A, b, serviceRef, "restricted");
      return serviceRef;
    });
    if (!installed) return;

    await rec.check("a second, non-admin device joins the account (IRK-signed grant on .com)", async () => {
      const issuedAt = Date.now();
      const g: DeviceCapabilityGrant = {
        grantId: randomBytes(16).toString("hex"),
        username: A.username,
        deviceId: phoneId,
        devicePubKey: phone.publicKey,
        scopes: ["browse", "install-service", "vibe-code", "view-directory"],
        issuedAt,
        expiresAt: issuedAt + 24 * 3_600_000,
      };
      const r = await postJson(`https://${CONTROL}/api/users/${A.username}/device-grants`, {
        grant: { ...g, devicePubKey: bytesToHex(phone.publicKey) },
        signature: bytesToHex(signDeviceCapabilityGrant(g, irk)),
      });
      assert(r.status === 200, `mint ${r.status}: ${short(r.text)}`);
      return `device ${phoneId.slice(0, 8)}…`;
    });

    /** The rank the app sees for `who`, after a knock sign-in signed by it; null when the box refuses (401). */
    const appRole = async (who: Keypair): Promise<string | null> => {
      const k = await tryHttp(`${app}/private`, { headers: { accept: "text/html" } }, 45_000);
      const pageId = (/[?&#]page=([0-9a-f]+)/.exec(k.text) || [])[1] ?? "";
      const holder = cookieVal(k.setCookies, "Flagship-Knock") ?? "";
      assert(pageId && holder, `no knock page: ${k.status} ${short(k.text, 80)}`);
      const ka: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: who.publicKey, issuedAt: Date.now() };
      const auth = await postJson(`https://${fqdn}/api/service-access/knock/authorize`, {
        authorization: { ...ka, visitorAID: bytesToHex(who.publicKey) },
        sig: bytesToHex(signKnockAuthorization(ka, who)),
      });
      if (auth.status === 401) return null;
      assert(auth.status === 200, `authorize ${auth.status}: ${short(auth.text)}`);
      const poll = await http(`https://${fqdn}/__flagship/knock/${pageId}/status`, {
        headers: { accept: "application/json", cookie: `Flagship-Knock=${holder}` },
      });
      const cookie = cookieVal(poll.setCookies, "Flagship-App-Session");
      assert(cookie, `no session cookie: ${short(poll.json)}`);
      const g = await tryHttp(`${app}/private`, { headers: { accept: "text/html", cookie: `Flagship-App-Session=${cookie}` } }, 45_000);
      return echoedFlagshipHeaders(g.text)["x-flagship-role"] ?? null;
    };
    const rank = (target: string, r: string, signer: Keypair) => {
      const order: AppRankOrder = { serviceRef, target, rank: r, issuedAt: Date.now() };
      return postJson(
        `https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members/rank`,
        { order, signature: bytesToHex(signAppRank(order, signer)) },
        { "x-flagship-session": session },
      );
    };
    const members = async () => {
      const r = await http(`https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members`, {
        headers: { "x-flagship-session": session },
      });
      assert(r.status === 200, `members ${r.status}: ${short(r.text)}`);
      return r.json as {
        accountMembers: Array<{ kind: string; deviceId?: string; devicePub?: string; tier?: string; rank: string | null }>;
        members: Array<{ aid: string; role: string }>;
        invites: Array<{ inviteId: string; tier: string | null; creatorDeviceId: string | null }>;
      };
    };
    const create = async (signer: Keypair, label: string, deviceId?: string) => {
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
        request: { ...c, authorAID: bytesToHex(aid.publicKey), ...(deviceId ? { deviceId } : {}) },
        signature: bytesToHex(signCreateServiceInvite(c, signer)),
      });
      return { inv, status: r.status, tier: r.json?.tier as string | undefined, text: r.text };
    };
    const redeem = async (inv: Invite, who: Keypair) => {
      const redeemedAt = Date.now();
      const secretHash = serviceInviteSecretHash(inv.secret);
      return postJson(`https://${fqdn}/api/service-invites/redeem`, {
        secret: bytesToHex(inv.secret),
        visitorAID: bytesToHex(who.publicKey),
        aidSig: bytesToHex(signRedeemServiceInvite({ secretHash, visitorAID: who.publicKey, redeemedAt }, who)),
        redeemedAt,
      });
    };
    const withdraw = (inviteId: string, signer: Keypair) => {
      const revoke = { inviteId, issuedAt: Date.now() };
      return postJson(`https://${fqdn}/api/service-access/invite-withdraw`, {
        revoke,
        signature: bytesToHex(signRevokeServiceInvite(revoke, signer)),
      });
    };
    const comRevoke = (inviteId: string, signer: Keypair) => {
      const rv = { inviteId, issuedAt: Date.now() };
      return postJson(`https://${CONTROL}/api/users/${A.username}/service-invites/revoke`, {
        request: rv,
        signature: bytesToHex(signRevokeServiceInvite(rv, signer)),
      });
    };

    // ── default ranks per device ──────────────────────────────────────────
    await rec.check("DEFAULTS: the admin device signs in as master, the non-admin device as manager (members-only app)", async () => {
      const admin = await appRole(primaryDevice);
      const other = await appRole(phone);
      assert(admin === "master", `admin device role=${admin}`);
      assert(other === "manager", `non-admin device role=${other}`);
      return `master / manager`;
    });
    await rec.check("DEFAULTS: the members list shows both devices with their tier and rank, and no owner", async () => {
      const m = await members();
      const a = m.accountMembers.find((x) => x.deviceId === adminDeviceId);
      const p = m.accountMembers.find((x) => x.deviceId === phoneId);
      assert(a?.tier === "admin" && a.rank === "master", `admin row ${short(a)}`);
      assert(p?.tier === "member" && p.rank === "manager", `phone row ${short(p)}`);
      assert(!JSON.stringify(m).includes('"owner"'), "an owner rank leaked");
      return `${m.accountMembers.length} account members`;
    });

    // ── admin-only orders ─────────────────────────────────────────────────
    await rec.check("ADMIN-ONLY: the IRK can't change the mode, a rank or anything else (403)", async () => {
      const mode = await setModeWithIrk(A, b, serviceRef, "open");
      assert(mode.status === 403, `IRK mode: expected 403, got ${mode.status}`);
      const r = await rank(appRankTargetDevice(bytesToHex(phone.publicKey)), "master", irk);
      assert(r.status === 403, `IRK rank: expected 403, got ${r.status}`);
      const byPhone = await rank(appRankTargetDevice(bytesToHex(phone.publicKey)), "master", phone);
      assert(byPhone.status === 403, `non-admin device rank: expected 403, got ${byPhone.status}`);
      return "403 ×3";
    });

    // ── a manager-class device invites at Member ──────────────────────────
    let phoneInv: Invite | null = null;
    await rec.check("INVITE: the AID and IRK can't create an invite; the non-admin device's own key can (tier member)", async () => {
      const byIrk = await create(irk, "Gym IRK", phoneId);
      assert(byIrk.status === 403, `IRK create: expected 403, got ${byIrk.status}`);
      const byAid = await create(aid, "Gym AID", phoneId);
      assert(byAid.status === 403, `AID create: expected 403, got ${byAid.status}`);
      const own = await create(phone, "Gym Phone Pick", phoneId);
      assert(own.status === 200 && own.tier === "member", `device create ${own.status} tier=${own.tier}: ${short(own.text)}`);
      phoneInv = own.inv;
      return `invite ${own.inv.inviteId.slice(0, 8)}…`;
    });
    await rec.check("INVITE: the redeemer joins at Member although the manifest's default_role is master", async () => {
      assert(phoneInv, "no device invite");
      const r = await redeem(phoneInv, friendA);
      assert(r.status === 200 && r.json?.tier === "member", `redeem ${r.status}: ${short(r.text)}`);
      const role = await appRole(friendA);
      assert(role === "member", `role=${role}`);
      const row = (await members()).invites.find((x) => x.inviteId === phoneInv!.inviteId);
      assert(row?.creatorDeviceId === phoneId, `invite row ${short(row)}`);
      return "member, created by the phone";
    });
    await rec.check("RECORD: .com's owner-signed list proves the creating device", async () => {
      const issuedAt = Date.now();
      const q: ServiceInviteListQuery = { username: A.username, authorAID: bytesToHex(aid.publicKey), scope: "list", cursor: 0, issuedAt };
      const qs = new URLSearchParams({ authorAID: q.authorAID, scope: "list", cursor: "0", issuedAt: String(issuedAt), sig: bytesToHex(signServiceInviteListQuery(q, aid)) });
      const r = await http(`https://${CONTROL}/api/users/${A.username}/service-invites?${qs}`);
      assert(r.status === 200, `list ${r.status}: ${short(r.text)}`);
      const rows = (r.json?.invites ?? []) as Array<{ inviteId: string; creatorTier: string; creatorDeviceId: string | null }>;
      const mine = rows.find((x) => x.inviteId === phoneInv?.inviteId);
      assert(mine?.creatorTier === "member" && mine.creatorDeviceId === phoneId, `row ${short(mine)}`);
      return `member by ${phoneId.slice(0, 8)}…`;
    });

    // ── demotion: links stop letting new people in, no withdraw ───────────
    let laterInv: Invite | null = null;
    await rec.check("DEMOTE: an admin order makes the device a Member; it signs in as member", async () => {
      const later = await create(phone, "Gym Later", phoneId);
      assert(later.status === 200, `second create ${later.status}`);
      laterInv = later.inv;
      const r = await rank(appRankTargetDevice(bytesToHex(phone.publicKey)), "member", adminRoot);
      assert(r.status === 200, `rank ${r.status}: ${short(r.text)}`);
      await sleep(1100);
      const role = await appRole(phone);
      assert(role === "member", `role=${role}`);
      return "member";
    });
    await rec.check("DEMOTE: the demoted device's open link lets nobody new in (403), and it can't withdraw (403)", async () => {
      assert(laterInv && phoneInv, "missing invites");
      const r = await redeem(laterInv, friendC);
      assert(r.status === 403, `redeem: expected 403, got ${r.status}: ${short(r.text)}`);
      const w = await withdraw(phoneInv.inviteId, phone);
      assert(w.status === 403, `withdraw: expected 403, got ${w.status}: ${short(w.text)}`);
      const role = await appRole(friendA);
      assert(role === "member", `the person already in should stay: role=${role}`);
      return "403 / 403, friend stays";
    });
    await rec.check("REFUSE: an admin refuses the device; its sign-in is 401; then restores it to Manager", async () => {
      const r = await rank(appRankTargetDevice(bytesToHex(phone.publicKey)), "refused", adminRoot);
      assert(r.status === 200, `refuse ${r.status}: ${short(r.text)}`);
      const role = await appRole(phone);
      assert(role === null, `expected refused, got role=${role}`);
      await sleep(1100);
      const back = await rank(appRankTargetDevice(bytesToHex(phone.publicKey)), "manager", adminRoot);
      assert(back.status === 200, `restore ${back.status}`);
      return "401, restored";
    });

    // ── withdraw: own invites only, the people are out ────────────────────
    await rec.check("WITHDRAW: the device withdraws its own invite (.com + box) and the person it let in is out", async () => {
      assert(phoneInv, "no device invite");
      const c = await comRevoke(phoneInv.inviteId, phone);
      assert(c.status === 200, `.com revoke ${c.status}: ${short(c.text)}`);
      const w = await withdraw(phoneInv.inviteId, phone);
      assert(w.status === 200, `withdraw ${w.status}: ${short(w.text)}`);
      const role = await appRole(friendA);
      assert(role === null, `friend still in: role=${role}`);
      return `pruned ${w.json?.pruned}`;
    });
    let adminInv: Invite | null = null;
    await rec.check("ADMIN INVITE: the admin root invites at Manager; the device can't withdraw it", async () => {
      const made = await create(adminRoot, "Gym Admin Pick");
      assert(made.status === 200 && made.tier === "admin", `admin create ${made.status} tier=${made.tier}`);
      adminInv = made.inv;
      const order: AppMemberRoleOrder = { serverDomain: fqdn, serviceId: serviceRef, target: `invite:${made.inv.inviteId}`, role: "manager", issuedAt: Date.now() };
      const r = await postJson(
        `https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members/role`,
        { order, signature: bytesToHex(signAppMemberRole(order, adminRoot)) },
        { "x-flagship-session": session },
      );
      assert(r.status === 200, `role ${r.status}: ${short(r.text)}`);
      const red = await redeem(made.inv, friendB);
      assert(red.status === 200 && red.json?.tier === "admin", `redeem ${red.status}: ${short(red.text)}`);
      const role = await appRole(friendB);
      assert(role === "manager", `role=${role}`);
      const theirs = await comRevoke(made.inv.inviteId, phone);
      assert(theirs.status === 403, `device revoke of admin invite: expected 403, got ${theirs.status}`);
      const boxW = await withdraw(made.inv.inviteId, phone);
      assert(boxW.status === 403, `device withdraw of admin invite: expected 403, got ${boxW.status}`);
      return "manager; 403 / 403";
    });
    await rec.check("cleanup: the admin withdraws its invite; back to open", async () => {
      assert(adminInv, "no admin invite");
      const r = await comRevoke(adminInv.inviteId, adminRoot);
      assert(r.status === 200, `revoke ${r.status}`);
      const w = await withdraw(adminInv.inviteId, adminRoot);
      assert(w.status === 200, `withdraw ${w.status}`);
      await setMode(A, b, serviceRef, "open");
      return "revoked";
    });
  },
};

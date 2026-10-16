// Share a server (docs/share-a-server.md). On home2, A shares at the MANAGE
// level: B opens a share session with its per-share key, moves the box with a
// signed co-manager update (an unendorsed target is admitted, then refused by
// the release gate), signs in to a members-only app as Manager, and is refused
// owner-only actions until A revokes. On home, A shares at the VIEW level:
// the manage routes are refused until A raises the level (the open session
// picks it up), `.com` holds the offer, the acceptance, the unlock deposit and
// B's start-up push registration (kept only while the deposit names B's key),
// and B leaves on the box and on `.com`. The owner's activity log records it.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  deriveShareMemberKey,
  randomShareId,
  sealShareJson,
  shareAad,
  shareLinkKey,
  shareSha256Hex,
  shareTokenFromSecret,
  shareTokenHash,
  signKnockAuthorization,
  signServerShareAccept,
  signServerShareGrant,
  signServerShareLeave,
  signServerShareOffer,
  signServerSharePush,
  signServerShareRevoke,
  signServerShareSession,
  signServerShareUnlock,
  signServerShareUpdate,
  AAD_SHARE_ACCEPTANCE,
  AAD_SHARE_OFFER,
  AAD_SHARE_OWNER,
  type Keypair,
  type KnockAuthorization,
  type ServerShareAccept,
  type ServerShareGrant,
  type ServerShareLeave,
  type ServerShareOffer,
  type ServerSharePush,
  type ServerShareRevoke,
  type ServerShareSession,
  type ServerShareUnlock,
  type ServerShareUpdate,
  type ShareLevel,
} from "@flagship/protocol";
import { pair, type Account, type Box } from "../lib/fleet.js";
import { CONTROL, assert, cookieVal, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { echoedFlagshipHeaders, installWhoami, setMode, waitServing } from "./gating.js";
import type { Group } from "./types.js";

interface Share {
  shareId: string;
  member: Keypair;
  memberPubHex: string;
}

function newShare(B: Account): Share {
  const shareId = randomShareId();
  const member = deriveShareMemberKey({ seed: B.keys.umk }, shareId);
  return { shareId, member, memberPubHex: bytesToHex(member.publicKey) };
}

function grantFor(b: Box, sh: Share, level: ShareLevel): ServerShareGrant {
  return { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, level, unlockAtBoot: level === "manage", seeAppData: false, label: "gym co-manager", issuedAt: Date.now() };
}

/** Posts a share grant (admin root unless `signer`), with B's acceptance on the first one. */
function postGrant(b: Box, ownerSession: string, sh: Share, level: ShareLevel, signer: Keypair, withAccept: boolean) {
  const grant = grantFor(b, sh, level);
  const accept: ServerShareAccept = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, acceptedAt: Date.now() };
  return postJson(
    `https://${b.fqdn}/api/screens/shares`,
    { grant, signature: bytesToHex(signServerShareGrant(grant, signer)), ...(withAccept ? { accept, acceptSignature: bytesToHex(signServerShareAccept(accept, sh.member)) } : {}) },
    { "x-flagship-session": ownerSession },
  );
}

async function openSession(b: Box, sh: Share) {
  const n = await http(`https://${b.fqdn}/api/shares/nonce`);
  assert(n.status === 200 && n.json?.nonce, `nonce ${n.status}: ${short(n.text)}`);
  const session: ServerShareSession = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, nonceHex: n.json.nonce, issuedAt: Date.now() };
  return postJson(`https://${b.fqdn}/api/shares/session`, { session, signature: bytesToHex(signServerShareSession(session, sh.member)) });
}

/** The rank an app on `b` sees for `who` after a knock sign-in; null when the box refuses (401). */
async function knockRole(b: Box, slug: string, serviceRef: string, who: Keypair): Promise<string | null> {
  const app = `https://${slug}.${b.fqdn}`;
  const k = await tryHttp(`${app}/private`, { headers: { accept: "text/html" } }, 45_000);
  const pageId = (/[?&#]page=([0-9a-f]+)/.exec(k.text) || [])[1] ?? "";
  const holder = cookieVal(k.setCookies, "Flagship-Knock") ?? "";
  assert(pageId && holder, `no knock page: ${k.status} ${short(k.text, 80)}`);
  const ka: KnockAuthorization = { serverId: b.fqdn, serviceRef, pageId, visitorAID: who.publicKey, issuedAt: Date.now() };
  const auth = await postJson(`https://${b.fqdn}/api/service-access/knock/authorize`, {
    authorization: { ...ka, visitorAID: bytesToHex(who.publicKey) },
    sig: bytesToHex(signKnockAuthorization(ka, who)),
  });
  if (auth.status === 401) return null;
  assert(auth.status === 200, `authorize ${auth.status}: ${short(auth.text)}`);
  const poll = await http(`https://${b.fqdn}/__flagship/knock/${pageId}/status`, { headers: { accept: "application/json", cookie: `Flagship-Knock=${holder}` } });
  const cookie = cookieVal(poll.setCookies, "Flagship-App-Session");
  assert(cookie, `no session cookie: ${short(poll.json)}`);
  const g = await tryHttp(`${app}/private`, { headers: { accept: "text/html", cookie: `Flagship-App-Session=${cookie}` } }, 45_000);
  return echoedFlagshipHeaders(g.text)["x-flagship-role"] ?? null;
}

export const share: Group = {
  name: "share",
  title: "share a server: manage on home2 (update, Manager sign-in, refusals, revoke), view on home (refusals, level change, .com offer + unlock + push, leave)",
  needs: ["A1", "A2", "B1"],
  phase: 2,
  async run({ A, B, rec, box }) {
    await manageOnHome2(A, B!, rec, box("A2"));
    await viewOnHome(A, B!, rec, box("A1"));
  },
};

type Rec = Parameters<Group["run"]>[0]["rec"];

async function manageOnHome2(A: Account, B: Account, rec: Rec, b: Box): Promise<void> {
  const ownerSession = await pair(A, b);
  const os = { "x-flagship-session": ownerSession };
  const sh = newShare(B);
  const slug = "coapp";
  const serviceRef = `${A.username}--${slug}`;
  const appReady = installWhoami(A, b, slug, { enabled: true })
    .then(() => waitServing(`https://${slug}.${b.fqdn}/`).catch(() => undefined))
    .then(() => setMode(A, b, serviceRef, "restricted"))
    .then(() => true, (e: unknown) => String(e));

  await rec.check("a share grant signed by A's owner IRK is refused", async () => {
    const r = await postGrant(b, ownerSession, sh, "manage", A.keys.irk, true);
    assert(r.status === 403 || r.status === 400, `expected refusal, got ${r.status}: ${short(r.text)}`);
    return `${r.status}`;
  });
  const shared = await rec.check("A shares home2 with B (admin-root grant + B's acceptance)", async () => {
    const r = await postGrant(b, ownerSession, sh, "manage", A.keys.adminRoot, true);
    assert(r.status === 200 && r.json?.ok, `${r.status}: ${short(r.text)}`);
    return `share ${sh.shareId.slice(0, 8)}… level=manage`;
  });
  if (!shared) return;

  let token = "";
  const opened = await rec.check("B opens a share session (nonce + member-key signature)", async () => {
    const r = await openSession(b, sh);
    assert(r.status === 200 && r.json?.token, `${r.status}: ${short(r.text)}`);
    token = r.json.token;
    assert(r.json.level === "manage", `level=${r.json.level}`);
    return `level=${r.json.level}`;
  });
  if (!opened) return;
  const bs = { "x-flagship-session": token };
  let fromCommit = "";
  await rec.check("B sees the server (shares/me, server-detail, apps-list)", async () => {
    const me = await http(`https://${b.fqdn}/api/shares/me`, { headers: bs });
    assert(me.status === 200 && me.json?.shareId === sh.shareId, `me ${me.status}: ${short(me.text)}`);
    for (const p of ["/api/screens/server-detail", "/api/screens/apps-list"]) {
      const r = await http(`https://${b.fqdn}${p}`, { headers: bs });
      assert(r.status === 200, `${p} ${r.status}: ${short(r.text)}`);
      if (p.endsWith("server-detail")) fromCommit = String(r.json?.currentCommit ?? "");
    }
    return `canUpdate=${me.json.canUpdate}`;
  });
  await rec.check("B (manage) moves the box with a signed update: admitted (202), then the release gate refuses an unendorsed commit; a replay is 409", async () => {
    assert(/^[0-9a-f]{40}$/.test(fromCommit), `currentCommit=${fromCommit}`);
    const startedAt = Date.now();
    const update: ServerShareUpdate = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, targetCommit: randomBytes(20).toString("hex"), fromCommit, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
    const body = { update, signature: bytesToHex(signServerShareUpdate(update, sh.member)) };
    const forged = await postJson(`https://${b.fqdn}/api/shares/update`, { update, signature: bytesToHex(signServerShareUpdate(update, A.keys.irk)) }, bs);
    assert(forged.status === 403, `wrong key ${forged.status}: ${short(forged.text)}`);
    const r = await postJson(`https://${b.fqdn}/api/shares/update`, body, bs);
    assert(r.status === 202 && r.json?.accepted, `update ${r.status}: ${short(r.text)}`);
    const again = await postJson(`https://${b.fqdn}/api/shares/update`, body, bs);
    assert(again.status === 409, `replay ${again.status}: ${short(again.text)}`);
    for (let i = 0; i < 36; i++) {
      await sleep(5000);
      const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: os });
      const lu = d.json?.lastUpdate;
      if (lu && Number(lu.at) >= startedAt - 5000) {
        assert(lu.outcome === "refused" && lu.reason === "unendorsed", `lastUpdate ${short(lu)}`);
        assert(d.json.currentCommit === fromCommit, `the box moved to ${d.json.currentCommit}`);
        return `202, replay ${again.status} ${again.json?.code}, lastUpdate refused/unendorsed`;
      }
    }
    throw new Error("no lastUpdate verdict in 3 min");
  });
  await rec.check("B signs in to a members-only app on home2 with its share key and the app sees Manager", async () => {
    const ready = await appReady;
    assert(ready === true, `app setup: ${ready}`);
    const role = await knockRole(b, slug, serviceRef, sh.member);
    assert(role === "manager", `role=${role}`);
    return "manager";
  });
  await rec.check("B is refused owner-only actions (builds, MCP, copies, server order, share admin, activity, members)", async () => {
    const probes: Array<[string, string, unknown]> = [
      ["POST", "/api/build/mcp", { label: "x" }],
      ["POST", "/api/screens/services/copy", {}],
      ["POST", "/api/screens/server-order", {}],
      ["POST", "/api/screens/shares", {}],
      ["GET", "/api/screens/activity", undefined],
      ["GET", `/api/screens/services/${encodeURIComponent(serviceRef)}/members`, undefined],
    ];
    const got: string[] = [];
    for (const [method, path, body] of probes) {
      const r = await http(`https://${b.fqdn}${path}`, { method, headers: { "content-type": "application/json", ...bs }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      got.push(`${path.split("/").pop()}=${r.status}`);
      assert(r.status === 403 || r.status === 401, `${path} answered ${r.status}: ${short(r.text)}`);
    }
    return got.join(" ");
  });
  await rec.check("A revokes (admin-root signed) → B's session ends and the app refuses B's key", async () => {
    const revoke: ServerShareRevoke = { serverDomain: b.fqdn, shareId: sh.shareId, issuedAt: Date.now() };
    const r = await postJson(`https://${b.fqdn}/api/screens/shares/revoke`, { revoke, signature: bytesToHex(signServerShareRevoke(revoke, A.keys.adminRoot)) }, os);
    assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
    await sleep(1000);
    const me = await http(`https://${b.fqdn}/api/shares/me`, { headers: bs });
    assert(me.status === 403 || me.status === 401, `after revoke: ${me.status} ${short(me.text)}`);
    const role = await knockRole(b, slug, serviceRef, sh.member);
    assert(role === null, `the app still lets B in as ${role}`);
    return `${me.status}; app 401`;
  });
}

async function viewOnHome(A: Account, B: Account, rec: Rec, b: Box): Promise<void> {
  const ownerSession = await pair(A, b);
  const os = { "x-flagship-session": ownerSession };
  const sh = newShare(B);
  const view = await rec.check("A shares home with B at the VIEW level; B's session says view", async () => {
    const g = await postGrant(b, ownerSession, sh, "view", A.keys.adminRoot, true);
    assert(g.status === 200, `grant ${g.status}: ${short(g.text)}`);
    const s = await openSession(b, sh);
    assert(s.status === 200 && s.json?.level === "view", `session ${s.status}: ${short(s.text)}`);
    return "view";
  });
  if (!view) return;
  const s = await openSession(b, sh);
  const bs = { "x-flagship-session": String(s.json?.token) };
  await rec.check("VIEW: B reads the server, but the manage routes are refused (update, access requests: 403 manage-only)", async () => {
    const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: bs });
    assert(d.status === 200, `server-detail ${d.status}`);
    const update: ServerShareUpdate = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, targetCommit: "0".repeat(40), fromCommit: String(d.json?.currentCommit ?? "0".repeat(40)), nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
    const u = await postJson(`https://${b.fqdn}/api/shares/update`, { update, signature: bytesToHex(signServerShareUpdate(update, sh.member)) }, bs);
    assert(u.status === 403 && u.json?.code === "manage-only", `update ${u.status}: ${short(u.text)}`);
    const ar = await http(`https://${b.fqdn}/api/screens/access-requests`, { headers: bs });
    assert(ar.status === 403 && /manage-only/.test(ar.text), `access-requests ${ar.status}: ${short(ar.text)}`);
    return "update 403 manage-only, access-requests 403 manage-only";
  });
  await rec.check("A raises the share to MANAGE (a newer grant, no acceptance); B's open session picks it up", async () => {
    await sleep(1100);
    const g = await postGrant(b, ownerSession, sh, "manage", A.keys.adminRoot, false);
    assert(g.status === 200 && g.json?.created === false, `regrant ${g.status}: ${short(g.text)}`);
    const ar = await http(`https://${b.fqdn}/api/screens/access-requests`, { headers: bs });
    assert(ar.status === 200, `access-requests after raise ${ar.status}: ${short(ar.text)}`);
    return "access-requests 200";
  });

  // ── .com: the offer row, the acceptance, start-up approval ──────────────
  const secret = new Uint8Array(randomBytes(32));
  const shareToken = shareTokenFromSecret(secret);
  const th = { "x-flagship-share-token": shareToken };
  const linkKey = shareLinkKey(secret);
  const offered = await rec.check(".com takes A's offer (admin-root signed; the IRK is refused) and B's link reads it", async () => {
    const offerHex = sealShareJson(linkKey, shareAad(AAD_SHARE_OFFER, sh.shareId), { serverDomain: b.fqdn, level: "view", label: "gym" });
    const ownerHex = sealShareJson(linkKey, shareAad(AAD_SHARE_OWNER, sh.shareId), { note: "gym" });
    const offer: ServerShareOffer = { username: A.username, serverDomain: b.fqdn, shareId: sh.shareId, tokenHash: shareTokenHash(shareToken), offerSha256: shareSha256Hex(offerHex), ownerSha256: shareSha256Hex(ownerHex), expiresAt: Date.now() + 86_400_000, issuedAt: Date.now() };
    const post = (signer: Keypair) => postJson(`https://${CONTROL}/api/users/${A.username}/server-shares`, { offer, signature: bytesToHex(signServerShareOffer(offer, signer)), offerHex, ownerHex });
    const byIrk = await post(A.keys.irk);
    assert(byIrk.status === 403, `IRK offer ${byIrk.status}: ${short(byIrk.text)}`);
    const r = await post(A.keys.adminRoot);
    assert(r.status === 200, `offer ${r.status}: ${short(r.text)}`);
    const g = await http(`https://${CONTROL}/api/server-shares/${sh.shareId}`, { headers: th });
    assert(g.status === 200 && g.json?.state === "offered" && g.json?.unlock === false, `read ${g.status}: ${short(g.text)}`);
    const acc = await postJson(`https://${CONTROL}/api/server-shares/${sh.shareId}/accept`, { acceptance: sealShareJson(linkKey, shareAad(AAD_SHARE_ACCEPTANCE, sh.shareId), { memberPubHex: sh.memberPubHex }) }, th);
    assert(acc.status === 200, `accept ${acc.status}: ${short(acc.text)}`);
    const again = await postJson(`https://${CONTROL}/api/server-shares/${sh.shareId}/accept`, { acceptance: "00".repeat(40) }, th);
    assert(again.status === 409, `second accept ${again.status}`);
    const wrongToken = await http(`https://${CONTROL}/api/server-shares/${sh.shareId}`, { headers: { "x-flagship-share-token": "0".repeat(64) } });
    assert(wrongToken.status === 404, `wrong token ${wrongToken.status}`);
    return "IRK 403; offered → accepted; second accept 409; wrong token 404";
  });
  if (offered) {
    const providerToken = `gym-push-${randomBytes(8).toString("hex")}`;
    const push = (op: "put" | "delete") => {
      const p: ServerSharePush = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, op, platform: "webpush", tokenSha256: shareSha256Hex(providerToken), issuedAt: Date.now() };
      return postJson(`https://${CONTROL}/api/server-shares/${sh.shareId}/push`, { push: p, signature: bytesToHex(signServerSharePush(p, sh.member)), ...(op === "put" ? { providerToken } : {}) }, th);
    };
    const deposit = (memberPubHex: string, on: boolean) => {
      const sealedKey = randomBytes(80).toString("hex");
      const u: ServerShareUnlock = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex, sealedSha256: on ? shareSha256Hex(sealedKey) : "off", issuedAt: Date.now() };
      return postJson(`https://${CONTROL}/api/users/${A.username}/server-shares/${sh.shareId}/unlock`, { unlock: u, signature: bytesToHex(signServerShareUnlock(u, A.keys.adminRoot)), ...(on ? { sealedKey } : {}) });
    };
    await rec.check("notify-to-start: B's push registration is refused until A's unlock deposit names B's key, then kept", async () => {
      const before = await push("put");
      assert(before.status === 403 && before.json?.code === "unlock-not-shared", `before deposit ${before.status}: ${short(before.text)}`);
      const d = await deposit(sh.memberPubHex, true);
      assert(d.status === 200 && d.json?.unlock === true, `deposit ${d.status}: ${short(d.text)}`);
      const put = await push("put");
      assert(put.status === 200 && put.json?.push === true, `push ${put.status}: ${short(put.text)}`);
      const g = await http(`https://${CONTROL}/api/server-shares/${sh.shareId}`, { headers: th });
      assert(g.json?.unlock === true, `unlock flag ${short(g.json)}`);
      return "403 unlock-not-shared → deposit → push kept";
    });
    await rec.check("notify-to-start: a deposit naming another key refuses B's registration; withdrawing it drops B's token", async () => {
      await sleep(5);
      const other = await deposit(bytesToHex(deriveShareMemberKey({ seed: new Uint8Array(32).fill(0x5e) }, sh.shareId).publicKey), true);
      assert(other.status === 200, `other-key deposit ${other.status}: ${short(other.text)}`);
      const refused = await push("put");
      assert(refused.status === 403 && refused.json?.code === "unlock-not-shared", `push with another key's deposit ${refused.status}: ${short(refused.text)}`);
      await sleep(5);
      const off = await deposit(sh.memberPubHex, false);
      assert(off.status === 200 && off.json?.unlock === false, `deposit off ${off.status}: ${short(off.text)}`);
      const del = await push("delete");
      assert(del.status === 200 && del.json?.deleted === false, `token still on file after the deposit was withdrawn: ${short(del.text)}`);
      return "403; withdrawn → token gone";
    });
  }

  // ── B leaves ─────────────────────────────────────────────────────────────
  await rec.check("B leaves on the box: its session ends and a new one is refused (share-ended)", async () => {
    const leave: ServerShareLeave = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, issuedAt: Date.now() };
    const forged = await postJson(`https://${b.fqdn}/api/shares/leave`, { leave, signature: bytesToHex(signServerShareLeave(leave, A.keys.irk)) });
    assert(forged.status === 403, `leave signed by another key ${forged.status}`);
    const r = await postJson(`https://${b.fqdn}/api/shares/leave`, { leave, signature: bytesToHex(signServerShareLeave(leave, sh.member)) });
    assert(r.status === 200 && r.json?.ok, `leave ${r.status}: ${short(r.text)}`);
    const me = await http(`https://${b.fqdn}/api/shares/me`, { headers: bs });
    assert(me.status === 401, `old session ${me.status}`);
    const again = await openSession(b, sh);
    assert(again.status === 403 && /share-ended/.test(again.text), `new session ${again.status}: ${short(again.text)}`);
    return "401 / 403 share-ended";
  });
  if (offered) {
    await rec.check("B leaves on .com: the offer row ends", async () => {
      const leave: ServerShareLeave = { serverDomain: b.fqdn, shareId: sh.shareId, memberPubHex: sh.memberPubHex, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/server-shares/${sh.shareId}/leave`, { leave, signature: bytesToHex(signServerShareLeave(leave, sh.member)) }, th);
      assert(r.status === 200, `leave ${r.status}: ${short(r.text)}`);
      const g = await http(`https://${CONTROL}/api/server-shares/${sh.shareId}`, { headers: th });
      assert((g.status === 200 && g.json?.state === "ended") || g.status === 410, `after leave ${g.status}: ${short(g.text)}`);
      const ends = await http(`https://${CONTROL}/api/server/${b.fqdn}/share-ends?since=0`);
      assert((ends.json?.ends ?? []).some((e: { shareId: string; kind: string }) => e.shareId === sh.shareId && e.kind === "leave"), `share-ends ${short(ends.text)}`);
      return `${g.status} ${g.json?.state ?? ""}; share-ends lists the leave`;
    });
  }
  await rec.check("the owner's activity log records the share: granted, signed in, left", async () => {
    const r = await http(`https://${b.fqdn}/api/screens/activity?limit=200`, { headers: os });
    assert(r.status === 200, `activity ${r.status}`);
    const acts = (r.json?.entries ?? []) as Array<{ action: string; actor: { kind: string; shareId?: string } }>;
    // home carries this group's share only; the owner grants it, B signs in and leaves.
    const mine = (a: string) => acts.some((e) => e.action === a);
    const want = ["share.granted", "share.signed-in", "share.left"];
    const missing = want.filter((a) => !mine(a));
    assert(!missing.length, `missing ${missing.join(", ")} in ${short(acts.map((e) => e.action), 300)}`);
    return want.join(", ");
  });
}

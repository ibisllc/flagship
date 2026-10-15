// Service access on a real box, in today's model (docs/service-access-gating.md,
// docs/app-apis.md §2/§5): open apps forward anonymous visitors with
// X-Flagship-Visitor: anonymous and no identity; members-only apps knock
// except on `public_routes`; client-sent X-Flagship-* headers never reach the
// app; an invite redeemed under the visitor's PER-APP id becomes a member
// grant; the owner's admin-root-signed rank order moves member → manager →
// master; removing the person locks them out. traefik/whoami echoes the
// request headers the proxy sent, so the app's view is asserted directly.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  appMemberRoleTargetAid,
  deriveAppAccountId,
  deriveHouseholdKey,
  sealInviteBundle,
  serviceInviteId,
  serviceInviteSecretHash,
  signAppMemberRole,
  signCreateServiceInvite,
  signInstallService,
  signKnockAuthorization,
  signRedeemServiceInvite,
  signRemoveServiceAllow,
  signRevokeServiceInvite,
  signSetServiceAccessMode,
  type AppMemberRoleOrder,
  type CreateServiceInvite,
  type InstallServiceRequest,
  type KnockAuthorization,
  type RemoveServiceAllow,
  type RevokeServiceInvite,
  type SetServiceAccessMode,
} from "@flagship/protocol";
import { pair, type Account, type Box } from "../lib/fleet.js";
import { CONTROL, assert, cookieVal, http, postJson, short, sleep, tryHttp, type Resp } from "../lib/harness.js";
import type { Group } from "./types.js";

/** The X-Flagship-* request headers whoami echoed back (lower-cased names). */
export function echoedFlagshipHeaders(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^(X[-_]Flagship[-_][A-Za-z-_]+):\s*(.*)$/i.exec(line.trim());
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return out;
}

export async function installWhoami(acct: Account, box: Box, slug: string, access: Record<string, unknown>): Promise<void> {
  const manifestJson = JSON.stringify({
    schema_version: 1,
    name: slug,
    version: "0.1.0",
    description: "gym access probe",
    runtime: { image: "traefik/whoami", port: 80 },
    data: {},
    network: { subdomain: slug },
    access,
    migration: { verification: "standard" },
  });
  const req: InstallServiceRequest = { serverId: box.fqdn, creator: acct.username, slug, manifestJson, addOwnerToMembership: true, issuedAt: Date.now() };
  const r = await postJson(`https://${box.fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, acct.keys.irk)) }, {}, 120_000);
  assert(r.status === 200, `install ${r.status}: ${short(r.text, 240)}`);
}

export async function waitServing(url: string, seconds = 180): Promise<Resp> {
  let last = "";
  for (let i = 0; i < seconds / 5; i++) {
    const r = await tryHttp(url, { headers: { accept: "text/html" } }, 12_000);
    if (r.status === 200) return r;
    last = `${r.status} ${short(r.text, 80)}`;
    await sleep(5000);
  }
  throw new Error(`not serving in ${seconds}s: ${last}`);
}

export async function setMode(acct: Account, box: Box, serviceRef: string, mode: "open" | "restricted"): Promise<void> {
  const order: SetServiceAccessMode = { serverId: box.fqdn, serviceRef, mode, issuedAt: Date.now() };
  const r = await postJson(`https://${box.fqdn}/api/service-access`, { request: order, signature: bytesToHex(signSetServiceAccessMode(order, acct.keys.irk)) });
  assert(r.status === 200, `set-mode ${mode} ${r.status}: ${short(r.text)}`);
}

export const gating: Group = {
  name: "gating",
  title: "service access: open/members-only, public routes, header stripping, per-app invites, ranks, revoke",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, box }) {
    const b = box("A1");
    const fqdn = b.fqdn;
    const slug = "gate";
    const serviceRef = `${A.username}--${slug}`;
    const app = `https://${slug}.${fqdn}`;
    const { irk, aid: ownerAid, adminRoot } = A.keys;
    const household = deriveHouseholdKey({ seed: A.keys.umk });
    const friendUmk = { seed: new Uint8Array(32).fill(0xf2) };
    const friend = deriveAppAccountId(friendUmk, serviceRef);
    const friendHex = bytesToHex(friend.publicKey);
    const get = (path: string, headers: Record<string, string> = {}) =>
      tryHttp(`${app}${path}`, { headers: { accept: "text/html", ...headers } }, 15_000);

    const session = await pair(A, b);
    const installed = await rec.check("install the probe app (open, public route /pub/*)", async () => {
      await installWhoami(A, b, slug, { enabled: true, public_routes: ["/pub/*"] });
      await waitServing(`${app}/`);
      return serviceRef;
    });
    if (!installed) return;

    await rec.check("OPEN app: an anonymous visitor reaches the app as X-Flagship-Visitor: anonymous, with no user/role", async () => {
      const r = await get("/");
      assert(r.status === 200, `got ${r.status}`);
      const h = echoedFlagshipHeaders(r.text);
      assert(h["x-flagship-visitor"] === "anonymous", `visitor=${h["x-flagship-visitor"]} (${short(r.text, 200)})`);
      assert(!h["x-flagship-user"] && !h["x-flagship-role"], `identity leaked: ${JSON.stringify(h)}`);
      return "anonymous, no identity headers";
    });
    await rec.check("client-sent X-Flagship-* headers (dash and underscore) never reach the app", async () => {
      const r = await get("/", { "X-Flagship-Role": "owner", "X-Flagship-User": "forged-user", "X-Flagship-Visitor": "member" });
      const h = echoedFlagshipHeaders(r.text);
      assert(h["x-flagship-visitor"] === "anonymous", `visitor=${h["x-flagship-visitor"]}`);
      assert(!/forged-user/.test(r.text) && h["x-flagship-role"] !== "owner", `forged header passed: ${JSON.stringify(h)}`);
      const raw = await tryHttp(`${app}/`, { headers: { accept: "text/html", X_Flagship_Role: "owner" } }, 15_000);
      assert(!/X_Flagship_Role/i.test(raw.text), "underscore spelling reached the app");
      return "stripped";
    });
    await rec.check("the injected identity is box-signed (X-Flagship-Signature + runtime pubkey)", async () => {
      const r = await get("/");
      const h = echoedFlagshipHeaders(r.text);
      assert(/^[0-9a-f]{128}$/i.test(h["x-flagship-signature"] ?? ""), `signature=${h["x-flagship-signature"]}`);
      const pk = await http(`${app}/.flagship/runtime-pubkey`);
      assert(/^[0-9a-f]{64}$/.test(pk.json?.injectorPubKeyHex ?? ""), `runtime-pubkey ${pk.status}: ${short(pk.text)}`);
      return "signed + pubkey published";
    });

    await rec.check("owner sets members-only (owner-IRK signed)", async () => {
      await setMode(A, b, serviceRef, "restricted");
      const r = await http(`https://${fqdn}/api/service-access/${serviceRef}`);
      assert(r.json?.mode === "restricted", `mode=${r.json?.mode}`);
      return "mode=restricted";
    });
    let holder = "";
    let pageId = "";
    const knock = async (): Promise<void> => {
      const k = await get("/private");
      assert(k.status === 200 && /Access is restricted/i.test(k.text), `not the knock page: ${k.status} ${short(k.text, 80)}`);
      pageId = (/[?&]page=([0-9a-f]+)/.exec(k.text) || [])[1] ?? "";
      holder = cookieVal(k.setCookies, "Flagship-Knock") ?? "";
      assert(pageId && holder, "no pageId / Flagship-Knock holder cookie");
    };
    await rec.check("MEMBERS-ONLY: a browser gets the knock page (+ holder cookie, control-plane access link)", async () => {
      await knock();
      const k = await get("/private");
      assert(new RegExp(`${CONTROL.replace(/\./g, "\\.")}/access\\?`).test(k.text), "knock page lacks the control-plane /access link");
      return `page=${pageId.slice(0, 8)}…`;
    });
    await rec.check("MEMBERS-ONLY: a non-browser request is 403 JSON", async () => {
      const r = await tryHttp(`${app}/private`, { headers: { accept: "application/json" } });
      assert(r.status === 403 && r.json?.error === "access restricted", `got ${r.status}: ${short(r.text)}`);
      return `403 reason=${r.json?.reason}`;
    });
    await rec.check("MEMBERS-ONLY: a public_routes path is forwarded anonymously", async () => {
      const r = await get("/pub/hello");
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      assert(echoedFlagshipHeaders(r.text)["x-flagship-visitor"] === "anonymous", "not forwarded as anonymous");
      return "200 anonymous";
    });
    await rec.check("/__flagship/sign-in shows the sign-in knock page", async () => {
      const r = await get("/__flagship/sign-in?next=/private");
      assert(r.status === 200 && /Sign in/i.test(r.text), `got ${r.status}: ${short(r.text, 80)}`);
      return "sign-in page";
    });

    // ── invite → per-app redeem → member ──────────────────────────────────
    const secret = randomBytes(32);
    const secretHash = serviceInviteSecretHash(secret);
    const inviteId = serviceInviteId(ownerAid.publicKey, A.keys.primaryDevice.publicKey, Date.now() % 1_000_000);
    await rec.check(".com refuses an invite create signed by the owner IRK (admin-pinned account)", async () => {
      const create: CreateServiceInvite = { inviteId: inviteId + "x", authorAID: ownerAid.publicKey, serviceRef, secretHash, encryptedBundle: sealInviteBundle({ name: "x" }, household, inviteId + "x"), issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/users/${A.username}/service-invites`, {
        request: { ...create, authorAID: bytesToHex(ownerAid.publicKey) },
        signature: bytesToHex(signCreateServiceInvite(create, irk)),
      });
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    const created = await rec.check("invite created on .com (admin-root signed)", async () => {
      const create: CreateServiceInvite = { inviteId, authorAID: ownerAid.publicKey, serviceRef, secretHash, encryptedBundle: sealInviteBundle({ name: "Gym Friend" }, household, inviteId), issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/users/${A.username}/service-invites`, {
        request: { ...create, authorAID: bytesToHex(ownerAid.publicKey) },
        signature: bytesToHex(signCreateServiceInvite(create, adminRoot)),
      });
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      return `link: https://${fqdn}/invite#<secret>&a=${bytesToHex(ownerAid.publicKey).slice(0, 8)}…&i=${inviteId.slice(0, 8)}…&s=${serviceRef}`;
    });
    let memberCookie = "";
    const redeemed = created && (await rec.check("friend redeems under their PER-APP id (deriveAppAccountId(umk, serviceRef))", async () => {
      const redeemedAt = Date.now();
      const aidSig = bytesToHex(signRedeemServiceInvite({ secretHash, visitorAID: friend.publicKey, redeemedAt }, friend));
      const r = await postJson(`https://${fqdn}/api/service-invites/redeem`, { secret: bytesToHex(secret), visitorAID: friendHex, aidSig, redeemedAt });
      assert(r.status === 200 && r.json?.boundAID === friendHex, `redeem ${r.status}: ${short(r.text)}`);
      memberCookie = cookieVal(r.setCookies, "Flagship-App-Session") ?? "";
      return `bound ${friendHex.slice(0, 10)}…`;
    }));
    await rec.check("[deterministic] the friend's id differs per app (no cross-app linking)", () => {
      const other = deriveAppAccountId(friendUmk, `${A.username}--other`);
      assert(bytesToHex(other.publicKey) !== friendHex, "same id for two apps");
      return "distinct";
    });
    if (!redeemed) return;

    let secretId = "";
    await rec.check("knock → friend authorizes with the per-app id → holder poll gets the session → app sees a member", async () => {
      await knock();
      const k: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: friend.publicKey, issuedAt: Date.now() };
      const auth = await postJson(`https://${fqdn}/api/service-access/knock/authorize`, {
        authorization: { ...k, visitorAID: friendHex },
        sig: bytesToHex(signKnockAuthorization(k, friend)),
      });
      assert(auth.status === 200 && auth.json?.secretId, `authorize ${auth.status}: ${short(auth.text)}`);
      secretId = auth.json.secretId;
      const stranger = await http(`https://${fqdn}/__flagship/knock/${pageId}/status`, { headers: { accept: "application/json" } });
      assert(!cookieVal(stranger.setCookies, "Flagship-App-Session"), "a non-holder got the session cookie");
      const poll = await http(`https://${fqdn}/__flagship/knock/${pageId}/status`, { headers: { accept: "application/json", cookie: `Flagship-Knock=${holder}` } });
      assert(poll.json?.status === "authorized", `poll ${short(poll.json)}`);
      memberCookie = cookieVal(poll.setCookies, "Flagship-App-Session") ?? memberCookie;
      assert(memberCookie, "no session cookie");
      const r = await get("/private", { cookie: `Flagship-App-Session=${memberCookie}` });
      const h = echoedFlagshipHeaders(r.text);
      assert(r.status === 200 && h["x-flagship-visitor"] === "member", `visitor=${h["x-flagship-visitor"]} ${r.status}`);
      assert(h["x-flagship-role"] === "member" && h["x-flagship-user"], `role=${h["x-flagship-role"]} user=${h["x-flagship-user"]}`);
      return `member, user=${h["x-flagship-user"]?.slice(0, 10)}…`;
    });
    const roleOrder = (role: string, signer = adminRoot) => {
      const order: AppMemberRoleOrder = { serverDomain: fqdn, serviceId: serviceRef, target: appMemberRoleTargetAid(friendHex), role, issuedAt: Date.now() };
      return postJson(`https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members/role`, { order, signature: bytesToHex(signAppMemberRole(order, signer)) }, { "x-flagship-session": session });
    };
    await rec.check("the members list shows the friend as a member (paired session)", async () => {
      const r = await http(`https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members`, { headers: { "x-flagship-session": session } });
      assert(r.status === 200, `members ${r.status}: ${short(r.text)}`);
      const m = (r.json?.members ?? []).find((x: { aid: string }) => x.aid === friendHex);
      assert(m?.role === "member", `friend row: ${short(m)}`);
      return `${r.json.members.length} member(s), roles=${(r.json.roles ?? []).join("<")}`;
    });
    await rec.check("a rank order signed by the owner IRK is refused (admin root required)", async () => {
      const r = await roleOrder("manager", irk);
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    for (const role of ["manager", "master"]) {
      await rec.check(`rank → ${role} (admin-root signed); the app sees X-Flagship-Role: ${role}`, async () => {
        const r = await roleOrder(role);
        assert(r.status === 200, `role ${r.status}: ${short(r.text)}`);
        await sleep(1100);
        const g = await get("/private", { cookie: `Flagship-App-Session=${memberCookie}` });
        const h = echoedFlagshipHeaders(g.text);
        assert(h["x-flagship-role"] === role, `role=${h["x-flagship-role"]}`);
        return role;
      });
    }
    await rec.check("session status online, then close kills the browser session", async () => {
      const st = await postJson(`https://${fqdn}/api/service-access/session/status`, { secretId });
      assert(st.json?.status === "online", `status ${short(st.json)}`);
      const c = await postJson(`https://${fqdn}/api/service-access/session/close`, { secretId });
      assert(c.json?.closed === true, `close ${short(c.text)}`);
      const g = await get("/private", { cookie: `Flagship-App-Session=${memberCookie}` });
      assert(/Access is restricted/i.test(g.text), "closed cookie still reaches the app");
      return "closed";
    });
    await rec.check("owner removes the friend (allow-remove, owner IRK) → re-authorize is 401", async () => {
      const order: RemoveServiceAllow = { serverId: fqdn, serviceRef, aid: friendHex, issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/service-access/allow-remove`, { request: order, signature: bytesToHex(signRemoveServiceAllow(order, irk)) });
      assert(r.status === 200 && r.json?.removed === true, `allow-remove ${r.status}: ${short(r.text)}`);
      await knock();
      const k: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: friend.publicKey, issuedAt: Date.now() };
      const auth = await postJson(`https://${fqdn}/api/service-access/knock/authorize`, { authorization: { ...k, visitorAID: friendHex }, sig: bytesToHex(signKnockAuthorization(k, friend)) });
      assert(auth.status === 401, `expected 401, got ${auth.status}`);
      return "401";
    });
    await rec.check(".com invite revoke (admin-root signed) accepted", async () => {
      const revoke: RevokeServiceInvite = { inviteId, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/users/${A.username}/service-invites/revoke`, { request: revoke, signature: bytesToHex(signRevokeServiceInvite(revoke, adminRoot)) });
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      return "revoked";
    });
    await rec.check("back to OPEN: anonymous visitors reach /private again", async () => {
      await setMode(A, b, serviceRef, "open");
      const r = await get("/private");
      assert(r.status === 200 && echoedFlagshipHeaders(r.text)["x-flagship-visitor"] === "anonymous", `got ${r.status}`);
      return "open";
    });
  },
};

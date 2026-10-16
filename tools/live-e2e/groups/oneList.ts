// One access list per app across the account's servers (docs/service-access-
// gating.md "One list per app"), on account A's two live boxes: the same app
// on `home` and `home2`, `home` first in the server order (so it leads). An
// order sent to the follower reaches the leader; a person who joins on one box
// gets in on the other; a withdraw made while the follower is restarting
// holds there once it is back; and powering the leader off hands the role to
// `home2`, which then takes orders on its own. Runs late (it powers `home` off).
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCgkDelivery,
  signJournalRequest,
  type JournalRequest,
  cgkDeliveryToCarrierHex,
  deriveCGK,
  signDeviceEndpointClaim,
  deriveAppAccountId,
  deriveHouseholdKey,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signCreateServiceInvite,
  signKnockAuthorization,
  signPhoneOrder,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServerOrder,
  type CreateServiceInvite,
  type Keypair,
  type KnockAuthorization,
  type PhoneOrder,
  type ServerOrder,
} from "@flagship/protocol";
import { pair, pods } from "../lib/fleet.js";
import { CONTROL, assert, cookieVal, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { installWhoami, setMode, waitServing } from "./gating.js";
import type { Box } from "../lib/fleet.js";
import type { Group } from "./types.js";

export const oneList: Group = {
  name: "one-list",
  title: "one access list per app across home + home2: follower orders reach the leader, joins and withdraws everywhere, catch-up after a restart, leader hand-over",
  needs: ["A1", "A2"],
  phase: 8,
  async run({ A, rec, box, dir }) {
    const b1 = box("A1");
    const b2 = box("A2");
    const slug = "onelist";
    const serviceRef = `${A.username}--${slug}`;
    const household = deriveHouseholdKey({ seed: A.keys.umk });
    const friend = deriveAppAccountId({ seed: new Uint8Array(32).fill(0xd4) }, serviceRef);
    const [s1, s2] = [await pair(A, b1), await pair(A, b2)];

    const mode = async (b: Box) => {
      const r = await http(`https://${b.fqdn}/api/service-access/${encodeURIComponent(serviceRef)}`);
      return String(r.json?.mode ?? "");
    };
    /** Knock on `b`'s copy of the app as `who`: the HTTP status of the authorize (200 in, 401 out, 503 catching up). */
    const knock = async (b: Box, who: Keypair): Promise<number> => {
      const k = await tryHttp(`https://${slug}.${b.fqdn}/private`, { headers: { accept: "text/html" } }, 45_000);
      const pageId = (/[?&#]page=([0-9a-f]+)/.exec(k.text) || [])[1] ?? "";
      assert(pageId && cookieVal(k.setCookies, "Flagship-Knock"), `no knock page on ${b.serverName}: ${k.status} ${short(k.text, 80)}`);
      const ka: KnockAuthorization = { serverId: b.fqdn, serviceRef, pageId, visitorAID: who.publicKey, issuedAt: Date.now() };
      const r = await postJson(`https://${b.fqdn}/api/service-access/knock/authorize`, {
        authorization: { ...ka, visitorAID: bytesToHex(who.publicKey) },
        sig: bytesToHex(signKnockAuthorization(ka, who)),
      });
      return r.status;
    };
    /** On a failure: each box's leads and the gossip / hand-over lines of its daemon log, into the run's folder. */
    const diagnose = async (what: string) => {
      const out: Record<string, unknown> = {};
      for (const b of [b1, b2]) {
        const leads = await tryHttp(`https://${b.fqdn}/api/leads`, {}, 15_000).catch(() => null);
        const req: JournalRequest = { serverId: b.fqdn, unit: "flagship-daemon", lines: 2000, issuedAt: Date.now() };
        const j = await postJson(`https://${b.fqdn}/api/journal`, { request: req, signature: bytesToHex(signJournalRequest(req, A.keys.irk)) }).catch(() => null);
        const lines = ((j?.json?.lines ?? []) as string[]).filter((l) => /gossip|access-sync|cgk|device-book/i.test(String(l)));
        out[b.serverName] = { leads: leads?.json ?? leads?.status, log: lines.slice(-80) };
      }
      writeFileSync(join(dir, `one-list-${what.replace(/\W+/g, "-")}.json`), JSON.stringify(out, null, 2));
      return short(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as { leads: unknown }).leads]))), 600);
    };
    const until = async (what: string, f: () => Promise<boolean>, ms = 120_000, every = 5_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await f().catch(() => false)) return;
        await sleep(every);
      }
      throw new Error(`${what}: not within ${Math.round(ms / 1000)} s; ${await diagnose(what)}`);
    };

    // Gym boxes have no phone to hand them the account's cloud gossip key (the
    // box-to-box hand-over's key comes from it), so the gym deposits it, as the
    // owner's phone does after a box registers.
    const gossiping = await rec.check("both boxes get the cloud gossip key", async () => {
      const list = await pods(A.username);
      const cgk = deriveCGK(A.keys.umk);
      for (const b of [b1, b2]) {
        const stkHex = String(list.find((p) => p.serverDomain === b.fqdn)?.identityPubKey ?? "").toLowerCase();
        assert(/^[0-9a-f]{64}$/.test(stkHex), `no STK for ${b.serverName}`);
        const now = Date.now();
        const { delivery, signature } = buildCgkDelivery({
          serverDomain: b.fqdn,
          cgk,
          boxIdentityPub: Buffer.from(stkHex, "hex"),
          irk: A.keys.irk,
          issuedAt: now,
        });
        const nonce = randomBytes(32);
        const auth = { username: A.username, endpointLabel: "device", phoneIrkPub: A.keys.irk.publicKey, issuedAt: now, expiresAt: now + 120_000, nonce };
        const r = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/cgk-deposit`, {
          auth: { ...auth, phoneIrkPub: bytesToHex(auth.phoneIrkPub), nonce: bytesToHex(nonce) },
          authSignature: bytesToHex(signDeviceEndpointClaim(auth, A.keys.irk)),
          deposit: {
            serverDomain: b.fqdn,
            requestNonceHex: randomBytes(32).toString("hex"),
            stkPub: stkHex,
            sealed: cgkDeliveryToCarrierHex(delivery, signature),
            issuedAt: now,
          },
        });
        assert(r.status === 200, `cgk deposit ${b.serverName} ${r.status}: ${short(r.text)}`);
      }
      await until("both boxes gossip", async () => {
        for (const b of [b1, b2]) {
          const r = await tryHttp(`https://${b.fqdn}/api/leads`, {}, 15_000);
          if (r.json?.gossipActive !== true) return false;
        }
        return true;
      }, 8 * 60_000, 15_000);
      return "gossipActive on both";
    });
    if (!gossiping) return;

    const ready = await rec.check("the same app on both boxes, home first in the server order (home leads)", async () => {
      const list = await pods(A.username);
      const stk = (b: Box) => String(list.find((p) => p.serverDomain === b.fqdn)?.identityPubKey ?? "").toLowerCase();
      const order: ServerOrder = { user: A.username, stks: [stk(b1), stk(b2)], issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      const signature = signServerOrder(order, A.keys.adminRoot);
      const r = await postJson(`https://${CONTROL}/api/accounts/${A.username}/server-order`, { order, signature });
      assert(r.status === 200, `server order ${r.status}: ${short(r.text)}`);
      for (const [b, s] of [[b1, s1], [b2, s2]] as const) {
        const a = await postJson(`https://${b.fqdn}/api/screens/server-order`, { order, signature }, { "x-flagship-session": s });
        assert(a.status === 200, `${b.serverName} order ${a.status}`);
        await installWhoami(A, b, slug, { enabled: true, default_role: "member" });
        await waitServing(`https://${slug}.${b.fqdn}/`);
      }
      // Each box re-reads the account's servers and asks which run the app every 30 s.
      await sleep(45_000);
      return `leader ${b1.serverName} (first in the order)`;
    });
    if (!ready) return;

    await rec.check("an order on the follower (home2) reaches the leader (home)", async () => {
      await setMode(A, b2, serviceRef, "restricted");
      await until("home restricted", async () => (await mode(b1)) === "restricted", 4 * 60_000);
      return "home: restricted";
    });

    let inviteId = "";
    await rec.check("a person who joins on home2 gets in on home", async () => {
      const secret = randomBytes(32);
      inviteId = randomServiceInviteId();
      const c: CreateServiceInvite = {
        inviteId,
        authorAID: A.keys.aid.publicKey,
        serviceRef,
        secretHash: serviceInviteSecretHash(secret),
        encryptedBundle: sealInviteBundle({ name: "Gym One List" }, household, inviteId),
        issuedAt: Date.now(),
      };
      const made = await postJson(`https://${CONTROL}/api/users/${A.username}/service-invites`, {
        request: { ...c, authorAID: bytesToHex(A.keys.aid.publicKey) },
        signature: bytesToHex(signCreateServiceInvite(c, A.keys.adminRoot)),
      });
      assert(made.status === 200, `create ${made.status}: ${short(made.text)}`);
      const redeemedAt = Date.now();
      const secretHash = serviceInviteSecretHash(secret);
      const red = await postJson(`https://${b2.fqdn}/api/service-invites/redeem`, {
        secret: bytesToHex(secret),
        visitorAID: bytesToHex(friend.publicKey),
        aidSig: bytesToHex(signRedeemServiceInvite({ secretHash, visitorAID: friend.publicKey, redeemedAt }, friend)),
        redeemedAt,
      });
      assert(red.status === 200, `redeem on home2 ${red.status}: ${short(red.text)}`);
      await until("the friend gets in on home", async () => (await knock(b1, friend)) === 200, 4 * 60_000);
      return "200 on home";
    });

    await rec.check("a withdraw made while home2 restarts holds on home2 once it is back", async () => {
      const power: PhoneOrder = { type: "power-off", serverId: b2.fqdn, mode: "restart", issuedAt: Date.now() };
      const p = await postJson(`https://${b2.fqdn}/api/power`, { request: power, signature: bytesToHex(signPhoneOrder(power, A.keys.adminRoot)) });
      assert(p.status === 200, `restart home2 ${p.status}: ${short(p.text)}`);
      await until("home2 is down", async () => (await tryHttp(`https://${b2.fqdn}/api/front-page`, {}, 8_000)).status !== 200, 120_000, 3_000);
      const revoke = { inviteId, issuedAt: Date.now() };
      const signature = bytesToHex(signRevokeServiceInvite(revoke, A.keys.adminRoot));
      const w = await postJson(`https://${b1.fqdn}/api/service-access/invite-withdraw`, { revoke, signature });
      assert(w.status === 200, `withdraw on home ${w.status}: ${short(w.text)}`);
      assert((await knock(b1, friend)) === 401, "the friend still gets in on home");
      await until("home2 is back", async () => (await tryHttp(`https://${b2.fqdn}/api/front-page`, {}, 8_000)).status === 200, 10 * 60_000, 10_000);
      // From the moment it answers, home2 never lets the friend in: first it is
      // catching up (503), then it has the withdraw (401).
      const seen: number[] = [];
      const deadline = Date.now() + 3 * 60_000;
      while (Date.now() < deadline) {
        const s = await knock(b2, friend).catch(() => 0);
        seen.push(s);
        assert(s !== 200, `home2 let a withdrawn person in (statuses ${seen.join(",")})`);
        if (s === 401) break;
        await sleep(5_000);
      }
      assert(seen.at(-1) === 401, `home2 never settled on 401: ${seen.join(",")}`);
      return seen.join(",");
    });

    await rec.check("the leader going down hands the role to home2: it takes orders and new people on its own", async () => {
      const off: PhoneOrder = { type: "power-off", serverId: b1.fqdn, mode: "off", issuedAt: Date.now() };
      const p = await postJson(`https://${b1.fqdn}/api/power`, { request: off, signature: bytesToHex(signPhoneOrder(off, A.keys.adminRoot)) });
      assert(p.status === 200, `power off home ${p.status}: ${short(p.text)}`);
      b1.online = false;
      await until("home is down", async () => (await tryHttp(`https://${b1.fqdn}/api/front-page`, {}, 8_000)).status !== 200, 3 * 60_000, 5_000);
      await sleep(45_000);
      await setMode(A, b2, serviceRef, "open");
      assert((await mode(b2)) === "open", "home2 didn't apply its own order");
      await setMode(A, b2, serviceRef, "restricted");
      assert((await mode(b2)) === "restricted", "home2 didn't apply its second order");
      assert((await knock(b2, friend)) === 401, "the withdrawn friend got in on home2");
      return "home2 leads";
    });
  },
};

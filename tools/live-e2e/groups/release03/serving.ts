// The owner's one dead-man setting, live (docs/architecture-v2/serving-wiring.md): a serving policy with a time
// limit stops the box's app routes at the relay when no admin lease is live, while the box's own control name keeps
// answering; a lease (signed by the admin root, or by a P-256 renewal key the admin root delegated) brings them back;
// its end stops them again. Runs alone (it stops every app on A1 for a while) and leaves A1 on the default, no time
// limit. Skips when the gym's .com serves no revocation key (the relay then has no serving authority).
import { randomBytes } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ed,
  signServingLeaseP256,
  signServingRecord,
  type RenewalKeyDelegation,
  type ServingLease,
  type ServingPolicy,
} from "@flagship/protocol";
import { pair } from "../../lib/fleet.js";
import { CONTROL, SkipError, assert, http, postJson, short, sleep, tryHttp } from "../../lib/harness.js";
import { installWhoami, waitServing } from "../gating.js";
import type { Group } from "../types.js";
import { uninstall } from "./util.js";

const SLUG = "servewho";

export const serving: Group = {
  name: "serving",
  title: "the dead-man: a time limit stops a box's app routes at the relay without a lease, a lease restores them, its end stops them; the control name keeps answering",
  needs: ["A1"],
  phase: 4.5,
  async run({ A, rec, box }) {
    const acct = A!;
    const b = box("A1");
    const key = await tryHttp(`https://${CONTROL}/api/serving/revocation-key`);
    if (key.status !== 200) {
      await rec.check("the gym serves a revocation key (serving authority on)", async () => {
        throw new SkipError(`GET /api/serving/revocation-key ${key.status}: set SERVING_REVOCATION_SEED on the gym Worker and FLAGSHIP_SERVING_REVOCATION_PUB on the gym relay`);
      });
      return;
    }
    const session = { "x-flagship-session": await pair(acct, b) };
    const app = `https://${SLUG}.${b.fqdn}/`;
    const control = `https://${b.fqdn}/api/front-page`;
    const appUp = async () => (await tryHttp(app, { headers: { accept: "text/html" } }, 10_000)).status === 200;
    const controlUp = async () => (await tryHttp(control, {}, 10_000)).status === 200;
    const until = async (want: boolean, seconds: number): Promise<number> => {
      const t0 = Date.now();
      while (Date.now() - t0 < seconds * 1000) {
        if ((await appUp()) === want) return Date.now() - t0;
        await sleep(2000);
      }
      throw new Error(`the app was not ${want ? "served" : "stopped"} within ${seconds} s`);
    };
    const adminSign = (m: Uint8Array) => ed.sign(m, acct.keys.adminRoot.privateKey);
    let sv = { boxPub: "", regGen: 1, policyGen: 0, scopeSha256: "" };
    const policy = (o: Partial<ServingPolicy>): ServingPolicy => ({
      account: acct.username,
      box: sv.boxPub,
      regGen: sv.regGen,
      policyGen: ++sv.policyGen,
      grace: "7d",
      onLapse: "stop-apps",
      scopeSha256: sv.scopeSha256,
      issuedAt: Date.now(),
      ...o,
    });
    const setPolicy = async (p: ServingPolicy) => {
      const body = { policy: p, signature: bytesToHex(signServingRecord("serving-policy", p, adminSign)) };
      const c = await postJson(`https://${CONTROL}/api/accounts/${acct.username}/serving-policy`, body);
      assert(c.status === 200, `.com policy ${c.status}: ${short(c.text)}`);
      const x = await postJson(`https://${b.fqdn}/api/screens/serving`, { policy: { record: p, signature: body.signature } }, session);
      assert(x.status === 200 && x.json?.policyAdopted === true, `box policy ${x.status}: ${short(x.text)}`);
    };
    let lastNotAfter = 0;
    const postLease = async (lease: ServingLease, signature: string, delegationPub?: string) => {
      const r = await postJson(`https://${CONTROL}/api/accounts/${acct.username}/serving-leases`, {
        leases: [{ lease, signature, ...(delegationPub ? { delegationPub } : {}) }],
      });
      assert(r.status === 200 && r.json?.accepted >= 1, `.com lease ${r.status}: ${short(r.text)}`);
      lastNotAfter = Math.max(lastNotAfter, lease.notAfter);
    };
    const lease = (p: ServingPolicy, seconds: number): ServingLease => {
      const now = Date.now();
      return { account: p.account, box: p.box, regGen: p.regGen, policyGen: p.policyGen, leaseId: randomBytes(16).toString("hex"), issuedAt: now, notAfter: now + seconds * 1000 };
    };

    const ready = await rec.check("setup: an app is served and server-detail tells the policy's fields", async () => {
      await installWhoami(acct, b, SLUG, { enabled: false });
      await waitServing(app);
      const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: session });
      assert(d.json?.serving?.boxPub && d.json.serving.scopeSha256, `serving ${short(d.json?.serving)}`);
      sv = { boxPub: d.json.serving.boxPub, regGen: d.json.serving.regGen, policyGen: d.json.serving.policyGen, scopeSha256: d.json.serving.scopeSha256 };
      return `policyGen ${sv.policyGen}, regGen ${sv.regGen}`;
    });
    if (!ready) return;
    try {
      let p7: ServingPolicy | null = null;
      await rec.check("a 7-day policy with no lease stops the app at the relay; the control name keeps answering", async () => {
        p7 = policy({});
        await setPolicy(p7);
        const ms = await until(false, 90);
        assert(await controlUp(), "the control name stopped answering");
        return `app stopped ${(ms / 1000).toFixed(0)} s after the policy`;
      });
      if (!p7) return;
      const p = p7 as ServingPolicy;
      await rec.check("an admin-root lease brings the app back", async () => {
        const l = lease(p, 120);
        await postLease(l, bytesToHex(signServingRecord("serving-lease", l, adminSign)));
        const ms = await until(true, 90);
        return `served again ${(ms / 1000).toFixed(0)} s after the lease`;
      });
      await rec.check("a delegated P-256 renewal key's lease keeps it served; an undelegated one is refused by .com", async () => {
        const sk = p256.utils.randomSecretKey();
        const renewalPub = bytesToHex(p256.getPublicKey(sk, true));
        const stranger = lease(p, 600);
        const refused = await postJson(`https://${CONTROL}/api/accounts/${acct.username}/serving-leases`, {
          leases: [{ lease: stranger, signature: signServingLeaseP256(stranger, sk), delegationPub: renewalPub }],
        });
        assert(refused.status === 200 && (refused.json?.accepted ?? 0) === 0, `undelegated: ${short(refused.text)}`);
        const d: RenewalKeyDelegation = { account: acct.username, alg: "p256", renewalPub, deviceId: bytesToHex(acct.keys.primaryDevice.publicKey), issuedAt: Date.now() };
        const dr = await postJson(`https://${CONTROL}/api/accounts/${acct.username}/renewal-delegations`, {
          delegation: d,
          signature: bytesToHex(signServingRecord("renewal-key-delegation", d, adminSign)),
        });
        assert(dr.status === 200, `delegation ${dr.status}: ${short(dr.text)}`);
        const l = lease(p, 150);
        await postLease(l, signServingLeaseP256(l, sk), renewalPub);
        assert(await appUp(), "the app is not served under the delegated lease");
        return `delegated key ${renewalPub.slice(0, 10)}… accepted`;
      });
      await rec.check("when the last lease ends the app stops within seconds; the control name keeps answering", async () => {
        const end = lastNotAfter;
        await sleep(Math.max(0, end - Date.now() - 20_000));
        const ms = await until(false, 60);
        const late = Date.now() - end;
        assert(await controlUp(), "the control name stopped answering");
        assert(late < 15_000, `stopped ${(late / 1000).toFixed(0)} s after the lease ended (the relay should close within 5 s)`);
        return `stopped ${(late / 1000).toFixed(1)} s after the lease ended (waited ${(ms / 1000).toFixed(0)} s)`;
      });
    } finally {
      await rec.check("cleanup: back to no time limit (the default); the app is served again", async () => {
        await setPolicy(policy({ grace: "indefinite" }));
        await until(true, 90);
        await uninstall(acct, b, SLUG);
        return `policyGen ${sv.policyGen}, no time limit`;
      });
    }
  },
};

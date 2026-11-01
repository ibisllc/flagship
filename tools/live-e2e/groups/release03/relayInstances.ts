// The relay as SEVERAL machines (Appendix H scenario 8 "repeat across multiple relay instances"; Appendix I 9.3
// "every relay instance", 9.8 "multi-relay cache expiry"; plan H3 "exclusivity across relay instances", H8 "pushes
// each entry to every relay instance"). Tunnels are pinned to a machine with Fly's `fly-force-instance-id` header;
// visitors at :443 land wherever Fly's balancer sends them, so a probe tries several times and counts.
//
// Skips unless the release manager runs the gym relay on two or more machines and names them:
//   flyctl scale count 2 -a flagship-services-gym
//   GYM_RELAY_INSTANCES="$(flyctl machines list -a flagship-services-gym --json | jq -r '[.[].id] | join(",")')"
// (and back to one machine after the run if the gym is meant to stay on one).
// Runs alone; never touches A1 beyond reading its address. Leaves behind: three revoked throwaway servers.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, nameListSha256, signRevokeDeviceCapabilityGrant, signServingRecord, type ServingPolicy } from "@flagship/protocol";
import { mintDeviceGrant } from "../../lib/fleet.js";
import { pinInstance, registerSimServer, relayInstances as machineIds, revokeServer, simHelloPayload, SimBox, visitSim, type SimServer } from "../../lib/boxSim.js";
import { CONTROL, SERVICES, SkipError, assert, http, postJson, short, sleep, tryHttp } from "../../lib/harness.js";
import { SimPhone, selfSignedPhoneCert } from "../../lib/phoneSim.js";
import type { Group } from "../types.js";

const REVOKE_DEADLINE_MS = 65_000;

export const relayInstances: Group = {
  name: "relay-instances",
  title: "across every gym relay machine (GYM_RELAY_INSTANCES): a revocation ends the tunnel wherever it is and no machine takes it back; a policy change reaches the machine holding the box; the phone name has one holder across machines and never reaches a box",
  needs: ["A1"],
  phase: 10.65,
  parallel: false,
  async run({ A, rec, box }) {
    const acct = A;
    const user = acct.username;
    let ids: string[] = [];
    try {
      ids = machineIds();
    } catch (e) {
      await rec.check("GYM_RELAY_INSTANCES names the gym relay's machines", async () => {
        throw new Error((e as Error).message);
      });
      return;
    }
    if (ids.length < 2) {
      await rec.check("the gym relay runs on two or more machines", async () => {
        throw new SkipError(
          'the gym relay is one machine: `flyctl scale count 2 -a flagship-services-gym`, then set GYM_RELAY_INSTANCES to the machine ids (comma-separated, `flyctl machines list -a flagship-services-gym`)',
        );
      });
      return;
    }
    const key = await tryHttp(`https://${CONTROL}/api/serving/revocation-key`);
    const ep = await http(`https://${CONTROL}/api/services/endpoints`);
    const tunnelUrl = typeof ep.json?.tunnelHub === "string" ? (ep.json.tunnelHub as string) : "";
    if (key.status !== 200 || !tunnelUrl) {
      await rec.check("the gym relay has the serving authority on", async () => {
        throw new SkipError(`revocation key ${key.status}, tunnelHub ${tunnelUrl || "(none)"}`);
      });
      return;
    }
    const relayIp = (await lookup(box("A1").fqdn, { family: 4 })).address;
    const adminPub = bytesToHex(acct.keys.adminRoot.publicKey);
    const adminSign = (m: Uint8Array) => ed.sign(m, acct.keys.adminRoot.privateKey);
    const sims: SimBox[] = [];
    const phones: SimPhone[] = [];
    const servers: SimServer[] = [];
    const grants: string[] = [];

    const register = async () => {
      const r = await registerSimServer(acct);
      assert(r.status === 200 || r.status === 201, `register ${r.status}: ${short(r.text)}`);
      servers.push(r);
      return r;
    };
    const connectOn = async (s: SimServer, id: string, label: string, canonicals: string[] = []) => {
      const payload = await simHelloPayload({ username: user, server: s, irk: acct.keys.irk, rootSigner: acct.keys.adminRoot, canonicals, serving: { servingAdminKey: adminPub, servingPolicy: null } });
      try {
        const b = await SimBox.connect(tunnelUrl, payload, { label, headers: pinInstance(id) });
        sims.push(b);
        return b;
      } catch {
        return null;
      }
    };
    /** Visits `sni` `n` times; how many reached the simulated box `label`. */
    const hits = async (sni: string, label: string, n = 8) => {
      let k = 0;
      for (let i = 0; i < n; i++) if ((await visitSim(relayIp, sni)).label === label) k++;
      return k;
    };

    try {
      await rec.check("H8/I-3: a box revoked while its tunnel sits on the second machine is cut within 65 s, and a reconnect pinned to EVERY machine is refused", async () => {
        const v = await register();
        const b = await connectOn(v, ids[1]!, "V");
        assert(b?.accepted, `V's HELLO on ${ids[1]}: ${short(b?.ack ?? b?.closedWith)}`);
        const r = await revokeServer(acct, v.fqdn);
        assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
        const t0 = Date.now();
        await Promise.race([b.closed, sleep(REVOKE_DEADLINE_MS + 5_000)]);
        assert(b.closedWith && b.closedWith.at - t0 <= REVOKE_DEADLINE_MS, "the tunnel outlived the deadline");
        const again: string[] = [];
        for (const id of ids) {
          const c = await connectOn(v, id, `V@${id}`);
          assert(!c?.accepted, `machine ${id} took the revoked box back`);
          again.push(`${id}: ${String(c?.ack?.reason ?? c?.closedWith?.reason ?? "refused at upgrade")}`);
        }
        return `cut ${((b.closedWith.at - t0) / 1000).toFixed(1)} s after the revocation; ${again.join("; ")}`;
      });

      await rec.check("I-8: a stricter policy posted to .com stops the box's app routes on the machine holding its tunnel (pushed, not waited out); control stays", async () => {
        const w = await register();
        const app = `simapp.${w.fqdn}`;
        const b = await connectOn(w, ids[ids.length - 1]!, "W", [app]);
        assert(b?.accepted, `W's HELLO: ${short(b?.ack ?? b?.closedWith)}`);
        assert((await hits(app, "W", 10)) > 0, "W's app never answered on any visit (no visit landed on its machine?)");
        const p: ServingPolicy = {
          account: user,
          box: w.stkHex,
          regGen: 1,
          policyGen: 1,
          grace: "7d",
          onLapse: "stop-apps",
          scopeSha256: nameListSha256([{ class: "control", name: w.fqdn }, { class: "apps", name: `*.${w.fqdn}` }]),
          issuedAt: Date.now(),
        };
        const r = await postJson(`https://${CONTROL}/api/accounts/${user}/serving-policy`, { policy: p, signature: bytesToHex(signServingRecord("serving-policy", p, adminSign)) });
        assert(r.status === 200, `policy ${r.status}: ${short(r.text)}`);
        const t0 = Date.now();
        let stopped = false;
        while (Date.now() - t0 < 60_000 && !stopped) {
          stopped = (await hits(app, "W", 6)) === 0;
          if (!stopped) await sleep(2_000);
        }
        assert(stopped, "W's app still answers 60 s after the policy");
        assert((await hits(w.fqdn, "W", 10)) > 0, "W's control name no longer answers");
        await revokeServer(acct, w.fqdn);
        return `app routes stopped within ${Math.round((Date.now() - t0) / 1000)} s; control answers`;
      });

      await rec.check("H3/H7: the phone name has one holder across machines: phone 2 on another machine is refused route-held, takes over only after phone 1 leaves, and the name never reaches a box", async () => {
        const url = tunnelUrl.replace(/\/tunnel$/, "/phone-tunnel");
        const bare = `${user}.${SERVICES}`;
        const seeds = [new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32))];
        for (const sd of seeds) {
          const g = await mintDeviceGrant(acct, randomBytes(16).toString("hex"), { privateKey: sd, publicKey: ed.getPublicKey(sd) }, ["admin"], acct.keys.adminRoot);
          assert(g.status === 200 && typeof g.json?.grantId === "string", `grant ${g.status}: ${short(g.text)}`);
          grants.push(g.json.grantId as string);
        }
        const open = async (i: number) => {
          const p = await SimPhone.connect(url, { account: user, seed: seeds[i]!, label: `P${i + 1}`, tls: selfSignedPhoneCert(bare), headers: pinInstance(ids[i]!) });
          phones.push(p);
          return p;
        };
        const p1 = await open(0);
        const g1 = await p1.acquire();
        assert(g1.type === "granted", `phone 1 on ${ids[0]}: ${JSON.stringify(g1)}`);
        const p2 = await open(1);
        const r2 = await p2.acquire();
        assert(r2.type === "refused" && r2.code === "route-held", `phone 2 on ${ids[1]} while phone 1 holds: ${JSON.stringify(r2)}`);
        for (let i = 0; i < 6; i++) assert((await visitSim(relayIp, bare)).label === null, "the bare name reached a box");
        p1.terminate();
        await p1.closed;
        await p2.next((m) => m.type === "route-vacant", 30_000);
        const g2 = await p2.acquire();
        assert(g2.type === "granted", `phone 2 after phone 1 left: ${JSON.stringify(g2)}`);
        const p1b = await SimPhone.connect(url, { account: user, seed: seeds[0]!, label: "P1b", headers: pinInstance(ids[0]!) });
        phones.push(p1b);
        const back = await p1b.acquire();
        assert(back.type === "refused" && back.code === "route-held", `phone 1 back on ${ids[0]}: ${JSON.stringify(back)}`);
        return `generation ${String(g1.generation)} on ${ids[0]} → ${String(g2.generation)} on ${ids[1]}; phone 1's return refused`;
      });

      rec.skip(
        "I-3 / I-8: a relay machine that misses the revocation push (partitioned) still ends the box within 65 s",
        "needs a fault switch that drops one machine's serving feed (none is built); unit-covered by apps/web/tests/servingFeedClient.test.ts (gap fill) and servingGate.test.ts (lost contact)",
      );
    } finally {
      for (const b of sims) b.terminate();
      for (const p of phones) p.terminate();
      for (const s of servers) await revokeServer(acct, s.fqdn).catch(() => undefined);
      for (const grantId of grants) {
        const r = { grantId, username: user, reason: "decommissioned" as const, issuedAt: Date.now() };
        await postJson(`https://${CONTROL}/api/users/${user}/device-grants/revoke`, { request: r, signature: bytesToHex(signRevokeDeviceCapabilityGrant(r, acct.keys.irk)) }).catch(() => undefined);
      }
    }
  },
};

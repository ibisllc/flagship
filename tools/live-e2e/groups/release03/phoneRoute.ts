// The phone's bare `<account>.<apex>` name through the gym relay (plan H3, docs/architecture-v2/phone-route.md;
// Appendix H scenarios 6, 7, 8). Two simulated admin phones (node, lib/phoneSim.ts) with their own keys, admin grants
// on the gym .com and self-signed certificates for exactly the bare name. Handover is vacancy-only (owner, 2026-11-01):
// a claim by a non-admin key (what a box or a member device holds) is refused; phone 1 claims the vacant name and a
// visitor's TLS peer is phone 1; phone 2's signed hello gets a 2xx and is recorded; phone 2's claim is refused
// route-held; phone 1 releases, phone 2 hears route-vacant and claims, phone 1 cannot take it back; phone 2
// disconnecting closes the name (no box fallback) and wakes standby phone 1; revoking a grant ends a claim. The relay may run several instances: a visitor that lands on one not holding the phone's tunnel is closed,
// so each probe tries a few times and counts what it reached. Skips when the relay has no phone route.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, signRevokeDeviceCapabilityGrant } from "@flagship/protocol";
import { mintDeviceGrant } from "../../lib/fleet.js";
import { CONTROL, SERVICES, SkipError, assert, http, postJson, short, sleep } from "../../lib/harness.js";
import { SimPhone, sayHello, selfSignedPhoneCert } from "../../lib/phoneSim.js";
import type { Group } from "../types.js";

/** What one visitor reached: the phone's label, or null (closed without an answer). */
async function visit(ip: string, hostname: string, ca: string[], timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    const s = tlsConnect({ host: ip, port: 443, servername: hostname, ca, checkServerIdentity: () => undefined });
    s.setTimeout(timeoutMs, () => finish(null));
    s.on("secureConnect", () => {
      const cn = s.getPeerCertificate()?.subject?.CN;
      if (cn !== hostname) return finish(`wrong-cert:${String(cn)}`);
      s.write(`GET /.well-known/flagship-phone HTTP/1.1\r\nhost: ${hostname}\r\nconnection: close\r\n\r\n`);
    });
    s.on("data", (d) => (text += d.toString()));
    s.on("end", () => {
      const m = /"phone":"([^"]+)"/.exec(text);
      finish(m ? m[1]! : null);
    });
    s.on("error", () => finish(null));
  });
}

async function visits(ip: string, hostname: string, ca: string[], n = 6): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (let i = 0; i < n; i++) out.push(await visit(ip, hostname, ca));
  return out;
}

export const phoneRoute: Group = {
  name: "phone-route",
  title: "the bare account name routes only to the admin phone holding it (vacancy-only claims, presence hello, release and standby, no box fallback, revocation)",
  needs: ["A1"],
  phase: 4,
  async run({ A, rec, box }) {
    const acct = A!;
    const bare = `${acct.username}.${SERVICES}`;
    const ep = await http(`https://${CONTROL}/api/services/endpoints`);
    const hub = typeof ep.json?.tunnelHub === "string" ? (ep.json.tunnelHub as string) : "";
    const url = hub.replace(/\/tunnel$/, "/phone-tunnel");
    let probe: SimPhone | null = null;
    try {
      probe = await SimPhone.connect(url, { account: acct.username, seed: randomBytes(32) });
    } catch (e) {
      await rec.check("the gym relay offers /phone-tunnel", async () => {
        throw new SkipError(`no phone tunnel at ${url || "(no tunnelHub)"}: ${String(e)} (the relay needs the serving authority on)`);
      });
      return;
    }
    probe.close();

    // The relay's address: the box's name resolves there (the bare name may not have its own record).
    const relayIp = (await lookup(box("A1").fqdn, { family: 4 })).address;
    const certs = { p1: selfSignedPhoneCert(bare), p2: selfSignedPhoneCert(bare) };
    const ca = [certs.p1.cert, certs.p2.cert];
    const seeds = { p1: randomBytes(32), p2: randomBytes(32), member: randomBytes(32) };
    const kp = (s: Uint8Array) => ({ privateKey: s, publicKey: ed.getPublicKey(s) });
    const grantIds: Record<string, string> = {};
    const phones: SimPhone[] = [];
    const open = async (seed: Uint8Array, label: string, tls?: { key: string; cert: string }) => {
      const p = await SimPhone.connect(url, { account: acct.username, seed, label, ...(tls ? { tls } : {}) });
      phones.push(p);
      return p;
    };

    try {
      await rec.check("two admin phones and a member device get grants on .com", async () => {
        for (const [name, seed, scopes, signer] of [
          ["p1", seeds.p1, ["admin"], acct.keys.adminRoot],
          ["p2", seeds.p2, ["admin"], acct.keys.adminRoot],
          ["member", seeds.member, ["browse"], acct.keys.irk],
        ] as const) {
          const r = await mintDeviceGrant(acct, randomBytes(16).toString("hex"), kp(seed), [...scopes], signer);
          assert(r.status === 200 && typeof r.json?.grantId === "string", `${name} grant ${r.status}: ${short(r.text)}`);
          grantIds[name] = r.json.grantId as string;
        }
      });

      await rec.check("scenario 6: a non-admin key (the IRK every box is entitled under, a member device) cannot claim the bare name", async () => {
        const irk = await open(acct.keys.irk.privateKey, "irk");
        const a = await irk.acquire();
        assert(a.type === "refused" && a.code === "not-eligible", `IRK claim: ${JSON.stringify(a)}`);
        const member = await open(seeds.member, "member");
        const b = await member.acquire();
        assert(b.type === "refused" && b.code === "not-eligible", `member claim: ${JSON.stringify(b)}`);
        const seen = await visits(relayIp, bare, ca, 3);
        assert(seen.every((v) => v === null), `the bare name answered with no holder: ${JSON.stringify(seen)}`);
        const own = await http(`https://${box("A1").fqdn}/api/front-page`);
        assert(own.status === 200, `the box's own name stopped answering: ${own.status}`);
        return `refused ${a.code}/${b.code}; bare name closed; ${box("A1").fqdn} still 200`;
      });

      let p1!: SimPhone;
      await rec.check("phone 1 claims the vacant name; a visitor's TLS peer is phone 1's own certificate", async () => {
        p1 = await open(seeds.p1, "P1", certs.p1);
        const g = await p1.acquire();
        assert(g.type === "granted", `phone 1: ${JSON.stringify(g)}`);
        const seen = await visits(relayIp, bare, [certs.p1.cert]);
        assert(seen.includes("P1"), `no visitor reached phone 1: ${JSON.stringify(seen)}`);
        assert(seen.every((v) => v === "P1" || v === null), `a visitor reached something else: ${JSON.stringify(seen)}`);
        return `generation ${String(g.generation)}; ${seen.filter((v) => v === "P1").length}/${seen.length} visitors reached phone 1`;
      });

      const p2Pub = bytesToHex(ed.getPublicKey(seeds.p2));
      await rec.check("presence: phone 2's signed hello to https://<account>.<apex>/ gets a 2xx and phone 1 records it", async () => {
        let answer: string | null = null;
        for (let i = 0; i < 6 && answer === null; i++) {
          answer = await sayHello({ ip: relayIp, hostname: bare, account: acct.username, seed: seeds.p2, ca: [certs.p1.cert] });
        }
        assert(answer === "P1", `hello answered by ${String(answer)}`);
        assert(p1.seen.has(p2Pub), "phone 1 did not record phone 2's hello");
      });

      let p2!: SimPhone;
      await rec.check("scenario 7: while phone 1 holds the name, phone 2 is refused route-held with phone 1's generation; visitors stay with phone 1", async () => {
        p2 = await open(seeds.p2, "P2", certs.p2);
        const r = await p2.acquire();
        assert(r.type === "refused" && r.code === "route-held", `phone 2: ${JSON.stringify(r)}`);
        const seen = await visits(relayIp, bare, ca);
        assert(!seen.includes("P2") && seen.includes("P1"), `visitors: ${JSON.stringify(seen)}`);
        return `refused route-held at generation ${String(r.generation)}`;
      });

      await rec.check("scenario 7: phone 1 releases (signed); standby phone 2 hears route-vacant, claims, and new visitors reach phone 2; phone 1 cannot take it back", async () => {
        const rel = await p1.release();
        assert(rel.type === "released", `release: ${JSON.stringify(rel)}`);
        const vacant = await p2.next((m) => m.type === "route-vacant", 20_000);
        const g = await p2.acquire();
        assert(g.type === "granted", `phone 2 after route-vacant: ${JSON.stringify(g)}`);
        const seen = await visits(relayIp, bare, ca);
        assert(seen.includes("P2") && !seen.includes("P1"), `visitors after the release: ${JSON.stringify(seen)}`);
        const back = await p1.acquire();
        assert(back.type === "refused" && back.code === "route-held", `phone 1 retake: ${JSON.stringify(back)}`);
        return `vacant at generation ${String(vacant.generation)}, phone 2 holds generation ${String(g.generation)}`;
      });

      await rec.check("scenario 8: phone 2 disconnects; standby phone 1 hears route-vacant; the bare name closes and never reaches the box", async () => {
        p2.terminate();
        await p2.closed;
        await p1.next((m) => m.type === "route-vacant", 20_000);
        const seen = await visits(relayIp, bare, ca);
        assert(seen.every((v) => v === null), `the bare name still answered: ${JSON.stringify(seen)}`);
        const own = await http(`https://${box("A1").fqdn}/api/front-page`);
        assert(own.status === 200, `the box's own name: ${own.status}`);
      });

      await rec.check("scenario 8: revoking phone 1's admin grant ends its claim and closes its tunnel", async () => {
        const again = await p1.acquire();
        assert(again.type === "granted", `phone 1 re-acquire: ${JSON.stringify(again)}`);
        const r = { grantId: grantIds.p1!, username: acct.username, reason: "decommissioned" as const, issuedAt: Date.now() };
        const rv = await postJson(`https://${CONTROL}/api/users/${acct.username}/device-grants/revoke`, {
          request: r,
          signature: bytesToHex(signRevokeDeviceCapabilityGrant(r, acct.keys.irk)),
        });
        assert(rv.status === 200, `revoke ${rv.status}: ${short(rv.text)}`);
        const t0 = Date.now();
        await Promise.race([p1.closed, sleep(45_000)]);
        assert(p1.closedWith?.code === 4403, `phone 1's tunnel after revocation: ${JSON.stringify(p1.closedWith)}`);
        const seen = await visits(relayIp, bare, ca, 3);
        assert(seen.every((v) => v === null), `the bare name answered after revocation: ${JSON.stringify(seen)}`);
        return `tunnel closed ${Math.round((Date.now() - t0) / 1000)} s after the revocation`;
      });
    } finally {
      for (const p of phones) p.terminate();
    }
  },
};

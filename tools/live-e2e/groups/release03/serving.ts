// The owner's one dead-man setting, live (docs/architecture-v2/serving-wiring.md): a serving policy with a time
// limit stops the box's app routes at the relay when no admin lease is live, while the box's own control name keeps
// answering; a lease (signed by the admin root, or by a P-256 renewal key the admin root delegated) brings them back;
// its end stops them again. Runs alone (it stops every app on A1 for a while) and leaves A1 on the default, no time
// limit. Skips when the gym's .com serves no revocation key (the relay then has no serving authority).
// Appendix H scenario 9 / Appendix I 9.1: the lease's end is measured on a WebSocket held open across it (a long-lived
// app connection the relay must cut within its deadline) while the app's TLS certificate is still in date.
import { randomBytes } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";
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
    // One attempt per probe (the harness's http() retries a failed GET twice, 5 s apart, which made a stop look 20 s late).
    const appUp = async () => {
      try {
        const r = await fetch(app, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(8_000), redirect: "manual" });
        await r.arrayBuffer().catch(() => {});
        return r.status === 200;
      } catch {
        return false;
      }
    };
    const controlUp = async () => (await tryHttp(control, {}, 10_000)).status === 200;
    /** Polls until the app is (not) served; returns when the first probe that saw it began, measured from the call. */
    const until = async (want: boolean, seconds: number): Promise<number> => {
      const t0 = Date.now();
      while (Date.now() - t0 < seconds * 1000) {
        const probeStart = Date.now();
        if ((await appUp()) === want) return probeStart - t0;
        await sleep(1000);
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
      await installWhoami(acct, b, SLUG, { enabled: true });
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
      await rec.check("when the last lease ends the app stops within seconds, a WebSocket held open across the end is cut, the app's certificate is still in date; the control name keeps answering", async () => {
        const end = lastNotAfter;
        await sleep(Math.max(0, end - Date.now() - 30_000));
        const certEnd = await certNotAfter(`${SLUG}.${b.fqdn}`);
        const ws = await openEcho(`wss://${SLUG}.${b.fqdn}/echo`);
        const t0 = Date.now();
        const ms = await until(false, 90);
        const late = t0 + ms - end;
        await Promise.race([ws.closed, sleep(Math.max(0, end + 15_000 - Date.now()))]);
        assert(await controlUp(), "the control name stopped answering");
        assert(late < 15_000, `stopped ${(late / 1000).toFixed(0)} s after the lease ended (the relay should close within 5 s)`);
        assert(ws.closedAt !== null, "the WebSocket opened before the lease ended is still open 15 s after it");
        const wsLate = ws.closedAt - end;
        assert(wsLate < 10_000, `the WebSocket was cut ${(wsLate / 1000).toFixed(1)} s after the lease ended (deadline 5 s)`);
        assert(certEnd > end + 86_400_000, `the app certificate ends ${new Date(certEnd).toISOString()}: not "still valid" at the lease's end`);
        return `new requests stopped ${(late / 1000).toFixed(1)} s, the open WebSocket cut ${(wsLate / 1000).toFixed(1)} s after the lease ended; app certificate valid until ${new Date(certEnd).toISOString().slice(0, 10)}`;
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

/** The served certificate's end (ms), read over TLS without trusting anything. */
function certNotAfter(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false });
    s.setTimeout(15_000, () => {
      s.destroy();
      reject(new Error(`no TLS answer from ${host}`));
    });
    s.on("secureConnect", () => {
      const t = Date.parse(s.getPeerCertificate()?.valid_to ?? "");
      s.destroy();
      if (Number.isFinite(t)) resolve(t);
      else reject(new Error(`no certificate end from ${host}`));
    });
    s.on("error", reject);
  });
}

/** A WebSocket to whoami's echo, open and answering; `closedAt` is when it ended. */
async function openEcho(url: string): Promise<{ closed: Promise<void>; closedAt: number | null }> {
  const ws = new WebSocket(url, { headers: { origin: new URL(url.replace(/^wss:/, "https:")).origin } });
  const out: { closed: Promise<void>; closedAt: number | null } = { closed: Promise.resolve(), closedAt: null };
  out.closed = new Promise((r) =>
    ws.on("close", () => {
      out.closedAt = Date.now();
      r();
    }),
  );
  ws.on("error", () => undefined);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("unexpected-response", (_q, resp) => rej(new Error(`WebSocket upgrade ${resp.statusCode} at ${url}`)));
    ws.once("error", rej);
  });
  const echoed = new Promise<boolean>((r) => {
    ws.once("message", (d) => r(String(d) === "gym-ping"));
    setTimeout(() => r(false), 10_000).unref?.();
  });
  ws.send("gym-ping");
  assert(await echoed, `the WebSocket at ${url} did not echo`);
  return out;
}

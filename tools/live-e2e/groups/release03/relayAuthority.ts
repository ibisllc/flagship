// Recovery and revocation through the REAL gym relay and `.com` (Appendix I section 9; Appendix H scenarios 6, 9, 10).
// The box is simulated (lib/boxSim.ts): a throwaway server the harness registers with a key it holds, connected to the
// relay's /tunnel with a real HELLO, answering every relayed stream with a label. That lets the group do what a real
// box cannot be made to do safely: claim names it must not get, keep streams open across a deadline, be revoked,
// re-registered and replayed. What it proves is the relay's and `.com`'s side; the box software's own reaction
// (locking, renewal scheduling) is the `serving` group's, on A1.
//
// Order: routing refusals (H6) → lease expiry with long-lived streams (I-1) → control-only issuance after expiry,
// one real certificate (I-2) → policy reductions and indefinite (I-8) → renewal rules (H10) → explicit revocation
// with long-lived streams (I-3) → the revoked box's certificate and credentials (I-4) → a new key for the name and
// replays across generations (I-5, H10 previous identity) → revocation racing issuance and reconnect (I-6).
// Runs alone (one phase) because it holds the relay's attention for ~15 min and briefly claims A1's control name;
// it never revokes A1. Leaves behind: two revoked throwaway servers (the account's teardown removes them).
// Skips when the gym .com serves no revocation key (no serving authority on the relay).
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { X509Certificate } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ed,
  nameListSha256,
  signRevokeDeviceCapabilityGrant,
  signServingLeaseP256,
  signServingRecord,
  type Keypair,
  type RenewalKeyDelegation,
  type ServingGrace,
  type ServingLease,
  type ServingPolicy,
} from "@flagship/protocol";
import { mintDeviceGrant } from "../../lib/fleet.js";
import {
  orderCertificate,
  RawVisitor,
  registerSimServer,
  revokeServer,
  simHelloPayload,
  SimBox,
  simKey,
  unrevokeServer,
  visitSim,
  type SimServer,
} from "../../lib/boxSim.js";
import { CONTROL, SERVICES, SkipError, assert, http, postJson, short, sleep, tryHttp, type Resp } from "../../lib/harness.js";
import { accountReadHeaders } from "../../readToken.js";
import type { Group } from "../types.js";

/** The relay must close app streams within 5 s of a lease's end; the probe itself adds up to a few seconds. */
const APP_CUT_SLACK_MS = 10_000;
/** Committed revocation to observable disconnection (Appendix I §4): 60 s cached status + 5 s shutdown. */
const REVOKE_DEADLINE_MS = 65_000;

export const relayAuthority: Group = {
  name: "relay-authority",
  title:
    "Appendix I recovery/revocation and Appendix H 6/9/10 through the real relay and .com with a simulated box: no bare-name or sibling route, app lease expiry cuts open app streams and keeps control, control-only issuance after expiry, policy reductions, renewal rules, revocation ends every stream within 65 s, no revival by replay, re-registration or race",
  needs: ["A1"],
  phase: 10.6,
  parallel: false,
  async run({ A, rec, box }) {
    const acct = A;
    const user = acct.username;
    const bare = `${user}.${SERVICES}`;
    const a1 = box("A1");
    const key = await tryHttp(`https://${CONTROL}/api/serving/revocation-key`);
    if (key.status !== 200) {
      await rec.check("the gym serves a revocation key (serving authority on)", async () => {
        throw new SkipError(`GET /api/serving/revocation-key ${key.status}: set SERVING_REVOCATION_SEED on the gym Worker and FLAGSHIP_SERVING_REVOCATION_PUB on the gym relay`);
      });
      return;
    }
    const ep = await http(`https://${CONTROL}/api/services/endpoints`);
    const tunnelUrl = typeof ep.json?.tunnelHub === "string" ? (ep.json.tunnelHub as string) : "";
    if (!tunnelUrl) {
      await rec.check("the gym .com names the relay's tunnel hub", async () => {
        throw new SkipError(`no tunnelHub in /api/services/endpoints: ${short(ep.text)}`);
      });
      return;
    }
    const relayIp = (await lookup(a1.fqdn, { family: 4 })).address;
    const adminPub = bytesToHex(acct.keys.adminRoot.publicKey);
    const adminSign = (m: Uint8Array) => ed.sign(m, acct.keys.adminRoot.privateKey);
    const sims: SimBox[] = [];
    const revoked = new Set<string>();

    /** First answer from up to `tries` visits: a sim label, or null. */
    const reach = async (sni: string, tries = 2): Promise<string | null> => {
      for (let i = 0; i < tries; i++) {
        const v = await visitSim(relayIp, sni);
        if (v.label) return v.label;
      }
      return null;
    };
    const waitReach = async (sni: string, want: string | null, seconds: number): Promise<number> => {
      const t0 = Date.now();
      let last: string | null = null;
      while (Date.now() - t0 < seconds * 1000) {
        last = await reach(sni, 1);
        if (last === want) return Date.now() - t0;
        await sleep(2_000);
      }
      throw new Error(`${sni} answered ${String(last)}, not ${String(want)}, for ${seconds} s`);
    };
    const connect = async (s: SimServer, label: string, canonicals: string[] = [], extra: { payload?: Record<string, unknown> } = {}) => {
      const payload = extra.payload ?? (await simHelloPayload({ username: user, server: s, irk: acct.keys.irk, rootSigner: acct.keys.adminRoot, canonicals, serving: { servingAdminKey: adminPub, servingPolicy: null } }));
      const b = await SimBox.connect(tunnelUrl, payload, { label });
      sims.push(b);
      return { box: b, payload };
    };
    /** A connection attempt that may be refused at any step: accepted or not, and why. */
    const attempt = async (s: SimServer, label: string, canonicals: string[] = [], extra: { payload?: Record<string, unknown> } = {}) => {
      try {
        const c = await connect(s, label, canonicals, extra);
        return { accepted: c.box.accepted, why: String(c.box.ack?.reason ?? c.box.closedWith?.reason ?? "") };
      } catch (e) {
        return { accepted: false, why: (e as Error).message };
      }
    };
    const servingRow = async (fqdn: string) => {
      const h = acct.demo ? {} : await accountReadHeaders(CONTROL, user, acct.keys.irk);
      const r = await http(`https://${CONTROL}/api/accounts/${user}/serving`, { headers: h });
      return ((r.json?.servers ?? []) as Array<{ serverDomain: string; boxPub: string; regGen: number; revoked: boolean }>).find((x) => x.serverDomain === fqdn);
    };

    // ── policies and leases for one simulated box ─────────────────────────
    const gens = new Map<string, number>();
    const policy = (s: SimServer, regGen: number, grace: ServingGrace, over: Partial<ServingPolicy> = {}): ServingPolicy => {
      const k = `${s.stkHex}/${regGen}`;
      const policyGen = (gens.get(k) ?? 0) + 1;
      gens.set(k, policyGen);
      return {
        account: user,
        box: s.stkHex,
        regGen,
        policyGen,
        grace,
        onLapse: "stop-apps",
        scopeSha256: nameListSha256([
          { class: "control", name: s.fqdn },
          { class: "apps", name: `*.${s.fqdn}` },
        ]),
        issuedAt: Date.now(),
        ...over,
      };
    };
    const postPolicy = (p: ServingPolicy, signer: (m: Uint8Array) => Uint8Array = adminSign): Promise<Resp> =>
      postJson(`https://${CONTROL}/api/accounts/${user}/serving-policy`, { policy: p, signature: bytesToHex(signServingRecord("serving-policy", p, signer)) });
    const setPolicy = async (p: ServingPolicy) => {
      const r = await postPolicy(p);
      assert(r.status === 200, `policy gen ${p.policyGen} (${p.grace}): ${r.status} ${short(r.text)}`);
      return p;
    };
    const lease = (p: ServingPolicy, seconds: number, over: Partial<ServingLease> = {}): ServingLease => {
      const now = Date.now();
      return { account: p.account, box: p.box, regGen: p.regGen, policyGen: p.policyGen, leaseId: randomBytes(16).toString("hex"), issuedAt: now, notAfter: now + seconds * 1000, ...over };
    };
    type SignedLease = { lease: ServingLease; signature: string; delegationPub?: string };
    const adminLease = (l: ServingLease): SignedLease => ({ lease: l, signature: bytesToHex(signServingRecord("serving-lease", l, adminSign)) });
    const postLeases = async (...leases: SignedLease[]) => {
      const r = await postJson(`https://${CONTROL}/api/accounts/${user}/serving-leases`, { leases });
      assert(r.status === 200, `serving-leases ${r.status}: ${short(r.text)}`);
      return { accepted: Number(r.json?.accepted ?? 0), refused: ((r.json?.refused ?? []) as Array<{ code: string }>).map((x) => x.code) };
    };
    const refusedWith = async (what: string, l: SignedLease, codes: string[]) => {
      const r = await postLeases(l);
      assert(r.accepted === 0 && r.refused.length === 1, `${what}: accepted ${r.accepted}`);
      assert(codes.includes(r.refused[0]!), `${what}: refused ${r.refused[0]}, expected ${codes.join(" or ")}`);
      return `${what}: ${r.refused[0]}`;
    };

    const held: { S: SimServer | null; T: SimServer | null } = { S: null, T: null };
    try {
      // ── setup ──────────────────────────────────────────────────────────
      const setup = await rec.check("setup: register a throwaway server whose key the harness holds", async () => {
        const r = await registerSimServer(acct);
        assert(r.status === 200 || r.status === 201, `register ${r.status}: ${short(r.text)}`);
        held.S = r;
        return r.fqdn;
      });
      if (!setup || !held.S) return;
      const s: SimServer = held.S;
      const app = `simapp.${s.fqdn}`;

      // ── H6 / I-9: names a box must never get ──────────────────────────
      await rec.check("H6/I-9: a box whose entitlement (signed by the account's IRK) also names the bare account name and a sibling's control name gets neither route; the sibling still answers itself", async () => {
        const { box: b } = await connect(s, "S-greedy", [app, bare, a1.fqdn]);
        try {
          if (!b.accepted) return `the HELLO was refused: ${String(b.ack?.reason ?? b.closedWith?.reason)}`;
          const toBare = await reach(bare, 3);
          assert(toBare === null, `the bare name reached the box (${toBare})`);
          for (let i = 0; i < 3; i++) {
            const v = await visitSim(relayIp, a1.fqdn);
            assert(v.label === null, `A1's control name reached the simulated box (${v.label})`);
          }
          const own = await tryHttp(`https://${a1.fqdn}/api/front-page`, {}, 20_000);
          assert(own.status === 200, `A1 stopped answering: ${own.status}`);
          // TLS ends on the box and the relay routes by SNI only, so no certificate the box might hold changes this.
          return "accepted for its own names only: the bare name closed, A1's name still A1's";
        } finally {
          b.terminate();
          await b.closed;
        }
      });

      // The tunnel the rest of the group uses.
      let main = await connect(s, "S", [app]);
      const firstPayload = main.payload;
      await rec.check("setup: the simulated box's tunnel is accepted; its control name and its app name reach it (no time limit yet)", async () => {
        assert(main.box.accepted, `HELLO: ${short(main.box.ack ?? main.box.closedWith)}`);
        await waitReach(s.fqdn, "S", 30);
        await waitReach(app, "S", 30);
        return `${s.fqdn} and ${app} answer`;
      });

      // ── I-1 / H9: the app lease ends while the tunnel and its streams are open ──
      let p = policy(s, 1, "7d");
      await rec.check("I-1: a 7-day policy and a 60 s lease; at the lease's end an app stream held open is cut within 5 s, a held control stream and the tunnel stay, new app visits stop, new control visits still reach the box", async () => {
        await setPolicy(p);
        await waitReach(app, null, 45);
        const l = lease(p, 60);
        const r = await postLeases(adminLease(l));
        assert(r.accepted === 1, `lease refused: ${r.refused.join(",")}`);
        await waitReach(app, "S", 45);
        const appV = await RawVisitor.open(relayIp, app);
        const ctlV = await RawVisitor.open(relayIp, s.fqdn);
        assert((await appV.firstAnswer())?.label === "S" && (await ctlV.firstAnswer())?.label === "S", "the held streams did not reach the box");
        assert(Date.now() < l.notAfter - 3_000, "the lease ended before the streams were open; nothing measured");
        await Promise.race([appV.closed, sleep(Math.max(0, l.notAfter + 20_000 - Date.now()))]);
        assert(appV.closedAt !== null, "the app stream is still open 20 s after the lease ended");
        const cut = appV.closedAt - l.notAfter;
        assert(cut <= APP_CUT_SLACK_MS, `the app stream was cut ${(cut / 1000).toFixed(1)} s after the lease ended`);
        assert(cut > -3_000, `the app stream ended ${(-cut / 1000).toFixed(1)} s BEFORE the lease ended`);
        assert(ctlV.closedAt === null, "the control stream was cut with the app lease");
        assert(main.box.closedWith === null, `the tunnel closed: ${short(main.box.closedWith)}`);
        assert((await reach(app, 2)) === null, "a new app visit still reached the box");
        assert((await reach(s.fqdn)) === "S", "a new control visit no longer reaches the box");
        ctlV.end();
        return `app stream cut ${(cut / 1000).toFixed(1)} s after the lease's end; control stream and tunnel kept`;
      });

      // ── I-2: control-only issuance after the lease lapsed ──────────────
      await rec.check("I-2: after the lapse the service refuses the box's app certificate (no serving), and control orders naming either wildcard, an extra name, another box or the phone name", async () => {
        const out: string[] = [];
        const refuse = async (what: string, r: Resp, codes: string[]) => {
          assert(r.status >= 400 && r.status < 500 && codes.includes(String(r.json?.code)), `${what}: ${r.status} ${short(r.text)} (expected ${codes.join("/")})`);
          out.push(`${what} ${r.json?.code}`);
        };
        await refuse("apps", await orderCertificate({ acct, signer: s.stk, cls: "apps", names: [`*.${s.fqdn}`], server: s.fqdn }), ["issuance-no-serving"]);
        await refuse("*.box", await orderCertificate({ acct, signer: s.stk, cls: "control", names: [`*.${s.fqdn}`], server: s.fqdn }), ["issuance-csr-names"]);
        await refuse("*.user", await orderCertificate({ acct, signer: s.stk, cls: "control", names: [s.fqdn, `*.${user}.${SERVICES}`], server: s.fqdn }), ["issuance-csr-names"]);
        await refuse("extra", await orderCertificate({ acct, signer: s.stk, cls: "control", names: [s.fqdn, `x.${s.fqdn}`], server: s.fqdn }), ["issuance-csr-names"]);
        await refuse("phone name", await orderCertificate({ acct, signer: s.stk, cls: "control", names: [bare], server: s.fqdn }), ["issuance-csr-names"]);
        await refuse("another box", await orderCertificate({ acct, signer: s.stk, cls: "control", names: [a1.fqdn], server: a1.fqdn }), ["issuance-unknown-device"]);
        return out.join("; ");
      });
      await rec.check("I-2: after the lapse the exact control certificate is issued (one real order), naming exactly the box's control name", async () => {
        const r = await orderCertificate({ acct, signer: s.stk, cls: "control", names: [s.fqdn], server: s.fqdn });
        if (r.status === 503 && r.json?.code === "issuance-not-configured") throw new SkipError("the gym .com has no issuance ACME account key");
        assert(r.status === 202 && typeof r.json?.orderId === "string", `control order ${r.status}: ${short(r.text)}`);
        const done = await pollOrder(r.json.orderId as string, 6 * 60_000);
        assert(done.status === "issued", `the order ended ${done.status} ${String(done.code ?? "")}: ${short(done.error)}`);
        const leaf = new X509Certificate(String(done.chainPem).split(/(?=-----BEGIN CERTIFICATE-----)/)[0]!);
        const sans = (leaf.subjectAltName ?? "").split(",").map((x) => x.trim().replace(/^DNS:/, ""));
        assert(sans.length === 1 && sans[0] === s.fqdn, `leaf names ${sans.join(", ")}`);
        return `issued for ${s.fqdn} only, until ${leaf.validTo}`;
      });

      // ── I-8: policy reductions and indefinite ──────────────────────────
      await rec.check("I-8: a reduction (30 days → 7 days) outdates the longer lease at once: apps stop, the old lease and the old policy replayed are refused", async () => {
        const p30 = await setPolicy(policy(s, 1, "30d"));
        const long = adminLease(lease(p30, 20 * 86_400));
        const r = await postLeases(long);
        assert(r.accepted === 1, `20-day lease under 30 days: ${r.refused.join(",")}`);
        await waitReach(app, "S", 45);
        p = await setPolicy(policy(s, 1, "7d"));
        const ms = await waitReach(app, null, 60);
        const replayLease = await refusedWith("the 20-day lease again", long, ["serving-lease-policy-gen"]);
        const old = await postJson(`https://${CONTROL}/api/accounts/${user}/serving-policy`, { policy: p30, signature: bytesToHex(signServingRecord("serving-policy", p30, adminSign)) });
        assert(old.status === 409 && old.json?.code === "serving-policy-stale", `the 30-day policy replayed: ${old.status} ${short(old.text)}`);
        return `apps stopped ${(ms / 1000).toFixed(0)} s after the reduction; ${replayLease}; old policy 409 stale`;
      });
      await rec.check("I-8: an indefinite policy serves apps with no lease and takes none (no-limit); back to 7 days stops them again", async () => {
        const pi = await setPolicy(policy(s, 1, "indefinite"));
        await waitReach(app, "S", 60);
        const none = await refusedWith("a lease under indefinite", adminLease(lease(pi, 60)), ["serving-lease-no-limit"]);
        p = await setPolicy(policy(s, 1, "7d"));
        await waitReach(app, null, 60);
        return none;
      });

      // ── H10: renewal within policy and every way a renewal may not work ──
      await rec.check("H10: within policy a renewal is accepted (admin root, and a renewal key the admin delegated to a live device)", async () => {
        const l1 = lease(p, 90);
        const r1 = await postLeases(adminLease(l1));
        assert(r1.accepted === 1, `admin-root renewal: ${r1.refused.join(",")}`);
        adminEnd = Math.max(adminEnd, l1.notAfter);
        await waitReach(app, "S", 45);
        return "accepted; the app is served";
      });
      let adminEnd = 0;
      const device = simKey();
      const devicePub = bytesToHex(device.publicKey);
      const renewalSk = p256.utils.randomSecretKey();
      const renewalPub = bytesToHex(p256.getPublicKey(renewalSk, true));
      let grantId = "";
      const delegated = (l: ServingLease): SignedLease => ({ lease: l, signature: signServingLeaseP256(l, renewalSk), delegationPub: renewalPub });
      await rec.check("H10: a renewal key delegated to a throwaway device renews; an undelegated P-256 key does not", async () => {
        const g = await mintDeviceGrant(acct, randomBytes(16).toString("hex"), device, ["browse"], acct.keys.irk);
        assert(g.status === 200 && typeof g.json?.grantId === "string", `device grant ${g.status}: ${short(g.text)}`);
        grantId = g.json.grantId as string;
        const stranger = p256.utils.randomSecretKey();
        const sl = lease(p, 300);
        const undelegated = await postLeases({ lease: sl, signature: signServingLeaseP256(sl, stranger), delegationPub: bytesToHex(p256.getPublicKey(stranger, true)) });
        assert(undelegated.accepted === 0, "an undelegated key's lease was accepted");
        const d: RenewalKeyDelegation = { account: user, alg: "p256", renewalPub, deviceId: devicePub, issuedAt: Date.now() };
        const dr = await postJson(`https://${CONTROL}/api/accounts/${user}/renewal-delegations`, { delegation: d, signature: bytesToHex(signServingRecord("renewal-key-delegation", d, adminSign)) });
        assert(dr.status === 200, `delegation ${dr.status}: ${short(dr.text)}`);
        const r = await postLeases(delegated(lease(p, 240)));
        assert(r.accepted === 1, `delegated renewal: ${r.refused.join(",")}`);
        return `undelegated refused (${undelegated.refused.join(",")}); delegated accepted`;
      });
      await rec.check("H10: renewals that widen scope, outlive the grace, change policy, name another box or come from the wrong key are refused", async () => {
        const il = lease(p, 60);
        const irkLease: SignedLease = { lease: il, signature: bytesToHex(signServingRecord("serving-lease", il, (m) => ed.sign(m, acct.keys.irk.privateKey))) };
        const out = [
          await refusedWith("8 days under a 7-day grace", adminLease(lease(p, 8 * 86_400)), ["serving-lease-invalid"]),
          await refusedWith("delegated, 8 days", delegated(lease(p, 8 * 86_400)), ["serving-lease-invalid"]),
          await refusedWith("signed by the IRK", irkLease, ["serving-lease-invalid", "serving-policy-signature"]),
          await refusedWith("another box", adminLease(lease(p, 60, { box: (await servingRow(a1.fqdn))?.boxPub ?? "00".repeat(32) })), ["serving-lease-unknown-box", "serving-lease-reg-gen", "serving-lease-no-limit", "serving-lease-policy-gen"]),
          await refusedWith("issued 10 min ahead (clock)", adminLease(lease(p, 60, { issuedAt: Date.now() + 10 * 60_000, notAfter: Date.now() + 11 * 60_000 })), ["serving-lease-invalid"]),
          await refusedWith("already ended", adminLease(lease(p, 60, { issuedAt: Date.now() - 120_000, notAfter: Date.now() - 60_000 })), ["serving-lease-expired"]),
        ];
        const byDevice = await postPolicy(policy(s, 1, "indefinite"), (m) => ed.sign(m, device.privateKey));
        assert(byDevice.status === 403 && byDevice.json?.code === "serving-policy-signature", `a policy signed by the delegated device's key: ${byDevice.status} ${short(byDevice.text)}`);
        out.push("policy by the device key: serving-policy-signature");
        return out.join("; ");
      });
      await rec.check("H10: removing the device revokes its renewal key: its renewals are refused and the relay drops its lease (apps stop when the admin lease ends, not the delegated one)", async () => {
        const adminL = lease(p, 70);
        const a = await postLeases(adminLease(adminL));
        assert(a.accepted === 1, `admin lease: ${a.refused.join(",")}`);
        adminEnd = Math.max(adminEnd, adminL.notAfter);
        const rv = { grantId, username: user, reason: "decommissioned" as const, issuedAt: Date.now() };
        const r = await postJson(`https://${CONTROL}/api/users/${user}/device-grants/revoke`, { request: rv, signature: bytesToHex(signRevokeDeviceCapabilityGrant(rv, acct.keys.irk)) });
        assert(r.status === 200, `grant revoke ${r.status}: ${short(r.text)}`);
        const refused = await refusedWith("delegated renewal after removal", delegated(lease(p, 600)), ["serving-lease-key-revoked"]);
        await sleep(Math.max(0, adminEnd - Date.now()));
        const ms = await waitReach(app, null, 30);
        return `${refused}; apps stopped ${(ms / 1000).toFixed(0)} s after the admin lease, the delegated one (240 s) no longer counts`;
      });

      // ── I-3: explicit revocation of an active box ───────────────────────
      p = await setPolicy(policy(s, 1, "indefinite"));
      await waitReach(app, "S", 60).catch(() => undefined);
      await rec.check("I-3: revoking the active box ends its tunnel and every held stream (control and app) within 65 s; new visits reach nothing", async () => {
        const appV = await RawVisitor.open(relayIp, app);
        const ctlV = await RawVisitor.open(relayIp, s.fqdn);
        assert((await appV.firstAnswer())?.label === "S" && (await ctlV.firstAnswer())?.label === "S", "the held streams did not reach the box");
        const r = await revokeServer(acct, s.fqdn);
        assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
        revoked.add(s.fqdn);
        const t0 = Date.now();
        await Promise.race([Promise.all([main.box.closed, appV.closed, ctlV.closed]), sleep(REVOKE_DEADLINE_MS + 5_000)]);
        const late = (at: number | null | undefined) => (at == null ? Infinity : at - t0);
        const times = { tunnel: late(main.box.closedWith?.at), app: late(appV.closedAt), control: late(ctlV.closedAt) };
        for (const [k, v] of Object.entries(times)) assert(v <= REVOKE_DEADLINE_MS, `the ${k} was still open ${(REVOKE_DEADLINE_MS / 1000).toFixed(0)} s after the revocation`);
        assert((await reach(s.fqdn)) === null && (await reach(app)) === null, "a new visit reached the revoked box");
        return `tunnel ${(times.tunnel / 1000).toFixed(1)} s, app stream ${(times.app / 1000).toFixed(1)} s, control stream ${(times.control / 1000).toFixed(1)} s after the revocation`;
      });

      // ── I-4: the revoked box keeps its certificate, gets nothing ───────
      await rec.check("I-4: the revoked box (its control certificate still valid) cannot reconnect, with a fresh HELLO or its first HELLO replayed, gets no route, and is refused issuance", async () => {
        const fresh = await attempt(s, "S-again", [app]);
        assert(!fresh.accepted, "a fresh HELLO from the revoked box was accepted");
        const replay = await attempt(s, "S-replay", [], { payload: firstPayload });
        assert(!replay.accepted, "the first HELLO replayed was accepted");
        assert((await reach(s.fqdn)) === null, "the revoked box's name routes");
        const o = await orderCertificate({ acct, signer: s.stk, cls: "control", names: [s.fqdn], server: s.fqdn });
        assert(o.json?.code === "issuance-revoked", `control order after revocation: ${o.status} ${short(o.text)}`);
        return `fresh: ${fresh.why}; replay: ${replay.why}; issuance-revoked`;
      });

      // ── I-5: a new key for the name, replays across generations ────────
      const k2 = simKey();
      const now: { current: { stk: Keypair; stkHex: string; regGen: number; how: string } | null } = { current: null };
      await rec.check("I-5: the revoked name registered again with a NEW key inherits nothing: the old key stays shut out", async () => {
        const again = await registerSimServer(acct, s.label, k2);
        if (again.status === 200 || again.status === 201) {
          const row = await servingRow(s.fqdn);
          assert(row && row.boxPub === again.stkHex, `.com lists ${short(row)} for the name`);
          now.current = { stk: k2, stkHex: again.stkHex, regGen: row.regGen, how: "re-registered with a new key" };
          const old = await attempt(s, "S-oldkey", [app]);
          assert(!old.accepted, "the old key's HELLO was accepted after the name moved to a new key");
          const o = await orderCertificate({ acct, signer: s.stk, cls: "control", names: [s.fqdn], server: s.fqdn });
          assert(["issuance-unknown-device", "issuance-revoked"].includes(String(o.json?.code)), `old key's order: ${o.status} ${short(o.text)}`);
          revoked.delete(s.fqdn);
          return `accepted at regGen ${row.regGen}; the old key: HELLO refused, ${o.json?.code}`;
        }
        assert(again.status >= 400 && again.status < 500, `re-register ${again.status}: ${short(again.text)}`);
        const u = await unrevokeServer(acct, s.fqdn);
        assert(u.status === 200, `un-revoke (admin root) ${u.status}: ${short(u.text)}`);
        revoked.delete(s.fqdn);
        const row = await servingRow(s.fqdn);
        assert(row && row.regGen >= 2 && !row.revoked, `after un-revoke: ${short(row)}`);
        now.current = { stk: s.stk, stkHex: s.stkHex, regGen: row.regGen, how: "un-revoked by the admin root" };
        return `a new key for the name: ${again.status} (refused); the owner's un-revoke started regGen ${row.regGen}`;
      });
      if (now.current) {
        const cur = now.current;
        const sNow: SimServer = { label: s.label, fqdn: s.fqdn, stk: cur.stk, stkHex: cur.stkHex };
        await rec.check("I-5 / H10 previous identity: the earlier generation's policy, lease and certificate order are refused; a fresh 7-day policy with no lease serves control only", async () => {
          const oldPolicy = policy(s, 1, "indefinite");
          const rp = await postPolicy(oldPolicy);
          assert(rp.status === 409 || rp.status === 403, `a regGen-1 policy: ${rp.status} ${short(rp.text)}`);
          const oldLease = await refusedWith("a regGen-1 lease", adminLease(lease(p, 60)), ["serving-lease-reg-gen", "serving-lease-unknown-box"]);
          // A new key's row may start at regGen 1 again: then there is no earlier generation of THIS key to order under.
          const o = cur.regGen > 1 ? await orderCertificate({ acct, signer: cur.stk, cls: "control", names: [s.fqdn], server: s.fqdn, regGen: 1 }) : null;
          assert(!o || o.json?.code === "issuance-reg-gen", `a regGen-1 certificate order: ${o?.status} ${short(o?.text)}`);
          await setPolicy(policy(sNow, cur.regGen, "7d"));
          main = await connect(sNow, "S2", [app]);
          assert(main.box.accepted, `the ${cur.how} box's HELLO: ${short(main.box.ack ?? main.box.closedWith)}`);
          await waitReach(s.fqdn, "S2", 30);
          await waitReach(app, null, 30);
          return `policy ${rp.status} ${rp.json?.code}; ${oldLease}; order ${o?.json?.code ?? "n/a (new key at regGen 1)"}; control answers, apps do not`;
        });
        main.box.terminate();
      }

      // ── I-6: revocation racing issuance and reconnection ───────────────
      await rec.check("I-6: revocation races an in-flight control order and a reconnect: the order never delivers a certificate, no tunnel outlives 65 s, the name routes nothing", async () => {
        const t = await registerSimServer(acct);
        assert(t.status === 200 || t.status === 201, `register ${t.status}: ${short(t.text)}`);
        held.T = t;
        const first = await connect(t, "T");
        assert(first.box.accepted, `T's HELLO: ${short(first.box.ack ?? first.box.closedWith)}`);
        const o = await orderCertificate({ acct, signer: t.stk, cls: "control", names: [t.fqdn], server: t.fqdn });
        assert(o.status === 202, `T's order ${o.status}: ${short(o.text)}`);
        const [rv, again] = await Promise.all([revokeServer(acct, t.fqdn), connect(t, "T-race").catch(() => null)]);
        assert(rv.status === 200, `revoke ${rv.status}: ${short(rv.text)}`);
        revoked.add(t.fqdn);
        const t0 = Date.now();
        const tunnels = [first.box, ...(again ? [again.box] : [])];
        await Promise.race([Promise.all(tunnels.map((b) => b.closed)), sleep(REVOKE_DEADLINE_MS + 5_000)]);
        for (const b of tunnels) assert(b.closedWith && b.closedWith.at - t0 <= REVOKE_DEADLINE_MS, `a tunnel of T is open ${REVOKE_DEADLINE_MS / 1000} s after the revocation`);
        assert((await reach(t.fqdn)) === null, "T's name routes after the revocation");
        const done = await pollOrder(o.json.orderId as string, 6 * 60_000);
        assert(done.status !== "issued", `a certificate was delivered after the revocation (${short(done.names)})`);
        return `order ${done.status} ${String(done.code ?? "")}; ${tunnels.length} tunnel(s) closed`;
      });

      rec.skip(
        "I-7 (second half): stop the relay's contact with .com: no new tunnels after 60 s, every tunnel closed after 10 min",
        "needs a fault switch that cuts the gym relay's serving feed (none is built; covered by apps/web/tests/servingGate.test.ts and tunnelHubServing.test.ts)",
      );
    } finally {
      for (const b of sims) b.terminate();
      for (const sv of [held.S, held.T]) {
        if (sv && !revoked.has(sv.fqdn)) await revokeServer(acct, sv.fqdn).catch(() => undefined);
      }
    }
  },
};

async function pollOrder(orderId: string, ms: number): Promise<Record<string, any>> {
  const end = Date.now() + ms;
  let last: Record<string, any> = {};
  while (Date.now() < end) {
    const r = await http(`https://${CONTROL}/api/certificates/orders/${orderId}`);
    last = (r.json ?? {}) as Record<string, any>;
    if (last.status === "issued" || last.status === "failed") return last;
    await sleep(Math.max(2_000, Math.min(15_000, Number(last.pollAfterMs) || 5_000)));
  }
  throw new Error(`order ${orderId} not finished within ${Math.round(ms / 1000)} s (last ${short(last)})`);
}

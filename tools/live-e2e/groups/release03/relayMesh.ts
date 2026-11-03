// The relay mesh on the gym (docs/architecture-v2/relay-mesh.md §14.1): three relays (`gym-a` Fly, `gym-b` a second Fly
// app, `gym-c` the Rust relay on an UpCloud VM), one gym `.com` directory, simulated boxes pinned to a relay by its
// direct name (`wss://<relayId>.tunnel.<apex>:8443/tunnel`) and visitors pinned to a relay by its direct address
// (:443). Supersedes relayInstances (two machines of one Fly app cannot be told apart on raw TCP).
//
// Skips unless the gym runs the mesh (`relays` in the gym `.com`'s /api/services/endpoints, every relay mesh-ready):
// see docs/runbooks/relay-mesh.md "Gym". Optional, per check:
//   GYM_MESH_SIM_SEED / GYM_MESH_SIM_ID   a gym-admitted relay key for the rogue-relay check (lib/meshSim.ts)
//   GYM_MESH_RELAY_C_CONTROL=1            the group may drain and restart gym-c (scripts/gym-relay-c.sh drain|start)
//   GYM_MESH_REBALANCE=1                  the gym relays run with FLAGSHIP_MESH_REBALANCE_MS shortened
//   GYM_RELAY_STATS_SECRET                the relays' /api/stats secret (extra evidence: per-peer rejected counts)
// Runs alone. Leaves behind: revoked throwaway servers and revoked device grants of account A.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ed,
  emptyMoveHintRateState,
  HEAD_REFUSE_NEW_MS,
  leaseFor,
  nameListSha256,
  phoneLedgerRanking,
  signRelayMeshRecord,
  signRevokeDeviceCapabilityGrant,
  signServingRecord,
  type BoxAttachment,
  type MoveHintRateState,
  type ServingPolicy,
} from "@flagship/protocol";
import { createRealAccount, mintDeviceGrant, type Account } from "../../lib/fleet.js";
import { accountReadHeaders } from "../../readToken.js";
import {
  moveSimBox,
  RawVisitor,
  readSimAnswer,
  registerSimServer,
  relayTunnelUrl,
  revokeServer,
  simAnswer,
  simHelloPayload,
  SimBox,
  simCheckHint,
  visitSim,
  type SimServer,
} from "../../lib/boxSim.js";
import { CONTROL, SERVICES, SkipError, assert, postJson, short, sleep } from "../../lib/harness.js";
import {
  fetchRelayBlessing,
  gymMesh,
  MESH_RUNBOOK,
  MeshSimRelay,
  relayHealth,
  relayStats,
  simRelayFromEnv,
  tcpReachable,
  waitReady,
  type GymMesh,
  type GymRelay,
} from "../../lib/meshSim.js";
import { connect as tlsConnect } from "node:tls";
import { SimPhone, isPhoneCert, selfSignedPhoneCert } from "../../lib/phoneSim.js";
import type { Group } from "../types.js";

/** The gym's revocation deadline (relay-mesh.md §12). */
const REVOKE_DEADLINE_MS = 65_000;
/** The relays' hold before a refused visitor is closed (§7.2). */
const HOLD_MS = 4_000;
/** How long a sim box keeps its old tunnel after a move (the box's 30 s, shortened: the harness, not a box). */
const MOVE_GRACE_MS = 5_000;
const REPO = resolve(import.meta.dirname, "../../../..");

/**
 * Which phone answered a real TLS handshake for `hostname` through the relay at `ip`: the index of the certificate in
 * `certs` it presented, or null (closed, timed out, or another certificate). The raw sim ClientHello (`visitSim`)
 * cannot be used for a phone: it offers only a TLS 1.3 suite without supported_versions, so a real TLS endpoint
 * answers it with a handshake_failure alert, never a handshake record.
 */
function phoneAnswering(ip: string, hostname: string, certs: string[], ms = 6_000): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    const s = tlsConnect({ host: ip, port: 443, servername: hostname, rejectUnauthorized: false });
    s.setTimeout(ms, () => finish(null));
    s.on("secureConnect", () => {
      const fp = s.getPeerCertificate()?.fingerprint256;
      const i = certs.findIndex((c) => isPhoneCert(fp, [c]));
      finish(i >= 0 ? i : null);
    });
    s.on("error", () => finish(null));
    s.on("close", () => finish(null));
  });
}

export const relayMesh: Group = {
  name: "relay-mesh",
  title:
    "the relay mesh across gym-a, gym-b and gym-c: a visit through one relay reaches a box held by another, account home and co-locate moves, the phone name across relays, a revocation and a lease end across relays, rebalancing, a relay leaving and rejoining, a rogue relay refused",
  needs: ["A1"],
  phase: 10.66,
  parallel: false,
  async run({ A, rec }) {
    const acct = A;
    const user = acct.username;
    const adminPub = bytesToHex(acct.keys.adminRoot.publicKey);
    const adminSign = (m: Uint8Array) => ed.sign(m, acct.keys.adminRoot.privateKey);

    let mesh: GymMesh | null = null;
    const ok = await rec.check("the gym runs the relay mesh: the gym .com lists the relays, each is reachable and mesh-ready", async () => {
      const m = await gymMesh();
      if (m.relays.length < 2) throw new SkipError(`the gym .com lists ${m.relays.length} relay(s) in /api/services/endpoints (the mesh needs 2+): ${MESH_RUNBOOK}`);
      if (!m.directory) throw new SkipError(`no directory at https://feed.${CONTROL}/v1/directory.json: ${MESH_RUNBOOK}`);
      for (const r of m.relays) {
        if (!(await tcpReachable(r.ip))) throw new SkipError(`${r.relayId} (${r.ip}:443) is not reachable from this runner (an IPv6-only relay needs IPv6 here): ${MESH_RUNBOOK}`);
      }
      const notReady = await waitReady(m.relays, 30_000);
      if (notReady.length) throw new SkipError(`not mesh-ready: ${notReady.join("; ")} (${MESH_RUNBOOK})`);
      mesh = m;
      return `${m.relays.map((r) => `${r.relayId}@${r.ip}`).join(", ")}; directory v${m.directory.directoryVersion}; tunnelHub ${m.tunnelHub ?? "(none)"}`;
    });
    if (!ok || !mesh) return;
    const M: GymMesh = mesh;
    const byId = (id: string): GymRelay | undefined => M.relays.find((r) => r.relayId === id);
    const RA = byId("gym-a") ?? M.relays[0]!;
    const RB = byId("gym-b") ?? M.relays.find((r) => r !== RA)!;
    const RC = byId("gym-c") ?? M.relays.find((r) => r !== RA && r !== RB) ?? null;
    const three = RC !== null;
    const need3 = () => {
      if (!three) throw new SkipError(`needs three relays; the gym lists ${M.relays.length} (${MESH_RUNBOOK})`);
    };

    const sims: SimBox[] = [];
    const phones: SimPhone[] = [];
    const servers: SimServer[] = [];
    const grants: string[] = [];
    const held: { rogue: MeshSimRelay | null } = { rogue: null };
    const rates = new Map<string, MoveHintRateState>();

    /** Which account each sim server belongs to (account A, or the rebalancing check's own fresh account). */
    const ownerOf = new Map<string, Account>();
    const register = async (owner: Account = acct): Promise<SimServer> => {
      const r = await registerSimServer(owner);
      assert(r.status === 200 || r.status === 201, `register ${r.status}: ${short(r.text)}`);
      servers.push(r);
      ownerOf.set(r.fqdn, owner);
      return r;
    };
    const payloadFor = (s: SimServer, canonicals: string[], serving?: Record<string, unknown>) => () => {
      const owner = ownerOf.get(s.fqdn) ?? acct;
      return simHelloPayload({
        username: owner.username,
        server: s,
        irk: owner.keys.irk,
        rootSigner: owner.keys.adminRoot,
        canonicals,
        serving: serving ?? { servingAdminKey: bytesToHex(owner.keys.adminRoot.publicKey), servingPolicy: null },
      });
    };
    /** A mesh sim box on `relay`; retried until the relay knows the new registration from the log (≤ 45 s). */
    const connectOn = async (s: SimServer, relay: GymRelay, label: string, o: { canonicals?: string[]; serving?: Record<string, unknown>; echo?: boolean; tries?: number } = {}): Promise<SimBox> => {
      const payload = payloadFor(s, o.canonicals ?? [], o.serving);
      const end = Date.now() + (o.tries ?? 45_000);
      let last = "";
      for (;;) {
        try {
          const b = await SimBox.connect(relayTunnelUrl(relay.tunnelHost), await payload(), { label, mesh: { server: s }, ...(o.echo ? { echo: true } : {}) });
          if (b.accepted) {
            sims.push(b);
            return b;
          }
          last = JSON.stringify(b.ack ?? b.closedWith);
          b.terminate();
        } catch (e) {
          last = (e as Error).message;
        }
        if (Date.now() > end) throw new Error(`${label} on ${relay.relayId}: ${last}`);
        await sleep(3_000);
      }
    };
    const mustMesh = (b: SimBox, relay: GymRelay) => {
      assert(b.meshAcked, `${b.label}: ${relay.relayId} answered without mesh-v1 / relayId (${short(b.ackFull)})`);
      assert(b.relayId === relay.relayId, `${b.label}: the ACK names ${b.relayId}, dialled ${relay.relayId}`);
      const a = b.attachResults[0];
      assert(a?.ok === true, `${b.label}: attachment on ${relay.relayId} answered ${JSON.stringify(a)}`);
    };
    /** Whether a visit to `sni` through `relay` reached `label`. */
    const reaches = async (relay: GymRelay, sni: string, label: string) => (await visitSim(relay.ip, sni, 6_000)).label === label;
    const until = async (cond: () => Promise<boolean>, ms: number, every = 1_000): Promise<number | null> => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await cond()) return Date.now() - t0;
        await sleep(every);
      }
      return null;
    };
    const follow = async (b: SimBox, s: SimServer, hint: NonNullable<Awaited<ReturnType<SimBox["waitHint"]>>>, canonicals: string[], echo = false) => {
      const fresh = await gymMesh();
      const r = await moveSimBox(b, hint, {
        server: s,
        servicesApex: SERVICES,
        payload: payloadFor(s, canonicals),
        directory: fresh.directory,
        directoryFetchedAt: fresh.directoryFetchedAt,
        caKeys: fresh.caKeys.length ? fresh.caKeys : M.caKeys,
        rate: rates.get(s.fqdn) ?? emptyMoveHintRateState(),
        graceMs: MOVE_GRACE_MS,
        label: b.label,
        echo,
      });
      rates.set(s.fqdn, r.rate);
      assert(r.ok, `${b.label} did not follow the ${String((hint.hint as { reason?: string }).reason)} hint: ${r.ok ? "" : r.reason}`);
      sims.push(r.box);
      return r.box;
    };

    // Kept from the first check for the rogue check (a box the mesh routes to).
    let anchor: { s: SimServer; holder: GymRelay; label: string } | null = null;

    try {
      await rec.check("§14.1 cross-relay visit: a box on gym-a is reached through every other relay, its ClientHello arrives verbatim, and a name nobody holds closes at the 4 s hold", async () => {
        const s = await register();
        const b = await connectOn(s, RA, "X", { echo: true });
        mustMesh(b, RA);
        const others = M.relays.filter((r) => r !== RA);
        for (const r of others) {
          const t = await until(() => reaches(r, s.fqdn, "X"), 20_000);
          assert(t !== null, `a visit through ${r.relayId} never reached the box on ${RA.relayId}`);
        }
        // Verbatim: the box echoes the visitor's bytes after its label line.
        const v = await RawVisitor.open(RB.ip, s.fqdn);
        await v.firstAnswer(6_000);
        const expected = Buffer.concat([Buffer.from(simAnswer("X", s.fqdn), "latin1"), Buffer.from(v.sent)]);
        await until(async () => v.received.length >= expected.length, 5_000, 100);
        v.end();
        assert(v.received.subarray(0, expected.length).equals(expected), `through ${RB.relayId}: ${v.received.length} bytes back, not the label + the ${v.sent.length}-byte ClientHello verbatim`);
        // A registered-looking name nobody holds: dropped at the hold, through every entry.
        const holds: string[] = [];
        for (const r of M.relays) {
          const miss = await RawVisitor.open(r.ip, `nobody${randomBytes(3).toString("hex")}.${user}.${SERVICES}`);
          await Promise.race([miss.closed, sleep(HOLD_MS + 6_000)]);
          const ms = (miss.closedAt ?? Date.now()) - miss.openedAt;
          miss.end();
          assert(readSimAnswer(miss.received) === null, `${r.relayId} answered a name nobody holds`);
          assert(ms >= HOLD_MS - 500 && ms <= HOLD_MS + 3_000, `${r.relayId} closed the miss after ${ms} ms (hold ${HOLD_MS} ms)`);
          holds.push(`${r.relayId} ${ms} ms`);
        }
        anchor = { s, holder: RA, label: "X" };
        return `reached via ${others.map((r) => r.relayId).join(", ")}; ${v.sent.length} B verbatim; misses closed ${holds.join(", ")}`;
      });

      await rec.check("§14.1 account home: two boxes of one account on different relays: the one off the home gets a co-locate hint, moves make-before-break, and <app>.<user> is answered from every entry", async () => {
        const app = `mesh${randomBytes(3).toString("hex")}.${user}.${SERVICES}`;
        const s1 = await register();
        const s2 = await register();
        const b1 = await connectOn(s1, RA, "H1", { canonicals: [app] });
        mustMesh(b1, RA);
        await sleep(2_000);
        const b2 = await connectOn(s2, RB, "H2", { canonicals: [app] });
        mustMesh(b2, RB);
        // The account may already have a home (its real boxes): whichever box is off it gets the hint.
        const pairs: Array<[SimBox, SimServer]> = [[b1, s1], [b2, s2]];
        let hinted = 0;
        const moved: string[] = [];
        const deadline = Date.now() + 30_000;
        const live: SimBox[] = [b1, b2];
        while (Date.now() < deadline && hinted === 0) {
          for (const [b, s] of pairs) {
            const h = await b.waitHint("co-locate", 1_000);
            if (!h) continue;
            hinted++;
            const to = String((h.hint as { toRelayId?: string }).toRelayId);
            const nb = await follow(b, s, h, [app]);
            live[live.indexOf(b)] = nb;
            moved.push(`${b.label} ${b.relayId}→${to}`);
          }
        }
        assert(hinted > 0, `no co-locate hint within 30 s to either box (H1 on ${RA.relayId}, H2 on ${RB.relayId}): the relays did not agree on one home`);
        // Another round: a box that was not hinted but is still off the home gets its hint now.
        for (const [i, b] of live.entries()) {
          const h = await b.waitHint("co-locate", 5_000);
          if (h) {
            live[i] = await follow(b, pairs[i]![1], h, [app]);
            moved.push(`${b.label} ${b.relayId}→${String((h.hint as { toRelayId?: string }).toRelayId)}`);
          }
        }
        await sleep(MOVE_GRACE_MS + 2_000);
        assert(live[0]!.relayId === live[1]!.relayId, `the boxes ended on ${live[0]!.relayId} and ${live[1]!.relayId}, not one home`);
        const answers: string[] = [];
        for (const r of M.relays) {
          const t = await until(async () => {
            const v = await visitSim(r.ip, app, 6_000);
            if (v.label === "H1" || v.label === "H2") {
              answers.push(`${r.relayId}→${v.label}`);
              return true;
            }
            return false;
          }, 20_000);
          assert(t !== null, `${app} through ${r.relayId} reached neither box`);
        }
        return `home ${live[0]!.relayId}; moved ${moved.join(", ")}; ${answers.join(", ")}`;
      });

      await rec.check("§14.1 phone across relays: a phone on gym-b holds the bare name (granted by its ledger relay); visitors through the other relays reach it; a second phone elsewhere is refused route-held, then claims on vacancy", async () => {
        const bare = `${user}.${SERVICES}`;
        const ranking = phoneLedgerRanking(user, M.directory, null);
        const phoneUrl = (r: GymRelay) => `wss://${r.tunnelHost}:8443/phone-tunnel`;
        const seeds = [new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32))];
        for (const sd of seeds) {
          const g = await mintDeviceGrant(acct, randomBytes(16).toString("hex"), { privateKey: sd, publicKey: ed.getPublicKey(sd) }, ["admin"], acct.keys.adminRoot);
          assert(g.status === 200 && typeof g.json?.grantId === "string", `grant ${g.status}: ${short(g.text)}`);
          grants.push(g.json.grantId as string);
        }
        const readHeaders = async () => (acct.demo ? {} : accountReadHeaders(CONTROL, acct.username, acct.keys.irk));
        const certs = [selfSignedPhoneCert(bare), selfSignedPhoneCert(bare)];
        const certPems = certs.map((c) => c.cert);
        const open = async (i: number, relay: GymRelay) => {
          const opts = {
            account: user,
            seed: seeds[i]!,
            label: `P${i + 1}`,
            tls: certs[i]!,
            com: { control: CONTROL, readHeaders },
          } as unknown as Parameters<typeof SimPhone.connect>[1];
          const p = await SimPhone.connect(phoneUrl(relay), opts);
          if (!Array.isArray((p as unknown as { grants?: unknown }).grants)) {
            p.terminate();
            throw new SkipError("needs chunk F's phoneSim grants (the begin carries no admin grant chain, which a mesh relay refuses)");
          }
          phones.push(p);
          return p;
        };
        const second = RC ?? RA;
        const p1 = await open(0, RB);
        const g1 = await p1.acquire();
        assert(g1.type === "granted", `phone 1 on ${RB.relayId}: ${JSON.stringify(g1)}`);
        for (const r of M.relays) {
          const t = await until(async () => (await phoneAnswering(r.ip, bare, certPems)) === 0, 20_000);
          assert(t !== null, `a TLS visit to ${bare} through ${r.relayId} never reached phone 1 on ${RB.relayId}`);
        }
        const p2 = await open(1, second);
        const r2 = await p2.acquire();
        assert(r2.type === "refused" && r2.code === "route-held", `phone 2 on ${second.relayId} while phone 1 holds: ${JSON.stringify(r2)}`);
        p1.terminate();
        await p1.closed;
        await p2.next((m) => m.type === "route-vacant", 30_000);
        const g2 = await p2.acquire();
        assert(g2.type === "granted", `phone 2 after phone 1 left: ${JSON.stringify(g2)}`);
        const t = await until(async () => (await phoneAnswering(RB.ip, bare, certPems)) === 1, 20_000);
        assert(t !== null, `after the hand-over, a TLS visit to ${bare} through ${RB.relayId} never reached phone 2 on ${second.relayId}`);
        return `ledger ranking ${ranking.join(" > ")}; generation ${String(g1.generation)} on ${RB.relayId} → ${String(g2.generation)} on ${second.relayId}`;
      });

      await rec.check("§14.1 revocation across relays: a box on gym-a reached through gym-b is revoked; within 65 s gym-b refuses, gym-a closes the tunnel, and every relay refuses its HELLO", async () => {
        const s = await register();
        const b = await connectOn(s, RA, "R");
        mustMesh(b, RA);
        assert((await until(() => reaches(RB, s.fqdn, "R"), 20_000)) !== null, `R never reachable through ${RB.relayId}`);
        const r = await revokeServer(acct, s.fqdn);
        assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
        const t0 = Date.now();
        await Promise.race([b.closed, sleep(REVOKE_DEADLINE_MS + 5_000)]);
        assert(b.closedWith && b.closedWith.at - t0 <= REVOKE_DEADLINE_MS, `the tunnel on ${RA.relayId} outlived the deadline`);
        const cut = b.closedWith.at - t0;
        const refusedIn = await until(async () => !(await reaches(RB, s.fqdn, "R")), Math.max(5_000, REVOKE_DEADLINE_MS - (Date.now() - t0)));
        assert(refusedIn !== null, `${RB.relayId} still forwards to the revoked box`);
        const again: string[] = [];
        for (const relay of M.relays) {
          const c = await SimBox.connect(relayTunnelUrl(relay.tunnelHost), await payloadFor(s, [])(), { label: `R@${relay.relayId}`, mesh: { server: s } }).catch(() => null);
          sims.push(...(c ? [c] : []));
          assert(!c?.accepted, `${relay.relayId} took the revoked box back`);
          again.push(`${relay.relayId}: ${String(c?.ack?.reason ?? c?.closedWith?.reason ?? "refused at upgrade")}`);
        }
        return `holder closed ${(cut / 1000).toFixed(1)} s after the revocation (code ${b.closedWith.code}); ${RB.relayId} refused by ${((Date.now() - t0) / 1000).toFixed(1)} s; ${again.join("; ")}`;
      });

      await rec.check("§14.1 dead-man across relays: a box with a 7 d policy and a lease ending in 45 s: its app stops through every entry within 5 s + one poll of the lease end; its control name still answers", async () => {
        const s = await register();
        const app = `deadman.${s.fqdn}`;
        const p: ServingPolicy = {
          account: user,
          box: s.stkHex,
          regGen: 1,
          policyGen: 1,
          grace: "7d",
          onLapse: "stop-apps",
          scopeSha256: nameListSha256([{ class: "control", name: s.fqdn }, { class: "apps", name: `*.${s.fqdn}` }]),
          issuedAt: Date.now(),
        };
        const policySig = bytesToHex(signServingRecord("serving-policy", p, adminSign));
        const pr = await postJson(`https://${CONTROL}/api/accounts/${user}/serving-policy`, { policy: p, signature: policySig });
        if (pr.status === 404 || pr.status === 405) throw new SkipError(`the gym .com has no serving-policy route (${pr.status}): cannot make a lease end in the run`);
        assert(pr.status === 200, `policy ${pr.status}: ${short(pr.text)}`);
        const lease = { ...leaseFor(p, Date.now(), randomBytes(16).toString("hex"))!, notAfter: Date.now() + 45_000 };
        const serving = {
          servingAdminKey: adminPub,
          servingPolicy: { record: p, signature: policySig },
          servingLeases: [{ record: lease, signature: bytesToHex(signServingRecord("serving-lease", lease, adminSign)) }],
        };
        // The policy head must reach the relays first, else the holder decides `policy-stale` (apps off): retry.
        const held: { b: SimBox | null } = { b: null };
        const up = await until(async () => {
          held.b?.terminate();
          held.b = await connectOn(s, RA, "D", { canonicals: [app], serving });
          const t = await until(() => reaches(RB, app, "D"), 6_000);
          return t !== null;
        }, 30_000, 2_000);
        assert(up !== null && held.b, `D's app never answered through ${RB.relayId} (the policy head did not reach ${RA.relayId}?)`);
        const wait = lease.notAfter - Date.now();
        if (wait > 0) await sleep(wait);
        const budget = 5_000 + 5_000 + 5_000;
        const stopped: string[] = [];
        for (const r of M.relays) {
          const t = await until(async () => !(await reaches(r, app, "D")), budget, 1_000);
          assert(t !== null, `D's app still answers through ${r.relayId} ${Math.round((Date.now() - lease.notAfter) / 1000)} s after the lease end`);
          stopped.push(`${r.relayId} +${Math.round((Date.now() - lease.notAfter) / 1000)} s`);
        }
        for (const r of M.relays) assert(await reaches(r, s.fqdn, "D"), `D's control name stopped through ${r.relayId}`);
        return `app stopped after the lease end: ${stopped.join(", ")}; control answers everywhere`;
      });

      if (process.env.GYM_MESH_REBALANCE !== "1") {
        rec.skip("§14.1 rebalancing: visits through gym-c dominate and the account moves there with no failed visit", "set GYM_MESH_REBALANCE=1 once the gym relays run with FLAGSHIP_MESH_REBALANCE_MS shortened (docs/runbooks/relay-mesh.md \"Gym\"); unshortened the decision runs hourly");
      } else {
        // A fresh account with no other box and no other traffic: account A's real boxes (A1, A2, ...) talk to each
        // other through their relay (gossip to each sibling's own name is visitor traffic, counted with the home as the
        // entry) and may attach elsewhere or as legacy boxes, so with account A the home's decision could be "share",
        // "lead" or "legacy-box" depending on what the fleet did in the last window (run 30 alone: moved; full runs 28 and
        // 32: no hint). Here K is the account's only box, so gym-a is its home and every counted byte enters at gym-c.
        await rec.check("§14.1 rebalancing: 600 visits through gym-c to a box on gym-a: gym-a moves the account to gym-c (locality hint), the box moves make-before-break, and no visit through gym-c fails", async () => {
          need3();
          const solo = await createRealAccount();
          const s = await register(solo);
          let b = await connectOn(s, RA, "K");
          mustMesh(b, RA);
          assert((await until(() => reaches(RC!, s.fqdn, "K"), 20_000)) !== null, `K never reachable through ${RC!.relayId}`);
          let failed = 0;
          let visits = 0;
          let stop = false;
          // Each failure's start relative to the hint and the move, and why: a gap in make-before-break clusters at the move.
          const misses: Array<{ at: number; why: string }> = [];
          let hintAt = 0;
          let movedAt = 0;
          const phase = (t: number) => (!hintAt || t < hintAt ? "before-hint" : !movedAt || t < movedAt ? "moving" : `+${Math.round((t - movedAt) / 100) / 10}s after the move`);
          const pump = async () => {
            while (!stop) {
              const t = Date.now();
              const v = await visitSim(RC!.ip, s.fqdn, 6_000);
              visits++;
              if (v.label !== "K") {
                failed++;
                misses.push({ at: t, why: v.label ? `answered by ${v.label}` : (v.error ?? "no answer") });
              }
            }
          };
          const pumps = Array.from({ length: 12 }, () => pump());
          const hint = await (async () => {
            const end = Date.now() + 4 * 60_000;
            while (Date.now() < end) {
              const h = await b.waitHint("locality", 2_000);
              if (h) return h;
            }
            return null;
          })();
          if (!hint) {
            stop = true;
            await Promise.all(pumps);
            // The home's own count of its decisions (§10.2 refusal reasons) says why; no guessing. In a full run account A
            // carries an hour of real traffic through gym-a, so "share"/"lead" (the 60-min byte window) is as likely as
            // "legacy-box".
            const st = await relayStats(RA);
            const reb = (st?.mesh as { rebalance?: unknown } | undefined)?.rebalance;
            const why = reb ? `${RA.relayId} rebalance ${JSON.stringify(reb)}` : `set GYM_RELAY_STATS_SECRET to see ${RA.relayId}'s decision counts`;
            throw new Error(`no locality hint within 4 min after ${visits} visits (${failed} failed) through ${RC!.relayId} to ${s.fqdn}, the only box of the fresh account ${solo.username} (§10.2; ${why})`);
          }
          hintAt = Date.now();
          assert((hint.hint as { toRelayId?: string }).toRelayId === RC!.relayId, `the locality hint names ${String((hint.hint as { toRelayId?: string }).toRelayId)}, not ${RC!.relayId}`);
          b = await follow(b, s, hint, []);
          movedAt = Date.now();
          await sleep(MOVE_GRACE_MS + 5_000);
          stop = true;
          await Promise.all(pumps);
          assert(b.relayId === RC!.relayId, `K is on ${b.relayId}`);
          assert(failed === 0, `${failed} of ${visits} visits through ${RC!.relayId} failed: ${short(misses.map((m) => `${phase(m.at)} ${m.why}`), 900)}`);
          return `${visits} visits, none failed; K (fresh account ${solo.username}) moved ${RA.relayId}→${RC!.relayId}`;
        });
      }

      if (process.env.GYM_MESH_RELAY_C_CONTROL !== "1") {
        const why = "set GYM_MESH_RELAY_C_CONTROL=1 to let the group drain and restart gym-c (scripts/gym-relay-c.sh drain|start; docs/runbooks/relay-mesh.md \"Gym\")";
        rec.skip("§14.1 relay leaving: draining gym-c sends its mesh boxes retire hints; they move and stay reachable through the others", why);
        rec.skip("§14.1 relay joining: gym-c back: bridges form, it turns mesh-ready, visitors through it reach the existing boxes", why);
      } else {
        let leaver: { b: SimBox; s: SimServer } | null = null;
        await rec.check("§14.1 relay leaving: draining gym-c sends its mesh boxes retire hints; they move and stay reachable through the others", async () => {
          need3();
          const s = await register();
          const b = await connectOn(s, RC!, "L");
          mustMesh(b, RC!);
          const t0 = Date.now();
          const d = await script("drain");
          assert(d.code === 0, `gym-relay-c.sh drain exited ${d.code}: ${short(d.stderr || d.stdout, 300)}`);
          const h = await b.waitHint("retire", 60_000, t0);
          assert(h, `L on ${RC!.relayId} got no retire hint within 60 s of the drain`);
          const nb = await follow(b, s, h, []);
          leaver = { b: nb, s };
          for (const r of M.relays.filter((x) => x !== RC)) assert((await until(() => reaches(r, s.fqdn, "L"), 20_000)) !== null, `L not reachable through ${r.relayId} after the move`);
          const h503 = await relayHealth(RC!);
          return `retire hint → ${nb.relayId} in ${Math.round((h.at - t0) / 1000)} s; gym-c health ${h503.status}`;
        });
        await rec.check("§14.1 relay joining: gym-c back: bridges form, it turns mesh-ready, visitors through it reach the existing boxes", async () => {
          need3();
          const st = await script("start");
          assert(st.code === 0, `gym-relay-c.sh start exited ${st.code}: ${short(st.stderr || st.stdout, 300)}`);
          const t0 = Date.now();
          const notReady = await waitReady([RC!], 3 * 60_000);
          assert(notReady.length === 0, `gym-c not mesh-ready 3 min after start: ${notReady.join("; ")}`);
          const l = leaver as { b: SimBox; s: SimServer } | null;
          const x = anchor as { s: SimServer; holder: GymRelay; label: string } | null;
          const sni = l ? l.s.fqdn : x?.s.fqdn;
          const label = l ? "L" : (x?.label ?? "X");
          assert(sni, "no box from an earlier check to visit");
          assert((await until(() => reaches(RC!, sni, label), 30_000)) !== null, `a visit through the rejoined ${RC!.relayId} never reached ${label}`);
          return `mesh-ready ${Math.round((Date.now() - t0) / 1000)} s after start; reaches ${label}`;
        });
      }

      const sim = simRelayFromEnv();
      if ("why" in sim) {
        rec.skip("§14.1 rogue relay: a forged attachment, a replayed expired one, a hint to an unblessed target and a query flood are refused or rate-limited; real routing unaffected", sim.why);
      } else {
        await rec.check("§14.1 rogue relay: a forged attachment, a replayed expired one, a hint to an unblessed target and a query flood are refused or rate-limited; real routing unaffected", async () => {
          const a = anchor as { s: SimServer; holder: GymRelay; label: string } | null;
          assert(a, "needs the cross-relay check's box");
          // A transport error (status 0) never reached .com: ask again; a refusal is an answer.
          let bl = await fetchRelayBlessing({ relayId: sim.relayId, seed: sim.seed });
          for (let i = 0; i < 3 && bl.status === 0; i++) {
            await new Promise((r) => setTimeout(r, 5_000));
            bl = await fetchRelayBlessing({ relayId: sim.relayId, seed: sim.seed });
          }
          assert(bl.blessing, `the gym .com refused ${sim.relayId}'s blessing request: ${bl.status} ${short(bl.body)} (admit it: ${MESH_RUNBOOK})`);
          const rogue = await MeshSimRelay.connect({ relayId: sim.relayId, seed: sim.seed, peer: RB, blessing: bl.blessing });
          held.rogue = rogue;
          const before = await relayStats(RB);
          const now = Date.now();
          // 1. A forged attachment: the anchor box's name, signed by a key that is not its STK, naming the rogue.
          const thief = new Uint8Array(randomBytes(32));
          const forged: BoxAttachment = { serverFqdn: a.s.fqdn, boxPub: a.s.stkHex, regGen: 1, relayId: sim.relayId, attachedAt: now, issuedAt: now, notAfter: now + 20 * 60_000 };
          // 2. A replay: the box's own signature, but long expired.
          const old: BoxAttachment = { ...forged, attachedAt: now - 3_600_000, issuedAt: now - 3_600_000, notAfter: now - 1_800_000 };
          rogue.send({
            type: "announce",
            items: [
              { kind: "box", attachment: forged, signature: signRelayMeshRecord("relay-attachment", forged, (m) => ed.sign(m, thief)) },
              { kind: "box", attachment: old, signature: signRelayMeshRecord("relay-attachment", old, (m) => ed.sign(m, a.s.stk.privateKey)) },
            ],
          });
          // 3. A move hint to an unblessed target, as a box would get it: the box's own check refuses it.
          const hintRec = { serverFqdn: a.s.fqdn, boxPub: a.s.stkHex, fromRelayId: sim.relayId, toRelayId: "gym-zz", reason: "retire" as const, issuedAt: now, notAfter: now + 60_000 };
          const holderBox = sims.find((x) => x.label === a.label && x.accepted);
          const hintVerdict = holderBox
            ? simCheckHint(holderBox, { hint: hintRec, signature: signRelayMeshRecord("relay-move-hint", hintRec, (m) => ed.sign(m, sim.seed)), target: { ...bl.blessing, relayId: "gym-zz" } as unknown as Record<string, unknown> }, {
                server: a.s,
                servicesApex: SERVICES,
                directory: M.directory,
                directoryFetchedAt: M.directoryFetchedAt,
                caKeys: M.caKeys,
                rate: emptyMoveHintRateState(),
              })
            : { ok: false as const, reason: "no-relay" as const };
          assert(!hintVerdict.ok, "the box would follow a rogue hint to an unblessed target");
          // 4. A query flood past the per-peer limit (500/s, burst 1,000).
          const flood = await rogue.flood(a.s.fqdn, 2_500, 8_000);
          assert(flood.busy > 0 || rogue.closedWith !== null, `2,500 queries at once: ${flood.answers} answers, none busy, bridge still open`);
          // Real routing is unaffected: every entry still reaches the box on its real holder.
          for (const r of M.relays) assert((await until(() => reaches(r, a.s.fqdn, a.label), 15_000)) !== null, `after the rogue's messages, ${r.relayId} no longer reaches ${a.label}`);
          const after = await relayStats(RB);
          const rejected = (st: Record<string, unknown> | null) =>
            ((st?.mesh as { peers?: Array<{ relayId?: string; rejected?: number }> } | undefined)?.peers ?? []).find((p) => p.relayId === sim.relayId)?.rejected ?? null;
          const rj = rejected(after);
          if (after) assert((rj ?? 0) >= 2 + (rejected(before) ?? 0), `${RB.relayId}'s stats count ${String(rj)} rejected items from ${sim.relayId}`);
          return `forged + replayed refused (routing intact${after ? `, ${RB.relayId} counts ${String(rj)} rejected` : ""}); rogue hint refused by the box check (${hintVerdict.ok ? "" : hintVerdict.reason}); flood: ${flood.answers} answers, ${flood.busy} busy${rogue.closedWith ? `, bridge closed ${rogue.closedWith.code} ${rogue.closedWith.reason}` : ""}`;
        });
      }

      rec.skip(
        "§14.1 .com contact: the gym feed paused → relays 503 at 60 s and refuse new tunnels; resumed → healthy",
        `no gym-only switch pauses the relay feed (chunk B's ServingFeed alarm is the only publisher) and it cannot be faked from here: blocking one relay's feed fetch does not make it stale, because its peers gossip every head over the bridges (§6.3), and closing bridges too would take the relay out of the mesh rather than test the rule. Covered by tools/relay-conformance MESH09 (stale 60 s → try-again + 503, ${HEAD_REFUSE_NEW_MS / 60_000} min; close-all; a peer's head keeps a relay fresh) on both relays and mixed pairs.`,
      );
    } finally {
      held.rogue?.close();
      for (const b of sims) b.terminate();
      for (const p of phones) p.terminate();
      for (const s of servers) await revokeServer(ownerOf.get(s.fqdn) ?? acct, s.fqdn).catch(() => undefined);
      for (const grantId of grants) {
        const r = { grantId, username: user, reason: "decommissioned" as const, issuedAt: Date.now() };
        await postJson(`https://${CONTROL}/api/users/${user}/device-grants/revoke`, { request: r, signature: bytesToHex(signRevokeDeviceCapabilityGrant(r, acct.keys.irk)) }).catch(() => undefined);
      }
    }
  },
};

/** `bash scripts/gym-relay-c.sh <op>` from the repo root (only with GYM_MESH_RELAY_C_CONTROL=1). */
function script(op: "drain" | "start"): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile("bash", ["scripts/gym-relay-c.sh", op], { cwd: REPO, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, stdout, stderr });
    });
  });
}

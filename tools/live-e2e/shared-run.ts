#!/usr/bin/env -S npx tsx
/**
 * The live gym runner: provisions ONE shared fleet per run, runs the scenario
 * groups against it, and always tears the fleet down.
 *
 *   account A: `home` (demo flow) + `home2` (gym provision, same account)
 *   account B: `home` (demo flow) — a second, unrelated account; `home2` (unpaired) takes its backup
 *   account R: `home` + `home2` (a REAL account: admin root pinned, read tokens, admin-only
 *              add-server; both boxes share the SWK a phone derives for `home`, so `home`
 *              can migrate onto `home2`)
 *   A3: account A's `home3` (gym provision), left unpaired: the `archive` group restores onto it
 *
 * Groups declare which boxes they need; only those are provisioned. Groups in
 * the same phase run in parallel (each uses its own app slugs); later phases
 * hold the box-wide or destructive scenarios and run one after another.
 *
 *   npx tsx tools/live-e2e/shared-run.ts                       # every group
 *   npx tsx tools/live-e2e/shared-run.ts --groups core,gating  # a subset
 *   npx tsx tools/live-e2e/shared-run.ts --keep                # leave the fleet up (prints --reuse)
 *   npx tsx tools/live-e2e/shared-run.ts --reuse gym-results/<run>/fleet.json
 *   npx tsx tools/live-e2e/shared-run.ts --teardown --reuse gym-results/<run>/fleet.json   # tear a kept fleet down
 *   npx tsx tools/live-e2e/shared-run.ts --dns-probe --groups core   # also write the DNS timeline of the first box's issuance (docs/wildcard-dns.md)
 *   npx tsx tools/live-e2e/shared-run.ts --list
 *   npx tsx tools/live-e2e/shared-run.ts --all-boxes --keep    # provision the whole fleet whatever the groups need
 *
 * Env: GYM_ADMIN_SECRET, GYM_DEMO_IRK_KEK (both required), GYM_LIVE_CONTROL_APEX,
 *      GYM_LIVE_SERVICES_APEX, GYM_RUN_DIR (artifact dir).
 *
 * Exit: 0 all green · 1 a check failed · 3 nothing failed but something was
 * skipped (inconclusive) · 2 the harness crashed.
 */
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { deriveSWK, ed } from "@flagship/protocol";
import { join } from "node:path";
import { ADMIN, CONTROL, KEK, Recorder, SERVICES, runDir, tryHttp, writeJson } from "./lib/harness.js";
import { dnsRecordsNeeded } from "./lib/dnsBudget.js";
import { startDnsProbe, type DnsProbe } from "./lib/dnsProbe.js";

/** The shared flagship.services DNS zone's record cap (gym and prod together). */
const DNS_ZONE_CAP = Number(process.env.GYM_DNS_ZONE_CAP || 200);
import {
  Account,
  addBox,
  createDemoAccount,
  createRealAccount,
  rememberRealAccount,
  demoServerId,
  freshUsername,
  stallReport,
  sweep,
  teardown,
  waitOnline,
  type Box,
} from "./lib/fleet.js";
import { GROUPS, type Group, type GroupCtx, type Slot } from "./groups/index.js";
import { acmeBudget } from "./lib/acmeProbe.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function log(s: string): void {
  process.stdout.write(`[runner] ${s}\n`);
}

interface FleetFile {
  /** A real account carries its (throwaway, gym-only) key seeds so `--reuse` can sign for it. */
  accounts: Array<{ username: string; boxes: Box[]; real?: Record<string, string> }>;
}

const SEEDED = ["irk", "aid", "adminRoot", "delegated", "rck", "primaryDevice"] as const;

function saveFleet(dir: string, accounts: Account[]): void {
  const data: FleetFile = {
    accounts: accounts.map((a) => ({
      username: a.username,
      boxes: a.boxes,
      ...(a.demo ? {} : { real: { umk: bytesToHex(a.keys.umk), ...Object.fromEntries(SEEDED.map((k) => [k, bytesToHex(a.keys[k].privateKey)])) } }),
    })),
  };
  writeJson(dir, "fleet.json", data);
}

function loadFleet(path: string): Account[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as FleetFile;
  return data.accounts.map((a) => {
    let acct: Account;
    if (a.real) {
      const kp = (h: string) => ({ privateKey: hexToBytes(h), publicKey: ed.getPublicKey(hexToBytes(h)) });
      const keys = { umk: hexToBytes(a.real.umk!), ...Object.fromEntries(SEEDED.map((k) => [k, kp(a.real![k]!)])) } as Account["keys"];
      acct = new Account(a.username, keys, false);
      rememberRealAccount(acct);
    } else {
      acct = new Account(a.username);
    }
    acct.boxes.push(...a.boxes.map((b) => ({ ...b, session: undefined })));
    return acct;
  });
}

async function main(): Promise<number> {
  if (flag("--list")) {
    for (const g of GROUPS) log(`${g.name.padEnd(14)} phase ${g.phase}  needs ${g.needs.join(",")}  — ${g.title}`);
    return 0;
  }
  if (!ADMIN || !KEK) {
    log("GYM_ADMIN_SECRET and GYM_DEMO_IRK_KEK are required (load .gym-secrets.env)");
    return 2;
  }
  if (flag("--teardown")) {
    const path = opt("--reuse");
    if (!path) {
      log("--teardown needs --reuse <fleet.json>");
      return 2;
    }
    const rep = await teardown(loadFleet(path));
    log(`teardown: ${JSON.stringify(rep).slice(0, 600)}`);
    const left = await sweep(false);
    log(`gym servers left: ${Array.isArray(left.body?.servers) ? left.body.servers.length : "?"}; gym DNS records left: ${left.body?.dnsWouldDelete}`);
    return 0;
  }
  const wanted = (opt("--groups") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !GROUPS.some((g) => g.name === w));
  if (unknown.length) {
    log(`unknown group(s): ${unknown.join(", ")} (see --list)`);
    return 2;
  }
  const groups: Group[] = wanted.length ? GROUPS.filter((g) => wanted.includes(g.name)) : GROUPS;
  const needs = new Set<Slot>(flag("--all-boxes") ? ["A1", "A2", "A3", "B1", "B2", "B3", "R1", "R2"] : groups.flatMap((g) => g.needs));
  const keep = flag("--keep");
  const reusePath = opt("--reuse");
  const dir = runDir("live-run");
  log(`control=${CONTROL} services=${SERVICES} groups=${groups.map((g) => g.name).join(",")}`);
  log(`artifacts: ${dir}`);

  let accounts: Account[] = [];
  let tornDown = false;
  const doTeardown = async (why: string): Promise<void> => {
    if (tornDown || reusePath || keep) return;
    tornDown = true;
    log(`teardown (${why})…`);
    const rep = await teardown(accounts).catch((e) => ({ error: String(e) }));
    writeJson(dir, "teardown.json", rep);
    log(`teardown: ${JSON.stringify(rep).slice(0, 400)}`);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      log(`${sig} — tearing down before exit`);
      void doTeardown(sig).finally(() => process.exit(130));
    });
  }

  if (!reusePath && !flag("--skip-acme-check")) {
    // Gym and prod certificates share flagship.services' Let's Encrypt budget.
    const budget = await acmeBudget(SERVICES);
    log(`Let's Encrypt budget for ${SERVICES}: ${budget.ok ? "room" : "EXHAUSTED"} (${budget.detail})`);
    if (!budget.ok) {
      log("not provisioning: every new box (gym or prod) would fail to get a certificate; try again in a few hours");
      return 3;
    }
  }
  const startedAt = new Date();
  const summary: Record<string, { pass: number; fail: number; skip: number }> = {};
  const fleetRec = new Recorder("fleet");
  const phases = [...new Set(groups.map((g) => g.phase))].sort((x, y) => x - y);
  const firstPhase = (s: Slot) => Math.min(...groups.filter((g) => g.needs.includes(s)).map((g) => g.phase));
  const lastPhase = (s: Slot) => Math.max(...groups.filter((g) => g.needs.includes(s)).map((g) => g.phase));
  // A1 and B1 are their demo accounts' first box (released only with the
  // account); the others are gym-provisioned and can go as soon as no later
  // group needs them. A box is provisioned up front unless a released box's
  // last phase comes before its first one: then it starts once that box is
  // gone, so the fleet's DNS records never peak above what the shared zone holds.
  const RELEASABLE: Slot[] = ["A2", "A3", "B2", "B3", "R1", "R2"];
  const plan = new Map<Slot, number>();
  for (const s of needs) {
    const before = flag("--all-boxes") || !RELEASABLE.includes(s) ? [] : [...needs].filter((r) => r !== s && RELEASABLE.includes(r) && lastPhase(r) < firstPhase(s));
    plan.set(s, before.length ? Math.max(...before.map(lastPhase)) : -Infinity);
  }
  // Boxes up at once, phase by phase: up from its kick (start, or the end of
  // phase plan(s)) until released after its last phase.
  const alive = (s: Slot, p: number) => plan.get(s)! < p && (!RELEASABLE.includes(s) || flag("--all-boxes") || p <= lastPhase(s));
  const alivePeak = Math.max(0, ...phases.map((p) => [...needs].filter((s) => alive(s, p)).length));
  const accountsNeeded = new Set([...needs].map((s) => s[0]));

  if (!reusePath) {
    const z = await sweep(false).catch(() => null);
    const zoneRecords = typeof z?.body?.zoneRecords === "number" ? z.body.zoneRecords : null;
    const leftover = Number(z?.body?.dnsWouldDelete ?? 0) + (Array.isArray(z?.body?.servers) ? z.body.servers.length : 0);
    if (leftover) {
      log(`another run's gym servers or DNS records are still up (${leftover}); reap them with tools/live-e2e/sweep-cli.ts --destroy once no gym run is in progress`);
      return 3;
    }
    if (zoneRecords !== null) {
      // One wildcard per account (docs/wildcard-dns.md): an account holds 4 records
      // whatever its box count; a box only adds records while its certificate is
      // being issued. (Before it was ~8 per account and ~4 per box.)
      const need = dnsRecordsNeeded(alivePeak, accountsNeeded.size);
      log(`DNS zone: ${zoneRecords} of ${DNS_ZONE_CAP} records; this run adds up to ~${need} (peak ${alivePeak} boxes)`);
      if (zoneRecords + need > DNS_ZONE_CAP - 5) {
        log("not provisioning: the shared zone would fill and new boxes (prod's too) couldn't get their DNS-01 records; run fewer groups (--groups) or free prod records");
        return 3;
      }
    }
  }

  let dnsProbe: DnsProbe | undefined;
  let A: Account | undefined;
  let B: Account | undefined;
  let R: Account | undefined;
  const SLOT_NAME: Record<Slot, string> = { A1: "home", A2: "home2", A3: "home3", B1: "home", B2: "home2", B3: "home3", R1: "home", R2: "home2" };
  const accountOf = (s: Slot) => (s[0] === "A" ? A : s[0] === "B" ? B : R);
  const slotBox = (s: Slot): Box | undefined => accountOf(s)?.boxes.find((b) => b.serverName === SLOT_NAME[s]);
  const accountMade = new Map<string, Promise<Account>>();
  const ensureAccount = (letter: string): Promise<Account> => {
    let p = accountMade.get(letter);
    if (!p) {
      p = (async () => {
        let acct: Account;
        if (letter === "R") {
          acct = await createRealAccount();
          R = acct;
        } else {
          const username = freshUsername(letter === "A" ? "ga" : "gb");
          // Before the account exists, so the probe sees the box name from its first answer.
          if (letter === "A" && flag("--dns-probe")) {
            dnsProbe = await startDnsProbe({ box: `home.${username}.${SERVICES}`, account: `${username}.${SERVICES}`, apex: SERVICES }, dir).catch((e) => {
              log(`dns probe not started: ${e instanceof Error ? e.message : String(e)}`);
              return undefined;
            });
            if (dnsProbe) log(`dns probe on home.${username}.${SERVICES} (${dir}/dns-probe.jsonl)`);
          }
          acct = await createDemoAccount(username);
          if (letter === "A") A = acct;
          else B = acct;
        }
        accounts.push(acct);
        saveFleet(dir, accounts);
        return acct;
      })();
      accountMade.set(letter, p);
    }
    return p;
  };
  const provisioned = new Map<Slot, Promise<void>>();
  const provision = (s: Slot): Promise<void> => {
    let p = provisioned.get(s);
    if (!p) {
      p = (async () => {
        const made = await fleetRec.check(`provision ${s} (${SLOT_NAME[s]} of account ${s[0]})`, async () => {
          const acct = await ensureAccount(s[0]!);
          if (s === "A1" || s === "B1") return `${acct.username}: ${acct.box("home").fqdn} (demo flow)`;
          const extras = s[0] === "R"
            ? { provisionExtras: { swkHex: bytesToHex(deriveSWK({ seed: acct.keys.umk }, `home.${acct.username}.${SERVICES}`)), backupIntervalMs: 60_000 } }
            : s === "B3"
              ? { installerGitRef: "main" }
              : {};
          const b = await addBox(acct, SLOT_NAME[s], extras);
          saveFleet(dir, accounts);
          return `${b.fqdn} (${b.serverId})`;
        });
        const b = slotBox(s);
        if (!made || !b) return;
        await fleetRec.check(`${b.serverName}.${b.account} online + serving (≤20 min)`, async () => {
          try {
            const r = await waitOnline(b, 20, (m) => fleetRec.log(m));
            if (dnsProbe && s === "A1") setTimeout(() => dnsProbe?.stopIssuance(), 120_000);
            if (!b.serverId) b.serverId = await demoServerId(b.account).catch(() => null);
            saveFleet(dir, accounts);
            return r;
          } catch (e) {
            writeJson(dir, `stall-${b.fqdn}.json`, await stallReport(b).catch((x) => ({ error: String(x) })));
            throw e;
          }
        });
      })();
      provisioned.set(s, p);
    }
    return p;
  };
  const release = async (s: Slot): Promise<void> => {
    const b = slotBox(s);
    if (!b || keep || reusePath || b.via !== "gym-provision" || !b.serverId) return;
    const r = await tryHttp(`https://${CONTROL}/api/gym/teardown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN },
      body: JSON.stringify({ serverIds: [b.serverId], serverDomains: [b.fqdn] }),
    }, 300_000);
    b.online = false;
    log(`released ${s} (${b.fqdn}): ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 160)}`);
  };

  try {
    // ── provision ────────────────────────────────────────────────────────
    if (reusePath) {
      accounts = loadFleet(reusePath);
      A = accounts.find((a) => a.demo && a.username.startsWith("ga"));
      B = accounts.find((a) => a.demo && a.username.startsWith("gb"));
      R = accounts.find((a) => !a.demo);
      log(`reusing fleet from ${reusePath}: ${accounts.map((a) => a.boxes.map((b) => b.fqdn).join(" ")).join(" ")}`);
      await Promise.all(
        accounts.flatMap((a) => a.boxes).map((b) =>
          fleetRec.check(`${b.serverName}.${b.account} online + serving`, () => waitOnline(b, 3)),
        ),
      );
    } else {
      // Every account the run needs exists up front (its demo box with it).
      for (const letter of accountsNeeded) void ensureAccount(letter).catch(() => undefined);
      if (accountsNeeded.has("A")) void provision("A1");
      if (accountsNeeded.has("B")) void provision("B1");
      for (const s of needs) if (plan.get(s) === -Infinity) void provision(s);
    }

    // ── groups, phase by phase ───────────────────────────────────────────
    for (const phase of phases) {
      const inPhase = groups.filter((g) => g.phase === phase);
      if (!reusePath) await Promise.all([...new Set(inPhase.flatMap((g) => g.needs))].map(provision));
      log(`phase ${phase}: ${inPhase.map((g) => g.name).join(", ")}`);
      const runOne = async (g: Group): Promise<void> => {
        const rec = new Recorder(g.name);
        const missing = g.needs.filter((s) => !slotBox(s)?.online);
        if (missing.length) {
          rec.skip(g.title, `box(es) ${missing.join(",")} not online`);
        } else {
          const ctx: GroupCtx = {
            groupOk: (name) => {
              const s = summary[name];
              return !!s && s.fail === 0 && s.skip === 0 && s.pass > 0;
            },
            A: A!,
            B,
            R,
            rec,
            dir,
            box: (s) => slotBox(s)!,
            adopt: (acct, b) => {
              if (!accounts.includes(acct)) accounts.push(acct);
              if (!acct.boxes.includes(b)) acct.boxes.push(b);
              saveFleet(dir, accounts);
            },
          };
          try {
            await g.run(ctx);
          } catch (e) {
            rec.results.push({ name: `${g.name} crashed`, ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e), ms: 0 });
            rec.log(`✗ crashed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        writeJson(dir, `${g.name}.json`, { group: g.name, title: g.title, results: rec.results });
        summary[g.name] = { pass: rec.passed, fail: rec.failed, skip: rec.skipped };
      };
      if (inPhase.every((g) => g.parallel !== false)) await Promise.all(inPhase.map(runOne));
      else for (const g of inPhase) await runOne(g);
      if (!reusePath) {
        await Promise.all([...needs].filter((s) => RELEASABLE.includes(s) && lastPhase(s) === phase).map(release));
        for (const s of needs) if (plan.get(s) === phase) void provision(s);
      }
    }
  } finally {
    writeJson(dir, "fleet-checks.json", fleetRec.results);
    summary.fleet = { pass: fleetRec.passed, fail: fleetRec.failed, skip: fleetRec.skipped };
    await doTeardown("end of run");
    if (dnsProbe) {
      await new Promise((r) => setTimeout(r, 15_000));
      dnsProbe.stop();
      writeJson(dir, "dns-probe-summary.json", dnsProbe.summary());
    }
    if (keep && !reusePath) log(`--keep: fleet left up. Reuse: --reuse ${join(dir, "fleet.json")}`);
  }

  let left = await sweep(false).catch((e) => ({ status: 0, body: String(e) }));
  let leftServers = Array.isArray(left.body?.servers) ? left.body.servers : [];
  let leftDns = Number(left.body?.dnsWouldDelete ?? 0);
  if (!reusePath && !keep && (leftServers.length || leftDns)) {
    log(`after teardown: ${leftServers.length} gym server(s) and ${leftDns} gym DNS record(s) left — sweeping`);
    const swept = await sweep(true).catch((e) => ({ status: 0, body: String(e) }));
    writeJson(dir, "sweep.json", swept);
    left = await sweep(false).catch((e) => ({ status: 0, body: String(e) }));
    leftServers = Array.isArray(left.body?.servers) ? left.body.servers : [];
    leftDns = Number(left.body?.dnsWouldDelete ?? 0);
  }
  writeJson(dir, "summary.json", { control: CONTROL, startedAt, finishedAt: new Date(), summary, gymServersLeft: leftServers, gymDnsLeft: leftDns });
  log("──────── summary");
  let fail = 0;
  let skip = 0;
  for (const [name, s] of Object.entries(summary)) {
    log(`${s.fail ? "✗" : s.skip ? "·" : "✓"} ${name.padEnd(14)} ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped`);
    fail += s.fail;
    skip += s.skip;
  }
  log(`gym-labelled servers still on UpCloud: ${leftServers.length}${leftServers.length ? " — " + leftServers.map((s: { title: string }) => s.title).join(", ") : ""}; gym DNS records left: ${leftDns}`);
  log(`checks: ${Object.values(summary).reduce((n, s) => n + s.pass + s.fail + s.skip, 0)} in ${Math.round((Date.now() - startedAt.getTime()) / 60_000)} min`);
  log(`artifacts: ${dir}/summary.json`);
  return fail ? 1 : skip ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stdout.write(`[runner] crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(2);
  });

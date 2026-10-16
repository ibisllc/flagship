#!/usr/bin/env -S npx tsx
/**
 * The live gym runner: provisions ONE shared fleet per run, runs the scenario
 * groups against it, and always tears the fleet down.
 *
 *   account A: `home` (demo flow) + `home2` (gym provision, same account)
 *   account B: `home` (demo flow) — a second, unrelated account
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
import { ADMIN, CONTROL, KEK, Recorder, SERVICES, runDir, writeJson } from "./lib/harness.js";
import {
  Account,
  addBox,
  createDemoAccount,
  createRealAccount,
  rememberRealAccount,
  demoServerId,
  freshUsername,
  sweep,
  teardown,
  waitOnline,
  type Box,
} from "./lib/fleet.js";
import { GROUPS, type Group, type GroupCtx, type Slot } from "./groups/index.js";

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
  const needs = new Set<Slot>(flag("--all-boxes") ? ["A1", "A2", "A3", "B1", "R1", "R2"] : groups.flatMap((g) => g.needs));
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

  const startedAt = new Date();
  const summary: Record<string, { pass: number; fail: number; skip: number }> = {};
  try {
    // ── provision ────────────────────────────────────────────────────────
    const fleetRec = new Recorder("fleet");
    if (reusePath) {
      accounts = loadFleet(reusePath);
      log(`reusing fleet from ${reusePath}: ${accounts.map((a) => a.boxes.map((b) => b.fqdn).join(" ")).join(" ")}`);
      await Promise.all(
        accounts.flatMap((a) => a.boxes).map((b) =>
          fleetRec.check(`${b.serverName}.${b.account} online + serving`, () => waitOnline(b, 3)),
        ),
      );
    } else {
      const wantA = needs.has("A1") || needs.has("A2") || needs.has("A3");
      const wantB = needs.has("B1");
      const kicks: Promise<unknown>[] = [];
      if (wantA) {
        kicks.push(
          fleetRec.check("create account A + its home box (demo flow)", async () => {
            const a = await createDemoAccount(freshUsername("ga"));
            accounts.push(a);
            saveFleet(dir, accounts);
            // More boxes need the account registered first.
            const more = await Promise.all((["A2", "A3"] as const).filter((s) => needs.has(s)).map((s) => addBox(a, s === "A2" ? "home2" : "home3")));
            saveFleet(dir, accounts);
            return [`${a.username}: ${a.box("home").fqdn}`, ...more.map((b) => `${b.fqdn} (${b.serverId})`)].join(" + ");
          }),
        );
      }
      if (wantB) {
        kicks.push(
          fleetRec.check("create account B + its home box (demo flow)", async () => {
            const b = await createDemoAccount(freshUsername("gb"));
            accounts.push(b);
            saveFleet(dir, accounts);
            return `${b.username}: ${b.box("home").fqdn}`;
          }),
        );
      }
      if (needs.has("R1") || needs.has("R2")) {
        kicks.push(
          fleetRec.check("create REAL account R (admin root pinned) + its boxes (admin-approved add-server)", async () => {
            const r = await createRealAccount();
            accounts.push(r);
            saveFleet(dir, accounts);
            const provisionExtras = { swkHex: bytesToHex(deriveSWK({ seed: r.keys.umk }, `home.${r.username}.${SERVICES}`)), backupIntervalMs: 60_000 };
            const made = await Promise.all((["R1", "R2"] as const).filter((s) => needs.has(s)).map((s) => addBox(r, s === "R1" ? "home" : "home2", { provisionExtras })));
            saveFleet(dir, accounts);
            return `${r.username}: ${made.map((b) => `${b.fqdn} (${b.serverId})`).join(" + ")}`;
          }),
        );
      }
      await Promise.all(kicks);
      const boxes = accounts.flatMap((a) => a.boxes);
      await Promise.all(
        boxes.map((b) =>
          fleetRec.check(`${b.serverName}.${b.account} online + serving (≤20 min)`, async () => {
            const r = await waitOnline(b, 20, (s) => fleetRec.log(s));
            if (!b.serverId) b.serverId = await demoServerId(b.account).catch(() => null);
            saveFleet(dir, accounts);
            return r;
          }),
        ),
      );
    }
    writeJson(dir, "fleet-checks.json", fleetRec.results);
    summary.fleet = { pass: fleetRec.passed, fail: fleetRec.failed, skip: fleetRec.skipped };

    const A = accounts.find((a) => a.demo && a.username.startsWith("ga"));
    const B = accounts.find((a) => a.demo && a.username.startsWith("gb"));
    const R = accounts.find((a) => !a.demo);
    const slotBox = (s: Slot): Box | undefined => {
      switch (s) {
        case "A1":
          return A?.boxes.find((b) => b.serverName === "home");
        case "A2":
          return A?.boxes.find((b) => b.serverName === "home2");
        case "A3":
          return A?.boxes.find((b) => b.serverName === "home3");
        case "B1":
          return B?.boxes.find((b) => b.serverName === "home");
        case "R1":
          return R?.boxes.find((b) => b.serverName === "home");
        case "R2":
          return R?.boxes.find((b) => b.serverName === "home2");
      }
    };

    // ── groups, phase by phase ───────────────────────────────────────────
    const phases = [...new Set(groups.map((g) => g.phase))].sort((x, y) => x - y);
    for (const phase of phases) {
      const inPhase = groups.filter((g) => g.phase === phase);
      log(`phase ${phase}: ${inPhase.map((g) => g.name).join(", ")}`);
      const runOne = async (g: Group): Promise<void> => {
        const rec = new Recorder(g.name);
        const missing = g.needs.filter((s) => !slotBox(s)?.online);
        if (missing.length) {
          rec.skip(g.title, `box(es) ${missing.join(",")} not online`);
        } else {
          const ctx: GroupCtx = {
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
    }
  } finally {
    await doTeardown("end of run");
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

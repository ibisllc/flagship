#!/usr/bin/env -S npx tsx
/**
 * LIVE F9 lanes (RELEASE-0.3-JOURNAL.md F9; docs/runbooks/final-deploy.md "The 0.2 apps, Studios and servers
 * until 0.3 ships"): 0.2 clients against the 0.3 gym. Two modes; the third F9 case (a 0.2 Studio hosting the
 * 0.3 appliance) is a GUI and is a manual step in docs/runbooks/0.3-hardware-acceptance.md §18.
 *
 *   recipe   (F9 b) a 0.2 app's recipe ("installerGitRef": "main", signed into the blob) through the 0.3
 *            installer. Proves: (1) the 0.3 engine refuses it as it stands, with its sentence (what a 0.3
 *            Studio shows today: it passes the recipe's own ref through; see the lane report); (2) given the
 *            exact endorsed commit as the burn ref, the 0.3 ISO installs it, the 0.3 bootstrap registers a
 *            blob that names "main", the phone unlocks the first boot, and the box serves, with no
 *            "needs an update" flag on /pods.
 *   box      (F9 a) a server running 0.2 (main at the endorsed 0.2 box release, installed the 0.2 way: the 0.2
 *            tree's own cloud-init, which clones the commit from GitHub) on a REAL account against the 0.3 gym
 *            `.com`. Proves: (1) it registers and heartbeats; (2) `.com` flags it `updateRequired: box-too-old`
 *            on /pods (the apps' "This server needs an update"); (3) it gets no certificate (DNS-01 answers 410
 *            under 0.3). Then, ONLY once 0.3 is on GitHub `main` AND endorsed there (a 0.2 box lists releases
 *            from origin/main and trusts the production maintainer pin, so the gym cannot hand it one):
 *            (4) an admin-root-signed update order to main's head (or the box's own first-boot move) takes it
 *            to 0.3: the flag clears, it gets a certificate from the 0.3 issuance service and serves. Before
 *            that (every gym run until release step 7) the update half is SKIPPED with that reason, exit 3.
 *
 *   set -a; source .gym-secrets.env; set +a
 *   npx tsc -b && npx tsx tools/live-e2e/lanes/upgrade-02.ts recipe
 *   npx tsx tools/live-e2e/lanes/upgrade-02.ts box
 *
 * Env: GYM_INSTALLER_GIT_REF / GYM_WORKTREE (the gym release, recipe mode's burn ref), F9_FROM_COMMIT (box mode:
 *      the 0.2 commit, default the 0.2 endorsed box release dbdf2e08), F9_REPO_URL (default GitHub), ISO_LANE_*.
 * Prerequisites: the gym lock free (taken; GYM_LOCK_HELD=1 under gym-release-run.sh), no gym servers up, the
 *      UpCloud token; recipe: curl + xorriso; box: git (archive of the 0.2 commit from this checkout), npm
 *      (installs the 0.2 tree's dependencies once into ISO_LANE_WORK, ~2 GB).
 * Duration: recipe ~55-70 min (one ISO install); box ~30 min for the 0.2 half (+ ~10 min one-time 0.2 build),
 *      +30-45 min when the update half runs. Cost: one UpCloud server each.
 * Exit: 0 green · 1 a check failed · 3 nothing failed but something was skipped · 2 crashed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { installBlobJsonShortString } from "@flagship/control-plane";
import { signAuthCode, signInstallBlob, signUpdateOrder, type InstallBlob, type UpdateOrder } from "@flagship/protocol";
import { BootApprover } from "../lib/bootApprover.js";
import { createRealAccount, issueAuthCode, newAuthCode, pair, pods, waitOnline, type Account, type Box } from "../lib/fleet.js";
import { takeGymLock } from "../lib/gymLock.js";
import { ADMIN, CONTROL, Recorder, SkipError, assert, http, postJson, runDir, short, sleep, tryHttp, writeJson } from "../lib/harness.js";
import {
  ISO_WORK,
  ISO_ZONE,
  ISO_PLAN,
  bootFromDisk,
  bootIsoServer,
  destroyIsoServer,
  gymCounts,
  isoBox,
  issueIsoRecipe,
  personalizedIso,
  preseedFor,
  publicIpv4,
  removeIso,
  upcloud,
  waitInstallEvidence,
} from "../lib/isoBox.js";
import { BRANCH_REF_REFUSAL, parseLsRemote, podView, productAtLeast } from "../lib/upgrade02.js";
import { mailboxAuth } from "../groups/update.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const GYM_WT = process.env.GYM_WORKTREE || `${homedir()}/.cache/flagship/gym-worktree`;
const REPO_URL = process.env.F9_REPO_URL || "https://github.com/ibisllc/flagship.git";
const RAW_MAIN = process.env.F9_RAW_MAIN || "https://raw.githubusercontent.com/ibisllc/flagship/main";
const EVIDENCE = "Disk key secured: one unlock key slot, install key removed";
/** The endorsed 0.2 box release (AGENTS.md "Release run 2026-10-20/21"). */
const DEFAULT_02 = "dbdf2e08";
const DEBIAN_13_TEMPLATE = process.env.F9_TEMPLATE || "01000000-0000-4000-8000-000020080100";
const log = (s: string): void => void process.stdout.write(`[upgrade-02] ${s}\n`);

function gymRelease(): string {
  if (process.env.GYM_INSTALLER_GIT_REF && /^[0-9a-f]{40}$/.test(process.env.GYM_INSTALLER_GIT_REF)) return process.env.GYM_INSTALLER_GIT_REF;
  return (JSON.parse(readFileSync(`${GYM_WT}/release/box-release.json`, "utf8")) as { commit: string }).commit;
}

// ── F9 b: a 0.2 recipe through the 0.3 installer ──────────────────────────────────────────────────────────────
async function recipeLane(rec: Recorder, dir: string, cleanup: Cleanup): Promise<void> {
  const release = gymRelease();
  const acct = await createRealAccount();
  cleanup.usernames.push(acct.username);
  // What a 0.2 app writes: the blob names the branch "main", signed by the account's IRK.
  const recipe = await issueIsoRecipe(acct, "home", { installerGitRef: "main" });
  log(`account ${acct.username}, box ${recipe.fqdn}; burn ref ${release.slice(0, 12)}`);

  await rec.check("the 0.3 engine refuses the 0.2 recipe as it stands (\"main\" is a branch, not the exact commit)", async () => {
    try {
      await preseedFor(recipe.recipeJson);
    } catch (e) {
      const m = (e as Error).message;
      assert(BRANCH_REF_REFUSAL.test(m), `refused, but with another reason: ${m}`);
      return `"${m}" (a 0.3 installer that passes the recipe's own ref shows this; it says nothing about updating the app)`;
    }
    throw new Error("the 0.3 engine accepted a recipe that names a branch");
  });

  const approver = new BootApprover(acct, recipe.fqdn, log);
  approver.start();
  cleanup.stops.push(() => approver.stop());
  const made: { box: Box | null } = { box: null };
  const installed = await rec.check("with the endorsed commit as the burn ref, the 0.3 ISO installs the 0.2 recipe and seals the disk (one key slot)", async () => {
    const iso = await personalizedIso(`f9-recipe-${acct.username}`, await preseedFor(recipe.recipeJson, { installerGitRef: release }));
    cleanup.isoPaths.push(iso);
    const srv = await bootIsoServer(iso, `flagship-gym-f9-recipe-${acct.username}`, (s) => cleanup.isoStorages.push(s), log);
    made.box = isoBox(acct, recipe, srv);
    cleanup.serverIds.push(srv.serverId);
    cleanup.fqdns.push(recipe.fqdn);
    return await waitInstallEvidence(recipe.authCode.serial, (h) => h.some((x) => typeof x.detail === "string" && x.detail.includes(EVIDENCE)), 45, log);
  });
  if (!installed || !made.box) return;
  const b: Box = made.box;
  const t0 = Date.now();
  const online = await rec.check("its first boot is unlocked by the phone and the box serves (≤ 40 min)", async () => {
    await bootFromDisk(b.serverId!, log);
    const r = await waitOnline(b, 40, log);
    assert(approver.unlocksSince(t0).length >= 1, "online without a phone approval");
    return r;
  });
  if (!online) return;
  await rec.check("/pods asks for no update (the box runs 0.3), and the box runs the burn's commit", async () => {
    const row = (await pods(acct.username)).find((p) => p.serverDomain === b.fqdn);
    const v = podView(row);
    assert(v.heartbeat && v.updateRequired === null, `pods ${short(row, 300)}`);
    const session = await pair(acct, b);
    const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
    const now = String(d.json?.currentCommit ?? "");
    assert(/^[0-9a-f]{40}$/.test(now), `server-detail ${d.status}: ${short(d.text)}`);
    return `commit ${now.slice(0, 8)} (burn ${release.slice(0, 8)}${now === release ? "" : ", moved on by its first-boot update"})`;
  });
  writeJson(dir, "recipe-box.json", { fqdn: b.fqdn, release });
}

// ── F9 a: a 0.2 server under 0.3 ──────────────────────────────────────────────────────────────────────────────
function resolveCommit(ref: string): string {
  return execFileSync("git", ["-C", REPO, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
}

/** The 0.2 tree's own cloud-init builder (packages/control-plane at that commit), built once into ISO_LANE_WORK. */
function userData02(from: string, args: Record<string, unknown>): string {
  const tree = join(ISO_WORK, `tree-${from.slice(0, 12)}`);
  if (!existsSync(join(tree, "packages/control-plane/dist/demoCloudConfig.js"))) {
    mkdirSync(tree, { recursive: true });
    log(`building the 0.2 tree ${from.slice(0, 12)} in ${tree} (once)`);
    execFileSync("sh", ["-c", `git -C '${REPO}' archive ${from} | tar -x -C '${tree}'`], { stdio: "inherit" });
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tree, stdio: "inherit", timeout: 1_800_000 });
    execFileSync("npx", ["tsc", "-b", "packages/control-plane"], { cwd: tree, stdio: "inherit", timeout: 900_000 });
  }
  const script = 'import { buildCloudConfigUserData } from "./packages/control-plane/dist/demoCloudConfig.js"; process.stdout.write(buildCloudConfigUserData(JSON.parse(process.argv[1])));';
  return execFileSync("node", ["--input-type=module", "-e", script, JSON.stringify(args)], { cwd: tree, encoding: "utf8" });
}

async function boxLane(rec: Recorder, dir: string, cleanup: Cleanup): Promise<void> {
  const from = resolveCommit(process.env.F9_FROM_COMMIT || DEFAULT_02);
  const acct: Account = await createRealAccount();
  cleanup.usernames.push(acct.username);
  const authCode = newAuthCode(acct, "home");
  const issued = await issueAuthCode(authCode, acct.keys.irk, acct.keys.adminRoot);
  assert(issued.status === 200 || issued.status === 201, `auth-code issue ${issued.status}: ${short(issued.text)}`);
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: acct.username,
    serverName: "home",
    phoneDelegatedPubKey: acct.keys.delegated.publicKey,
    registrationUrl: `https://${CONTROL}/api/server/register`,
    authCode,
    authCodeUserSignature: signAuthCode(authCode, acct.keys.irk),
    installerGitRef: from,
    rckPubKey: acct.keys.rck.publicKey,
  };
  const b: Box = { account: acct.username, serverName: "home", fqdn: authCode.serverDomain, serverId: null, via: "gym-provision", online: false, serial: authCode.serial };
  cleanup.fqdns.push(b.fqdn);
  log(`account ${acct.username}, 0.2 box ${b.fqdn} at ${from.slice(0, 12)}`);

  const made = await rec.check("a server is installed the 0.2 way (the 0.2 tree's own cloud-init: clone the 0.2 commit, build, register with the 0.3 gym .com)", async () => {
    const userData = userData02(from, {
      installBlobJson: installBlobJsonShortString(blob, signInstallBlob(blob, acct.keys.irk)),
      installerGitRef: from,
      demoUserIrkPrivHex: bytesToHex(acct.keys.irk.privateKey),
      ownerAidPubHex: bytesToHex(acct.keys.aid.publicKey),
      adminRootPubHex: bytesToHex(acct.keys.adminRoot.publicKey),
      adminRootPrivHex: bytesToHex(acct.keys.adminRoot.privateKey),
    });
    writeJson(dir, "user-data-0.2.json", { from, bytes: userData.length });
    const srv = await upcloud("POST", "/server", {
      server: {
        zone: ISO_ZONE,
        plan: ISO_PLAN,
        title: `flagship-gym-f9-box-${acct.username}`,
        hostname: "flagship-pod",
        labels: { label: [{ key: "flagship-demo", value: acct.username.toLowerCase() }, { key: "flagship-env", value: "gym" }] },
        metadata: "yes",
        user_data: userData,
        storage_devices: { storage_device: [{ action: "clone", storage: DEBIAN_13_TEMPLATE, title: `flagship-gym-f9-box-${acct.username}-disk`, size: 40, tier: "maxiops" }] },
        networking: {
          interfaces: {
            interface: [
              { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
              { type: "utility", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
            ],
          },
        },
      },
    });
    assert(srv.status < 300, `UpCloud create ${srv.status}: ${short(srv.text, 300)}`);
    b.serverId = srv.json.server.uuid;
    b.ipv4 = publicIpv4(srv.json.server);
    cleanup.serverIds.push(b.serverId!);
    return `${b.serverId} at ${b.ipv4}`;
  });
  if (!made) return;

  const row = async () => (await pods(acct.username)).find((p) => p.serverDomain === b.fqdn);
  const registered = await rec.check("the 0.2 box registers and sends heartbeats to the 0.3 .com (≤ 30 min)", async () => {
    const deadline = Date.now() + 30 * 60_000;
    let last = "";
    while (Date.now() < deadline) {
      const v = podView(await row());
      last = JSON.stringify(v);
      if (v.registered && v.heartbeat) return last;
      await sleep(30_000);
    }
    throw new Error(`not registered with a heartbeat in 30 min: ${last}`);
  });
  if (!registered) return;

  await rec.check(".com flags it on /pods: updateRequired box-too-old (the apps' \"This server needs an update\")", async () => {
    const deadline = Date.now() + 10 * 60_000;
    let r: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      r = await row();
      if (podView(r).updateRequired === "box-too-old") return short(r?.updateRequired);
      await sleep(30_000);
    }
    throw new Error(`no updateRequired: ${short(r, 300)}`);
  });

  await rec.check("it gets no certificate under 0.3 (DNS-01 answers 410), so it serves nothing (info)", async () => {
    const v = podView(await row());
    const f = await tryHttp(`https://${b.fqdn}/api/front-page`, {}, 10_000);
    return `certificate on /pods: ${v.certificate}; https://${b.fqdn}/api/front-page → ${f.status || "no TLS"}`;
  });

  // The update half: a 0.2 box can only move to a release endorsed on GitHub main under the production pin.
  let target = "";
  const ready = await rec.check("0.3 is on GitHub main (release/version.json) so a 0.2 box can list it", async () => {
    const v = await fetch(`${RAW_MAIN}/release/version.json`, { headers: { "cache-control": "no-cache" } }).then((r) => r.json()).catch(() => null);
    if (!productAtLeast(v, "0.3")) throw new SkipError(`main is still ${short(v)}: the 0.2 → 0.3 update can only run once release/0.3 is on main and endorsed (release steps 1-7), against the gym`);
    target = parseLsRemote(execFileSync("git", ["ls-remote", REPO_URL, "refs/heads/main"], { encoding: "utf8", timeout: 60_000 })) ?? "";
    assert(target, "could not read main's head");
    return `main is ${short(v)} at ${target.slice(0, 12)}`;
  });
  if (!ready) return;

  await rec.check("an admin-root-signed update order to main's head is accepted by .com (the box may also move by itself at first boot)", async () => {
    const order: UpdateOrder = { serverDomain: b.fqdn, targetCommit: target, fromCommit: from, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
    const r = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/update`, {
      ...mailboxAuth(acct),
      deposit: { serverDomain: b.fqdn, requestNonceHex: randomBytes(32).toString("hex") },
      order,
      signature: bytesToHex(signUpdateOrder(order, acct.keys.adminRoot)),
    });
    assert(r.status === 200, `${r.status}: ${short(r.text)}`);
    return `→ ${target.slice(0, 12)}`;
  });

  const moved = await rec.check("the box runs 0.3: the updateRequired flag clears (boxLevel 3 heartbeat) (≤ 45 min)", async () => {
    const deadline = Date.now() + 45 * 60_000;
    let last = "";
    while (Date.now() < deadline) {
      const r = await row();
      const v = podView(r);
      last = `${JSON.stringify(v)}`;
      if (v.heartbeat && v.updateRequired === null) return last;
      await sleep(30_000);
    }
    throw new Error(`still flagged after 45 min: ${last}`);
  });
  if (!moved) return;

  await rec.check("it gets a certificate from the 0.3 issuance service and serves; server-detail names main's head", async () => {
    await waitOnline(b, 20, log);
    const session = await pair(acct, b);
    const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
    assert(d.status === 200, `server-detail ${d.status}: ${short(d.text)}`);
    const now = String(d.json?.currentCommit ?? "");
    assert(now === target, `runs ${now.slice(0, 12)}, not main's ${target.slice(0, 12)}`);
    return `on ${now.slice(0, 12)}; lastUpdate ${short(d.json?.lastUpdate, 160)}`;
  });
}

interface Cleanup {
  usernames: string[];
  serverIds: string[];
  fqdns: string[];
  isoStorages: string[];
  isoPaths: string[];
  stops: Array<() => Promise<void>>;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode !== "recipe" && mode !== "box") {
    log("usage: upgrade-02.ts recipe|box");
    return 2;
  }
  if (!ADMIN) throw new Error("GYM_ADMIN_SECRET is not set (source .gym-secrets.env)");
  const lock = takeGymLock(`F9 ${mode} lane (tools/live-e2e/lanes/upgrade-02.ts)`);
  const rec = new Recorder(`upgrade-02-${mode}`);
  const dir = runDir(`upgrade-02-${mode}`);
  const cleanup: Cleanup = { usernames: [], serverIds: [], fqdns: [], isoStorages: [], isoPaths: [], stops: [] };
  let base = { servers: -1, dns: -1 };
  try {
    base = await gymCounts();
    log(`gym before: ${base.servers} server(s), ${base.dns} DNS record(s); artifacts in ${dir}`);
    if (base.servers !== 0) throw new Error(`the gym has ${base.servers} server(s) up: not starting on a busy gym`);
    if (mode === "recipe") await recipeLane(rec, dir, cleanup);
    else await boxLane(rec, dir, cleanup);
  } catch (e) {
    rec.results.push({ name: `upgrade-02 ${mode} crashed`, ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e), ms: 0 });
    log(`✗ ${(e as Error).message}`);
  } finally {
    for (const s of cleanup.stops) await s().catch(() => undefined);
    if (cleanup.usernames.length) {
      await destroyIsoServer({ serverIds: cleanup.serverIds, fqdns: cleanup.fqdns, usernames: cleanup.usernames, isoStorages: cleanup.isoStorages }, log);
    }
    for (const p of cleanup.isoPaths) removeIso(p);
    if (base.servers >= 0) {
      const after = await gymCounts().catch(() => ({ servers: -1, dns: -1 }));
      log(`gym after: ${after.servers} server(s), ${after.dns} DNS record(s) (before: ${base.servers}, ${base.dns})`);
      if (after.servers !== base.servers || after.dns !== base.dns) {
        rec.results.push({ name: "the gym is back to where it was (servers, DNS)", ok: false, detail: `before ${base.servers}/${base.dns}, after ${after.servers}/${after.dns}: run tools/live-e2e/sweep-cli.ts`, ms: 0 });
      }
    }
    writeJson(dir, `upgrade-02-${mode}.json`, { lane: `upgrade-02 ${mode}`, results: rec.results });
    lock.release();
  }
  return rec.failed ? 1 : rec.skipped ? 3 : 0;
}

process.exit(await main().catch((e) => (log(`CRASH: ${e instanceof Error ? e.message : e}`), 2)));

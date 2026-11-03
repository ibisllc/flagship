#!/usr/bin/env -S npx tsx
/**
 * LIVE lane "boot-chain refresh across an update + reboot" (RELEASE-0.3-JOURNAL.md D2, B0, A1;
 * docs/boot-chain-refresh.md). The one place a REAL encrypted box (installed from the personalized Debian
 * ISO, not a cloud-init fleet box, which has no LUKS and no FLAGSHIP_BOOT) goes through:
 *
 *   1. install from the ISO (the real preseed + bootstrap: register, seal, one key slot), first boot from
 *      the disk, the start-up unlock approved by the simulated owner phone (lib/bootApprover.ts), online;
 *   2. B0, first boot: /boot is the FLAGSHIP_BOOT partition and holds this boot's `flagship-unlock.log`,
 *      written by the premount in the initramfs (the ext4 + by-label mount fix);
 *   3. the installed chain is made older than the release (one comment line appended to the installed
 *      premount over debug SSH: exactly what a box installed before a chain change looks like), then an
 *      endorsed update is ordered (the gym's update target, admin-root signed) and applied;
 *   4. the refresh stages a trial (trial initrd, `custom.cfg`, `next_entry`), the owner's Lock-and-restart
 *      (`/api/power`, admin root) writes the one-shot lock marker on FLAGSHIP_BOOT and reboots;
 *   5. the trial boot: the marker forces the phone, the phone approves, the box serves; the unlock log on
 *      FLAGSHIP_BOOT says `lock-once=yes` and "consumed the one-shot lock marker", the marker is gone (B0),
 *      /proc/cmdline carried the trial token, and the daemon promoted it (no trial left, the installed
 *      premount is the release's again, Activity `server.bootchain.refreshed`);
 *   6. one more restart on the promoted default: unlocks, serves, no trial token;
 *   7. B2 #8: the promoted initrd pins the box's own /boot filesystem and LUKS volume by UUID;
 *   8. B2 #7: the owner deposits an auto-unlock lease and the phone goes out of reach; a plain restart of
 *      the promoted default unlocks from the lease (the seal holds: the box resealed the lease key to the
 *      default chain after the last phone-approved boot); then, only where the lease key is sealed to the
 *      TPM under PCR 8 or 9, a one-time GRUB entry with one more command-line argument (an unendorsed
 *      chain change) must NOT unlock: the box waits for the phone, the premount logs the TPM's refusal,
 *      and the phone's approval brings it up. Software custody or an unmeasured GRUB skip that half
 *      (docs/boot-chain-refresh.md "Auto-unlock and the TPM seal").
 *
 * If the update target can't be published (not built by this refresh), step 3's update is SKIPPED and the
 * refresh is started by a daemon restart instead (it runs on every start): the chain is still proven, the
 * "across an update" half is not (exit 3).
 *
 *   set -a; source .gym-secrets.env; set +a          # GYM_ADMIN_SECRET (+ GYM_DEMO_IRK_KEK, unused here)
 *   bash scripts/gym-refresh.sh                      # the gym on the tip under test (+ its update target)
 *   npx tsc -b && npx tsx tools/live-e2e/lanes/boot-chain-refresh.ts
 *
 * Env: GYM_INSTALLER_GIT_REF (default: the gym worktree's box release), GYM_WORKTREE, ISO_LANE_ZONE/PLAN/WORK/ISO
 *      (lib/isoBox.ts), BOOTCHAIN_NO_STALE=1 (rely on the release's own chain change instead of the comment line).
 * Prerequisites: the gym lock free (taken here; GYM_LOCK_HELD=1 when gym-release-run.sh runs it), no gym
 *      servers up, ~/.config/flagship/upcloud-token, ssh + ssh-keygen + curl + xorriso (remaster), ~1 GB disk.
 * Duration: about 75-100 min (ISO build and upload ~10, install ~25, first boot ~10, update ~10, two
 *      restarts ~15 each). Cost: one 2xCPU-4GB UpCloud server for that time.
 * Exit: 0 green · 1 a check failed · 3 nothing failed but something was skipped · 2 crashed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { signPhoneOrder, signUpdateOrder, type PhoneOrder, type UpdateOrder } from "@flagship/protocol";
import { BootApprover } from "../lib/bootApprover.js";
import {
  BOOT_FACTS_SCRIPT,
  BOOT_UNENDORSED_ONCE,
  CLEAR_UNENDORSED,
  MAKE_CHAIN_STALE,
  PLAIN_REBOOT,
  STALE_CHAIN_LINE,
  parseBootFacts,
  sealCoversGrub,
  type BootFacts,
} from "../lib/bootFacts.js";
import { debugGrantSibling, debugKey, sudoScript, type DebugKey } from "../lib/debugSsh.js";
import { createRealAccount, pair, waitOnline, type Account, type Box } from "../lib/fleet.js";
import { takeGymLock } from "../lib/gymLock.js";
import { ADMIN, CONTROL, Recorder, SERVICES, SkipError, assert, http, postJson, runDir, short, sleep, tryHttp, writeJson } from "../lib/harness.js";
import {
  bootFromDisk,
  consoleEvidence,
  bootIsoServer,
  destroyIsoServer,
  gymCounts,
  isoBox,
  issueIsoRecipe,
  personalizedIso,
  powerOn,
  preseedFor,
  removeIso,
  waitInstallEvidence,
} from "../lib/isoBox.js";
import { mailboxAuth } from "../groups/update.js";

const EVIDENCE = "Disk key secured: one unlock key slot, install key removed";
const GYM_WT = process.env.GYM_WORKTREE || `${homedir()}/.cache/flagship/gym-worktree`;
const log = (s: string): void => void process.stdout.write(`[boot-chain] ${s}\n`);

function gymRelease(): string {
  if (process.env.GYM_INSTALLER_GIT_REF && /^[0-9a-f]{40}$/.test(process.env.GYM_INSTALLER_GIT_REF)) return process.env.GYM_INSTALLER_GIT_REF;
  return (JSON.parse(readFileSync(`${GYM_WT}/release/box-release.json`, "utf8")) as { commit: string }).commit;
}

function updateTarget(mode: "publish" | "unpublish"): string {
  const script = fileURLToPath(new URL("../../../scripts/gym-update-target.sh", import.meta.url));
  try {
    return execFileSync("bash", [script, mode, "--worktree", GYM_WT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 }).trim();
  } catch (e) {
    throw new Error(String((e as { stderr?: string }).stderr ?? "").trim().split("\n").at(-1) || (e as Error).message);
  }
}

async function main(): Promise<number> {
  const rec = new Recorder("boot-chain");
  await lane(rec);
  return rec.failed ? 1 : rec.skipped ? 3 : 0;
}

async function lane(rec: Recorder): Promise<void> {
  if (!ADMIN) throw new Error("GYM_ADMIN_SECRET is not set (source .gym-secrets.env)");
  const lock = takeGymLock("boot-chain lane (tools/live-e2e/lanes/boot-chain-refresh.ts)");
  const dir = runDir("boot-chain-lane");
  const base = await gymCounts();
  log(`gym before: ${base.servers} server(s), ${base.dns} DNS record(s); artifacts in ${dir}`);
  if (base.servers !== 0) {
    lock.release();
    throw new Error(`the gym has ${base.servers} server(s) up: not starting on a busy gym`);
  }
  const release = gymRelease();
  let acct: Account | null = null;
  const made: { box: Box | null; staged: BootFacts | null } = { box: null, staged: null };
  const storages: string[] = [];
  let isoPath = "";
  let approver: BootApprover | null = null;
  let published = false;
  try {
    acct = await createRealAccount();
    const a = acct;
    const key = await debugKey(dir);
    const fqdn = `home.${a.username}.${SERVICES}`;
    const recipe = await issueIsoRecipe(a, "home", { installerGitRef: release, extras: { debugGrant: debugGrantSibling(fqdn, key, a.keys.adminRoot) } });
    log(`account ${a.username}, box ${recipe.fqdn}, serial ${recipe.authCode.serial}, release ${release.slice(0, 12)}`);
    approver = new BootApprover(a, recipe.fqdn, log);
    approver.start();
    const appr = approver;

    const installed = await rec.check("the box installs from the personalized ISO and seals its disk (one LUKS key slot)", async () => {
      isoPath = await personalizedIso(`bootchain-${a.username}`, await preseedFor(recipe.recipeJson));
      const srv = await bootIsoServer(isoPath, `flagship-gym-bootchain-${a.username}`, (s) => storages.push(s), log);
      made.box = isoBox(a, recipe, srv);
      return await waitInstallEvidence(recipe.authCode.serial, (h) => h.some((x) => typeof x.detail === "string" && x.detail.includes(EVIDENCE)), 45, log);
    });
    if (!installed || !made.box) return;
    const b: Box = made.box;

    const firstBoot = Date.now();
    const online = await rec.check("first boot from the disk: the phone approves the start-up unlock and the box comes online and serves (≤ 40 min)", async () => {
      await bootFromDisk(b.serverId!, log);
      const r = await waitOnline(b, 40, log);
      assert(appr.unlocksSince(firstBoot).length >= 1, "online without a phone approval: the disk was not unlocked by the phone");
      return `${r}; ${appr.unlocksSince(firstBoot).length} unlock approval(s)`;
    });
    if (!online) {
      // Whatever the box can tell: its console (unlock prompt? kernel? login?) and, if its daemon came up far enough to
      // honour the recipe's debug grant, the boot and daemon journals.
      await consoleEvidence(b.serverId!, join(dir, "first-boot"), log);
      if (b.ipv4) {
        const j = await sudoScript(b.ipv4, key, "journalctl -b --no-pager -n 120 -u flagship-daemon -u flagship-first-boot-register; journalctl -b --no-pager -p warning -n 60", 60_000).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
        mkdirSync(join(dir, "first-boot"), { recursive: true });
        writeFileSync(join(dir, "first-boot", "journal.txt"), `${j.stdout}\n--- stderr ---\n${j.stderr}`);
        log(`first-boot journal over debug SSH: exit ${j.code} (${join(dir, "first-boot", "journal.txt")})`);
      }
      return;
    }

    const facts = async (what: string): Promise<BootFacts> => {
      const ip = b.ipv4 ?? "";
      assert(ip, "no public IPv4 for the box");
      let last = "";
      for (let i = 0; i < 12; i++) {
        const r = await sudoScript(ip, key, BOOT_FACTS_SCRIPT);
        if (r.code === 0 && r.stdout.includes("@@flagship-fact:end")) {
          const f = parseBootFacts(r.stdout);
          writeJson(dir, `boot-facts-${what}.json`, f);
          return f;
        }
        last = `${r.code} ${short(r.stderr || r.stdout, 200)}`;
        await sleep(10_000);
      }
      throw new Error(`debug SSH to ${ip} did not answer (${last})`);
    };

    const first = await rec.check("debug access from the recipe's admin-signed grant opens SSH for the debug user", async () => {
      const f = await facts("first-boot");
      return `boot id ${f.bootId.slice(0, 8)}, LUKS ${f.luksDevice ?? "none"}`;
    });
    if (!first) return;

    await rec.check("B0, first boot: /boot is FLAGSHIP_BOOT and holds this boot's unlock log, written by the premount (phone unlock)", async () => {
      const f = await facts("first-boot");
      assert(f.luksDevice, "no crypto_LUKS partition: not an encrypted box");
      assert(f.bootMount?.label === "FLAGSHIP_BOOT", `/boot is ${short(f.bootMount)}, not the FLAGSHIP_BOOT partition`);
      assert(f.unlockLog.premountStarted, `no premount start line in /boot/flagship-unlock.log: ${short(f.unlockLog.lines, 300)}`);
      assert(f.unlockLog.unlockedBy === "phone", `the log does not say the phone's reply unlocked it: ${short(f.unlockLog.lines.slice(-4), 300)}`);
      assert(!f.unlockLog.fatal, `FATAL in the log: ${f.unlockLog.fatal}`);
      return `${f.bootMount!.source} ext4=${f.bootMount!.fstype}; ${f.unlockLog.lines.length} log lines, mode=${f.unlockLog.mode} lock-once=${f.unlockLog.lockOnce}`;
    });

    const stale = process.env.BOOTCHAIN_NO_STALE === "1"
      ? (rec.skip("the installed chain is made older than the release", "BOOTCHAIN_NO_STALE=1: relying on the release's own chain change"), true)
      : await rec.check("the installed chain is made older than the release (a comment line on the installed premount, as root)", async () => {
          const r = await sudoScript(b.ipv4!, key, MAKE_CHAIN_STALE);
          assert(r.code === 0, `${r.code} ${short(r.stderr, 200)}`);
          const f = await facts("stale");
          assert(f.premountLastLine === STALE_CHAIN_LINE, `the premount ends with ${short(f.premountLastLine)}`);
          return `premount sha ${f.premountSha256?.slice(0, 12)}`;
        });
    if (!stale) return;

    let session = await pair(a, b);
    let current = "";
    const updated = await rec.check("an endorsed update (the gym's update target, admin-root signed) is applied (≤ 25 min)", async () => {
      const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
      current = String(d.json?.currentCommit ?? "");
      try {
        updateTarget("publish");
        published = true;
      } catch (e) {
        throw new SkipError(`the update target could not be published (${(e as Error).message}); the refresh is started by a daemon restart instead`);
      }
      await sleep(70_000);
      const u = await http(`https://${b.fqdn}/api/screens/updates?refresh=1`, { headers: { "x-flagship-session": session } }, 120_000);
      const target = String(u.json?.latest?.commit ?? "");
      assert(/^[0-9a-f]{40}$/.test(target) && target !== current, `nothing newer than ${current.slice(0, 8)}: ${short(u.json?.releases, 200)}`);
      const order: UpdateOrder = { serverDomain: b.fqdn, targetCommit: target, fromCommit: current, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
      const dep = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/update`, {
        ...mailboxAuth(a),
        deposit: { serverDomain: b.fqdn, requestNonceHex: randomBytes(32).toString("hex") },
        order,
        signature: bytesToHex(signUpdateOrder(order, a.keys.adminRoot)),
      });
      assert(dep.status === 200, `deposit ${dep.status}: ${short(dep.text)}`);
      const deadline = Date.now() + 25 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        await sleep(30_000);
        let r = await tryHttp(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
        if (r.status === 401) {
          b.session = undefined;
          session = await pair(a, b).catch(() => session);
          r = await tryHttp(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
        }
        const lu = r.json?.lastUpdate;
        last = `${r.status} commit=${String(r.json?.currentCommit ?? "").slice(0, 8)} lastUpdate=${short(lu, 160)}`;
        if (lu?.outcome === "applied" && r.json?.currentCommit === target) return `${current.slice(0, 8)} → ${target.slice(0, 8)}`;
        if (lu?.outcome === "refused" || lu?.outcome === "rolled-back") throw new Error(last);
      }
      throw new Error(`not applied in 25 min (${last})`);
    });
    if (!updated && !rec.results.at(-1)?.skipped) return;
    if (!updated) {
      // The refresh runs on every daemon start: start one.
      const r = await sudoScript(b.ipv4!, key, "systemctl restart flagship-daemon");
      log(`daemon restarted for the refresh (${r.code})`);
    }

    const trialStaged = await rec.check("the refresh stages a trial: trial initrd, custom.cfg, next_entry=flagship-bootchain-trial (≤ 15 min)", async () => {
      const deadline = Date.now() + 15 * 60_000;
      let f: BootFacts | null = null;
      while (Date.now() < deadline) {
        f = await facts("staged");
        if (f.state.trial?.token && f.nextEntry === "flagship-bootchain-trial" && f.customCfgPresent) {
          made.staged = f;
          return `trial ${String(f.state.trial.digest ?? "").slice(0, 12)}, token ${String(f.state.trial.token).slice(0, 8)}`;
        }
        await sleep(30_000);
      }
      const j = await sudoScript(b.ipv4!, key, "journalctl -u flagship-daemon --no-pager -n 3000 | grep -F '[boot-chain]' | tail -n 12");
      throw new Error(`no trial staged: state=${short(f?.state, 200)} next_entry=${f?.nextEntry} custom.cfg=${f?.customCfgPresent}; daemon: ${short(j.stdout, 600)}`);
    });
    if (!trialStaged || !made.staged) return;
    const stagedFacts: BootFacts = made.staged;
    const trialToken = String(stagedFacts.state.trial!.token);

    const restart = async (what: string): Promise<number> => {
      const order: PhoneOrder = { type: "power-off", serverId: b.fqdn, mode: "restart", issuedAt: Date.now() };
      const p = await postJson(`https://${b.fqdn}/api/power`, { request: order, signature: bytesToHex(signPhoneOrder(order, a.keys.adminRoot)) });
      assert(p.status === 200, `${what}: /api/power ${p.status}: ${short(p.text)}`);
      const t = Date.now();
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline && (await tryHttp(`https://${b.fqdn}/api/front-page`, {}, 8_000)).status === 200) await sleep(3_000);
      // A restart the boot worker didn't take becomes a shutdown by design: press the power button.
      await sleep(60_000);
      log(`${what}: power ${await powerOn(b.serverId!)}`);
      b.online = false;
      b.session = undefined;
      return t;
    };

    const t1 = await restart("trial restart").catch((e) => {
      rec.results.push({ name: "Lock and restart (/api/power, admin root) takes the box down", ok: false, detail: (e as Error).message, ms: 0 });
      return 0;
    });
    if (!t1) return;

    const trialBack = await rec.check("the trial boot: the lock marker forces the phone, the phone approves, the box serves again (≤ 30 min)", async () => {
      const r = await waitOnline(b, 30, log);
      assert(appr.unlocksSince(t1).length >= 1, "back online with no phone approval after the Lock-and-restart");
      return r;
    });
    if (!trialBack) return;

    await rec.check("B0, trial boot: the unlock log on FLAGSHIP_BOOT says lock-once=yes and that the marker was consumed; the marker is gone", async () => {
      const f = await facts("trial-boot");
      assert(f.unlockLog.premountStarted, `no premount start line: ${short(f.unlockLog.lines, 300)}`);
      assert(f.unlockLog.lockOnce === "yes", `lock-once=${f.unlockLog.lockOnce}: the premount did not see the marker the restart wrote`);
      assert(f.unlockLog.consumedMarker, "no \"consumed the one-shot lock marker\" line");
      assert(!f.lockOncePresent, "/boot/flagship-lock-once is still there");
      return `${f.unlockLog.lines.length} lines, unlocked by ${f.unlockLog.unlockedBy}`;
    });

    await rec.check("it booted the trial and promoted it: the token was on /proc/cmdline, no trial left, custom.cfg gone, the premount is the release's again (≤ 15 min)", async () => {
      let f = await facts("trial-boot");
      assert(f.bootchainToken === trialToken, `this boot's command line has token ${f.bootchainToken ?? "none"}, not the trial's ${trialToken.slice(0, 8)}`);
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline && (f.state.trial || f.customCfgPresent)) {
        await sleep(30_000);
        f = await facts("promoted");
      }
      assert(!f.state.trial && !f.customCfgPresent, `not promoted: state=${short(f.state, 200)} custom.cfg=${f.customCfgPresent}`);
      assert(!f.state.failed || f.state.failed.digest !== stagedFacts.state.trial?.digest, `recorded as failed: ${short(f.state.failed)}`);
      assert(f.premountLastLine !== STALE_CHAIN_LINE, "the installed premount still carries the stale line");
      return `confirmed ${String(f.state.confirmed?.digest ?? "").slice(0, 12)}, premount sha ${f.premountSha256?.slice(0, 12)}`;
    });

    await rec.check("Activity records server.bootchain.refreshed", async () => {
      session = await pair(a, b);
      const r = await http(`https://${b.fqdn}/api/screens/activity?limit=200`, { headers: { "x-flagship-session": session } });
      const kinds = ((r.json?.entries ?? []) as Array<{ kind?: string; action?: string }>).map((e) => e.kind ?? e.action);
      assert(kinds.includes("server.bootchain.refreshed"), `no refreshed entry; bootchain kinds: ${kinds.filter((k) => String(k).includes("bootchain")).join(",") || "none"}`);
      assert(!kinds.includes("server.bootchain.rolled-back"), "a rolled-back entry is there too");
      return "server.bootchain.refreshed";
    });

    const t2 = await restart("default restart").catch(() => 0);
    await rec.check("one more restart boots the promoted default: the phone unlocks it, it serves, no trial token", async () => {
      assert(t2, "the restart order was refused");
      await waitOnline(b, 30, log);
      assert(appr.unlocksSince(t2).length >= 1, "no phone approval for this boot");
      const f = await facts("default-boot");
      assert(f.bootchainToken === null, `a trial token on the default boot: ${f.bootchainToken}`);
      assert(f.unlockLog.premountStarted && f.unlockLog.consumedMarker, `unlock log: ${short(f.unlockLog.lines, 300)}`);
      assert(!f.state.trial && !f.customCfgPresent, `a trial again: ${short(f.state)}`);
      return `boot ${f.bootId.slice(0, 8)}, unlocked by ${f.unlockLog.unlockedBy}`;
    });

    // ── B2 #8: the initrd pins this box's own disks ────────────────────────────────────────────────
    const pinned = await rec.check("B2 #8: the promoted initrd pins this box's own boot partition and LUKS volume by UUID", async () => {
      const f = await facts("uuids");
      const u = f.uuids;
      assert(u.initrdBoot && u.initrdBoot === u.diskBoot, `the initrd pins boot ${u.initrdBoot ?? "nothing"}, /boot is ${u.diskBoot ?? "?"}`);
      assert(u.initrdLuks && u.initrdLuks === u.diskLuks, `the initrd pins LUKS ${u.initrdLuks ?? "nothing"}, the volume is ${u.diskLuks ?? "?"}`);
      return `boot ${u.initrdBoot.slice(0, 8)}, LUKS ${u.initrdLuks.slice(0, 8)}`;
    });
    if (!pinned) return;

    // ── B2 #7: the TPM-sealed lease key across the chain (docs/boot-chain-refresh.md "Auto-unlock and the
    // TPM seal"). The owner turns auto-unlock on, then the phone goes out of reach. ────────────────────
    const custodyFacts = await facts("custody");
    const custody = custodyFacts.custody;
    log(`lease key custody: ${custody.kind}${custody.pcrs.length ? ` (PCRs ${custody.pcrs.join(",")})` : ""}, unlock policy ${custodyFacts.unlockPolicy}`);
    const leased = custodyFacts.unlockPolicy === "strict"
      ? (rec.skip("the owner deposits an auto-unlock lease", "the box's unlock policy is strict: this lane deposits only a classical (v2) lease"), false)
      : await rec.check("the owner deposits an auto-unlock lease sealed to the box's boot key", async () => {
          assert(appr.lastRequestKey, "no start-up request seen: the boot key is unknown");
          return `lease ${(await appr.depositLease(appr.lastRequestKey)).slice(0, 8)}`;
        });
    if (!leased) return;
    appr.setPaused(true);

    const t3 = Date.now();
    const held = await rec.check("the seal holds: a plain restart of the promoted default unlocks from the lease with the phone out of reach (≤ 20 min)", async () => {
      const r = await sudoScript(b.ipv4!, key, PLAIN_REBOOT);
      assert(r.code === 0, `reboot: ${r.code} ${short(r.stderr, 200)}`);
      b.online = false;
      b.session = undefined;
      await sleep(60_000);
      await waitOnline(b, 20, log);
      assert(appr.unlocksSince(t3).length === 0, "the phone answered: the box was not unlocked by its lease");
      const f = await facts("lease-boot");
      assert(f.unlockLog.unlockedBy === "lease", `unlocked by ${f.unlockLog.unlockedBy}: ${short(f.unlockLog.lines.slice(-4), 300)}`);
      assert(!f.unlockLog.tpmRefused, "the TPM refused the boot chain it sealed to after the last approved boot");
      return `custody ${custody.kind}; ${appr.unansweredSince(t3).length} unanswered request(s)`;
    });
    if (!held) return;

    if (!sealCoversGrub(custody)) {
      rec.skip(
        "an unendorsed boot-chain change (one more GRUB command-line argument) does not auto-unlock",
        custody.kind === "tpm"
          ? `the seal covers PCRs ${custody.pcrs.join(",")}: GRUB measures nothing on this box, so no PCR covers its entries (documented)`
          : `${custody.kind} custody: the lease key is a file on /boot and nothing binds it to the boot chain (documented)`,
      );
    } else {
      const t4 = Date.now();
      await rec.check("an unendorsed boot-chain change (one more GRUB command-line argument) does not auto-unlock: the box waits for the phone (8 min)", async () => {
        const r = await sudoScript(b.ipv4!, key, BOOT_UNENDORSED_ONCE);
        assert(r.code === 0, `unendorsed entry: ${r.code} ${short(r.stderr || r.stdout, 300)}`);
        b.online = false;
        b.session = undefined;
        const deadline = Date.now() + 8 * 60_000;
        while (Date.now() < deadline) {
          await sleep(20_000);
          const up = await tryHttp(`https://${b.fqdn}/api/front-page`, {}, 8_000);
          assert(up.status !== 200 || Date.now() - t4 < 30_000, "the box came up on a chain its seal does not cover, with nobody answering");
        }
        assert(appr.unansweredSince(t4).length >= 1, "the box never asked the phone");
        return `${appr.unansweredSince(t4).length} unanswered request(s), still locked after 8 min`;
      });
      appr.setPaused(false);
      await rec.check("the phone comes back and approves; the premount logged that the TPM refused the changed chain", async () => {
        await waitOnline(b, 20, log);
        assert(appr.unlocksSince(t4).length >= 1, "online without the phone");
        const f = await facts("unendorsed-boot");
        assert(/(^|\s)gym\.unendorsed=1(\s|$)/.test(f.cmdline), `not the unendorsed entry: ${f.cmdline}`);
        assert(f.unlockLog.tpmRefused, `no TPM refusal in the unlock log: ${short(f.unlockLog.lines, 300)}`);
        assert(f.unlockLog.unlockedBy === "phone", `unlocked by ${f.unlockLog.unlockedBy}`);
        await sudoScript(b.ipv4!, key, CLEAR_UNENDORSED);
        return "TPM refused, phone approved";
      });
    }
    appr.setPaused(false);
    return;
  } catch (e) {
    rec.results.push({ name: "boot-chain lane crashed", ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e), ms: 0 });
    log(`✗ crashed: ${(e as Error).message}`);
    return;
  } finally {
    await approver?.stop().catch(() => undefined);
    if (published) {
      try {
        updateTarget("unpublish");
      } catch (e) {
        log(`the update target is still in releases.json (${(e as Error).message}): a box made later moves onto it at its first boot`);
      }
    }
    const bx = made.box;
    if (acct) {
      await destroyIsoServer({ serverIds: bx?.serverId ? [bx.serverId] : [], fqdns: bx ? [bx.fqdn] : [], usernames: [acct.username], isoStorages: storages }, log);
    }
    if (isoPath) removeIso(isoPath);
    const after = await gymCounts().catch(() => ({ servers: -1, dns: -1 }));
    log(`gym after: ${after.servers} server(s), ${after.dns} DNS record(s) (before: ${base.servers}, ${base.dns})`);
    if (after.servers !== base.servers || after.dns !== base.dns) {
      rec.results.push({ name: "the gym is back to where it was (servers, DNS)", ok: false, detail: `before ${base.servers}/${base.dns}, after ${after.servers}/${after.dns}: run tools/live-e2e/sweep-cli.ts (dry run, then --destroy)`, ms: 0 });
    }
    writeJson(dir, "boot-chain.json", { lane: "boot-chain-refresh", release, results: rec.results });
    lock.release();
  }
}

process.exit(await main().catch((e) => (log(`CRASH: ${e instanceof Error ? e.message : e}`), 2)));

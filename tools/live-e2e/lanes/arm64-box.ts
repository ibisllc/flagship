#!/usr/bin/env -S npx tsx
/**
 * LIVE lane "arm64-box" (release plan G8 / R8: "one arm64 gym box"): a real gym box on arm64.
 *
 * Why local: UpCloud, the gym's cloud, has no arm64 plans or templates (its API lists 190 plans in the
 * gpu, cloud_native, general_purpose, premium, starter and developer families, every one x86-64, and
 * only amd64 Debian templates; checked 2026-11-02), and the Hetzner account (CAX arm64) is suspended.
 * So the box runs on this Apple Silicon Mac under QEMU with HVF (native speed): Debian 13 genericcloud
 * arm64, UEFI, user-mode NAT. A box only dials out (relay tunnel, `.com`, the artifact bucket), so NAT
 * is enough for it to come online and serve through the gym relay like any gym box.
 *
 * The cloud-init user-data is built exactly as `/api/gym/provision` builds it (gymProvision.ts →
 * buildCloudConfigUserData), imported from the GYM worktree's built control-plane so it names the gym's
 * box release, artifact base and trust; only the cloud differs. The account is a fresh REAL gym account
 * (admin root pinned; its AuthCode recorded through `/api/auth-code/issue` with the admin root's
 * approval, as an app does), and the box self-mints its entitlement with the account's gym-only keys,
 * as gym-provisioned boxes do.
 *
 * Checks: the gym release lists an arm64 artifact (preflight; else exit 3) → the box registers and
 * serves HTTPS through the gym relay → server-detail's runtime target is linux-arm64 → `/api/stack`
 * reports keyd served by the pinned Rust binary (and broker/core/access) → a whoami app installs and
 * serves → teardown (gym teardown for the account and its DNS, QEMU killed, work dir removed).
 *
 *   set -a; source .gym-secrets.env; set +a          # GYM_ADMIN_SECRET (+ GYM_DEMO_IRK_KEK, unused here)
 *   npx tsx tools/live-e2e/lanes/arm64-box.ts
 *
 * Prerequisites: an Apple Silicon Mac with qemu-system-aarch64 + qemu-img (Homebrew `qemu`, firmware in
 * /opt/homebrew/share/qemu), hdiutil (macOS), ssh-keygen; the gym refreshed with an arm64 artifact for
 * its release: `GYM_ARTIFACT_ARCHES=amd64,arm64 bash scripts/gym-refresh.sh`; ~6 GB free disk (image +
 * the overlay's growth); the gym lock (taken here; GYM_LOCK_HELD=1 when gym-release-run.sh runs it).
 * Duration: about 25-40 min (first boot, artifact download, Podman/Postgres images under HVF).
 *
 * Env: GYM_WORKTREE (default ~/.cache/flagship/gym-worktree, built by gym-refresh), GYM_INSTALLER_GIT_REF
 *      (default: the gym worktree's release/box-release.json commit), ARM64_LANE_IMAGE (a Debian 13
 *      genericcloud arm64 qcow2; default: downloaded once to ~/.cache/flagship/debian-13-genericcloud-arm64.qcow2),
 *      ARM64_LANE_WORK (default <tmp>/arm64-box-lane), ARM64_LANE_ACCEL (hvf | tcg; default hvf),
 *      ARM64_LANE_KEEP=1 (leave the VM and account up for diagnosis; prints how to tear down),
 *      QEMU_SHARE (default /opt/homebrew/share/qemu), GYM_BOX_STACK (default arch-v2).
 * Exit: 0 every check passed and cleanup verified · 1 a check failed · 3 not runnable (no arm64 artifact,
 *       no QEMU/HVF, the gym lock held) · 2 crashed.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { deriveSWK, signAuthCode, signInstallBlob, signInstallService, type InstallBlob, type InstallServiceRequest } from "@flagship/protocol";
import type * as ControlPlane from "@flagship/control-plane";
import { createRealAccount, issueAuthCode, newAuthCode, pair, teardown, waitOnline, type Account, type Box } from "../lib/fleet.js";
import { ADMIN, CONTROL, Recorder, SERVICES, assert, http, postJson, runDir, short, sleep, tryHttp, writeJson } from "../lib/harness.js";
import { qemuArgs, noCloudMetaData, releaseListsArch } from "../lib/arm64Box.js";
import { describeStatus, rustServedProblem, tsServedProblem, gymStack, type ComponentStatus } from "../lib/rustCustody.js";
import { takeGymLock } from "../lib/gymLock.js";
import { whoamiManifest } from "../groups/core.js";

const GYM_WT = process.env.GYM_WORKTREE || join(homedir(), ".cache/flagship/gym-worktree");
const WORK = process.env.ARM64_LANE_WORK || join(tmpdir(), "arm64-box-lane");
const QEMU_SHARE = process.env.QEMU_SHARE || "/opt/homebrew/share/qemu";
const IMAGE_URL = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-arm64.qcow2";
const IMAGE = process.env.ARM64_LANE_IMAGE || join(homedir(), ".cache/flagship/debian-13-genericcloud-arm64.qcow2");
const ACCEL = process.env.ARM64_LANE_ACCEL === "tcg" ? "tcg" : "hvf";
const SSH_PORT = 2241;
const STACK = gymStack();
const log = (s: string): void => void process.stdout.write(`[arm64-box] ${s}\n`);

class NotRunnable extends Error {}

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  return r.stdout;
}

function boxRelease(): string {
  const pinned = process.env.GYM_INSTALLER_GIT_REF;
  if (pinned && /^[0-9a-f]{40}$/.test(pinned)) return pinned;
  const f = join(GYM_WT, "release/box-release.json");
  if (!existsSync(f)) throw new NotRunnable(`no gym worktree at ${GYM_WT} (run scripts/gym-refresh.sh, or set GYM_WORKTREE)`);
  const c = String((JSON.parse(readFileSync(f, "utf8")) as { commit?: string }).commit ?? "");
  if (!/^[0-9a-f]{40}$/.test(c)) throw new NotRunnable(`the gym box release names no exact commit (${f})`);
  return c;
}

async function gymControlPlane(): Promise<typeof ControlPlane> {
  const entry = join(GYM_WT, "packages/control-plane/dist/index.js");
  if (!existsSync(entry)) throw new NotRunnable(`the gym worktree's control-plane is not built (${entry}); run scripts/gym-refresh.sh`);
  return (await import(pathToFileURL(entry).href)) as typeof ControlPlane;
}

async function main(): Promise<number> {
  if (!ADMIN) throw new Error("GYM_ADMIN_SECRET is not set (source .gym-secrets.env)");
  const rec = new Recorder("arm64-box");
  const dir = runDir("lane-arm64-box");
  let lock: ReturnType<typeof takeGymLock> | null = null;
  let acct: Account | null = null;
  let qemuStarted = false;
  try {
    // ── preflight ──────────────────────────────────────────────────────────
    for (const bin of ["qemu-system-aarch64", "qemu-img", "hdiutil", "ssh-keygen"]) {
      if (spawnSync("which", [bin]).status !== 0) throw new NotRunnable(`${bin} is not installed (brew install qemu; hdiutil is macOS-only)`);
    }
    if (ACCEL === "hvf" && process.arch !== "arm64") throw new NotRunnable("HVF runs an arm64 guest only on an Apple Silicon Mac (set ARM64_LANE_ACCEL=tcg to emulate, very slowly)");
    for (const f of ["edk2-aarch64-code.fd", "edk2-arm-vars.fd"]) if (!existsSync(join(QEMU_SHARE, f))) throw new NotRunnable(`no ${f} in ${QEMU_SHARE}`);
    const commit = boxRelease();
    const index = await fetch(`https://${CONTROL}/build/iso/releases.json`, { headers: { "cache-control": "no-cache" } }).then((r) => r.json()).catch(() => null);
    if (!releaseListsArch(index as never, commit, "arm64")) {
      throw new NotRunnable(`the gym release ${commit.slice(0, 12)} has no arm64 artifact in releases.json: refresh the gym with GYM_ARTIFACT_ARCHES=amd64,arm64 bash scripts/gym-refresh.sh`);
    }
    const cp = await gymControlPlane();
    lock = takeGymLock("lane arm64-box (tools/live-e2e/lanes/arm64-box.ts)");
    log(`gym release ${commit.slice(0, 12)} lists arm64; work dir ${WORK}`);

    // ── the image and the guest ────────────────────────────────────────────
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(join(WORK, "seed"), { recursive: true });
    if (!existsSync(IMAGE)) {
      log(`downloading ${IMAGE_URL}`);
      mkdirSync(join(IMAGE, ".."), { recursive: true });
      const dl = spawnSync("curl", ["-fL", "--retry", "3", "-o", IMAGE, IMAGE_URL], { stdio: "inherit" });
      if (dl.status !== 0) throw new Error("image download failed");
    }

    // ── a fresh real gym account and a recipe for `home` ───────────────────
    acct = await createRealAccount();
    const a = acct;
    const serverName = "home";
    const fqdn = `${serverName}.${a.username}.${SERVICES}`;
    const code = newAuthCode(a, serverName);
    const issued = await issueAuthCode(code, a.keys.irk, a.keys.adminRoot);
    assert(issued.status === 200, `auth-code issue ${issued.status}: ${short(issued.text)}`);
    const blob: InstallBlob = {
      version: 2,
      serverDomain: fqdn,
      username: a.username,
      serverName,
      phoneDelegatedPubKey: a.keys.delegated.publicKey,
      registrationUrl: `https://${CONTROL}/api/server/register`,
      authCode: code,
      authCodeUserSignature: signAuthCode(code, a.keys.irk),
      installerGitRef: commit,
      rckPubKey: a.keys.rck.publicKey,
    };
    const sig = signInstallBlob(blob, a.keys.irk);
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "gym-arm64-lane", "-f", join(WORK, "key")]);
    const userData = cp.buildCloudConfigUserData({
      installBlobJson: JSON.stringify(JSON.parse(cp.installBlobJsonShortString(blob, sig))),
      installerGitRef: commit,
      demoUserIrkPrivHex: bytesToHex(a.keys.irk.privateKey),
      ownerAidPubHex: bytesToHex(a.keys.aid.publicKey),
      adminRootPubHex: bytesToHex(a.keys.adminRoot.publicKey),
      adminRootPrivHex: bytesToHex(a.keys.adminRoot.privateKey),
      swkHex: bytesToHex(deriveSWK({ seed: a.keys.umk }, fqdn)),
      stack: STACK,
      debugSshPublicKey: readFileSync(join(WORK, "key.pub"), "utf8").trim(),
    });
    writeFileSync(join(WORK, "seed/user-data"), userData);
    writeFileSync(join(WORK, "seed/meta-data"), noCloudMetaData(`flagship-arm64-${randomBytes(4).toString("hex")}`));
    sh("hdiutil", ["makehybrid", "-quiet", "-iso", "-joliet", "-default-volume-name", "cidata", "-o", join(WORK, "seed.iso"), join(WORK, "seed")]);
    sh("qemu-img", ["create", "-q", "-f", "qcow2", "-b", IMAGE, "-F", "qcow2", join(WORK, "disk.qcow2"), "40G"]);
    copyFileSync(join(QEMU_SHARE, "edk2-arm-vars.fd"), join(WORK, "vars.fd"));
    sh("qemu-system-aarch64", qemuArgs(
      {
        firmwareCode: join(QEMU_SHARE, "edk2-aarch64-code.fd"),
        firmwareVars: join(WORK, "vars.fd"),
        disk: join(WORK, "disk.qcow2"),
        seed: join(WORK, "seed.iso"),
        console: join(WORK, "console.log"),
        monitor: join(WORK, "monitor.sock"),
        pidFile: join(WORK, "qemu.pid"),
      },
      { cpus: 4, memoryMiB: 6144, sshPort: SSH_PORT, accel: ACCEL },
    ));
    qemuStarted = true;
    log(`QEMU (${ACCEL}) booting ${fqdn}; console ${join(WORK, "console.log")}; ssh -i ${join(WORK, "key")} -p ${SSH_PORT} root@127.0.0.1`);
    const b: Box = { account: a.username, serverName, fqdn, serverId: null, via: "gym-provision", online: false, serial: code.serial };
    a.boxes.push(b);

    // ── checks ─────────────────────────────────────────────────────────────
    const online = await rec.check("the arm64 box registers and serves HTTPS through the gym relay (≤45 min)", async () => waitOnline(b, 45, log));
    if (online) {
      const session = await pair(a, b);
      const s = { "x-flagship-session": session };
      await rec.check("server-detail: the box runs on arm64 (runtime target linux-arm64)", async () => {
        const d = await http(`https://${fqdn}/api/screens/server-detail`, { headers: s });
        assert(d.status === 200, `${d.status}: ${short(d.text)}`);
        const target = String(d.json?.runtime?.target ?? "");
        assert(target === "linux-arm64", `runtime target ${target || "(none)"}`);
        return `${target}, release ${String(d.json?.currentCommit ?? "").slice(0, 12)}`;
      });
      await rec.check(`/api/stack: keyd is ${STACK === "arch-v2" ? "the pinned Rust binary" : "the TypeScript keyd"} on arm64`, async () => {
        const st = await http(`https://${fqdn}/api/stack`, { headers: s });
        assert(st.status === 200, `${st.status}: ${short(st.text)}`);
        const c = (st.json?.components ?? {}) as Record<string, ComponentStatus | null>;
        const problem = STACK === "arch-v2" ? rustServedProblem(c.keyd) : tsServedProblem(c.keyd);
        assert(!problem, `keyd: ${problem}`);
        return `keyd ${describeStatus(c.keyd)}; broker ${describeStatus(c.broker)}; core ${describeStatus(c.core)}; access ${describeStatus(c.access)}`;
      });
      await rec.check("a whoami app installs and serves on the arm64 box", async () => {
        const slug = "armwho";
        const req: InstallServiceRequest = { serverId: fqdn, creator: a.username, slug, manifestJson: whoamiManifest(slug), addOwnerToMembership: true, issuedAt: Date.now() };
        const r = await postJson(`https://${fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, a.keys.irk)) }, {}, 180_000);
        assert(r.status === 200, `install ${r.status}: ${short(r.text, 240)}`);
        const deadline = Date.now() + 15 * 60_000;
        let last = "";
        while (Date.now() < deadline) {
          const c = await tryHttp(`https://${slug}.${fqdn}/`, {}, 15_000);
          if (c.status === 200) return `200 ${short(c.text, 80)}`;
          last = `${c.status} ${short(c.text, 100)}`;
          await sleep(15_000);
        }
        throw new Error(`not 200 in 15 min (${last})`);
      });
    }
  } catch (e) {
    if (e instanceof NotRunnable || /gym lock is held/.test((e as Error).message)) {
      log(`NOT RUNNABLE: ${(e as Error).message}`);
      rec.skip("arm64 gym box", (e as Error).message);
    } else {
      rec.results.push({ name: "arm64-box crashed", ok: false, detail: (e as Error).stack ?? String(e), ms: 0 });
      log(`FAILED: ${(e as Error).message}`);
    }
  } finally {
    const keep = process.env.ARM64_LANE_KEEP === "1";
    if (keep && qemuStarted) {
      log(`ARM64_LANE_KEEP=1: VM (${join(WORK, "qemu.pid")}) and account ${acct?.username} left up; tear down with kill $(cat ${join(WORK, "qemu.pid")}) and npx tsx tools/live-e2e/sweep-cli.ts --destroy`);
    } else {
      if (acct) {
        const t = await teardown([acct]).catch((e) => ({ error: String(e) }));
        log(`gym teardown: ${short(t, 300)}`);
      }
      if (qemuStarted && existsSync(join(WORK, "qemu.pid"))) {
        spawnSync("kill", [readFileSync(join(WORK, "qemu.pid"), "utf8").trim()]);
        log("QEMU stopped");
      }
      if (existsSync(join(WORK, "console.log"))) copyFileSync(join(WORK, "console.log"), join(dir, "arm64-console.log"));
      rmSync(WORK, { recursive: true, force: true });
    }
    lock?.release();
    writeJson(dir, "arm64-box.json", { lane: "arm64-box", results: rec.results });
  }
  log(`${rec.passed} passed, ${rec.failed} failed, ${rec.skipped} skipped`);
  return rec.failed ? 1 : rec.skipped || rec.passed === 0 ? 3 : 0;
}

process.exit(await main().catch((e) => (log(`CRASH: ${e instanceof Error ? e.stack : e}`), 2)));

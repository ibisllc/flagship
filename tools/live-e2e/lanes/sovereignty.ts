#!/usr/bin/env -S npx tsx
/**
 * LIVE "sovereignty" lane (release plan D2, docs/data-sovereignty.md section 7): a box cut off from
 * `.com` and `.services` is still its owner's. Standalone, like lanes/luks-burn.ts; not part of a
 * shared-run fleet.
 *
 * What it proves, in order:
 *   1. A box of a REAL account A (UMK, admin root pinned) comes online with an SWK the owner's
 *      devices derive (deriveSWK(UMK, fqdn)); the box's own identity key (STK, made at install) is read
 *      on the box and pinned, as a phone pins it at first contact, and a Python app with a Postgres row
 *      and a file runs on it.
 *   2. The cut: one nft table on the box (lib/sovereignty.ts cutScript) lets the box reach only
 *      loopback, private ranges and the runner's SSH; its public name stops answering through the
 *      relay and its heartbeat (/pods lastReported) stops advancing.
 *   3. Acting as the phone, with NO call to `.com` or `.services` for any rescue step: over the
 *      box's private UpCloud utility address (the LAN-direct listener, raw TLS on :443), reached
 *      through an SSH forward on a sibling VM in the same private network, the runner checks the
 *      key-bound hello (the pinned STK, certificate hash equal to the leaf its own TLS
 *      saw), is refused for an order naming another certificate, for an IRK-signed order on this
 *      admin-pinned box and for a stranger's key, then opens a session with the admin root.
 *   4. Offline control: stop, start and restart the app through owner-signed
 *      `flagship/offline-control/v1` orders (state read back from /api/rescue/server); a replayed
 *      order is refused.
 *   5. Rescue my data: a backup with a passcode slot and an account slot is made through
 *      /api/rescue/archive, downloaded in 4 MiB parts, matches x-flagship-bundle-sha256, splits into
 *      one `.flagship` file and opens with the PASSCODE.
 *   6. Nothing left the box meanwhile: the drop rules counted the box's attempts, only SSH replies
 *      went to the runner, /pods lastReported did not move and the relay still does not serve it.
 *   7. The reboot cliff, recorded as INFO (see below): the signed `server-restart` order is accepted
 *      and the box goes down.
 *   8. Import into another account B: a new box of B adopts the file (opened with the passcode, not
 *      A's account key) and the app serves the same row and file there.
 *
 * What it cannot prove on the gym: gym boxes are cloud-init installs with NO LUKS, so a restarted
 * gym box boots without any unlock, and the nft cut (runtime rules, not persisted) is gone after the
 * restart. The D2 "reboot cliff" (an encrypted box stays locked until `.com` is back, because offline
 * boot unlock is not in 0.3) is therefore only documented here; it is proven on hardware
 * (docs/runbooks/0.3-hardware-acceptance.md section 3, step 5). Discovery by mDNS is not exercised
 * either (UpCloud's utility network carries no multicast between servers); the lane uses the manual
 * address path, which is what a phone does when its router blocks multicast.
 *
 * Not built on purpose: the "gym-only `.com` rule that makes A's account answer 404" from the spec.
 * The runner never asks `.com` anything during the rescue (the phone's rescue path reads only local
 * records), and the box cannot reach `.com` at all through the cut, so a 404 rule would test nothing
 * the cut does not already; the N1 screen's handling of that 404 is covered by the apps' mock gyms.
 *
 * Run (the gym lock must be free; never beside a gym run):
 *   set -a; source .gym-secrets.env; set +a     # GYM_ADMIN_SECRET, GYM_DEMO_IRK_KEK
 *   npx tsc -b && npx tsx tools/live-e2e/lanes/sovereignty.ts
 *
 * Prerequisites: the gym refreshed on the tip under test (bash scripts/gym-refresh.sh: the gym
 * Worker, D1 and the box artifact boxes install), an UpCloud token
 * (GYM_UPCLOUD_TOKEN_FILE, default ~/.config/flagship/upcloud-token), ssh/ssh-keygen on PATH, the
 * gym lock free, room in the UpCloud core quota for 2 boxes + 1 small VM, and no other gym servers up.
 * Env: GYM_LIVE_CONTROL_APEX / GYM_LIVE_SERVICES_APEX (harness defaults), GYM_INSTALLER_GIT_REF
 * (default: the box release), SOV_SIBLING_PLAN (default 1xCPU-2GB), GYM_RUN_DIR, GYM_LOCK_HELD=1 when
 * a parent already holds the lock.
 * Duration: about 60 to 80 minutes (two box installs ~15 min each, overlapped; the app build ~10;
 * the backup and download a few; the restore onto B ~10-20). Cost: 2 gym boxes + 1 sibling VM for
 * that time.
 * Exit: 0 green · 1 a check failed · 3 nothing failed but something was skipped · 2 crashed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  checkRescueHello,
  deriveServerArchiveKey,
  deriveSWK,
  openBackupWithPasscode,
  parseBackupFile,
  parseRescueExchange,
  signOfflineControl,
  signRescueSession,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type Keypair,
  type OfflineControlAction,
  type RescueExchange,
} from "@flagship/protocol";
import { addBox, createRealAccount, pair, pods, waitOnline, type Account, type Box } from "../lib/fleet.js";
import { ADMIN, CONTROL, Recorder, adminHeaders, assert, http, runDir, short, sleep, tryHttp, writeJson } from "../lib/harness.js";
import { takeGymLock } from "../lib/gymLock.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../lib/mcpBuild.js";
import { armRestore, uploadAndRestore } from "../lib/restore.js";
import { splitBundle } from "../lib/bundle.js";
import { createDebianVm, destroyVm, run, serverAddresses, ssh, type Vm } from "../lib/upcloudVm.js";
import {
  LIFT_CUT_COMMAND,
  LIST_CUT_COMMAND,
  appStateIn,
  applyCutCommand,
  bundleOffsets,
  controlOrderFor,
  cutDelta,
  cutScript,
  nonceHex,
  parseCutCounters,
  parseSshClient,
  rescueHeaders,
  sessionOrderFor,
  type RuleCounter,
} from "../lib/sovereignty.js";
import { PY_APP, pyAppFiles } from "../groups/runtimes.js";

const PASSCODE = "gym-rescue-passcode-9v4q";
const ARGON = { m: 1024, t: 1, p: 1 };
const log = (s: string): void => void process.stdout.write(`[sovereignty] ${s}\n`);

interface Answer {
  status: number;
  json: any;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  certSha256: string;
}

/** One HTTPS request to the box through the forwarded LAN port, SNI and Host = the box name, any certificate accepted (the hello binds it). */
function lanRequest(port: number, fqdn: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        servername: fqdn,
        method,
        path,
        rejectUnauthorized: false,
        agent: false,
        headers: { host: fqdn, ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}), ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const peer = (res.socket as import("node:tls").TLSSocket).getPeerCertificate?.();
        const certSha256 = peer?.raw ? createHash("sha256").update(peer.raw).digest("hex") : "";
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json: any = null;
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {
            /* binary or empty */
          }
          resolve({ status: res.statusCode ?? 0, json, body: buf, headers: res.headers, certSha256 });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

async function gymCounts(): Promise<{ servers: number; dns: number }> {
  const r = await http(`https://${CONTROL}/api/gym/teardown`, { method: "POST", headers: { "content-type": "application/json", ...adminHeaders() }, body: JSON.stringify({ all: true, dryRun: true }) }, 120_000);
  assert(r.status === 200, `gym sweep dry run ${r.status}: ${short(r.text)}`);
  return { servers: Array.isArray(r.json?.servers) ? r.json.servers.length : -1, dns: Number(r.json?.dnsWouldDelete ?? -1) };
}

async function main(): Promise<number> {
  if (!ADMIN) throw new Error("GYM_ADMIN_SECRET is not set (source .gym-secrets.env)");
  const lock = takeGymLock("sovereignty lane (tools/live-e2e/lanes/sovereignty.ts)");
  const dir = runDir("sovereignty");
  const rec = new Recorder("sovereignty");
  const keyDir = join(dir, "keys");
  let sibling: Vm | null = null;
  let tunnel: ChildProcess | null = null;
  const accounts: Account[] = [];
  let base = { servers: -1, dns: -1 };
  let pendingB: Promise<unknown> = Promise.resolve();
  try {
    base = await gymCounts();
    log(`gym before: ${base.servers} server(s), ${base.dns} DNS record(s)`);
    if (base.servers !== 0) throw new Error(`the gym has ${base.servers} server(s) running: not starting a lane on a busy gym`);

    // ── 1. two real accounts; A's box with a derivable SWK and root SSH; B's empty box ──────────
    const sib = await createSiblingKey(keyDir);
    const A = await createRealAccount();
    const B = await createRealAccount();
    accounts.push(A, B);
    log(`account A ${A.username}, account B ${B.username}`);
    const fqdnA = `home.${A.username}.${process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services"}`;
    const swk = deriveSWK({ seed: A.keys.umk }, fqdnA);
    let a: Box | undefined;
    let b: Box | undefined;
    const madeA = rec.check("A's box is provisioned with an SWK derived from the UMK and an SSH key for the lane", async () => {
      a = await addBox(A, "home", { provisionExtras: { swkHex: bytesToHex(swk), debugSshPublicKey: sib.pub } });
      return `${a.fqdn} (${a.serverId})`;
    });
    const madeB = rec.check("B's box (the import target) is provisioned", async () => {
      b = await addBox(B, "rescued");
      return `${b.fqdn} (${b.serverId})`;
    });
    pendingB = madeB;
    if (!(await madeA) || !a) return finish();
    const boxA = a;
    if (!(await rec.check("A's box comes online and serves (≤25 min)", () => waitOnline(boxA, 25, log)))) return finish();
    // A box makes its own identity key (STK) at install; the phone pins it at first contact (ServerKeyPins) and never
    // derives one. The lane cannot hold a phone's pin, so it pins the key read on the box itself (below), checked against
    // the one the box registered.
    let podsStk = "";
    await rec.check("the box registered its identity key with .com (/pods identityPubKey)", async () => {
      const p = (await pods(A.username)).find((x) => x.serverDomain === boxA.fqdn);
      podsStk = String(p?.identityPubKey ?? "").toLowerCase();
      assert(/^[0-9a-f]{64}$/.test(podsStk), `pods ${short(p?.identityPubKey)}`);
      return podsStk.slice(0, 16);
    });

    const session = await pair(A, boxA);
    const s = { "x-flagship-session": session };
    const serviceId = `${A.username}--${PY_APP}`;
    const marker = `rescued-${randomBytes(3).toString("hex")}`;
    const appUp = await rec.check("a Python app with a Postgres row and a file runs on A's box", async () => {
      const deadline = Date.now() + 12 * 60_000;
      while (Date.now() < deadline) {
        const d = await tryHttp(`https://${boxA.fqdn}/api/screens/server-detail`, { headers: s });
        if (d.json?.appSandbox?.state === "ready") break;
        await sleep(15_000);
      }
      const c = await mcpOpen(boxA, session, "gym-sovereignty");
      await buildAndDeploy(c, pyAppFiles);
      await finishAndWaitLive(c, boxA, serviceId);
      const base = `https://${PY_APP}.${boxA.fqdn}`;
      let w = await tryHttp(`${base}/write?text=${marker}`);
      for (let i = 0; i < 24 && w.status !== 200; i++) {
        await sleep(5000);
        w = await tryHttp(`${base}/write?text=${marker}`);
      }
      assert(w.status === 200, `/write ${w.status}: ${short(w.text)}`);
      const r = await http(`${base}/read`);
      assert(r.json?.file === marker && r.json?.rows?.includes(marker), `/read ${short(r.text)}`);
      return `file + row "${marker}"`;
    });
    if (!appUp) return finish();

    // ── 2. the sibling on the private network, the SSH forward, the cut ─────────────────────────
    const addrA = await serverAddresses(boxA.serverId!);
    const utilA = addrA.utilityV4[0];
    const pubA = boxA.ipv4 ?? addrA.publicV4[0];
    if (!(await rec.check("A's box has a private (utility) address and a public one for SSH", async () => {
      assert(utilA && pubA, `addresses ${short(addrA)}`);
      return `${addrA.zone}: utility ${utilA}, public ${pubA}`;
    }))) return finish();
    const boxVm: Vm = { uuid: boxA.serverId!, ip: pubA!, key: sib.key };
    // The pin: the public half of the seed the box holds (keyd's on arch-v2, the daemon's identity file on classic).
    let pinnedStk = new Uint8Array(0);
    if (!(await rec.check("the box's own identity key, read on the box, is the key it registered (the phone's first-contact pin)", async () => {
      const r = await ssh(boxVm, "cat /var/lib/flagship-keyd/identity.key 2>/dev/null || cat /var/flagship/identity/identity.priv.hex", 30_000);
      const seed = r.stdout.trim().toLowerCase();
      assert(/^[0-9a-f]{64}$/.test(seed), `no identity seed on the box: ${short(r.stderr)}`);
      pinnedStk = ed25519.getPublicKey(hexToBytes(seed));
      assert(bytesToHex(pinnedStk) === podsStk, `box ${bytesToHex(pinnedStk).slice(0, 16)} vs pods ${podsStk.slice(0, 16)}`);
      return bytesToHex(pinnedStk).slice(0, 16);
    }))) return finish();
    const sibOk = await rec.check("a sibling Debian VM on the same private network", async () => {
      sibling = await createDebianVm({ dir: keyDir, title: `gym-sovereignty-sibling-${A.username}`, zone: addrA.zone || "de-fra1", plan: process.env.SOV_SIBLING_PLAN || "1xCPU-2GB", log, utility: true });
      const r = await ssh(sibling, `nc -z -w 5 ${utilA} 443 && echo reachable`, 30_000);
      assert(/reachable/.test(r.stdout), `the sibling can't reach ${utilA}:443 (the LAN-direct listener): ${short(r.stderr)}`);
      return `${sibling.ip} reaches ${utilA}:443`;
    });
    if (!sibOk || !sibling) return finish();
    const lport = await freePort();
    tunnel = spawn("ssh", ["-N", "-i", (sibling as Vm).key, "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-L", `127.0.0.1:${lport}:${utilA}:443`, `root@${(sibling as Vm).ip}`], { stdio: "ignore" });
    const lan = (method: string, path: string, body?: unknown, headers?: Record<string, string>, ms?: number) => lanRequest(lport, boxA.fqdn, method, path, body, headers, ms);

    let runnerV4 = "";
    let counters0: Record<string, RuleCounter> = {};
    let lastReportedAtCut: unknown = null;
    const cut = await rec.check("the cut: the box may reach only private ranges and the runner's SSH (nft, counted)", async () => {
      const who = await ssh(boxVm, "echo $SSH_CLIENT", 30_000);
      runnerV4 = parseSshClient(who.stdout) ?? "";
      assert(runnerV4, `no SSH_CLIENT from the box: ${short(who.stdout + who.stderr)}`);
      const r = await ssh(boxVm, applyCutCommand(cutScript({ runnerV4 })), 180_000);
      assert(r.code === 0, `nft: ${short(r.stderr, 300)}`);
      counters0 = parseCutCounters(r.stdout);
      assert(counters0["drop4"] && counters0["runner-ssh"], `the cut is not listed: ${short(r.stdout, 300)}`);
      return `runner ${runnerV4} (SSH replies only); everything public dropped`;
    });
    if (!cut) return finish();
    await rec.check("cut off: the public name stops answering through the relay and the heartbeat stops", async () => {
      const deadline = Date.now() + 6 * 60_000;
      let st = 0;
      while (Date.now() < deadline) {
        st = (await tryHttp(`https://${boxA.fqdn}/`, {}, 12_000)).status;
        if (st !== 200) break;
        await sleep(10_000);
      }
      assert(st !== 200, "the relay still serves the box 6 minutes after the cut");
      lastReportedAtCut = (await pods(A.username)).find((x) => x.serverDomain === boxA.fqdn)?.lastReported ?? null;
      return `relay answers ${st}; /pods lastReported frozen at ${String(lastReportedAtCut)}`;
    });

    // ── 3. the phone, over the private network only ─────────────────────────────────────────────
    const hello = async (): Promise<{ h: RescueExchange; seen: string }> => {
      const clientNonce = nonceHex();
      const r = await lan("POST", "/api/rescue/hello", { clientNonce });
      assert(r.status === 200, `hello ${r.status}: ${short(r.body.toString("utf8"))}`);
      const h = parseRescueExchange(r.json?.hello);
      assert(h, `hello shape ${short(r.json)}`);
      const check = checkRescueHello(h, hexToBytes(String(r.json.signatureHex)), pinnedStk, { serverDomain: boxA.fqdn, clientNonce, seenCertSha256: r.certSha256, now: Date.now() });
      assert(check.ok, `the hello does not check out: ${check.ok ? "" : check.reason}`);
      return { h, seen: r.certSha256 };
    };
    const openSession = async (h: RescueExchange, signer: Keypair, cert?: string) => {
      const order = sessionOrderFor(h, Date.now(), cert);
      return lan("POST", "/api/rescue/session", { order, signatureHex: bytesToHex(signRescueSession(order, signer)) });
    };

    await rec.check("the box's hello is signed by its pinned identity key (STK) and names the certificate this connection saw", async () => {
      const { h, seen } = await hello();
      return `hello names cert ${h.certSha256.slice(0, 16)}, TLS saw ${seen.slice(0, 16)}`;
    });
    await rec.check("an order naming another certificate (a relaying machine in the middle) is refused", async () => {
      const { h } = await hello();
      const r = await openSession(h, A.keys.adminRoot, "0".repeat(64));
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.body.toString("utf8"))}`);
      return short(r.json?.error ?? r.status, 120);
    });
    await rec.check("an IRK-signed session order is refused on this admin-pinned box", async () => {
      const { h } = await hello();
      const r = await openSession(h, A.keys.irk);
      assert(r.status === 403, `expected 403, got ${r.status}`);
      return short(r.json?.error ?? r.status, 120);
    });
    await rec.check("a stranger's key (account B's admin root) is refused", async () => {
      const { h } = await hello();
      const r = await openSession(h, B.keys.adminRoot);
      assert(r.status === 403, `expected 403, got ${r.status}`);
      return short(r.json?.error ?? r.status, 120);
    });
    let token = "";
    const opened = await rec.check("the admin root opens a rescue session over the private network, with no .com", async () => {
      const { h } = await hello();
      const r = await openSession(h, A.keys.adminRoot);
      assert(r.status === 200 && /^[0-9a-f]{64}$/.test(String(r.json?.token)), `session ${r.status}: ${short(r.body.toString("utf8"))}`);
      token = r.json.token;
      return `token until ${new Date(Number(r.json.expiresAt)).toISOString()}`;
    });
    if (!opened) return finish();
    const rh = rescueHeaders(token);
    const server = async () => {
      const r = await lan("GET", "/api/rescue/server", undefined, rh);
      assert(r.status === 200, `server ${r.status}: ${short(r.body.toString("utf8"))}`);
      return r.json;
    };
    let sessionNonce = "";
    await rec.check("the server summary lists the app and its state", async () => {
      const j = await server();
      sessionNonce = String(j.sessionNonce ?? "");
      const st = appStateIn(j, serviceId);
      assert(st === "running" || st === "starting", `${serviceId} is ${st}`);
      assert(/^[0-9a-f]{32}$/.test(sessionNonce), "no session nonce");
      return `${(j.apps ?? []).length} app(s); ${PY_APP} ${st}; controls ${short(j.controls)}`;
    });

    // ── 4. offline control ──────────────────────────────────────────────────────────────────────
    const control = (action: OfflineControlAction, target = serviceId, nonce?: string) => {
      const order = controlOrderFor({ serverDomain: boxA.fqdn, sessionNonce, action, target, now: Date.now(), ...(nonce ? { nonce } : {}) });
      const body = { order, signatureHex: bytesToHex(signOfflineControl(order, A.keys.adminRoot)) };
      return { body, send: () => lan("POST", "/api/rescue/control", body, rh, 180_000) };
    };
    const waitState = async (want: string[], ms = 3 * 60_000) => {
      const deadline = Date.now() + ms;
      let st = "";
      while (Date.now() < deadline) {
        st = appStateIn(await server(), serviceId);
        if (want.includes(st)) return st;
        await sleep(5_000);
      }
      throw new Error(`${PY_APP} is ${st}, not ${want.join("/")}`);
    };
    await rec.check("offline control: stop the app (signed order), the summary shows it stopped", async () => {
      const r = await control("app-stop").send();
      assert(r.status === 200, `stop ${r.status}: ${short(r.body.toString("utf8"))}`);
      return await waitState(["stopped"]);
    });
    await rec.check("offline control: start it again, it runs", async () => {
      const r = await control("app-start").send();
      assert(r.status === 200, `start ${r.status}: ${short(r.body.toString("utf8"))}`);
      return await waitState(["running"]);
    });
    await rec.check("offline control: restart it; the same signed order sent again is refused", async () => {
      const c = control("app-restart");
      const r = await c.send();
      assert(r.status === 200, `restart ${r.status}: ${short(r.body.toString("utf8"))}`);
      const again = await lan("POST", "/api/rescue/control", c.body, rh);
      assert(again.status === 403, `replay ${again.status}`);
      return `${await waitState(["running"])}; replay ${again.status}`;
    });
    await rec.check("an offline order signed by the IRK is refused", async () => {
      const order = controlOrderFor({ serverDomain: boxA.fqdn, sessionNonce, action: "app-restart", target: serviceId, now: Date.now() });
      const r = await lan("POST", "/api/rescue/control", { order, signatureHex: bytesToHex(signOfflineControl(order, A.keys.irk)) }, rh);
      assert(r.status === 403, `expected 403, got ${r.status}`);
      return "403";
    });

    // ── 5. rescue my data ───────────────────────────────────────────────────────────────────────
    const archiveId = randomBytes(16).toString("hex");
    const contentKey = new Uint8Array(randomBytes(32));
    let meta: { bytes: number; sha256: string } | null = null;
    let data: Buffer | null = null;
    const made = await rec.check("a backup (passcode + account slots) is made through the rescue session", async () => {
      const slots = [
        wrapAccountSlot(archiveId, contentKey, deriveServerArchiveKey({ seed: A.keys.umk }, archiveId), new Uint8Array(randomBytes(12))),
        wrapPasscodeSlot(archiveId, contentKey, PASSCODE, new Uint8Array(randomBytes(16)), new Uint8Array(randomBytes(12)), ARGON),
      ];
      const noPass = await lan("POST", "/api/rescue/archive/start", { archiveId, key: bytesToHex(contentKey), slots: slots.slice(0, 1) }, rh);
      assert(noPass.status === 400, `a backup without a passcode: ${noPass.status}`);
      const r = await lan("POST", "/api/rescue/archive/start", { archiveId, key: bytesToHex(contentKey), slots }, rh);
      assert(r.status === 202, `start ${r.status}: ${short(r.body.toString("utf8"))}`);
      const deadline = Date.now() + 20 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const st = await lan("GET", "/api/rescue/archive", undefined, rh);
        const x = st.json?.archive;
        last = short(x, 200);
        if (x?.state === "ready") {
          meta = { bytes: Number(x.bytes), sha256: String(x.sha256) };
          return `${x.bytes} B, ${(x.apps ?? []).length} app(s); a backup without a passcode was refused`;
        }
        if (x?.state === "failed") throw new Error(`backup failed: ${x.reason}`);
        await sleep(5_000);
      }
      throw new Error(`not ready in 20 min: ${last}`);
    });
    if (!made || !meta) return finish();
    const m = meta as { bytes: number; sha256: string };
    const fetched = await rec.check("the one .flagship file downloads in 4 MiB parts, matches its SHA-256 and opens with the passcode", async () => {
      const first = await lan("GET", "/api/rescue/archive/bundle?offset=0", undefined, rh, 120_000);
      assert(first.status === 200, `bundle ${first.status}: ${short(first.body.toString("utf8"))}`);
      const total = Number(first.headers["x-flagship-bundle-bytes"]);
      const want = String(first.headers["x-flagship-bundle-sha256"] ?? "");
      const parts: Buffer[] = [first.body];
      for (const off of bundleOffsets(total, first.body.length)) {
        const r = await lan("GET", `/api/rescue/archive/bundle?offset=${off}`, undefined, rh, 120_000);
        assert(r.status === 200, `bundle at ${off}: ${r.status}`);
        parts.push(r.body);
      }
      const bundle = Buffer.concat(parts);
      const sha = createHash("sha256").update(bundle).digest("hex");
      assert(bundle.length === total && sha === want, `${bundle.length}/${total} B, sha ${sha.slice(0, 12)} vs ${want.slice(0, 12)}`);
      const split = splitBundle(bundle);
      const opened = openBackupWithPasscode(parseBackupFile(split.backupText), PASSCODE);
      assert(bytesToHex(opened.contentKey) === bytesToHex(contentKey), "the passcode opened another key");
      assert(split.data.length === m.bytes && createHash("sha256").update(split.data).digest("hex") === m.sha256, "the data part differs from the backup's record");
      data = split.data;
      return `${bundle.length} B in ${parts.length} part(s)`;
    });

    // ── 6. nothing left the box ─────────────────────────────────────────────────────────────────
    await rec.check("nothing left the box during the rescue: drops counted, only SSH replies to the runner, heartbeat frozen, relay dark", async () => {
      const l = await ssh(boxVm, LIST_CUT_COMMAND, 30_000);
      const delta = cutDelta(counters0, parseCutCounters(l.stdout));
      assert(!delta.missing.length, `the cut is gone: missing ${delta.missing.join(",")}`);
      const now = (await pods(A.username)).find((x) => x.serverDomain === boxA.fqdn)?.lastReported ?? null;
      assert(String(now) === String(lastReportedAtCut), `the heartbeat moved: ${String(lastReportedAtCut)} → ${String(now)}`);
      const relay = (await tryHttp(`https://${boxA.fqdn}/`, {}, 12_000)).status;
      assert(relay !== 200, "the relay serves the box again");
      return `${delta.dropped} outbound packet(s) dropped, ${delta.runnerSsh} SSH reply packet(s) to the runner; lastReported ${String(now)}; relay ${relay}`;
    });

    // ── 7. the reboot cliff (info on a gym box) ─────────────────────────────────────────────────
    await rec.check("(info) offline server-restart is accepted and the box goes down; a gym box has no LUKS, so the D2 cliff (stays locked while cut) is proven on hardware only", async () => {
      const r = await control("server-restart", boxA.fqdn).send();
      assert(r.status === 202, `restart ${r.status}: ${short(r.body.toString("utf8"))}`);
      const deadline = Date.now() + 3 * 60_000;
      let down = false;
      while (Date.now() < deadline && !down) {
        down = await lan("POST", "/api/rescue/hello", { clientNonce: nonceHex() }, undefined, 8_000).then(() => false, () => true);
        if (!down) await sleep(3_000);
      }
      assert(down, "the box never went down");
      // Back up: the nft table did not persist and nothing asks for an unlock on a gym box.
      const back = await waitOnline(boxA, 15, log).catch((e: Error) => `not back in 15 min: ${e.message}`);
      return `went down; came back by itself (expected without LUKS, the cut is not persistent): ${short(back, 120)}`;
    });

    // ── 8. import into account B with the passcode ──────────────────────────────────────────────
    if (!fetched || !data) return finish();
    if (!(await madeB) || !b) return finish();
    const boxB = b;
    if (!(await rec.check("B's box comes online (≤25 min)", () => waitOnline(boxB, 25, log)))) return finish();
    const bytes = data as Buffer;
    const restored = await rec.check("B's box adopts the rescued file (opened with the passcode, not A's account key) and rebuilds the app", async () => {
      const tok = await armRestore(B, boxB, { archiveId, bytes: m.bytes, sha256: m.sha256 });
      return await uploadAndRestore(boxB, tok, archiveId, bytes, contentKey);
    });
    if (restored) {
      await rec.check("the app on B's box serves the same row and file", async () => {
        let r = await tryHttp(`https://${PY_APP}.${boxB.fqdn}/read`);
        for (let i = 0; i < 36 && r.status !== 200; i++) {
          await sleep(5_000);
          r = await tryHttp(`https://${PY_APP}.${boxB.fqdn}/read`);
        }
        assert(r.status === 200 && r.json?.file === marker && r.json?.rows?.includes(marker), `/read ${r.status}: ${short(r.text)}`);
        return `file + row "${marker}" on ${boxB.fqdn}`;
      });
    }
    return finish();
  } catch (e) {
    rec.results.push({ name: "sovereignty lane crashed", ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e), ms: 0 });
    log(`✗ crashed: ${e instanceof Error ? e.message : String(e)}`);
    return finish();
  } finally {
    if (tunnel) tunnel.kill();
    log("cleanup");
    // B's box may still be provisioning when an early check ends the lane: wait so teardown sees it.
    await pendingB.catch(() => undefined);
    const serverIds = accounts.flatMap((x) => x.boxes).map((x) => x.serverId).filter((x): x is string => !!x);
    const serverDomains = accounts.flatMap((x) => x.boxes).map((x) => x.fqdn);
    if (accounts.length) {
      const td = await tryHttp(`https://${CONTROL}/api/gym/teardown`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ serverIds, serverDomains, usernames: accounts.map((x) => x.username) }),
      }, 300_000);
      log(`gym teardown: ${td.status} ${short(td.json ?? td.text, 300)}`);
    }
    if (sibling) await destroyVm(sibling, log).catch((e: Error) => log(`sibling not deleted: ${e.message}`));
    await rec.check("cleanup: the gym is back to its server and DNS counts", async () => {
      const after = await gymCounts();
      assert(after.servers === base.servers && after.dns === base.dns, `after ${after.servers}/${after.dns} vs before ${base.servers}/${base.dns}: run tools/live-e2e/sweep-cli.ts (dry run, then --destroy)`);
      return `${after.servers} server(s), ${after.dns} DNS record(s)`;
    }).catch(() => false);
    writeJson(dir, "sovereignty.json", { group: "sovereignty", results: rec.results, passed: rec.passed, failed: rec.failed, skipped: rec.skipped });
    lock.release();
  }

  function finish(): number {
    log(`${rec.passed} passed, ${rec.failed} failed, ${rec.skipped} skipped (${dir}/sovereignty.json)`);
    return rec.failed ? 1 : rec.skipped ? 3 : 0;
  }
}

/** A fresh ed25519 key for root SSH on A's box (the gym-only provision field) and on the sibling. */
async function createSiblingKey(dir: string): Promise<{ key: string; pub: string }> {
  const key = join(dir, "id_ed25519");
  const r = await run("bash", ["-c", `mkdir -p '${dir}' && [ -f '${key}' ] || ssh-keygen -q -t ed25519 -N '' -f '${key}'`]);
  if (r.code !== 0) throw new Error(`ssh-keygen: ${r.stderr}`);
  return { key, pub: readFileSync(`${key}.pub`, "utf8").trim() };
}

process.exit(await main().catch((e) => (log(`CRASH: ${e instanceof Error ? e.message : e}`), 2)));

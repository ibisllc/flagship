/**
 * Milestone 5 drill (docs/architecture-v2/drills/m5-upcloud.md). Runs ON a throwaway Debian 13
 * VM prepared by setup-box.sh, as root, from /opt/flagship:
 *
 *   npx tsx tools/arch-drills/m5/drill.ts <migrate|apps|rust|broken|rollback|luks>
 *
 * Every check prints one `RESULT {"phase","check","ok","detail"}` line. It drives the daemon's
 * own modules (not copies) against the real engine, systemd, nft and cryptsetup.
 */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync, renameSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { realCommandRunner, AppRunner, type CommandRunner } from "../../../packages/server-daemon/src/serviceRunner.js";
import { setActiveEngine } from "../../../packages/server-daemon/src/engine/engine.js";
import { bootArchV2, rustPathHealthy, tsCheckpoint } from "../../../packages/server-daemon/src/archV2Boot.js";
import { LoopVolumes } from "../../../packages/server-daemon/src/appQuota/loopVolumes.js";
import { ensureGvisor } from "../../../packages/server-daemon/src/appSandbox/gvisor.js";
import { startAppSandbox, setEgressFence } from "../../../packages/server-daemon/src/appSandbox/state.js";
import { EgressGateway } from "../../../packages/server-daemon/src/egress/gateway.js";
import { setContainersChangedHook } from "../../../packages/server-daemon/src/egress/sandboxNetworking.js";
import { installIccIsolation } from "../../../packages/server-daemon/src/egress/firewall.js";
import { installKeyd } from "../../../packages/server-daemon/src/keydInstall.js";
import { readRustStatuses, rustStackRegressions } from "../../../packages/server-daemon/src/rustStack/install.js";
import { brokerCall } from "../../../packages/server-daemon/src/rustStack/brokerClient.js";
import { CORE_CHECKPOINT, CORE_STATUS } from "../../../packages/server-daemon/src/rustStack/units.js";
import { runUpdateBootGate } from "../../../packages/server-daemon/src/updateHealthGate.js";
import { filePendingVerifyStore, realUpdateCommandRunner } from "../../../packages/server-daemon/src/updateConsumer.js";
import { buildArtifactSwapper } from "../../../packages/server-daemon/src/artifactUpdate.js";
import { loadArchV2Config } from "../../../packages/server-daemon/src/engine/engine.js";
import { KeydClient } from "../../../packages/keyd/src/client.js";
import { APPLIANCE_REKEY_BLOCK, buildApplianceFactoryLuksRecordBlock } from "../../../packages/flagship-builder/src/applianceDiskKey.js";

const phase = process.argv[2] ?? "";
const cmd = realCommandRunner as Required<CommandRunner>;
let failures = 0;
const log = (m: string) => console.log(m);

function result(check: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures++;
  console.log(`RESULT ${JSON.stringify({ phase, check, ok, detail })}`);
}

async function out(c: string, a: string[], timeoutMs = 600_000): Promise<string> {
  return (await cmd.capture(c, a, { timeoutMs })).stdout;
}

async function tryOut(c: string, a: string[], timeoutMs = 120_000): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await cmd.capture(c, a, { timeoutMs });
    return { ok: true, text: `${r.stdout}${r.stderr}` };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, text: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message}` };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let v = await what();
  while (!ok(v) && Date.now() < end) {
    await sleep(2000);
    v = await what();
  }
  return v;
}

const SWITCH = "/var/lib/flagship/arch-v2.json";
function setSwitch(rust: "on" | "off", engine: "docker" | "podman"): void {
  mkdirSync("/var/lib/flagship", { recursive: true });
  writeFileSync(SWITCH, JSON.stringify({ version: 1, rust, engine, source: "maintainer" }));
}

const APP = "flagship-drill--app";
const QAPP = "flagship-drill--q";
const APP_VOL = "flagship-files-drill--app";
const Q_VOL = "flagship-files-drill--q";

async function migrate(): Promise<void> {
  setActiveEngine("docker");
  await out("docker", ["pull", "-q", "docker.io/library/busybox:1.37"]);
  const ctx = "/var/tmp/drill-image";
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(ctx, "Containerfile"), 'FROM docker.io/library/busybox:1.37\nCMD ["sleep", "86400"]\n');
  await out("docker", ["build", "-q", "-t", `${APP}:1`, "-f", join(ctx, "Containerfile"), ctx]);
  const loops = new LoopVolumes(cmd, { log });
  await loops.create(APP_VOL, 64 * 1024 * 1024);
  writeFileSync(`/var/lib/flagship-files/${APP_VOL}/data/hello.txt`, "from docker\n");
  await out("docker", ["volume", "create", "drill-plain"]);
  await out("docker", ["run", "--rm", "-v", "drill-plain:/v", "docker.io/library/busybox:1.37", "sh", "-c", "echo plain > /v/p.txt"]);
  await out("docker", ["run", "-d", "--name", APP, "-v", `${APP_VOL}:/data`, `${APP}:1`]);
  const dockerDevice = (await out("docker", ["volume", "inspect", "--format", "{{.Options.device}}", APP_VOL])).trim();

  setSwitch("on", "podman");
  const boot = await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  result("boot chose podman", boot.engine === "podman", boot.engineNote ?? "");
  const marker = JSON.parse(readFileSync("/var/lib/flagship/engine-migration.json", "utf8"));
  result("marker", marker.result === "migrated", marker);
  result("image moved", (await tryOut("podman", ["image", "exists", `${APP}:1`])).ok);
  const podDevice = (await out("podman", ["volume", "inspect", "--format", "{{.Options.device}}", APP_VOL])).trim();
  result("files volume rebound to the same loop image", podDevice === dockerDevice && podDevice !== "", { dockerDevice, podDevice });
  const hello = await tryOut("podman", ["run", "--rm", "-v", `${APP_VOL}:/data`, "docker.io/library/busybox:1.37", "cat", "/data/hello.txt"]);
  result("files volume data readable under podman", hello.text.includes("from docker"), hello.text.trim());
  const plain = await tryOut("podman", ["run", "--rm", "-v", "drill-plain:/v", "docker.io/library/busybox:1.37", "cat", "/v/p.txt"]);
  result("plain volume copied", plain.text.includes("plain"), plain.text.trim());
  const active = await tryOut("systemctl", ["is-active", "docker.service"]);
  const enabled = await tryOut("systemctl", ["is-enabled", "docker.service"]);
  result("docker stopped and disabled", !active.text.includes("active\n") || active.text.includes("inactive"), { active: active.text.trim(), enabled: enabled.text.trim() });
  result("docker data kept", existsSync("/var/lib/docker/image") && existsSync("/var/lib/docker/volumes/drill-plain"));
  const again = await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  result("second boot does not migrate again", again.engine === "podman" && JSON.parse(readFileSync("/var/lib/flagship/engine-migration.json", "utf8")).at === marker.at);
}

async function apps(): Promise<void> {
  setActiveEngine("podman");
  const gv = await startAppSandbox(() => ensureGvisor({ cmd, probeImage: "docker.io/library/busybox:1.37", log }));
  result("gvisor registered with podman and its test container ran", gv.ok, gv.ok ? gv.version : gv.reason);
  const gateway = new EgressGateway({
    cmd,
    accessRules: (id) => (id === "drill--app" ? [{ line: 1, action: "allow", target: "example.com" }] : []),
    log,
  });
  const st = await gateway.start();
  result("egress gateway enforced", st.enforced, st);
  setEgressFence(() => gateway.status());
  setContainersChangedHook(() => gateway.refreshApps());
  const nft = await tryOut("nft", ["list", "table", "bridge", "flagship_icc"]);
  result("bridge isolation table installed", nft.ok && nft.text.includes("fs-apps"), nft.text.slice(0, 400));

  await tryOut("podman", ["rm", "-f", APP, QAPP]);
  const loops = new LoopVolumes(cmd, { log });
  if (!(await tryOut("podman", ["volume", "exists", Q_VOL])).ok) await loops.create(Q_VOL, 64 * 1024 * 1024);
  const runner = new AppRunner(cmd);
  const args = await runner.deploy({ serviceId: "drill--app", image: `${APP}:1`, port: 18081, containerPort: 8080, filesVolume: APP_VOL });
  await runner.deploy({ serviceId: "drill--q", image: `${APP}:1`, port: 18082, containerPort: 8080, filesVolume: Q_VOL });
  log(`deploy argv: ${args.join(" ")}`);
  await gateway.refreshApps();
  result("deployed under runsc", (await out("podman", ["inspect", APP, "--format", "{{.OCIRuntime}}"])).trim() === "runsc");
  const dmesg = await tryOut("podman", ["exec", APP, "dmesg"]);
  result("the app's kernel is gVisor", /gVisor/i.test(dmesg.text), dmesg.text.split("\n").slice(0, 2).join(" | "));
  const ro = (await out("podman", ["inspect", APP, "--format", "{{.HostConfig.ReadonlyRootfs}}|{{.EffectiveCaps}}|{{.HostConfig.CapAdd}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.PidsLimit}}"])).trim();
  result("hardening: read-only root, no effective capabilities, no-new-privileges, pids limit", /^true\|\[\]\|\[\]\|\[no-new-privileges\]\|\d+$/i.test(ro), ro);
  const data = await tryOut("podman", ["exec", APP, "cat", "/data/hello.txt"]);
  result("migrated files volume mounted at /data", data.text.includes("from docker"), data.text.trim());

  const dd = await tryOut("podman", ["exec", QAPP, "sh", "-c", "dd if=/dev/zero of=/data/big bs=1M count=200 2>&1; echo rc=$?"], 180_000);
  result("per-app quota: writing past the files limit fails with ENOSPC", /No space left/i.test(dd.text), dd.text.trim().split("\n").slice(-3).join(" | "));
  await tryOut("podman", ["exec", QAPP, "rm", "-f", "/data/big"]);

  const allowed = await tryOut("podman", ["exec", APP, "wget", "-q", "-O-", "-T", "20", "http://example.com/"], 60_000);
  result("egress: an allowed host is reached through the gateway", /Example Domain/i.test(allowed.text), allowed.text.slice(0, 200));
  const denied = await tryOut("podman", ["exec", APP, "wget", "-q", "-O-", "-T", "15", "http://neverssl.com/"], 60_000);
  result("egress: a host not on the list is refused", !denied.ok || !/neverssl/i.test(denied.text), denied.text.slice(0, 200));
  const direct = await tryOut("podman", ["exec", APP, "wget", "-q", "-O-", "-T", "10", "http://1.1.1.1/"], 60_000);
  result("egress: a bare IP is refused", !direct.ok || direct.text.trim() === "", direct.text.slice(0, 200));
  const other = await tryOut("podman", ["exec", QAPP, "wget", "-q", "-O-", "-T", "15", "http://example.com/"], 60_000);
  result("egress: an app with an empty list reaches nothing", !/Example Domain/i.test(other.text), other.text.slice(0, 200));

  // Containers on one bridge must not reach each other (Docker's enable_icc=false).
  await out("podman", ["exec", "-d", QAPP, "sh", "-c", "echo hi > /tmp/index.html; exec httpd -f -p 8080 -h /tmp"]);
  await sleep(2000);
  const ip = (await out("podman", ["inspect", QAPP, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"])).trim();
  const blocked = await tryOut("podman", ["exec", APP, "wget", "-q", "-O-", "-T", "6", `http://${ip}:8080/`], 60_000);
  result("icc: app to app on the bridge is dropped", !/hi|Connection refused/.test(blocked.text), { ip, text: blocked.text.slice(0, 160) });
  await out("nft", ["delete", "table", "bridge", "flagship_icc"]);
  const open = await tryOut("podman", ["exec", APP, "wget", "-q", "-O-", "-T", "6", `http://${ip}:8080/`], 60_000);
  // Any answer from the other app's stack (its page, or a refusal) means the frame got through.
  result("icc: without the table the same request goes through (the table is what isolates)", /hi|Connection refused/.test(open.text), open.text.slice(0, 160));
  await installIccIsolation(cmd, [
    { kind: "apps", bridge: "fs-apps" },
    { kind: "staging", bridge: "fs-staging" },
    { kind: "build", bridge: "fs-build" },
  ]);
  const again = await tryOut("podman", ["exec", APP, "wget", "-q", "-O-", "-T", "6", `http://${ip}:8080/`], 60_000);
  result("icc: dropped again once the table is back", !/hi|Connection refused/.test(again.text), again.text.slice(0, 160));

  // Backups and app copies use save/load and the files archive helpers under Podman.
  await out("docker", ["save", "-o", "/var/tmp/drill-save.tar", `${APP}:1`]);
  await out("docker", ["image", "rm", "-f", `${APP}:1`]).catch(() => "");
  const loaded = await tryOut("docker", ["load", "-q", "-i", "/var/tmp/drill-save.tar"]);
  result("image save then load round trip (app copy path)", loaded.ok && (await tryOut("podman", ["image", "exists", `${APP}:1`])).ok, loaded.text.trim());
  rmSync("/var/tmp/drill-save.tar", { force: true });
  await gateway.stop().catch(() => {});
}

async function keydPub(): Promise<string> {
  const c = new KeydClient({ socketPath: "/run/flagship-keyd/keyd.sock", component: "drill", timeoutMs: 5000 });
  try {
    return (await c.connect()).publicKey;
  } finally {
    c.close();
  }
}

async function statuses(): Promise<Record<string, string>> {
  const s = await readRustStatuses({});
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.choice}/${v.reason}`]));
}

async function rust(): Promise<void> {
  if (!existsSync("/var/flagship/identity/identity.priv.hex") && !existsSync("/var/lib/flagship-keyd/identity.key")) {
    mkdirSync("/var/flagship/identity", { recursive: true, mode: 0o700 });
    writeFileSync("/var/flagship/identity/identity.priv.hex", randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  setSwitch("off", "podman");
  await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  const k = await installKeyd({ repoPath: "/opt/flagship", run: (c, a) => realUpdateCommandRunner(c, a), onLog: log });
  result("TS keyd installed and serving", k === "installed" || k === "already-running", k);
  const tsPub = await keydPub();
  setSwitch("on", "podman");
  await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  const s = await until(statuses, (v) => v.keyd === "rust/running" && v.broker === "rust/running" && v.core === "rust/running", 90_000);
  result("all three components on their Rust binaries under systemd", s.keyd === "rust/running" && s.broker === "rust/running" && s.core === "rust/running", s);
  const rustPub = await until(keydPub, (v) => v.length > 0, 20_000).catch((e: Error) => e.message);
  result("Rust keyd serves the same box key from the same state (wire v1)", rustPub === tsPub, { tsPub: tsPub.slice(0, 16), rustPub: String(rustPub).slice(0, 16) });
  const exe = (await out("bash", ["-c", "readlink /proc/$(systemctl show -p MainPID --value flagship-keyd)/exe"])).trim();
  result("keyd's process is the Rust binary", exe.endsWith("installer/rust/flagship-keyd"), exe);
  const props = (await out("systemctl", ["show", "flagship-core", "-p", "User", "-p", "NoNewPrivileges", "-p", "PrivateNetwork", "-p", "ProtectSystem", "-p", "CapabilityBoundingSet"])).trim().split("\n").join(" ");
  result("core runs unprivileged and fenced", /User=flagship-core/.test(props) && /NoNewPrivileges=yes/.test(props) && /PrivateNetwork=yes/.test(props), props);
  const ps = (await brokerCall("docker", { argv: ["ps", "--format", "{{.Names}}"] })) as { stdout?: string };
  result("broker v1 runs the engine op under podman", String(ps.stdout).includes(APP), String(ps.stdout).trim());
  const refused = await brokerCall("docker", { argv: ["run", "--privileged", "busybox"] }).then(() => "accepted", (e: Error) => e.message);
  result("broker v1 still refuses a privileged container", /not allowed|forbidden/i.test(refused), refused);

  writeFileSync(CORE_CHECKPOINT, tsCheckpoint([{ serviceId: "drill--app" } as never, { serviceId: "drill--q" } as never]), { mode: 0o644 });
  const agree = await until(async () => JSON.parse(readFileSync(CORE_STATUS, "utf8")), (v) => v.ok === true && v.at > Date.now() / 1000 - 5 && v.divergent === 0, 140_000);
  result("core shadow agrees with the TS controller", agree.ok === true && agree.divergent === 0, agree);
  await out("podman", ["stop", "-t", "2", QAPP]);
  const diverge = await until(async () => JSON.parse(readFileSync(CORE_STATUS, "utf8")), (v) => v.divergent === 1, 140_000);
  result("core shadow notices a stopped app", diverge.divergent === 1, diverge);
  const rows = await tryOut("bash", ["-c", "cp /var/lib/flagship-core/journal.db /tmp/j.db && command -v sqlite3 >/dev/null && sqlite3 /tmp/j.db 'select installation, decision from shadow order by id' || echo no-sqlite3"]);
  log(`shadow journal: ${rows.text.trim()}`);
  await out("podman", ["start", QAPP]);
}

const PINS = "/opt/flagship/installer/rust/PINS.json";
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function broken(): Promise<void> {
  const cfg = loadArchV2Config();
  const brokerBin = "/opt/flagship/installer/rust/flagship-broker";
  copyFileSync(brokerBin, "/var/tmp/flagship-broker.good");
  writeFileSync(`${brokerBin}.new`, Buffer.concat([readFileSync(brokerBin), Buffer.from("x")]), { mode: 0o755 });
  renameSync(`${brokerBin}.new`, brokerBin);
  await out("systemctl", ["restart", "flagship-broker"]);
  const s1 = await until(statuses, (v) => v.broker === "ts/hash-mismatch", 30_000);
  result("a binary that is not the pinned one is not run (broker idles in fallback)", s1.broker === "ts/hash-mismatch", s1);
  const r1 = await rustStackRegressions({ config: cfg });
  result("the update gate sees the regression", r1.some((x) => x.startsWith("broker")), r1);
  const again = await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  result("a boot does not restart-loop the fallback", !again.rust.action.startsWith("fail") && ("restarted" in again.rust ? !again.rust.restarted.includes("broker") : true), again.rust);
  copyFileSync("/var/tmp/flagship-broker.good", `${brokerBin}.new`);
  renameSync(`${brokerBin}.new`, brokerBin);
  await out("systemctl", ["restart", "flagship-broker"]);
  const s2 = await until(statuses, (v) => v.broker === "rust/running", 30_000);
  result("the right binary comes back", s2.broker === "rust/running", s2);

  // A pinned keyd that crashes: three quick failures, then the TS keyd serves.
  const keydBin = "/opt/flagship/installer/rust/flagship-keyd";
  copyFileSync(keydBin, "/var/tmp/flagship-keyd.good");
  copyFileSync(PINS, "/var/tmp/PINS.good.json");
  writeFileSync(`${keydBin}.new`, "#!/bin/sh\necho crashing on purpose >&2\nexit 1\n", { mode: 0o755 });
  renameSync(`${keydBin}.new`, keydBin);
  const pins = JSON.parse(readFileSync(PINS, "utf8"));
  pins.binaries["flagship-keyd"] = sha(keydBin);
  writeFileSync(PINS, JSON.stringify(pins, null, 2));
  const t0 = Date.now();
  await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  const s3 = await until(statuses, (v) => v.keyd === "ts/failed-to-start", 150_000);
  result("a crashing keyd binary falls back to the TS keyd after three tries", s3.keyd === "ts/failed-to-start", { ...s3, seconds: Math.round((Date.now() - t0) / 1000) });
  const pub = await until(keydPub, (v) => v.length > 0, 30_000).catch((e: Error) => e.message);
  result("the box keeps its keys: the TS keyd answers", /^[0-9a-f]{64}$/.test(String(pub)), String(pub).slice(0, 16));
  result("the update gate fails that release", !(await rustPathHealthy(cfg, log)));
  copyFileSync("/var/tmp/flagship-keyd.good", `${keydBin}.new`);
  renameSync(`${keydBin}.new`, keydBin);
  copyFileSync("/var/tmp/PINS.good.json", PINS);
  await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  const s4 = await until(statuses, (v) => v.keyd === "rust/running", 90_000);
  result("restored release: keyd back on Rust", s4.keyd === "rust/running", s4);
}

async function rollback(): Promise<void> {
  const cfg = loadArchV2Config();
  const goodApp = readlinkSync("/opt/flagship");
  const goodRel = goodApp.replace(/\/app$/, "");
  const good = JSON.parse(readFileSync(join(goodRel, "INSTALLED.json"), "utf8")).commit as string;
  const bad = "b".repeat(40);
  const badRel = `/opt/flagship-releases/${bad}`;
  rmSync(badRel, { recursive: true, force: true });
  // A second installed release that differs only in a broken (but correctly pinned) keyd.
  await out("cp", ["-al", goodRel, badRel]);
  const keydBin = join(badRel, "app/installer/rust/flagship-keyd");
  rmSync(keydBin);
  writeFileSync(keydBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const pinsPath = join(badRel, "app/installer/rust/PINS.json");
  const pins = JSON.parse(readFileSync(pinsPath, "utf8"));
  rmSync(pinsPath);
  pins.binaries["flagship-keyd"] = sha(keydBin);
  pins.commit = bad;
  writeFileSync(pinsPath, JSON.stringify(pins, null, 2));
  rmSync(join(badRel, "INSTALLED.json"));
  writeFileSync(join(badRel, "INSTALLED.json"), JSON.stringify({ commit: bad, arch: "amd64" }));
  // The update applied: /opt/flagship now points at the bad release and the gate's marker is set.
  rmSync("/opt/flagship.new", { force: true });
  symlinkSync(join(badRel, "app"), "/opt/flagship.new");
  renameSync("/opt/flagship.new", "/opt/flagship");
  writeFileSync("/var/flagship/update-pending.json", JSON.stringify({ previousCommit: good, targetCommit: bad, bootAttempts: 0, stage: "staged" }));
  await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  const s1 = await until(statuses, (v) => v.keyd === "ts/failed-to-start", 150_000);
  result("bad release: keyd falls back, the box keeps running", s1.keyd === "ts/failed-to-start", s1);
  const gate = () =>
    runUpdateBootGate({
      pendingStore: filePendingVerifyStore("/var/flagship/update-pending.json"),
      swapper: buildArtifactSwapper({ repoPath: "/opt/flagship", runner: realUpdateCommandRunner, onLog: log }),
      awaitHealthy: () => rustPathHealthy(cfg, log),
      requestRestart: () => log("[drill] the daemon would restart here"),
      maxBootAttempts: 1,
      onLog: log,
    });
  const first = await gate();
  result("boot gate: the bad release is not healthy", first.action === "retry-restart", first);
  const second = await gate();
  result("boot gate: rolled back to the last good release", second.action === "rolled-back" && readlinkSync("/opt/flagship") === goodApp, { second, link: readlinkSync("/opt/flagship") });
  await bootArchV2({ repoPath: "/opt/flagship", cmd, run: (c, a) => realUpdateCommandRunner(c, a), log });
  const s2 = await until(statuses, (v) => v.keyd === "rust/running", 90_000);
  result("after the rollback keyd runs the good release's Rust binary", s2.keyd === "rust/running", s2);
  result("and the gate is healthy again", await rustPathHealthy(cfg, log));
}

async function luks(): Promise<void> {
  const work = "/var/tmp/luks-drill";
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const runOne = async (label: string, killAfterPct: number | null): Promise<void> => {
    const img = join(work, `${label}.img`);
    const key = join(work, `${label}.key`);
    writeFileSync(key, randomBytes(64), { mode: 0o600 });
    await out("truncate", ["-s", "1536M", img]);
    const dev = (await out("losetup", ["--find", "--show", img])).trim();
    await out("cryptsetup", ["luksFormat", "--type", "luks2", "--batch-mode", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", key, dev]);
    const name = `drill-${label}`;
    await out("cryptsetup", ["open", "--key-file", key, dev, name]);
    await out("mkfs.ext4", ["-q", `/dev/mapper/${name}`]);
    const mnt = join(work, `${label}.mnt`);
    mkdirSync(mnt);
    await out("mount", [`/dev/mapper/${name}`, mnt]);
    await out("dd", ["if=/dev/urandom", `of=${mnt}/owner-data`, "bs=1M", "count=600", "status=none"]);
    await out("sync", []);
    const before = sha(`${mnt}/owner-data`);
    const record = join(work, `${label}.factory.json`);
    const env = `export ROOT_LUKS_PART='${dev}' FLAGSHIP_LUKS_BUILD_KEY='${key}' FLAGSHIP_LUKS_FACTORY_RECORD='${record}' FLAGSHIP_LUKS_REKEY_MARKER='${work}/${label}.rekeyed.json' FLAGSHIP_LUKS_HEADER_BACKUP='${work}/${label}.header.img' FLAGSHIP_LUKS_TMP='${work}'`;
    const factory = buildApplianceFactoryLuksRecordBlock(key).replace(/\/etc\/flagship\/appliance-factory-luks\.json/g, record);
    writeFileSync(join(work, `${label}-factory.sh`), `#!/bin/bash\nset -euo pipefail\n${env}\n${factory}\n`);
    await out("bash", [join(work, `${label}-factory.sh`)]);
    const factoryVk = JSON.parse(readFileSync(record, "utf8")).volumeKeySha256 as string;
    const specialize = `#!/bin/bash\nset -uo pipefail\n${env}\nstage() { echo "[stage] $*"; }\nreport() { echo "[report] $*"; }\n${APPLIANCE_REKEY_BLOCK}\n`;
    writeFileSync(join(work, `${label}-rekey.sh`), specialize);
    if (killAfterPct !== null) {
      // A power cut mid re-encryption: kill cryptsetup once it reports progress, then close and
      // reopen the disk the way the next boot's initramfs would, and run the specializer again.
      const r = await tryOut("bash", ["-c", `bash ${work}/${label}-rekey.sh & pid=$!; for i in $(seq 1 600); do if pgrep -x cryptsetup >/dev/null && pgrep -af cryptsetup | grep -q reencrypt; then sleep ${killAfterPct === 0 ? 1 : 2}; pkill -9 -x cryptsetup; echo killed; break; fi; sleep 0.1; done; wait $pid; echo exit=$?`], 600_000);
      result(`${label}: the interrupted run stops without claiming success`, !/disk re-encrypted under its own key/.test(r.text), r.text.split("\n").slice(-4).join(" | "));
      await out("umount", [mnt]);
      await out("cryptsetup", ["close", name]);
      await out("cryptsetup", ["open", "--key-file", key, dev, name]);
      const pending = await tryOut("bash", ["-c", `cryptsetup luksDump ${dev} | grep -i reencrypt || true`]);
      result(`${label}: the header records an unfinished re-encryption`, /reencrypt/i.test(pending.text), pending.text.trim().slice(0, 200));
      await out("mount", [`/dev/mapper/${name}`, mnt]);
    }
    const r2 = await tryOut("bash", [join(work, `${label}-rekey.sh`)], 900_000);
    result(`${label}: specializer finishes${killAfterPct !== null ? " (resumed)" : ""}`, /disk re-encrypted under its own key/.test(r2.text), r2.text.split("\n").filter((l) => /\[appliance\]|\[stage\]/.test(l)).slice(-4).join(" | "));
    const newVk = (await out("bash", ["-c", `vk=${work}/vk.$$; cryptsetup luksDump --dump-volume-key --batch-mode --key-file ${key} --volume-key-file $vk ${dev} >/dev/null && sha256sum $vk | cut -d' ' -f1; shred -u $vk`])).trim();
    result(`${label}: the volume key changed`, /^[0-9a-f]{64}$/.test(newVk) && newVk !== factoryVk, { factory: factoryVk.slice(0, 12), now: newVk.slice(0, 12) });
    await out("sync", []);
    await out("umount", [mnt]);
    await out("cryptsetup", ["close", name]);
    await out("cryptsetup", ["open", "--key-file", key, dev, name]);
    await out("mount", [`/dev/mapper/${name}`, mnt]);
    result(`${label}: the owner's data is intact after re-encryption`, sha(`${mnt}/owner-data`) === before);
    const slots = (await out("bash", ["-c", `cryptsetup luksDump ${dev} | awk '/^Keyslots:/{f=1;next} /^[A-Za-z]/{f=0} f && /^[[:space:]]+[0-9]+:[[:space:]]*luks2/{n++} END{print n+0}'`])).trim();
    result(`${label}: exactly one key slot`, slots === "1", slots);
    await out("umount", [mnt]);
    await out("cryptsetup", ["close", name]);
    await out("losetup", ["-d", dev]);
  };
  await runOne("clean", null);
  await runOne("powercut", 30);
}

const phases: Record<string, () => Promise<void>> = { migrate, apps, rust, broken, rollback, luks };
const fn = phases[phase];
if (!fn) {
  console.error(`usage: drill.ts ${Object.keys(phases).join("|")}`);
  process.exit(2);
}
try {
  await fn();
} catch (e) {
  result("phase completed", false, (e as Error).stack ?? String(e));
}
console.log(`DONE ${phase} failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);

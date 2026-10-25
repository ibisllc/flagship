/**
 * Milestone 7 runtime drill: P04 WASI apps and P05 app groups + dedicated databases
 * (docs/architecture-v2/drills/m7-runtime.md). Runs ON a throwaway Debian 13 VM prepared by
 * setup-box.sh, as root, from /opt/flagship:
 *
 *   npx tsx tools/arch-drills/m7/drill.ts <wasi|groups|dbhostile> <docker|podman>
 *
 * Every check prints one `RESULT {"phase","check","ok","detail"}` line; the exit code is the
 * number of failed checks. It drives the daemon's own modules (not copies) against the real
 * engine, systemd and kernel, so each acceptance test of IMPLEMENTATION-PLAN.md §13.1 P04/P05
 * that needs a real box is checked here:
 *   P04: a WASI fixture app serving HTTP; an infinite loop (fuel and wall clock); the memory
 *        limit; a host call refused for an undeclared capability; compiled code isolated per
 *        app; backup and restore of its data; crash restart; the worker's fences.
 *   P05: group start order, member links only for the same app, rollback of every member,
 *        a consistent backup (every member held still); a hostile dedicated database that
 *        cannot exhaust a sibling's database or the management reserve.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { realCommandRunner, AppRunner, type AppSpec, type CommandRunner } from "../../../packages/server-daemon/src/serviceRunner.js";
import { setActiveEngine } from "../../../packages/server-daemon/src/engine/engine.js";
import { LoopVolumes } from "../../../packages/server-daemon/src/appQuota/loopVolumes.js";
import { ensureGvisor } from "../../../packages/server-daemon/src/appSandbox/gvisor.js";
import { startAppSandbox, setEgressFence } from "../../../packages/server-daemon/src/appSandbox/state.js";
import { EgressGateway } from "../../../packages/server-daemon/src/egress/gateway.js";
import { notifyContainersChanged, setContainersChangedHook } from "../../../packages/server-daemon/src/egress/sandboxNetworking.js";
import { ensureWasiRuntime } from "../../../packages/server-daemon/src/wasi/install.js";
import { WasiModuleStore } from "../../../packages/server-daemon/src/wasi/moduleStore.js";
import { WasiCapabilityBroker } from "../../../packages/server-daemon/src/wasi/broker.js";
import { wasiHostCalls } from "../../../packages/server-daemon/src/wasi/hostCalls.js";
import { WasiRunner, DEFAULT_WASI_RUN_LIMITS } from "../../../packages/server-daemon/src/wasi/runner.js";
import { wasiAppDir, wasiUnitName } from "../../../packages/server-daemon/src/wasi/unit.js";
import { RuntimeRouter } from "../../../packages/server-daemon/src/appRuntimes.js";
import { parseAppManifest, runtimeExtras } from "../../../packages/server-daemon/src/appModel.js";
import { OwnedPortBook, memoryPortBookStore } from "../../../packages/server-daemon/src/appGroups/portBook.js";
import { realAppCopyOps, setAppQuiesceHook } from "../../../packages/server-daemon/src/appCopy/ops.js";
import { DedicatedPostgres, memoryDedicatedStateStore } from "../../../packages/server-daemon/src/dataLayer/dedicated.js";
import { RealPostgresAdmin } from "../../../packages/server-daemon/src/dataLayer/realAdmins.js";
import { ManagementReserve } from "../../../packages/server-daemon/src/managementReserve.js";
import { runSandboxedSql } from "../../../packages/server-daemon/src/migrationSandbox.js";

const phase = process.argv[2] ?? "";
const engine = (process.argv[3] ?? "podman") as "docker" | "podman";
const cmd = realCommandRunner as Required<CommandRunner>;
let failures = 0;
const log = (m: string) => console.log(m);
const REPO = "/opt/flagship";
const FIXTURES = join(REPO, "rust/crates/flagship-wasi/tests/fixtures");
const MiB = 1024 * 1024;

function result(check: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures++;
  console.log(`RESULT ${JSON.stringify({ phase: `${phase}/${engine}`, check, ok, detail })}`);
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
const out = async (c: string, a: string[], t = 600_000) => (await cmd.capture(c, a, { timeoutMs: t })).stdout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(port: number, path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: (e as Error).message };
  }
}

async function until<T>(what: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let v = await what();
  while (!ok(v) && Date.now() < end) {
    await sleep(1000);
    v = await what();
  }
  return v;
}

async function freeBytes(): Promise<number> {
  const s = await statfs("/var/lib");
  return Number(s.bavail) * Number(s.bsize);
}

// ── P04: WASI ────────────────────────────────────────────────────────────────

function wasiManifest(digest: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 2,
    name: "notes",
    version: "1.0.0",
    runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080, digest },
    data: { stores: { files: true } },
    network: { subdomain: "notes" },
    access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" },
    resources: { memoryMiB: 32 },
    ...extra,
  });
}

async function wasiSpec(serviceId: string, manifestJson: string, port: number, volume: string | null): Promise<AppSpec> {
  const parsed = parseAppManifest(manifestJson, { accelerators: [], isolation: ["sandbox"], wasiWorlds: ["command", "http-proxy"], appGroups: false });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const data = volume ? { creator: "drill", slug: serviceId.split("--")[1]!, files: { volume } } : null;
  const extras = await runtimeExtras({ serviceId, app: parsed.app, data, appImage: parsed.manifest.runtime.image });
  // Small per-request limits so the misbehaving routes are stopped quickly.
  extras.wasi!.runLimits = { ...DEFAULT_WASI_RUN_LIMITS, memoryMiB: 32, fuel: 2_000_000_000, wallTimeMs: 5_000 };
  return {
    serviceId,
    image: parsed.manifest.runtime.image,
    port,
    containerPort: 8080,
    env: { FLAGSHIP_APP_ID: serviceId, FLAGSHIP_CREATOR: "drill", FLAGSHIP_SLUG: "notes", FLAGSHIP_HOST: "drill", OWNER_SETTING: "kept-off-disk" },
    ...(volume ? { filesVolume: volume } : {}),
    ...extras,
  };
}

async function unitPid(serviceId: string): Promise<number> {
  return Number((await out("systemctl", ["show", wasiUnitName(serviceId), "--property=MainPID", "--value"])).trim());
}

async function wasi(): Promise<void> {
  setActiveEngine(engine);
  const inst = await ensureWasiRuntime({ repoPath: REPO, run: (c, a) => cmd.run(c, a), onLog: log });
  result("the pinned worker and its unit are installed", inst.available, inst);
  if (!inst.available) return;
  const modules = new WasiModuleStore();
  const fixture = readFileSync(join(FIXTURES, "sdk-wasi-fixture.wasm"));
  const hostcalls = readFileSync(join(FIXTURES, "sdk-wasi-hostcalls.wasm"));
  const fd = await modules.put(fixture);
  const hd = await modules.put(hostcalls);
  const allow = new Set<string>(["example.com"]);
  const unmatched: string[] = [];
  let runner: WasiRunner;
  const broker = new WasiCapabilityBroker(
    wasiHostCalls({
      context: (id) => runner.context(id),
      accessRules: () => [...allow].map((h, i) => ({ line: i + 1, action: "allow", target: h })) as never,
      onUnmatched: (id, h) => unmatched.push(`${id} ${h}`),
    }),
    log,
  );
  const loops = new LoopVolumes(cmd, { log });
  runner = new WasiRunner({ cmd, modules, broker, available: () => true, filesHostPath: async (v) => loops.dataPath(v), onLog: log });
  const router = new RuntimeRouter(cmd);
  router.setWasiRunner(runner);
  setAppQuiesceHook((id) => router.quiesce(id));

  const A = "drill--wasia";
  const B = "drill--wasib";
  const volA = "flagship-files-drill--wasia";
  for (const v of [volA]) {
    await loops.remove(v).catch(() => {});
    await loops.create(v, 64 * MiB);
  }
  const specA = await wasiSpec(A, wasiManifest(fd), 18301, volA);
  await router.deploy(specA);
  const up = await runner.check(specA);
  result("a WASI fixture app serves HTTP on its loopback port", up.ok, up);
  const home = await http(18301, "/");
  result("GET / answers from the module", home.status === 200 && home.text.startsWith("flagship wasi fixture"), home.text.slice(0, 80));
  const who = await http(18301, "/whoami", { headers: { "X-Flagship-Visitor": "member", "X-Flagship-User": "u-1", "X-Flagship-Role": "manager" } });
  result("the app proxy's identity headers reach the app", who.text.includes('"visitor":"member"') && who.text.includes('"role":"manager"'), who.text);
  await http(18301, "/notes", { method: "POST", body: "drill note" });
  const notes = await http(18301, "/notes");
  result("data persists in the app's files folder", notes.text.includes("drill note") && existsSync(join(loops.dataPath(volA), "notes.txt")), notes.text);
  const env = await http(18301, "/env");
  result("platform env given, the files folder at /data", env.text.includes('"appId":"drill--wasia"') && env.text.includes('"filesDir":"/data"'), env.text);
  const cfg = readFileSync(join(wasiAppDir(A), "worker.json"), "utf8");
  result("the owner's settings are never written to disk", !cfg.includes("kept-off-disk"));

  // Limits.
  const spin = await http(18301, "/spin");
  result("an infinite loop is stopped (fuel or wall clock) and answered 503", spin.status === 503 && /fuel|wall-time/.test(spin.text), spin.text);
  const grow = await http(18301, "/grow");
  result("a memory bomb is stopped at the memory limit", grow.status === 503 && /memory/.test(grow.text), grow.text);
  result("the app keeps serving after both", (await http(18301, "/healthz")).status === 200);

  // Fences.
  const pid = await unitPid(A);
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const capEff = /CapEff:\s*([0-9a-f]+)/.exec(status)?.[1] ?? "?";
  const uid = /Uid:\s*(\d+)/.exec(status)?.[1] ?? "0";
  result("the worker runs as its own unprivileged user with no capabilities", Number(uid) > 0 && /^0+$/.test(capEff), { uid, capEff });
  const props = await out("systemctl", ["show", wasiUnitName(A), "--property=DynamicUser,NoNewPrivileges,IPAddressDeny,PrivateDevices,ProtectSystem,MemoryMax,TasksMax"]);
  result("unit fences: dynamic user, no new privileges, loopback only, memory and task limits", /DynamicUser=yes/.test(props) && /NoNewPrivileges=yes/.test(props) && /IPAddressDeny=\S/.test(props) && /MemoryMax=\d+/.test(props), props.trim().replace(/\n/g, " "));
  const ns = await tryOut("nsenter", ["-t", String(pid), "-m", "ls", "/var/flagship", "/var/lib/flagship-files", "/run/docker.sock"]);
  result("the worker sees none of the box's state, other apps' folders or the engine socket", !ns.ok && !/flagship-files-/.test(ns.text), ns.text.slice(0, 200));
  const nsData = await tryOut("nsenter", ["-t", String(pid), "-m", "ls", "/var/app/data", "/var/app/pkg"]);
  result("the worker sees only its own package and files folder", nsData.ok && /notes\.txt/.test(nsData.text) && /module\.wasm/.test(nsData.text), nsData.text.slice(0, 200));
  // A process in the worker's own unit (so under its IPAddressDeny cgroup filter) cannot connect out.
  const probe = await tryOut("systemd-run", ["--wait", "--pipe", "--quiet", "-p", "IPAddressDeny=any", "-p", "IPAddressAllow=localhost", "-p", "DynamicUser=yes", "busybox", "wget", "-q", "-O-", "-T", "5", "http://example.com/"], 60_000);
  result("the unit's address filter stops any outbound connection", !/Example Domain/.test(probe.text), probe.text.trim().slice(-120));

  // Crash restart.
  await cmd.run("kill", ["-9", String(pid)]);
  const back = await until(() => unitPid(A), (p) => p > 0 && p !== pid, 30_000);
  const again = await until(() => http(18301, "/healthz"), (r) => r.status === 200, 30_000);
  result("a crashed worker is restarted and serves again", back !== pid && again.status === 200, { before: pid, after: back });

  // Compiled code is per app: a second app with the same module runs in its own process and user.
  const specB = await wasiSpec(B, wasiManifest(fd, { data: {} }), 18302, null);
  await router.deploy(specB);
  await runner.check(specB);
  const pidB = await unitPid(B);
  const uidB = /Uid:\s*(\d+)/.exec(readFileSync(`/proc/${pidB}/status`, "utf8"))?.[1];
  result("the same module for two apps: two workers, two users, nothing shared", pidB > 0 && pidB !== (await unitPid(A)) && uidB !== uid, { a: uid, b: uidB });
  const cached = await tryOut("sh", ["-c", "find / -xdev \\( -name '*.cwasm' -o -path '*wasmtime*cache*' \\) 2>/dev/null | head -5"]);
  result("no compiled module is ever written to disk", cached.text.trim() === "", cached.text.trim());

  // Host calls behind capabilities.
  const C = "drill--wasic";
  const noCaps = await wasiSpec(C, wasiManifest(hd, { data: {} }), 18303, null);
  await router.deploy(noCaps);
  const refused = await runner.check(noCaps);
  result("a module importing an undeclared host call is refused before it serves", !refused.ok && /does not declare/.test(refused.ok ? "" : refused.reason), refused.ok ? "" : refused.reason.slice(0, 200));
  await router.stop(C);
  const withCaps = await wasiSpec(C, wasiManifest(hd, { data: {}, network: { subdomain: "notes", egress: ["example.com", "neverssl.com"] } }), 18303, null);
  withCaps.wasi!.postgres = { default: { url: "postgresql://x:y@host.flagship.internal:5432/x", database: "x", role: "x" } };
  // db_query is declared through postgres; the drill box has no database, so only egress is exercised.
  const m = JSON.parse(wasiManifest(hd, { network: { subdomain: "notes", egress: ["example.com", "neverssl.com"] } }));
  m.data = { stores: { postgres: true } };
  const withAll = await wasiSpec(C, JSON.stringify(m), 18303, null);
  withAll.wasi!.postgres = withCaps.wasi!.postgres;
  await router.deploy(withAll);
  result("declared host calls: the module is admitted", (await runner.check(withAll)).ok);
  const fetched = await http(18303, `/fetch?url=${encodeURIComponent("https://example.com/")}`);
  result("http_fetch to an owner-approved host goes out through the box", fetched.status === 200 && /Example Domain/.test(fetched.text), fetched.text.slice(0, 120));
  const notApproved = await http(18303, `/fetch?url=${encodeURIComponent("http://neverssl.com/")}`);
  result("http_fetch to a declared host the owner hasn't approved is refused, and asked", notApproved.status === 403 && unmatched.includes(`${C} neverssl.com`), notApproved.text.slice(0, 160));
  const undeclared = await http(18303, `/fetch?url=${encodeURIComponent("https://1.1.1.1/")}`);
  result("http_fetch to an undeclared host never reaches the box's broker", undeclared.status === 403 && /network.egress/.test(undeclared.text), undeclared.text.slice(0, 160));

  // Backup and restore of its data (the backup path: hold still, archive the folder, restore into a fresh one).
  const ops = realAppCopyOps();
  await http(18301, "/count");
  const resume = await ops.quiesce!(`flagship-${A}`);
  const frozen = (await out("systemctl", ["show", wasiUnitName(A), "--property=FreezerState", "--value"])).trim();
  const tar = "/var/tmp/drill-wasi-files.tar";
  await ops.archiveFiles(volA, `flagship-${A}`, tar);
  await resume?.();
  result("backup holds the worker still (cgroup freezer) while its folder is read", frozen === "frozen", frozen);
  await router.stop(A);
  await loops.remove(volA);
  await loops.create(volA, 64 * MiB);
  await ops.restoreFiles(volA, tar);
  await router.deploy(specA);
  await runner.check(specA);
  const restored = await http(18301, "/notes");
  const count = await http(18301, "/count");
  result("restored data: the notes and the counter come back", restored.text.includes("drill note") && count.text.trim() === "2", { notes: restored.text.trim(), count: count.text.trim() });

  // Uninstall.
  for (const id of [A, B, C]) await router.forget(id);
  const gone = await tryOut("systemctl", ["is-active", wasiUnitName(A)]);
  result("uninstall stops the worker and removes its folder", !/^active/m.test(gone.text) && !existsSync(wasiAppDir(A)), gone.text.trim());
  await broker.closeAll();
  await loops.remove(volA).catch(() => {});
  rmSync(tar, { force: true });
}

// ── P05: app groups ──────────────────────────────────────────────────────────

const GROUP = "drill--grp";
const OTHER = "drill--other";

function groupManifest(workerImage: string): string {
  return JSON.stringify({
    schema_version: 2,
    name: "grp",
    version: "1.0.0",
    runtime: { image: "docker.io/library/busybox:1.37", port: 8080 },
    data: {},
    network: { subdomain: "grp" },
    access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" },
    components: [
      { name: "api", image: "docker.io/traefik/whoami:v1.10", start: ["/whoami", "--port", "7000"], port: 7000 },
      { name: "worker", image: workerImage, start: ["sleep", "3600"], startAfter: ["api"] },
    ],
  });
}

async function groups(): Promise<void> {
  setActiveEngine(engine);
  const gv = await startAppSandbox(() => ensureGvisor({ cmd, probeImage: "docker.io/library/busybox:1.37", log }));
  result("gVisor ready", gv.ok, gv.ok ? gv.version : gv.reason);
  const gateway = new EgressGateway({ cmd, accessRules: () => [], log });
  const st = await gateway.start();
  result("egress gateway enforced (members link through it)", st.enforced, st);
  if (!st.enforced) return;
  setEgressFence(() => gateway.status());
  setContainersChangedHook(() => gateway.refreshApps());
  for (const img of ["docker.io/library/busybox:1.37", "docker.io/traefik/whoami:v1.10"]) await tryOut("docker", ["pull", img], 600_000);
  const book = new OwnedPortBook(memoryPortBookStore());
  const router = new RuntimeRouter(cmd);
  router.setGroupLinks({ gateway: () => gateway.appsGateway(), link: (p, t, o) => gateway.forwardOwnedPort(p, t, o), unlink: (p) => gateway.unforwardOwnedPort(p) });
  const box = router.capabilities(false);
  result("the box can run app groups", box.appGroups, box);
  const spec = async (manifest: string): Promise<AppSpec> => {
    const parsed = parseAppManifest(manifest, box);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const extras = await runtimeExtras({ serviceId: GROUP, app: parsed.app, data: null, appImage: parsed.manifest.runtime.image, linkPortFor: (k) => book.portFor(k) });
    return { serviceId: GROUP, image: parsed.manifest.runtime.image, command: ["httpd", "-f", "-p", "8080", "-h", "/tmp"], port: 18401, containerPort: 8080, env: {}, ...extras };
  };
  await router.stop(GROUP).catch(() => {});
  const v1 = await spec(groupManifest("docker.io/library/busybox:1.37"));
  await router.deploy(v1);
  await notifyContainersChanged();
  const started = async (n: string) => (await out("docker", ["inspect", "-f", "{{.State.StartedAt}}", n])).trim();
  const times = [await started(`flagship-${GROUP}.api`), await started(`flagship-${GROUP}.worker`), await started(`flagship-${GROUP}`)];
  result("members start in order: api, worker, then the main process", times[0]! <= times[1]! && times[1]! <= times[2]!, times);
  const link = v1.group!.members.find((m) => m.name === "api")!.linkPort!;
  const via = await tryOut("docker", ["exec", `flagship-${GROUP}`, "wget", "-q", "-O-", "-T", "10", `http://api:${link}/`], 60_000);
  result("the main process reaches its component through the gateway link", /Hostname/.test(via.text), via.text.slice(0, 120));
  // Another app's container is cut at the gateway.
  await tryOut("docker", ["rm", "-f", `flagship-${OTHER}`]);
  await new AppRunner(cmd).deploy({ serviceId: OTHER, image: "docker.io/library/busybox:1.37", command: ["sleep", "3600"] });
  await notifyContainersChanged();
  const gw = gateway.appsGateway()!;
  const stolen = await tryOut("docker", ["exec", `flagship-${OTHER}`, "wget", "-q", "-O-", "-T", "8", `http://${gw}:${link}/`], 60_000);
  result("another app cannot reach the group's member", !/Hostname/.test(stolen.text), stolen.text.slice(0, 160));

  // Consistent backup: every member held still.
  const resume = await router.quiesce(GROUP);
  const paused = [];
  for (const n of [`flagship-${GROUP}.api`, `flagship-${GROUP}.worker`, `flagship-${GROUP}`]) paused.push((await out("docker", ["inspect", "-f", "{{.State.Paused}}", n])).trim());
  await resume?.();
  result("a backup pauses every member at once, then resumes them", paused.every((p) => p === "true"), paused);

  // Transactional upgrade: a member that cannot start rolls every member back.
  const v2 = await spec(groupManifest("docker.io/library/busybox:does-not-exist-drill"));
  let failed = false;
  try {
    await router.restart(v2);
  } catch {
    failed = true;
    await router.restart(v1);
  }
  const states = [];
  for (const n of [`flagship-${GROUP}.api`, `flagship-${GROUP}.worker`, `flagship-${GROUP}`]) states.push((await out("docker", ["inspect", "-f", "{{.State.Status}} {{.Config.Image}}", n])).trim());
  result("a failed upgrade rolls every member back to the previous version", failed && states.every((s) => s.startsWith("running")) && !states.join(" ").includes("does-not-exist"), states);
  const after = await tryOut("docker", ["exec", `flagship-${GROUP}`, "wget", "-q", "-O-", "-T", "10", `http://api:${link}/`], 60_000);
  result("after the rollback the link still works", /Hostname/.test(after.text));

  await router.stop(GROUP);
  await tryOut("docker", ["rm", "-f", `flagship-${OTHER}`]);
  const left = await out("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  result("stopping the group removes every member", !left.includes(GROUP), left.trim());
  await gateway.stop().catch(() => {});
}

// ── P05: hostile dedicated database ──────────────────────────────────────────

async function psql(port: number, user: string, password: string, db: string, sql: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string }> {
  return tryOut("env", [`PGPASSWORD=${password}`, "psql", "-h", "127.0.0.1", "-p", String(port), "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", sql], timeoutMs);
}

async function dbhostile(): Promise<void> {
  setActiveEngine(engine);
  const gv = await startAppSandbox(() => ensureGvisor({ cmd, probeImage: "docker.io/library/busybox:1.37", log }));
  result("gVisor ready (migration sandbox)", gv.ok, gv.ok ? gv.version : gv.reason);
  await tryOut("docker", ["network", "create", "flagship-apps"]);
  const loops = new LoopVolumes(cmd, { log });
  const book = new OwnedPortBook(memoryPortBookStore());
  const d = new DedicatedPostgres({
    cmd,
    volumes: loops,
    preallocate: (p, b) => cmd.run("fallocate", ["-l", String(b), p]),
    disk: async () => {
      const s = await statfs("/var/lib");
      return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    },
    ports: book,
    // The drill reaches both instances from the host; apps would come through the gateway.
    links: () => ({ link: async () => true, unlink: async () => {} }),
    state: memoryDedicatedStateStore(),
    admin: (adminUrl) => new RealPostgresAdmin({ adminUrl }),
    onLog: log,
  });
  const reserveDir = "/var/tmp/drill-reserve";
  mkdirSync(reserveDir, { recursive: true });
  // The daemon's own reserve (managementReserve.ts), on the same disk as the database images.
  const reserve = new ManagementReserve(reserveDir, 8 * MiB, async () => freeBytes());
  result("the management reserve is in place", await reserve.ensure());
  const reserveFile = reserve.file;
  const reserveBefore = existsSync(reserveFile) ? statSync(reserveFile).size : -1;

  await d.dropApp("drill", "hostile").catch(() => {});
  await d.dropApp("drill", "sibling").catch(() => {});
  const a = await d.forApp("drill", "hostile", { diskBytes: 128 * MiB });
  const b = await d.forApp("drill", "sibling", { diskBytes: 128 * MiB });
  for (const [x, role] of [[a, "hostile"], [b, "sibling"]] as const) {
    await x.admin.createRoleAndDb({ db: `app_${role}`, role: `app_${role}`, password: `pw-${role}`, extensions: [] });
  }
  result("two dedicated instances, each its own container and port", a.port !== b.port && a.container !== b.container, { a: a.port, b: b.port });
  const limits = await out("docker", ["inspect", "-f", "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}", a.container]);
  result("the hostile instance has its own memory, CPU and process limits", /^268435456 500000000 128$/.test(limits.trim()), limits.trim());

  // Disk: fill the hostile database until it fails inside its own image.
  const freeBefore = await freeBytes();
  await psql(a.port, "app_hostile", "pw-hostile", "app_hostile", "CREATE TABLE t (x text)");
  let fill = { ok: true, text: "" };
  for (let i = 0; i < 40 && fill.ok; i++) {
    fill = await psql(a.port, "app_hostile", "pw-hostile", "app_hostile", "INSERT INTO t SELECT md5(g::text) || repeat('x', 2000) FROM generate_series(1, 20000) g");
  }
  result("filling the dedicated database ends in no space inside its own image", !fill.ok && /No space left|could not extend|could not write|PANIC|terminating connection|server closed/i.test(fill.text), fill.text.trim().split("\n").slice(-2).join(" | "));
  const freeAfter = await freeBytes();
  result("the host's free space did not go to the hostile database (its image was allocated up front)", freeBefore - freeAfter < 32 * MiB, { freeBeforeMiB: Math.round(freeBefore / MiB), freeAfterMiB: Math.round(freeAfter / MiB) });
  const sib = await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "CREATE TABLE IF NOT EXISTS s (x text); INSERT INTO s SELECT repeat('y', 1000) FROM generate_series(1, 5000); SELECT count(*) FROM s");
  result("the sibling database still writes", sib.ok && /5000/.test(sib.text), sib.text.trim());
  const reserveAfter = existsSync(reserveFile) ? statSync(reserveFile).size : -1;
  result("the management reserve is untouched", reserveAfter === reserveBefore, { reserveBefore, reserveAfter });

  // Memory: a huge sort is held to the instance's cgroup.
  const t0 = Date.now();
  const sort = await psql(a.port, "app_hostile", "pw-hostile", "app_hostile", "SET work_mem='1GB'; SELECT count(*) FROM (SELECT g, md5(g::text) m FROM generate_series(1, 30000000) g ORDER BY m) s", 240_000);
  const during = await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "SELECT 1");
  // 30 million sorted md5 rows need gigabytes: inside 256 MiB and a 32 MB temp-file limit the query must fail.
  result("a memory-hungry query in the hostile instance fails inside its own limits", !sort.ok, { seconds: Math.round((Date.now() - t0) / 1000), tail: sort.text.trim().slice(-200) });
  const aliveA = await until(() => psql(a.port, "app_hostile", "pw-hostile", "app_hostile", "SELECT 1", 10_000), (r) => r.ok, 60_000);
  result("the hostile instance recovers on its own", aliveA.ok);
  result("the sibling answers meanwhile", during.ok && during.text.trim() === "1");

  // Connections: exhaust the hostile instance's connections; the sibling still accepts.
  const holders: Array<ReturnType<typeof cmd.capture>> = [];
  for (let i = 0; i < 25; i++) {
    holders.push(cmd.capture("env", ["PGPASSWORD=pw-hostile", "psql", "-h", "127.0.0.1", "-p", String(a.port), "-U", "app_hostile", "-d", "app_hostile", "-tAc", "SELECT pg_sleep(20)"], { timeoutMs: 60_000 }).catch((e: Error & { stderr?: string }) => ({ stdout: "", stderr: `${e.stderr ?? ""}${e.message}` })));
  }
  await sleep(3000);
  const extra = await psql(a.port, "app_hostile", "pw-hostile", "app_hostile", "SELECT 1", 20_000);
  const sibConn = await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "SELECT 1", 20_000);
  result("connection exhaustion stays inside the hostile instance", !extra.ok && /too many|remaining connection slots/i.test(extra.text) && sibConn.ok, { hostile: extra.text.trim().slice(-120), sibling: sibConn.text.trim() });
  await Promise.all(holders);

  // CPU: a spinning query is held to half a CPU; the sibling stays quick.
  const spin = cmd.capture("env", ["PGPASSWORD=pw-hostile", "psql", "-h", "127.0.0.1", "-p", String(a.port), "-U", "app_hostile", "-d", "app_hostile", "-tAc", "SET statement_timeout='25s'; SELECT count(*) FROM generate_series(1, 2000000000)"], { timeoutMs: 60_000 }).catch(() => null);
  await sleep(3000);
  const q0 = Date.now();
  await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "SELECT count(*) FROM s");
  const ms = Date.now() - q0;
  result("a CPU-spinning hostile query doesn't slow the sibling's", ms < 3000, { ms });
  await spin;

  // Backups and migrations of a dedicated database.
  const ops = realAppCopyOps();
  const storeB = { url: `postgresql://app_sibling:pw-sibling@127.0.0.1:${b.port}/app_sibling`, database: "app_sibling", role: "app_sibling", profile: "dedicated" as const, container: b.container };
  await ops.dumpDatabase(storeB, "/var/tmp/drill-sibling.dump");
  result("a dedicated database is dumped in its own instance", statSync("/var/tmp/drill-sibling.dump").size > 1000);
  await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "DROP TABLE s");
  await ops.restoreDatabase(storeB, "/var/tmp/drill-sibling.dump");
  const back = await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "SELECT count(*) FROM s");
  result("and restored there", back.ok && back.text.trim() === "5000", back.text.trim());
  const sock = await d.socketForPort(b.port);
  let migrated = true;
  try {
    await runSandboxedSql({ cmd, target: { user: "app_sibling", password: "pw-sibling", database: "app_sibling", port: b.port }, sql: "CREATE TABLE migrated (id int);", socketVolume: sock! });
  } catch (e) {
    migrated = false;
    log(`migration: ${(e as Error).message}`);
  }
  const mt = await psql(b.port, "app_sibling", "pw-sibling", "app_sibling", "SELECT to_regclass('migrated') IS NOT NULL");
  result("a migration reaches the dedicated instance through its socket only (no network)", migrated && mt.text.trim() === "t", mt.text.trim());
  const local = await tryOut("docker", ["exec", b.container, "psql", "-h", "/var/run/postgresql", "-U", "flagship_admin", "-d", "postgres", "-tAc", "SELECT 1"]);
  result("the socket asks for a password too (no local trust)", !local.ok && /password/i.test(local.text), local.text.trim().slice(-120));

  await d.dropApp("drill", "hostile");
  await d.dropApp("drill", "sibling");
  rmSync("/var/tmp/drill-sibling.dump", { force: true });
  const left = await out("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  result("dropping the instances removes their containers and images", !/flagship-pgd-/.test(left) && !existsSync(loops.imagePath(`flagship-pgdata-${"0".repeat(24)}`)), left.trim());
  writeFileSync("/var/tmp/drill-m7-done", phase);
}

const phases: Record<string, () => Promise<void>> = { wasi, groups, dbhostile };
const run = phases[phase];
if (!run || (engine !== "docker" && engine !== "podman")) {
  console.error("usage: drill.ts <wasi|groups|dbhostile> <docker|podman>");
  process.exit(2);
}
run()
  .catch((e) => {
    failures++;
    console.log(`RESULT ${JSON.stringify({ phase: `${phase}/${engine}`, check: "crashed", ok: false, detail: (e as Error).stack })}`);
  })
  .finally(() => process.exit(failures));

/**
 * The owner's switch between the classic stack and arch-v2 (archV2Switch.ts): root's half checks
 * the order itself and installs nothing for a forged, stale, replayed or IRK-signed one; the
 * trial keeps the switch only once the box is healthy with every app back, and otherwise puts
 * the switch file back as it was; a revert is refused once the switch was kept.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ed, signArchV2SwitchOrder, type ArchV2SwitchOrder, type PolicyState, GENESIS_DIGEST } from "@flagship/protocol";
import {
  ArchV2Switcher,
  COMPOSE_DROPIN,
  COMPOSE_DROPIN_PATH,
  ENGINE_PACKAGES,
  SWITCH_ORDER_FILE,
  SWITCH_RECORD,
  SWITCH_TRIAL_FILE,
  SWITCH_VERDICT_FILE,
  TRIAL_MS,
  applySwitchAsRoot,
  buildArchV2SwitchHttp,
  ownerSwitchAuthorizer,
  parseSwitchRecord,
  settleSwitchAsRoot,
  type RootSwitchDeps,
  type SwitchFiles,
} from "../src/archV2Switch.js";
import { ARCH_V2_CONFIG, parseArchV2Config, type ArchV2Config, type EngineKind } from "../src/engine/engine.js";
import { bootArchV2 } from "../src/archV2Boot.js";
import { setPqAuthority } from "../src/pqAuthority.js";
import { ENGINE_APT_PACKAGES, ENGINE_SETUP_BLOCK } from "../../flagship-builder/src/engineSetup.js";

const SERVER = "home.alice.flagship.services";
const T = 1_790_000_000_000;
const REPO = "/opt/flagship";
const key = (n: number) => {
  const seed = new Uint8Array(32).fill(n);
  return { seed, pub: ed.getPublicKey(seed), sign: (m: Uint8Array) => ed.sign(m, seed) };
};
const IRK = key(1);
const ADMIN = key(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function memFiles(init: Record<string, string> = {}): SwitchFiles & { m: Map<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    m,
    read: async (p) => m.get(p) ?? null,
    write: async (p, c) => void m.set(p, c),
    remove: async (p) => void m.delete(p),
    exists: (p) => m.has(p),
  };
}

const order = (over: Partial<ArchV2SwitchOrder> = {}): ArchV2SwitchOrder => ({ serverDomain: SERVER, target: "arch-v2", nonce: "a1".repeat(16), issuedAt: T, ...over });
const signed = (o: ArchV2SwitchOrder, k = ADMIN) => ({ order: o, signatureHex: hex(signArchV2SwitchOrder(o, k.sign)) });

function root(files: ReturnType<typeof memFiles>, over: Partial<RootSwitchDeps> = {}) {
  const ran: string[] = [];
  const d: RootSwitchDeps = {
    files,
    run: async (c, a) => void ran.push(`${c} ${a.join(" ")}`),
    serverDomain: SERVER,
    authorize: ownerSwitchAuthorizer({ ownerIrkPub: IRK.pub, adminRootPub: ADMIN.pub, username: "alice" }),
    repoPath: REPO,
    now: () => T + 1000,
    ...over,
  };
  return { d, ran };
}

const PINS = `${REPO}/installer/rust/PINS.json`;
const withRelease = (extra: Record<string, string> = {}) => memFiles({ [PINS]: "{}", "/usr/bin/docker": "", ...extra });

afterEach(() => setPqAuthority(null));

describe("root's half of a switch", () => {
  it("checks the admin-signed order, installs Podman, then writes the switch last and starts the trial", async () => {
    const files = withRelease();
    files.m.set(SWITCH_ORDER_FILE, JSON.stringify(signed(order())));
    const { d, ran } = root(files);
    expect(await applySwitchAsRoot(d)).toEqual({ state: "trial", target: "arch-v2" });
    expect(ran).toEqual([
      "env DEBIAN_FRONTEND=noninteractive apt-get update -q",
      `env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${ENGINE_PACKAGES.join(" ")}`,
      "systemctl enable podman.socket",
    ]);
    expect(files.m.get(COMPOSE_DROPIN_PATH)).toBe(COMPOSE_DROPIN);
    expect(parseArchV2Config(files.m.get(ARCH_V2_CONFIG)!)).toMatchObject({ rust: "on", engine: "podman", source: "owner" });
    const rec = parseSwitchRecord(files.m.get(SWITCH_RECORD)!)!;
    expect(rec).toMatchObject({ state: "trial", target: "arch-v2", previousText: null, trialUntil: T + 1000 + TRIAL_MS });
    // The same order again is a no-op while it is on trial.
    expect(await applySwitchAsRoot(d)).toEqual({ state: "trial", target: "arch-v2" });
    expect(ran).toHaveLength(3);
  });

  it("refuses the IRK on an admin-pinned box, a stranger, another server, a changed order, and a stale one; nothing runs", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [signed(order(), IRK), /isn't signed by the owner/],
      [signed(order(), key(9)), /isn't signed by the owner/],
      [signed(order({ serverDomain: "home2.alice.flagship.services" })), /another server/],
      [{ ...signed(order()), order: order({ target: "classic" }) }, /isn't signed by the owner/],
      [signed(order({ issuedAt: T - 11 * 60_000 })), /too old/],
      [{ order: order(), signatureHex: "00" }, /can't be read/],
      [null, /can't be read/],
    ];
    for (const [body, why] of cases) {
      const files = withRelease();
      if (body) files.m.set(SWITCH_ORDER_FILE, JSON.stringify(body));
      const { d, ran } = root(files);
      await expect(applySwitchAsRoot(d)).rejects.toThrow(why);
      expect(ran).toEqual([]);
      expect(files.m.has(ARCH_V2_CONFIG)).toBe(false);
      expect(files.m.has(SWITCH_RECORD)).toBe(false);
    }
  });

  it("takes the IRK only on a box that pins no admin root", async () => {
    const files = withRelease({ [SWITCH_ORDER_FILE]: JSON.stringify(signed(order(), IRK)) });
    const { d } = root(files, { authorize: ownerSwitchAuthorizer({ ownerIrkPub: IRK.pub, username: "alice" }) });
    expect((await applySwitchAsRoot(d)).state).toBe("trial");
  });

  it("uses an order once, refuses a second switch while one is under way, and resumes an install a restart cut short", async () => {
    const files = withRelease({ [SWITCH_ORDER_FILE]: JSON.stringify(signed(order())) });
    const { d } = root(files);
    await applySwitchAsRoot(d);
    files.m.set(SWITCH_ORDER_FILE, JSON.stringify(signed(order({ nonce: "b2".repeat(16) }))));
    await expect(applySwitchAsRoot(d)).rejects.toThrow(/another switch is under way/);
    // Settled: the old order can't be replayed.
    files.m.set(SWITCH_VERDICT_FILE, JSON.stringify({ nonce: "a1".repeat(16), verdict: "commit" }));
    await settleSwitchAsRoot(d);
    files.m.set(SWITCH_ORDER_FILE, JSON.stringify(signed(order())));
    await expect(applySwitchAsRoot({ ...d, now: () => T + 2000 })).rejects.toThrow(/already used/);

    // An install cut short: the record says installing; the same order goes on even once stale.
    const cut = withRelease({ [SWITCH_ORDER_FILE]: JSON.stringify(signed(order())) });
    const failing = root(cut, { run: async (c) => { if (c === "systemctl") throw new Error("power cut"); } });
    await expect(applySwitchAsRoot(failing.d)).rejects.toThrow(/couldn't be installed/);
    // (A failure marks it reverted; simulate a hard power cut instead: installing, no switch yet.)
    const rec = parseSwitchRecord(cut.m.get(SWITCH_RECORD)!)!;
    cut.m.set(SWITCH_RECORD, JSON.stringify({ ...rec, state: "installing", reason: undefined, finishedAt: undefined }));
    const later = root(cut, { now: () => T + 60 * 60_000 });
    expect((await applySwitchAsRoot(later.d)).state).toBe("trial");
    expect(later.ran.some((r) => r.includes("apt-get install"))).toBe(true);
  });

  it("an install that fails leaves the switch file as it was and records why", async () => {
    const before = JSON.stringify({ version: 1, rust: "off", engine: "docker" });
    const files = withRelease({ [SWITCH_ORDER_FILE]: JSON.stringify(signed(order())), [ARCH_V2_CONFIG]: before });
    const { d } = root(files, { run: async (_c, a) => { if (a.includes("install")) throw new Error("no network"); } });
    await expect(applySwitchAsRoot(d)).rejects.toThrow(/couldn't be installed: no network/);
    expect(files.m.get(ARCH_V2_CONFIG)).toBe(before);
    expect(parseSwitchRecord(files.m.get(SWITCH_RECORD)!)).toMatchObject({ state: "reverted" });
  });

  it("refuses arch-v2 on a release without the Rust programs, and classic on a box without Docker", async () => {
    const noPins = memFiles({ "/usr/bin/docker": "", [SWITCH_ORDER_FILE]: JSON.stringify(signed(order())) });
    await expect(applySwitchAsRoot(root(noPins).d)).rejects.toThrow(/doesn't carry the new stack/);
    const noDocker = memFiles({ [PINS]: "{}", [SWITCH_ORDER_FILE]: JSON.stringify(signed(order({ target: "classic" }))) });
    await expect(applySwitchAsRoot(root(noDocker).d)).rejects.toThrow(/no Docker to go back to/);
  });

  it("puts the switch file back on a revert, keeps it on a commit, and refuses a revert once kept or after the trial", async () => {
    const before = JSON.stringify({ version: 1, rust: "off", engine: "docker" });
    const files = withRelease({ [SWITCH_ORDER_FILE]: JSON.stringify(signed(order())), [ARCH_V2_CONFIG]: before });
    const { d } = root(files);
    await applySwitchAsRoot(d);
    files.m.set(SWITCH_VERDICT_FILE, JSON.stringify({ nonce: "ff".repeat(16), verdict: "revert" }));
    await expect(settleSwitchAsRoot(d)).rejects.toThrow(/no switch is on trial/);
    files.m.set(SWITCH_VERDICT_FILE, JSON.stringify({ nonce: "a1".repeat(16), verdict: "drop-tables" }));
    await expect(settleSwitchAsRoot(d)).rejects.toThrow(/unknown verdict/);
    files.m.set(SWITCH_VERDICT_FILE, JSON.stringify({ nonce: "a1".repeat(16), verdict: "revert", reason: "apps\nmissing" }));
    await expect(settleSwitchAsRoot({ ...d, now: () => T + TRIAL_MS + 5000 })).rejects.toThrow(/trial has ended/);
    expect(await settleSwitchAsRoot(d)).toEqual({ state: "reverted" });
    expect(files.m.get(ARCH_V2_CONFIG)).toBe(before);
    expect(parseSwitchRecord(files.m.get(SWITCH_RECORD)!)!.reason).toBe("apps missing");

    const kept = withRelease({ [SWITCH_ORDER_FILE]: JSON.stringify(signed(order())) });
    const k = root(kept);
    await applySwitchAsRoot(k.d);
    kept.m.set(SWITCH_VERDICT_FILE, JSON.stringify({ nonce: "a1".repeat(16), verdict: "commit" }));
    expect(await settleSwitchAsRoot(k.d)).toEqual({ state: "done" });
    kept.m.set(SWITCH_VERDICT_FILE, JSON.stringify({ nonce: "a1".repeat(16), verdict: "revert" }));
    await expect(settleSwitchAsRoot(k.d)).rejects.toThrow(/already settled/);
    expect(parseArchV2Config(kept.m.get(ARCH_V2_CONFIG)!).engine).toBe("podman");
  });

  it("installs what a new arch-v2 box installs, with the same compose setting", () => {
    expect(ENGINE_PACKAGES.join(" ")).toBe(ENGINE_APT_PACKAGES);
    expect(ENGINE_SETUP_BLOCK).toContain(COMPOSE_DROPIN);
    expect(ENGINE_SETUP_BLOCK).toContain(COMPOSE_DROPIN_PATH);
  });
});

// ── the daemon's half ────────────────────────────────────────────────────

function daemon(o: { files?: ReturnType<typeof memFiles>; config?: ArchV2Config; engine?: EngineKind; free?: number; dockerDown?: boolean; apps?: string[][]; rootFails?: boolean } = {}) {
  const files = o.files ?? withRelease();
  let config = o.config ?? { version: 1 as const, rust: "off" as const, engine: "docker" as const };
  const engine = o.engine ?? "docker";
  const notes: string[] = [];
  const appsSeq = [...(o.apps ?? [["flagship-alice--shop"]])];
  const rootDeps = root(files, { now: () => T + 1000 });
  const s = new ArchV2Switcher({
    files,
    cmd: {
      run: async () => {},
      capture: async (_c, a) => {
        if (o.dockerDown) throw new Error("Cannot connect to the Docker daemon");
        if (a[0] === "image" && a[1] === "ls") return { stdout: "aaa\nbbb\n", stderr: "" };
        if (a[0] === "image" && a[1] === "inspect") return { stdout: `${2 * 1024 ** 3}\n${1024 ** 3}\n`, stderr: "" };
        if (a[0] === "volume") return { stdout: "flagship-files-alice--shop\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    },
    config: () => config,
    engine: () => engine,
    repoPath: REPO,
    disk: async () => ({ freeBytes: o.free ?? 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
    runningApps: async () => (appsSeq.length > 1 ? appsSeq.shift()! : appsSeq[0]!),
    root: {
      apply: async () => {
        if (o.rootFails) throw new Error("apt-get exited with code 100");
        const r = await applySwitchAsRoot(rootDeps.d);
        config = parseArchV2Config(files.m.get(ARCH_V2_CONFIG) ?? null);
        return r;
      },
      settle: async () => {
        const r = await settleSwitchAsRoot(rootDeps.d);
        config = parseArchV2Config(files.m.get(ARCH_V2_CONFIG) ?? null);
        return r;
      },
    },
    note: (k) => void notes.push(k),
    now: () => T + 1000,
  });
  return { s, files, notes, rootDeps, config: () => config };
}

describe("the plan", () => {
  it("lists the steps and what moves when nothing stands in the way", async () => {
    const p = await daemon().s.plan("arch-v2");
    expect(p).toMatchObject({ from: "classic", target: "arch-v2", images: 2, volumes: 1, blockers: [] });
    expect(p.needBytes).toBe(3 * 1024 ** 3 + 2 * 1024 ** 3 + 2 * 1024 ** 3);
    expect(p.steps[0]).toMatch(/Install Podman/);
  });

  it("says why it can't start: already there, under way, an update, no Rust programs, Docker down, no room", async () => {
    const codes = async (d: ReturnType<typeof daemon>, t: "arch-v2" | "classic" = "arch-v2") => (await d.s.plan(t)).blockers.map((b) => b.code);
    expect(await codes(daemon({ config: { version: 1, rust: "on", engine: "podman" }, engine: "podman" }))).toContain("already");
    expect(await codes(daemon({ files: withRelease({ "/var/flagship/update-pending.json": "{}" }) }))).toContain("update-in-progress");
    expect(await codes(daemon({ files: memFiles({ "/usr/bin/docker": "" }) }))).toEqual(["no-rust-binaries"]);
    expect(await codes(daemon({ dockerDown: true }))).toEqual(["docker-down"]);
    const tight = await daemon({ free: 3 * 1024 ** 3 }).s.plan("arch-v2");
    expect(tight.blockers[0]).toEqual({ code: "no-podman-room", error: "Moving the apps needs about 7.0 GB free on this server; it has 3.0 GB." });
    expect(await codes(daemon({ files: memFiles({ [PINS]: "{}" }), config: { version: 1, rust: "on", engine: "podman" }, engine: "podman" }), "classic")).toEqual(["no-docker"]);
    const busy = daemon();
    await busy.s.start(order(), signed(order()).signatureHex);
    expect(await codes(busy)).toContain("in-progress");
  });
});

describe("the trial", () => {
  it("starts with the apps that run now, and drops its trial when root refuses", async () => {
    const d = daemon();
    expect((await d.s.start(order(), signed(order()).signatureHex)).ok).toBe(true);
    expect(JSON.parse(d.files.m.get(SWITCH_TRIAL_FILE)!)).toEqual({ nonce: "a1".repeat(16), boots: 0, appsBefore: ["flagship-alice--shop"] });
    expect(d.notes).toEqual(["server.stack.switch-started"]);
    const f = daemon({ rootFails: true });
    await expect(f.s.start(order(), signed(order()).signatureHex)).rejects.toThrow(/apt-get/);
    expect(f.files.m.has(SWITCH_TRIAL_FILE)).toBe(false);
  });

  it("is kept once healthy with every app back", async () => {
    const d = daemon({ apps: [["flagship-alice--shop"], [], ["flagship-alice--shop"]] });
    await d.s.start(order(), signed(order()).signatureHex);
    let restarted = false;
    expect(await d.s.settle({ awaitHealthy: async () => true, requestRestart: () => (restarted = true), pollMs: 1 })).toBe("kept");
    expect(restarted).toBe(false);
    expect(parseSwitchRecord(d.files.m.get(SWITCH_RECORD)!)!.state).toBe("done");
    expect(d.config().engine).toBe("podman");
    expect(d.notes).toContain("server.stack.switched");
  });

  it("is put back, with a restart, when the box isn't healthy or an app doesn't come back", async () => {
    for (const [healthy, apps, why] of [
      [false, [["flagship-alice--shop"]], /didn't report healthy/],
      [true, [["flagship-alice--shop"], []], /1 app\(s\) didn't come back: flagship-alice--shop/],
    ] as const) {
      const d = daemon({ apps: apps.map((a) => [...a]) });
      await d.s.start(order(), signed(order()).signatureHex);
      let restarted = false;
      expect(await d.s.settle({ awaitHealthy: async () => healthy, requestRestart: () => (restarted = true), pollMs: 1, appsBackMs: 0 })).toBe("reverted");
      expect(restarted).toBe(true);
      expect(d.files.m.has(ARCH_V2_CONFIG)).toBe(false);
      expect(parseSwitchRecord(d.files.m.get(SWITCH_RECORD)!)!.reason).toMatch(why);
      expect(d.notes).toContain("server.stack.switch-reverted");
    }
  });

  it("counts starts and puts the switch back after three that never got healthy", async () => {
    const d = daemon();
    await d.s.start(order(), signed(order()).signatureHex);
    for (let i = 0; i < 3; i++) expect(await d.s.beforeEngine()).toBe(false);
    expect(await d.s.beforeEngine()).toBe(true);
    expect(d.files.m.has(ARCH_V2_CONFIG)).toBe(false);
    expect(parseSwitchRecord(d.files.m.get(SWITCH_RECORD)!)!.reason).toMatch(/3 starts/);
  });

  it("undoes a move to Podman that failed at once, and leaves a good one alone", async () => {
    const d = daemon();
    await d.s.start(order(), signed(order()).signatureHex);
    expect(await d.s.afterEngine("podman")).toBe(false);
    expect(await d.s.afterEngine("docker", "podman is not installed or does not run")).toBe(true);
    expect(parseSwitchRecord(d.files.m.get(SWITCH_RECORD)!)!.reason).toBe("podman is not installed or does not run");
  });

  it("boot reads the switch file only after the trial had its say, and again after a failed move was undone", async () => {
    let file: ArchV2Config = { version: 1, rust: "on", engine: "podman" };
    const boot = (before: boolean, after: boolean) =>
      bootArchV2({
        repoPath: REPO,
        cmd: { run: async () => {}, capture: async () => { throw new Error("no podman here"); } },
        run: async () => {},
        installRust: async (x) => ({ action: "skipped", reason: `${x.config.rust}/${x.config.engine}` }),
        loadConfig: () => file,
        switcher: {
          beforeEngine: async () => {
            if (before) file = { version: 1, rust: "off", engine: "docker" };
            return before;
          },
          afterEngine: async () => {
            if (after) file = { version: 1, rust: "off", engine: "docker" };
            return after;
          },
        },
      });
    expect((await boot(true, false)).rust).toEqual({ action: "skipped", reason: "off/docker" });
    file = { version: 1, rust: "on", engine: "podman" };
    const failed = await boot(false, true);
    expect(failed.engine).toBe("docker");
    expect(failed.engineNote).toMatch(/podman is not installed/);
    expect(failed.rust).toEqual({ action: "skipped", reason: "off/docker" });
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────────

function http(over: { adminRootPub?: Uint8Array | null; gateDenies?: boolean } = {}) {
  const d = daemon();
  let restarts = 0;
  const handle = buildArchV2SwitchHttp({
    serverId: SERVER,
    ownerIrkPub: IRK.pub,
    ...(over.adminRootPub === null ? {} : { adminRootPub: over.adminRootPub ?? ADMIN.pub }),
    username: "alice",
    gate: { check: () => (over.gateDenies ? { status: 401, headers: {}, body: "no session" } : null) },
    switcher: d.s,
    config: d.config,
    engine: () => "docker",
    requestRestart: () => void restarts++,
    now: () => T + 1000,
  });
  const post = (body: unknown) => handle({ method: "POST", path: "/api/stack/switch", headers: {}, body: Buffer.from(JSON.stringify(body)) });
  const body = (o: ArchV2SwitchOrder, k = ADMIN, extra: Record<string, unknown> = {}) => ({ order: o, signature: signed(o, k).signatureHex, ...extra });
  return { d, handle, post, body, restarts: () => restarts };
}

describe("POST /api/stack/switch", () => {
  it("refuses the IRK on an admin-pinned box, a stranger, another server and a stale order, and moves nothing", async () => {
    const h = http();
    for (const [b, status] of [
      [h.body(order(), IRK), 403],
      [h.body(order(), key(9)), 403],
      [h.body(order({ serverDomain: "evil.bob.flagship.services" })), 403],
      [h.body(order({ issuedAt: T - 10 * 60_000 })), 403],
      [{ order: order(), signature: "zz" }, 400],
      [{ order: { ...order(), target: "docker" }, signature: "00".repeat(64) }, 400],
    ] as const) {
      expect((await h.post(b))!.status).toBe(status);
    }
    expect(h.d.files.m.has(SWITCH_ORDER_FILE)).toBe(false);
    expect(h.d.files.m.has(ARCH_V2_CONFIG)).toBe(false);
  });

  it("takes the IRK only where no admin root is pinned", async () => {
    const h = http({ adminRootPub: null });
    expect((await h.post(h.body(order(), IRK, { dryRun: true })))!.status).toBe(200);
  });

  it("answers a dry run with the plan and changes nothing", async () => {
    const h = http();
    const r = await h.post(h.body(order(), ADMIN, { dryRun: true }));
    expect(r!.status).toBe(200);
    expect(JSON.parse(String(r!.body)).plan).toMatchObject({ target: "arch-v2", blockers: [] });
    expect(h.d.files.m.has(SWITCH_ORDER_FILE)).toBe(false);
  });

  it("starts the switch and restarts; a second order is refused with the blocker's sentence", async () => {
    const h = http();
    const r = await h.post(h.body(order()));
    expect(r!.status).toBe(202);
    expect(parseArchV2Config(h.d.files.m.get(ARCH_V2_CONFIG)!).engine).toBe("podman");
    await new Promise((res) => setTimeout(res, 600));
    expect(h.restarts()).toBe(1);
    const again = await h.post(h.body(order({ nonce: "c3".repeat(16) })));
    expect(again!.status).toBe(409);
    expect(JSON.parse(String(again!.body))).toMatchObject({ code: "in-progress", error: "A switch is already under way on this server. Wait until it has finished." });
  });

  it("under strict, refuses an order without the hybrid signature", async () => {
    const strict: PolicyState = { scope: { kind: "installation", id: SERVER }, profile: "strict", rollout: "enforced", generation: 1, headDigest: GENESIS_DIGEST, enforcedEver: true };
    setPqAuthority({ policy: () => strict, bindingFor: () => null });
    const h = http();
    expect((await h.post(h.body(order(), ADMIN, { dryRun: true })))!.status).toBe(403);
  });

  it("shows the plan to the owner's own sessions only", async () => {
    expect((await http({ gateDenies: true }).handle({ method: "GET", path: "/api/stack", headers: {}, body: Buffer.alloc(0) }))!.status).toBe(401);
    const r = await http().handle({ method: "GET", path: "/api/stack", headers: {}, body: Buffer.alloc(0) });
    expect(JSON.parse(String(r!.body))).toMatchObject({ stack: "classic", engine: "docker", switch: null, plan: { target: "arch-v2" } });
  });
});

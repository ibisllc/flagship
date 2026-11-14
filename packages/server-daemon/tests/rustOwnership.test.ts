// Who owns apps on an arch-v2 box (rustStack/ownership.ts), the Rust ingress in place of
// flagship-tlsd (rustStack/ingress.ts), and the daemon's decision socket for the ingress's proxy
// (rustProxyDecide.ts).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed, signRustOwnershipOrder, type RustOwnershipOrder } from "@flagship/protocol";
import {
  CUTOVER_PASSES,
  DEFAULT_OWNERSHIP,
  autoCutover,
  buildOwnershipHttp,
  cutoverBlockers,
  isAppNetwork,
  parseCoreStatus,
  parseOwnership,
  type CutoverFacts,
  type RustOwnership,
} from "../src/rustStack/ownership.js";
import { TLSD_RUST_DROPIN_PATH, ingressExecScript, syncRustIngress, tlsdRustDropIn } from "../src/rustStack/ingress.js";
import { decide, listenForDecisions, parseDecideRequest, type DecideDeps, type DecideRequest } from "../src/rustProxyDecide.js";
import { endpoints } from "../src/endpoints.js";
import { AppConnectionLimiter, type AppConnectionOptions } from "../src/appConnection.js";
import type { InstalledService } from "../src/servicePlatform.js";

const SERVER = "home.alice.flagship.services";
const T = 1_790_000_000_000;
const key = (n: number) => {
  const seed = new Uint8Array(32).fill(n);
  return { pub: ed.getPublicKey(seed), sign: (m: Uint8Array) => ed.sign(m, seed) };
};
const IRK = key(1);
const ADMIN = key(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const facts = (over: Partial<CutoverFacts> = {}): CutoverFacts => ({
  stack: "arch-v2",
  engine: "podman",
  coreChoice: "rust",
  core: { ok: true, mode: "serve", live: false, agreePasses: CUTOVER_PASSES, lastShadow: "agree", at: 1 },
  ingressPinned: true,
  appNetworks: ["10.89.0.0/24"],
  ...over,
});

describe("the ownership setting", () => {
  it("starts TS/shadow, chosen by default; a damaged file is TS/shadow chosen by the owner (no automatic move)", () => {
    expect(parseOwnership(null)).toEqual(DEFAULT_OWNERSHIP);
    expect(DEFAULT_OWNERSHIP.chosenBy).toBe("default");
    expect(parseOwnership("{not json")).toEqual({ ...DEFAULT_OWNERSHIP, chosenBy: "owner" });
    // A file from before the field came from an order.
    expect(parseOwnership(JSON.stringify({ reconciler: "shadow", proxy: "ts" })).chosenBy).toBe("owner");
    expect(parseOwnership(JSON.stringify({ reconciler: "rust", proxy: "ts", chosenBy: "default" })).chosenBy).toBe("default");
    expect(parseOwnership(JSON.stringify({ reconciler: "rust", proxy: "rust", proxyAllow: ["10.89.0.0/24", "127.0.0.0/8", "0.0.0.0/0"] }))).toMatchObject({
      reconciler: "rust",
      proxy: "rust",
      proxyAllow: ["10.89.0.0/24"],
    });
    expect(parseOwnership(JSON.stringify({ reconciler: "yes", proxy: 1 }))).toMatchObject({ reconciler: "shadow", proxy: "ts" });
  });

  it("knows an app network from anything else", () => {
    for (const ok of ["10.89.0.0/24", "172.20.0.0/16", "192.168.5.0/24", "100.64.0.0/16"]) expect(isAppNetwork(ok)).toBe(true);
    for (const bad of ["127.0.0.0/8", "0.0.0.0/0", "8.8.8.0/24", "10.0.0.0/4", "10.0.0.300/24", "fd00::/8", "10.89.0.0"]) expect(isAppNetwork(bad)).toBe(false);
  });

  it("reads core's status file", () => {
    expect(parseCoreStatus(JSON.stringify({ ok: true, mode: "serve", at: 5, apps: { live: true, agreePasses: 4, lastShadow: "agree" } }))).toEqual({ ok: true, mode: "serve", live: true, agreePasses: 4, lastShadow: "agree", at: 5 });
    expect(parseCoreStatus("x")).toBeNull();
  });
});

describe("the arch-v2 default (owner, 2026-11-02): Rust owners once they qualify", () => {
  const run = async (cur: RustOwnership, f: CutoverFacts) => {
    let saved: RustOwnership | null = null;
    const changed = await autoCutover({ current: () => cur, facts: async () => f, save: async (n) => void (saved = n), now: () => 7 });
    return { changed, saved: saved as RustOwnership | null };
  };
  it("takes both Rust owners on a qualified arch-v2 box nobody ordered, with the app network for the proxy", async () => {
    const r = await run(DEFAULT_OWNERSHIP, facts());
    expect(r.changed).toBe(true);
    expect(r.saved).toMatchObject({ reconciler: "rust", proxy: "rust", proxyAllow: ["10.89.0.0/24"], chosenBy: "default", at: 7 });
  });
  it("takes each one as it qualifies: the proxy first while core still compares", async () => {
    const r = await run(DEFAULT_OWNERSHIP, facts({ core: { ok: true, mode: "serve", live: false, agreePasses: 1, lastShadow: "agree", at: 1 } }));
    expect(r.saved).toMatchObject({ reconciler: "shadow", proxy: "rust" });
    const again = await run(r.saved!, facts());
    expect(again.saved).toMatchObject({ reconciler: "rust", proxy: "rust", proxyAllow: ["10.89.0.0/24"] });
  });
  it("in the first half hour waits to take both together, so a new box restarts once for them", async () => {
    const waiting = facts({ core: { ok: true, mode: "serve", live: false, agreePasses: 1, lastShadow: "agree", at: 1 } });
    let saved: RustOwnership | null = null;
    const save = async (n: RustOwnership) => void (saved = n);
    expect(await autoCutover({ current: () => DEFAULT_OWNERSHIP, facts: async () => waiting, save, now: () => 7, holdOneUntil: 100 })).toBe(false);
    expect(saved).toBeNull();
    expect(await autoCutover({ current: () => DEFAULT_OWNERSHIP, facts: async () => facts(), save, now: () => 8, holdOneUntil: 100 })).toBe(true);
    expect(saved).toMatchObject({ reconciler: "rust", proxy: "rust" });
    // After the hold, the proxy goes alone as before.
    expect(await autoCutover({ current: () => DEFAULT_OWNERSHIP, facts: async () => waiting, save, now: () => 101, holdOneUntil: 100 })).toBe(true);
    expect(saved).toMatchObject({ reconciler: "shadow", proxy: "rust" });
  });
  it("does nothing on classic, nothing unqualified, and never overrides an owner's order (a rollback included)", async () => {
    expect((await run(DEFAULT_OWNERSHIP, facts({ stack: "classic", engine: "docker" }))).changed).toBe(false);
    expect((await run(DEFAULT_OWNERSHIP, facts({ coreChoice: "ts", ingressPinned: false }))).changed).toBe(false);
    expect((await run({ ...DEFAULT_OWNERSHIP, chosenBy: "owner" }, facts())).changed).toBe(false);
    expect((await run({ ...DEFAULT_OWNERSHIP, reconciler: "rust", proxy: "rust" }, facts())).changed).toBe(false);
  });
});

describe("the cut-over rule", () => {
  const cur = DEFAULT_OWNERSHIP;
  it("lets the reconciler move only on arch-v2, with core serving from the release and agreeing", () => {
    expect(cutoverBlockers({ reconciler: "rust", proxy: "ts" }, cur, facts())).toEqual([]);
    expect(cutoverBlockers({ reconciler: "rust", proxy: "ts" }, cur, facts({ stack: "classic", engine: "docker" }))[0]!.code).toBe("not-arch-v2");
    expect(cutoverBlockers({ reconciler: "rust", proxy: "ts" }, cur, facts({ coreChoice: "ts" }))[0]!.code).toBe("core-not-running");
    expect(cutoverBlockers({ reconciler: "rust", proxy: "ts" }, cur, facts({ core: { ok: true, mode: "shadow", live: false, agreePasses: 9, lastShadow: "agree", at: 1 } }))[0]!.code).toBe("core-not-serving");
    const b = cutoverBlockers({ reconciler: "rust", proxy: "ts" }, cur, facts({ core: { ok: true, mode: "serve", live: false, agreePasses: 1, lastShadow: "alice--x/main: would deploy", at: 1 } }));
    expect(b[0]!.code).toBe("shadow-disagrees");
    expect(b[0]!.error).toContain("would deploy");
  });

  it("lets the proxy move only with a pinned ingress and a known app network", () => {
    expect(cutoverBlockers({ reconciler: "shadow", proxy: "rust" }, cur, facts())).toEqual([]);
    expect(cutoverBlockers({ reconciler: "shadow", proxy: "rust" }, cur, facts({ ingressPinned: false }))[0]!.code).toBe("no-ingress");
    expect(cutoverBlockers({ reconciler: "shadow", proxy: "rust" }, cur, facts({ appNetworks: [] }))[0]!.code).toBe("no-app-network");
  });

  it("never blocks going back, nor keeping what is already on", () => {
    const on: RustOwnership = { ...cur, reconciler: "rust", proxy: "rust" };
    const broken = facts({ stack: "classic", engine: "docker", coreChoice: null, core: null, ingressPinned: false, appNetworks: [] });
    expect(cutoverBlockers({ reconciler: "shadow", proxy: "ts" }, on, broken)).toEqual([]);
    expect(cutoverBlockers({ reconciler: "rust", proxy: "rust" }, on, broken)).toEqual([]);
  });
});

describe("POST /api/stack/rust-ownership", () => {
  function http(f: CutoverFacts = facts()) {
    let state: RustOwnership = { ...DEFAULT_OWNERSHIP };
    let restarts = 0;
    const handle = buildOwnershipHttp({
      serverId: SERVER,
      ownerIrkPub: IRK.pub,
      adminRootPub: ADMIN.pub,
      username: "alice",
      gate: { check: () => null },
      current: () => state,
      facts: async () => f,
      save: async (o) => void (state = o),
      requestRestart: () => void restarts++,
      now: () => T + 1000,
    });
    const order = (over: Partial<RustOwnershipOrder> = {}): RustOwnershipOrder => ({ serverDomain: SERVER, reconciler: "rust", proxy: "rust", nonce: "b2".repeat(16), issuedAt: T, ...over });
    const post = (o: RustOwnershipOrder, k = ADMIN) =>
      handle({ method: "POST", path: "/api/stack/rust-ownership", headers: {}, body: Buffer.from(JSON.stringify({ order: o, signature: hex(signRustOwnershipOrder(o, k.sign)) })) });
    return { handle, order, post, state: () => state, restarts: () => restarts };
  }

  it("takes the admin's order once, saves it, and restarts", async () => {
    const h = http();
    const r = await h.post(h.order());
    expect(r!.status).toBe(202);
    expect(h.state()).toMatchObject({ reconciler: "rust", proxy: "rust", proxyAllow: ["10.89.0.0/24"] });
    expect((await h.post(h.order()))!.status).toBe(409);
    await new Promise((r) => setTimeout(r, 600));
    expect(h.restarts()).toBe(1);
  });

  it("refuses the IRK on an admin-pinned box, another server, a stale order and a blocked move", async () => {
    const h = http(facts({ ingressPinned: false }));
    expect((await h.post(h.order(), IRK))!.status).toBe(403);
    expect((await h.post(h.order({ serverDomain: "home2.alice.flagship.services" })))!.status).toBe(403);
    expect((await h.post(h.order({ issuedAt: T - 10 * 60_000 })))!.status).toBe(403);
    const blocked = await h.post(h.order({ reconciler: "shadow" }));
    expect(blocked!.status).toBe(409);
    expect(JSON.parse(String(blocked!.body)).code).toBe("no-ingress");
    expect(h.state()).toEqual(DEFAULT_OWNERSHIP);
  });

  it("shows the setting and what blocks each move", async () => {
    const h = http(facts({ coreChoice: "ts" }));
    const r = await h.handle({ method: "GET", path: "/api/stack/rust-ownership", headers: {}, body: Buffer.alloc(0) });
    const j = JSON.parse(String(r!.body));
    expect(j).toMatchObject({ reconciler: "shadow", proxy: "ts" });
    expect(j.blockers.reconciler[0].code).toBe("core-not-running");
    expect(j.blockers.proxy).toEqual([]);
  });
});

describe("the Rust ingress in place of flagship-tlsd", () => {
  function sandbox(binBody: string, pinned?: string) {
    const root = mkdtempSync(join(tmpdir(), "ingress-exec-"));
    dirs.push(root);
    const release = join(root, "release");
    mkdirSync(join(release, "installer/rust"), { recursive: true });
    const bin = join(release, "installer/rust/flagship-ingress");
    writeFileSync(bin, binBody);
    chmodSync(bin, 0o755);
    writeFileSync(join(release, "installer/flagship-tlsd"), "#!/bin/bash\necho GO \"$@\"\n");
    chmodSync(join(release, "installer/flagship-tlsd"), 0o755);
    const sha = createHash("sha256").update(binBody).digest("hex");
    writeFileSync(join(release, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-ingress": pinned ?? sha } }));
    const run = join(root, "run");
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "ingress.args"), "--proxy-decide /run/flagship-tls/decide.sock --proxy-allow 10.89.0.0/24\n");
    const script = join(root, "exec.sh");
    writeFileSync(script, ingressExecScript(release, run, state));
    const sh = (args: string[], env: Record<string, string> = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { sh, run };
  }

  it("runs the pinned ingress with the proxy's arguments", () => {
    const s = sandbox("#!/bin/bash\necho RUST \"$@\"\n");
    expect(s.sh(["pre"]).status).toBe(0);
    expect(s.sh(["run", "--listen", "127.0.0.1:18443"]).stdout.trim()).toBe("RUST --listen 127.0.0.1:18443 --proxy-decide /run/flagship-tls/decide.sock --proxy-allow 10.89.0.0/24");
  });

  it("falls back to flagship-tlsd on a wrong hash or after three failed runs, and counts nothing for a clean stop", () => {
    const wrong = sandbox("#!/bin/bash\necho RUST\n", "00".repeat(32));
    wrong.sh(["pre"]);
    expect(wrong.sh(["run", "-x"]).stdout.trim()).toBe("GO -x");
    expect(JSON.parse(readFileSync(join(wrong.run, "ingress.status"), "utf8")).reason).toBe("hash-mismatch");
    const s = sandbox("#!/bin/bash\nexit 1\n");
    for (let i = 0; i < 3; i++) {
      s.sh(["pre"]);
      s.sh(["stopped"], { SERVICE_RESULT: "success" });
      s.sh(["stopped"], { SERVICE_RESULT: "exit-code" });
    }
    s.sh(["pre"]);
    expect(JSON.parse(readFileSync(join(s.run, "ingress.status"), "utf8"))).toMatchObject({ choice: "ts", reason: "failed-to-start" });
  });

  it("is written only for the proxy setting on arch-v2, and removed otherwise", async () => {
    const files = new Map<string, string>([["/etc/systemd/system/flagship-tlsd.service", "x"]]);
    const ran: string[] = [];
    const deps = (own: RustOwnership, rust: "on" | "off" = "on") => ({
      repoPath: "/opt/flagship",
      config: { version: 1 as const, rust, engine: "podman" as const },
      run: async (c: string, a: string[]) => void ran.push(`${c} ${a.join(" ")}`),
      ownership: () => own,
      fileExists: (p: string) => files.has(p),
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      remove: async (p: string) => void files.delete(p),
      runDir: "/run/flagship-rust",
      stateDir: "/var/lib/flagship-rust",
    });
    const on: RustOwnership = { ...DEFAULT_OWNERSHIP, proxy: "rust", proxyAllow: ["10.89.0.0/24"] };
    expect(await syncRustIngress(deps(on))).toBe("on");
    expect(files.get(TLSD_RUST_DROPIN_PATH)).toBe(tlsdRustDropIn(["10.89.0.0/24"]));
    expect(files.get(TLSD_RUST_DROPIN_PATH)).toContain("IPAddressAllow=10.89.0.0/24");
    expect(files.get("/var/lib/flagship-rust/ingress.args")).toContain("--proxy-allow 10.89.0.0/24");
    expect(await syncRustIngress(deps(on))).toBe("unchanged");
    expect(await syncRustIngress(deps(on, "off"))).toBe("off");
    expect(files.has(TLSD_RUST_DROPIN_PATH)).toBe(false);
    expect(await syncRustIngress(deps(DEFAULT_OWNERSHIP))).toBe("unchanged");
    expect(ran.filter((r) => r.includes("restart")).length).toBe(2);
    expect(() => tlsdRustDropIn(["127.0.0.0/8"])).toThrow();
  });
});

// ── the decision socket ──────────────────────────────────────────────────

const APP = { serviceId: "alice--notes", urlLabel: "notes", containerPort: 8080, manifest: { name: "Notes" } } as unknown as InstalledService;

function options(over: Partial<AppConnectionOptions> = {}): AppConnectionOptions {
  return {
    serviceId: APP.serviceId,
    gate: async () => null,
    prepare: async (req) => ({
      kind: "forward",
      headers: (() => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (!k.replace(/_/g, "-").startsWith("x-flagship-") && k !== "authorization") h[k] = v;
        return { ...h, "x-flagship-app-id": APP.serviceId, "x-flagship-visitor": "member", "x-flagship-user": "u1" };
      })(),
    }),
    upstream: { host: "10.89.0.7", port: 8080 },
    limiter: new AppConnectionLimiter(2),
    ...over,
  };
}

const deps = (over: Partial<DecideDeps> = {}, opt: Partial<AppConnectionOptions> = {}): DecideDeps => {
  const o = options(opt);
  return { enabled: () => true, appForSni: (s) => (s === "notes.home.alice.flagship.services" ? APP : undefined), options: () => o, ...over };
};

const ask = (over: Partial<DecideRequest> = {}): DecideRequest => ({
  sni: "notes.home.alice.flagship.services",
  method: "GET",
  target: "/",
  version: "1.1",
  headers: { host: "notes.home.alice.flagship.services", authorization: "Bearer fsk_a_b", "x-flagship-user": "forged" },
  upgrade: false,
  body: "none",
  ...over,
});

describe("the ingress's decisions", () => {
  it("forwards with the identity the TS proxy decided, and names what to drop", async () => {
    const r = await decide(ask(), deps());
    expect(r.answer).toEqual({
      action: "proxy",
      host: "10.89.0.7",
      port: 8080,
      set: [
        ["x-flagship-app-id", "alice--notes"],
        ["x-flagship-visitor", "member"],
        ["x-flagship-user", "u1"],
      ],
      remove: ["authorization"],
    });
    // Every name the Rust side accepts: lowercase tokens, identity headers only in `set`.
    if (r.answer.action === "proxy") {
      for (const [k] of r.answer.set) expect(k).toMatch(/^x-flagship-[a-z0-9-]+$/);
      for (const k of r.answer.remove) expect(k).toMatch(/^[a-z0-9!#$%&'*+.^_`|~-]+$/);
    }
    r.hold?.release();
  });

  it("leaves to the daemon what is not a plain forward", async () => {
    expect((await decide(ask(), deps({ enabled: () => false }))).answer.action).toBe("daemon");
    expect((await decide(ask({ sni: "home.alice.flagship.services" }), deps())).answer.action).toBe("daemon");
    for (const p of ["/__flagship/sign-in", "/.flagship/runtime-pubkey", "/api/service-access/knock/authorize"]) expect((await decide(ask({ target: p }), deps())).answer.action).toBe("daemon");
    expect((await decide(ask(), deps({}, { gate: async () => ({ status: 403, headers: {}, body: "" }) }))).answer.action).toBe("daemon");
    expect((await decide(ask(), deps({}, { prepare: async () => ({ kind: "respond", response: { status: 401, headers: {}, body: "" } }) }))).answer.action).toBe("daemon");
    expect((await decide(ask(), deps({}, { upstream: { endpoint: { serviceId: "alice--gone", env: "live", component: "main", role: "http" } } }))).answer.action).toBe("daemon");
  });

  it("holds the app's connection slot until the ingress lets go", async () => {
    const limiter = new AppConnectionLimiter(1);
    const d = deps({}, { limiter });
    const a = await decide(ask(), d);
    expect(a.answer.action).toBe("proxy");
    expect((await decide(ask(), d)).answer.action).toBe("daemon");
    a.hold!.release();
    expect((await decide(ask(), d)).answer.action).toBe("proxy");
  });

  it("parses only what the ingress sends", () => {
    const good = { v: 1, sni: "a.b", method: "GET", target: "/x", version: "1.1", headers: [["host", "a"]], upgrade: false, body: "none" };
    expect(parseDecideRequest(JSON.stringify(good))).toMatchObject({ headers: { host: "a" } });
    for (const bad of [
      { ...good, v: 2 },
      { ...good, target: "x" },
      { ...good, headers: [["Host", "a"]] },
      { ...good, headers: [["host", "a"], ["host", "b"]] },
      { ...good, headers: [["__proto__", "a"]] },
      { ...good, body: "stream" },
      { ...good, sni: "A B" },
    ]) {
      expect(parseDecideRequest(JSON.stringify(bad))).toBeNull();
    }
    expect(parseDecideRequest("nope")).toBeNull();
  });

  it("over the socket: one line each way, and an invalidated endpoint closes the lease", async () => {
    const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "dec-"));
    dirs.push(dir);
    const sock = join(dir, "decide.sock");
    const key = { serviceId: "alice--notes", env: "live" as const, component: "main", role: "http" as const };
    endpoints.publish(key, { host: "10.89.0.9", port: 3000, generation: 1, incarnation: "c1@t" });
    const server = await listenForDecisions(sock, deps({}, { upstream: { endpoint: key } }));
    try {
      const c = connect(sock);
      const line = await new Promise<string>((resolve) => {
        let buf = "";
        c.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\n")) resolve(buf.split("\n")[0]!);
        });
        c.write(`${JSON.stringify({ v: 1, ...ask(), headers: Object.entries(ask().headers) })}\n`);
      });
      expect(JSON.parse(line)).toMatchObject({ action: "proxy", host: "10.89.0.9", port: 3000 });
      const closed = new Promise<void>((resolve) => c.on("close", () => resolve()));
      endpoints.invalidate("alice--notes", "live", "main");
      await closed;
    } finally {
      server.close();
    }
  });
});

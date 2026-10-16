/**
 * Owner debug access on the box (docs/recipe-delivery-and-remote-install.md
 * "Debug access"): verify, open, renew, expire, revoke, survive restarts.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEBUG_ACCESS_HOUR_MS,
  canonicalDebugAccessGrant,
  deriveIRK,
  ed,
  signDebugAccessGrant,
  signDebugAccessRevoke,
  sshKeyFingerprint,
  type DebugAccessGrant,
  type Keypair,
} from "@flagship/protocol";
import {
  DebugAccessController,
  authorizedKeyLine,
  buildDebugAccessHttp,
  buildDebugSystem,
  debugGrantFromInstallBlob,
  sshExpiryTime,
  type DebugCommandRunner,
  type DebugSystem,
} from "../src/debugAccessGate.js";

const DOMAIN = "home.alice.flagship.services";
const T0 = 1_760_000_000_000;

function sshEd25519(seed: number): string {
  const pub = ed.getPublicKey(new Uint8Array(32).fill(seed));
  const type = new TextEncoder().encode("ssh-ed25519");
  const blob = new Uint8Array(4 + type.length + 4 + 32);
  const dv = new DataView(blob.buffer);
  dv.setUint32(0, type.length);
  blob.set(type, 4);
  dv.setUint32(4 + type.length, 32);
  blob.set(pub, 8 + type.length);
  return `ssh-ed25519 ${Buffer.from(blob).toString("base64")}`;
}
const KEY = sshEd25519(0x11);
const KEY2 = sshEd25519(0x12);

const admin: Keypair = (() => {
  const priv = new Uint8Array(32).fill(0x5a);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
})();
const irk = deriveIRK({ seed: new Uint8Array(32).fill(0x2a) });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function signed(g: Partial<DebugAccessGrant> = {}, key: Keypair = admin) {
  const grant: DebugAccessGrant = {
    serverDomain: DOMAIN,
    sshPublicKey: KEY,
    issuedAt: T0,
    expiresAt: T0 + 24 * DEBUG_ACCESS_HOUR_MS,
    ...g,
  };
  return { grant, signatureHex: hex(signDebugAccessGrant(grant, key)) };
}
function revoked(issuedAt: number, key: Keypair = admin) {
  const revoke = { serverDomain: DOMAIN, issuedAt };
  return { revoke, signatureHex: hex(signDebugAccessRevoke(revoke, key)) };
}

function fakeSystem(): DebugSystem & { events: string[]; openKey: string | null } {
  const s = {
    events: [] as string[],
    openKey: null as string | null,
    async open(k: { sshPublicKey: string; expiresAt: number }) {
      s.events.push(`open ${k.sshPublicKey === KEY ? "KEY" : "KEY2"} ${k.expiresAt}`);
      s.openKey = k.sshPublicKey;
    },
    async close() {
      s.events.push("close");
      s.openKey = null;
    },
  };
  return s;
}

let dir: string;
let clock: number;
let activity: Array<[string, string]>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "debug-access-"));
  clock = T0 + 60_000;
  activity = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function controller(opts: {
  system: DebugSystem;
  pinned?: boolean;
  installGrant?: unknown;
  legacy?: boolean;
}) {
  return new DebugAccessController({
    serverDomain: DOMAIN,
    authority: () => ({
      ownerIrkPub: irk.publicKey,
      ...(opts.pinned === false ? {} : { adminRootPub: admin.publicKey }),
      username: "alice",
    }),
    statePath: join(dir, "debug-access.json"),
    ...(opts.legacy ? { legacyMarkerPath: join(dir, "debug-access-done.json") } : {}),
    system: opts.system,
    installGrant: async () => opts.installGrant ?? null,
    activity: (kind, detail) => activity.push([kind, detail]),
    now: () => clock,
    tickMs: 3_600_000,
  });
}

describe("debug access grants", () => {
  it("opens for an admin-root grant naming this box, and server-detail says so", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys });
    const r = await c.grant(signed());
    expect(r).toMatchObject({ ok: true, change: "granted" });
    expect(sys.openKey).toBe(KEY);
    expect(c.view()).toEqual({
      on: true,
      expiresAt: T0 + 24 * DEBUG_ACCESS_HOUR_MS,
      keyFingerprint: sshKeyFingerprint(KEY),
      grantedBy: "admin",
    });
    expect(activity.map((a) => a[0])).toEqual(["server.debug-access.granted"]);
    c.stop();
  });

  it("refuses the IRK on an admin-pinned box, and takes it where no admin root is pinned", async () => {
    const sys = fakeSystem();
    const pinned = controller({ system: sys });
    const r = await pinned.grant(signed({}, irk));
    expect(r).toEqual({ ok: false, status: 403, error: "This server takes debug access only from an admin device of this account." });
    expect(sys.events).toEqual([]);

    await rm(join(dir, "debug-access.json"), { force: true });
    const legacy = controller({ system: sys, pinned: false });
    const ok = await legacy.grant(signed({}, irk));
    expect(ok).toMatchObject({ ok: true });
    expect(legacy.view().grantedBy).toBe("owner-key");
    pinned.stop();
    legacy.stop();
  });

  it("refuses a stranger's key, another box, a grant without a key, a v1 grant and bad times", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys });
    const stranger = { privateKey: new Uint8Array(32).fill(9), publicKey: ed.getPublicKey(new Uint8Array(32).fill(9)) };
    expect(await c.grant(signed({}, stranger))).toMatchObject({ ok: false, status: 403 });
    expect(await c.grant(signed({ serverDomain: "home2.alice.flagship.services" }))).toMatchObject({
      ok: false,
      error: "That debug access grant is for another server.",
    });
    const noKey = { grant: { serverDomain: DOMAIN, sshPublicKey: "", issuedAt: T0, expiresAt: T0 + 1000 }, signatureHex: "00".repeat(64) };
    expect(await c.grant(noKey)).toMatchObject({ ok: false, error: "Debug access needs an SSH public key." });
    const v1 = { grant: { serverDomain: DOMAIN, sshAuthorizedKey: "", issuedAt: T0 }, signatureHex: "00".repeat(64) };
    expect(await c.grant(v1)).toMatchObject({ ok: false, status: 422 });
    const long = { serverDomain: DOMAIN, sshPublicKey: KEY, issuedAt: T0, expiresAt: T0 + 8 * 24 * DEBUG_ACCESS_HOUR_MS };
    const longSig = hex(ed.sign(canonicalDebugAccessGrant(long), admin.privateKey));
    expect(await c.grant({ grant: long, signatureHex: longSig })).toMatchObject({ ok: false, error: expect.stringMatching(/7 days/) });
    clock = T0 + 60 * 60_000;
    expect(await c.grant(signed())).toMatchObject({ ok: false, error: expect.stringMatching(/clock/) });
    expect(sys.events).toEqual([]);
    expect(c.view().on).toBe(false);
    c.stop();
  });

  it("renews with a newer grant, refuses an older one, and a new key ends the old key's sessions", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys });
    await c.grant(signed());
    clock += 60_000;
    const renew = await c.grant(signed({ issuedAt: T0 + 120_000, expiresAt: T0 + 7 * 24 * DEBUG_ACCESS_HOUR_MS }));
    expect(renew).toMatchObject({ ok: true, change: "renewed" });
    expect(await c.grant(signed())).toMatchObject({ ok: false, status: 409 });
    await c.grant(signed({ sshPublicKey: KEY2, issuedAt: T0 + 130_000 }));
    expect(sys.events.slice(-2)).toEqual(["close", `open KEY2 ${T0 + 24 * DEBUG_ACCESS_HOUR_MS}`]);
    expect(activity.map((a) => a[0])).toEqual([
      "server.debug-access.granted",
      "server.debug-access.renewed",
      "server.debug-access.renewed",
    ]);
    c.stop();
  });

  it("revokes at once, and the revoke can't be replayed to kill a later grant", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys });
    await c.grant(signed());
    const off = await c.revoke(revoked(T0 + 90_000));
    expect(off).toMatchObject({ ok: true, change: "revoked" });
    expect(sys.openKey).toBeNull();
    expect(c.view()).toMatchObject({ on: false, expiresAt: null, lastEnded: { why: "revoked" } });
    expect(await c.grant(signed())).toMatchObject({ ok: false, status: 409 });
    expect(await c.grant(signed({ issuedAt: T0 + 100_000 }))).toMatchObject({ ok: true });
    expect(await c.revoke(revoked(T0 + 90_000))).toMatchObject({ ok: false, status: 409 });
    expect(c.view().on).toBe(true);
    expect(await c.revoke(revoked(T0 + 95_000, irk))).toMatchObject({ ok: false, status: 403 });
    expect(activity.map((a) => a[0])).toEqual([
      "server.debug-access.granted",
      "server.debug-access.revoked",
      "server.debug-access.granted",
    ]);
    c.stop();
  });

  it("closes at expiry", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys });
    await c.grant(signed({ expiresAt: T0 + DEBUG_ACCESS_HOUR_MS }));
    clock = T0 + DEBUG_ACCESS_HOUR_MS - 1;
    await c.checkExpiry();
    expect(sys.openKey).toBe(KEY);
    clock = T0 + DEBUG_ACCESS_HOUR_MS;
    expect(c.view().on).toBe(false);
    await c.checkExpiry();
    expect(sys.openKey).toBeNull();
    expect(activity.at(-1)?.[0]).toBe("server.debug-access.expired");
    c.stop();
  });
});

describe("debug access across restarts", () => {
  it("reopens an unexpired grant after a restart, and never reopens an expired one", async () => {
    const sys = fakeSystem();
    const first = controller({ system: sys });
    await first.grant(signed());
    first.stop();

    const sys2 = fakeSystem();
    const again = controller({ system: sys2 });
    await again.start();
    expect(sys2.events).toEqual([`open KEY ${T0 + 24 * DEBUG_ACCESS_HOUR_MS}`]);
    again.stop();

    clock = T0 + 25 * DEBUG_ACCESS_HOUR_MS;
    const sys3 = fakeSystem();
    const later = controller({ system: sys3 });
    await later.start();
    expect(sys3.events).toEqual(["close"]);
    expect(later.view()).toMatchObject({ on: false, lastEnded: { why: "expired" } });
    later.stop();

    const sys4 = fakeSystem();
    const fourth = controller({ system: sys4 });
    await fourth.start();
    expect(sys4.events).toEqual([]);
    fourth.stop();
  });

  it("finishes a close a crash interrupted", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys });
    await c.grant(signed());
    c.stop();
    const path = join(dir, "debug-access.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.active.ending = "revoked";
    await writeFile(path, JSON.stringify(state));

    const sys2 = fakeSystem();
    const next = controller({ system: sys2 });
    await next.start();
    expect(sys2.events).toEqual(["close"]);
    expect(next.view()).toMatchObject({ on: false, lastEnded: { why: "revoked" } });
    next.stop();
  });

  it("takes the recipe's grant once, at first boot only", async () => {
    const sys = fakeSystem();
    const c = controller({ system: sys, installGrant: JSON.stringify(signed()) });
    await c.start();
    expect(c.view().on).toBe(true);
    await c.revoke(revoked(T0 + 90_000));
    c.stop();

    const sys2 = fakeSystem();
    const next = controller({ system: sys2, installGrant: JSON.stringify(signed()) });
    await next.start();
    expect(sys2.events).toEqual([]);
    expect(next.view().on).toBe(false);
    next.stop();
  });

  it("an install-time grant may be older than the clock skew, but not ended", async () => {
    clock = T0 + 2 * DEBUG_ACCESS_HOUR_MS;
    const ok = controller({ system: fakeSystem(), installGrant: signed() });
    await ok.start();
    expect(ok.view().on).toBe(true);
    ok.stop();

    await rm(join(dir, "debug-access.json"));
    clock = T0 + 25 * DEBUG_ACCESS_HOUR_MS;
    const late = controller({ system: fakeSystem(), installGrant: signed() });
    await late.start();
    expect(late.view().on).toBe(false);
    late.stop();
  });

  it("an unreadable state file closes access and refuses grants signed before it was found", async () => {
    await writeFile(join(dir, "debug-access.json"), "{not json");
    const sys = fakeSystem();
    const c = controller({ system: sys });
    await c.start();
    expect(sys.events).toEqual(["close"]);
    expect(await c.grant(signed())).toMatchObject({ ok: false, status: 409 });
    c.stop();
  });

  it("closes the v1 gate's password access on the first start", async () => {
    await writeFile(join(dir, "debug-access-done.json"), JSON.stringify({ enabledAt: 1, serverDomain: DOMAIN }));
    const sys = fakeSystem();
    const c = controller({ system: sys, legacy: true });
    await c.start();
    expect(sys.events).toEqual(["close"]);
    await expect(readFile(join(dir, "debug-access-done.json"))).rejects.toThrow();
    expect(activity[0]?.[0]).toBe("server.debug-access.revoked");
    c.stop();
  });
});

describe("the OS side", () => {
  function recorder() {
    const calls: string[] = [];
    const files = new Map<string, { content: string; mode: number }>();
    const removed: string[] = [];
    const runner: DebugCommandRunner = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(" "));
      },
    };
    const sys = buildDebugSystem({
      runner,
      writeFile: async (p, content, mode) => void files.set(p, { content, mode }),
      removeFile: async (p) => void removed.push(p),
    });
    return { sys, calls, files, removed };
  }

  it("opens key-only: no password, root-owned key file with an expiry, key auth only for debug", async () => {
    const r = recorder();
    await r.sys.open({ sshPublicKey: KEY, expiresAt: Date.UTC(2026, 9, 17, 8, 30, 5) });
    expect(r.calls).toContain("usermod -p * -e  -s /bin/bash debug");
    expect(r.calls.some((c) => /chpasswd|passwd /.test(c))).toBe(false);
    const key = r.files.get("/etc/flagship/debug-ssh/authorized_keys")!;
    expect(key.content).toBe(`expiry-time="20261017083005Z" ${KEY} flagship-debug-access\n`);
    expect(key.mode).toBe(0o644);
    const sshd = r.files.get("/etc/ssh/sshd_config.d/10-flagship-debug.conf")!.content;
    expect(sshd).toContain("Match User debug");
    expect(sshd).toContain("AuthenticationMethods publickey");
    expect(sshd).toContain("PasswordAuthentication no");
    expect(sshd).not.toMatch(/PasswordAuthentication yes/);
    expect(r.files.get("/etc/sudoers.d/90-flagship-debug")?.mode).toBe(0o440);
  });

  it("closes: key and sudo gone, account locked and expired, sessions killed", async () => {
    const r = recorder();
    await r.sys.close();
    expect(r.removed).toEqual(expect.arrayContaining([
      "/etc/flagship/debug-ssh/authorized_keys",
      "/etc/sudoers.d/90-flagship-debug",
      "/etc/ssh/sshd_config.d/10-flagship-debug.conf",
    ]));
    expect(r.calls).toEqual(expect.arrayContaining([
      "usermod -p ! -e 1 debug",
      "loginctl terminate-user debug",
      "pkill -KILL -u debug",
    ]));
    expect(r.calls.indexOf("usermod -p ! -e 1 debug")).toBeLessThan(r.calls.indexOf("pkill -KILL -u debug"));
  });

  it("formats OpenSSH expiry times in UTC", () => {
    expect(sshExpiryTime(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("20260102030405Z");
    expect(authorizedKeyLine({ sshPublicKey: KEY, expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5) })).toMatch(/^expiry-time="20260102030405Z" ssh-ed25519 /);
  });
});

describe("the screens route", () => {
  const req = (body: unknown) => ({ body: Buffer.from(JSON.stringify(body)) }) as never;
  it("grants, revokes and reports, refusing companion sessions", async () => {
    const c = controller({ system: fakeSystem() });
    const allow = buildDebugAccessHttp({ controller: c, denyCompanion: () => null });
    const r = await allow("/api/screens/debug-access", "POST", req(signed()));
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r?.body))).toMatchObject({ ok: true, change: "granted", debugAccess: { on: true } });
    const view = await allow("/api/screens/debug-access", "GET", req(null));
    expect(JSON.parse(String(view?.body)).on).toBe(true);
    const bad = await allow("/api/screens/debug-access", "POST", req(signed({}, irk)));
    expect(bad?.status).toBe(403);
    expect(JSON.parse(String(bad?.body)).error).toMatch(/admin device/);
    const off = await allow("/api/screens/debug-access/revoke", "POST", req(revoked(T0 + 90_000)));
    expect(JSON.parse(String(off?.body))).toMatchObject({ change: "revoked", debugAccess: { on: false } });

    const deny = buildDebugAccessHttp({
      controller: c,
      denyCompanion: () => ({ status: 403, headers: {}, body: "companion" }),
    });
    expect((await deny("/api/screens/debug-access", "POST", req(signed())))?.status).toBe(403);
    expect(await allow("/api/screens/other", "GET", req(null))).toBeNull();
    c.stop();
  });
});

describe("the recipe sibling", () => {
  it("reads the debugGrant string or object from the install blob", async () => {
    const p = join(dir, "install-blob.json");
    await writeFile(p, JSON.stringify({ serverDomain: DOMAIN, debugGrant: JSON.stringify(signed()) }));
    expect(await debugGrantFromInstallBlob(p)).toEqual(signed());
    await writeFile(p, JSON.stringify({ serverDomain: DOMAIN, debugGrant: signed() }));
    expect(await debugGrantFromInstallBlob(p)).toEqual(signed());
    await writeFile(p, JSON.stringify({ serverDomain: DOMAIN }));
    expect(await debugGrantFromInstallBlob(p)).toBeNull();
    expect(await debugGrantFromInstallBlob(join(dir, "missing.json"))).toBeNull();
  });
});

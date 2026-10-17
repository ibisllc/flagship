import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIRK, signBackupPolicy, verifyBackupPolicy, type BackupPolicyOrder } from "@flagship/protocol";
import { BackupPolicyStore } from "../../src/backupPolicy/policy.js";
import { BackupCap, limitFor, splitBudget } from "../../src/backupPolicy/cap.js";
import { buildBackupPolicyHttp } from "../../src/backupPolicy/http.js";
import type { AppArchiveBytes } from "../../src/serverArchive/build.js";
import type { HttpRequest } from "../../src/runtime.js";

const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(43) });
const SRV = "home.harry.flagship.services";
const GB = 1024 ** 3;

function signed(o: Partial<BackupPolicyOrder> = {}, signer = owner) {
  const order: BackupPolicyOrder = { serverDomain: SRV, policy: "phone", phoneReserveBytes: 10 * GB, issuedAt: 1000, ...o };
  return { order, signatureHex: Buffer.from(signBackupPolicy(order, signer)).toString("hex") };
}

function store(dir = mkdtempSync(join(tmpdir(), "backup-policy-"))) {
  return new BackupPolicyStore({ path: join(dir, "backup-policy.json"), serverDomain: SRV, authorize: (o, s) => verifyBackupPolicy(o, s, owner.publicKey) });
}

const app = (pg: number, files: number, tree = 0): AppArchiveBytes => ({ postgresBytes: pg, filesBytes: files, treeBytes: tree, totalBytes: pg + files + tree });

const req = (method: string, body?: unknown): HttpRequest => ({
  method,
  path: "/api/screens/backup-policy",
  headers: {},
  body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
});

describe("backup policy store", () => {
  it("is unset until the owner signs one, then keeps the newest across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-policy-"));
    const s = store(dir);
    await s.load();
    expect(s.current()).toEqual({ policy: "unset", phoneReserveBytes: 0, issuedAt: null });
    const seen: string[] = [];
    s.onChange((p) => seen.push(p.policy));
    const a = signed();
    expect(await s.adopt(a.order, a.signatureHex)).toBeNull();
    const b = signed({ policy: "peer", phoneReserveBytes: 0, issuedAt: 2000 });
    expect(await s.adopt(b.order, b.signatureHex)).toBeNull();
    // An older order can't be replayed over the newer choice.
    expect(await s.adopt(a.order, a.signatureHex)).toMatch(/newer backup policy/);
    expect(seen).toEqual(["phone", "peer"]);
    const again = store(dir);
    await again.load();
    expect(again.current()).toEqual({ policy: "peer", phoneReserveBytes: 0, issuedAt: 2000 });
  });

  it("refuses a policy signed by anyone else, for another server, or malformed", async () => {
    const s = store();
    const x = signed({}, stranger);
    expect(await s.adopt(x.order, x.signatureHex)).toMatch(/admin device/);
    const y = signed({ serverDomain: "other.harry.flagship.services" });
    expect(await s.adopt(y.order, y.signatureHex)).toMatch(/different server/);
    expect(await s.adopt({ ...signed().order, phoneReserveBytes: 0 }, signed().signatureHex)).toMatch(/malformed/);
    expect(s.current().policy).toBe("unset");
  });

  it("takes the create-time policy riding beside the pairing order", async () => {
    const s = store();
    const p = signed({ policy: "none", phoneReserveBytes: 0 });
    expect(await s.adoptFromPairingJson(JSON.stringify({ request: {}, signature: "", backupPolicy: p }))).toBe(true);
    expect(s.current().policy).toBe("none");
    expect(await s.adoptFromPairingJson(JSON.stringify({ request: {}, signature: "" }))).toBe(false);
  });
});

describe("backup policy limit", () => {
  it("phone: the phone's reserve; peer: a third of the disk; none/unset: no limit", () => {
    expect(limitFor({ policy: "phone", phoneReserveBytes: 8 * GB, issuedAt: 1 }, 900 * GB)).toBe(8 * GB);
    expect(limitFor({ policy: "peer", phoneReserveBytes: 0, issuedAt: 1 }, 900 * GB)).toBe(300 * GB);
    expect(limitFor({ policy: "none", phoneReserveBytes: 0, issuedAt: 1 }, 900 * GB)).toBeNull();
    expect(limitFor({ policy: "unset", phoneReserveBytes: 0, issuedAt: null }, 900 * GB)).toBeNull();
  });

  it("splits the room left between apps, and each app's growth between Postgres and files", () => {
    const b = splitBudget(10 * GB, new Map([["a", app(2 * GB, 2 * GB)], ["b", app(0, 0, GB)]]));
    // 5 GB used, 5 GB of room, 2.5 GB each.
    expect(b.get("a")).toEqual({ totalBytes: 6.5 * GB, postgresBytes: 3.25 * GB, filesBytes: 3.25 * GB });
    expect(b.get("b")).toEqual({ totalBytes: 3.5 * GB, postgresBytes: 1.25 * GB, filesBytes: 1.25 * GB });
    // Over the limit: no growth for anyone.
    const over = splitBudget(GB, new Map([["a", app(2 * GB, 0)]]));
    expect(over.get("a")).toEqual({ totalBytes: 2 * GB, postgresBytes: 2 * GB, filesBytes: 0 });
  });

  it("refuses new apps, copies and imports past the limit, in the owner's words, and notes crossing it", async () => {
    const s = store();
    const p = signed({ phoneReserveBytes: 5 * GB });
    await s.adopt(p.order, p.signatureHex);
    let perApp = new Map([["harry--notes", app(2 * GB, GB)]]);
    const notes: Array<[string, boolean]> = [];
    const cap = new BackupCap({ policy: s, measure: async () => perApp, diskBytes: async () => 100 * GB, note: (k, _d, ok) => void notes.push([k, ok ?? true]) });
    await cap.refresh();
    expect(cap.admit()).toBeNull();
    expect(cap.admit(3 * GB)).toMatch(/needs about 3\.0 GB .* 2\.0 GB left under its backup limit of 5\.0 GB/);
    perApp = new Map([["harry--notes", app(4 * GB, 2 * GB)]]);
    await cap.refresh();
    expect(cap.overLimit()).toBe(true);
    expect(cap.admit()).toMatch(/holds 6\.0 GB of app data, over its backup limit of 5\.0 GB \(the space your device keeps/);
    expect(cap.view()).toMatchObject({ limitBytes: 5 * GB, usedBytes: 6 * GB, overLimit: true, overReason: expect.any(String) });
    perApp = new Map([["harry--notes", app(GB, 0)]]);
    await cap.refresh();
    expect(notes).toEqual([["server.backup.over-limit", false], ["server.backup.under-limit", true]]);
  });

  it("peer backups can't be chosen by a server already using more than a third of its disk", async () => {
    const s = store();
    const cap = new BackupCap({ policy: s, measure: async () => new Map([["a", app(40 * GB, 0)]]), diskBytes: async () => 90 * GB });
    await cap.refresh();
    const http = buildBackupPolicyHttp({ policy: s, cap });
    const r = await http.handle("/api/screens/backup-policy", "POST", req("POST", signed({ policy: "peer", phoneReserveBytes: 0 })), { companion: false });
    expect(r!.status).toBe(409);
    expect(JSON.parse(String(r!.body)).error).toMatch(/more than a third of its disk \(30 GB\)/);
    expect(s.current().policy).toBe("unset");
  });

  it("a peer-policy server keeps two thirds of its disk for other servers", async () => {
    const s = store();
    const p = signed({ policy: "peer", phoneReserveBytes: 0 });
    await s.adopt(p.order, p.signatureHex);
    const cap = new BackupCap({ policy: s, measure: async () => new Map([["a", app(40 * GB, 0)]]), diskBytes: async () => 90 * GB });
    await cap.refresh();
    expect(cap.limitBytes()).toBe(30 * GB);
    expect(cap.reservedForPeersBytes()).toBe(60 * GB);
    expect(cap.admit()).toMatch(/a third of its disk/);
  });

  it("no backups: no limit at all", async () => {
    const s = store();
    const p = signed({ policy: "none", phoneReserveBytes: 0 });
    await s.adopt(p.order, p.signatureHex);
    const cap = new BackupCap({ policy: s, measure: async () => new Map([["a", app(400 * GB, 0)]]), diskBytes: async () => 500 * GB });
    await cap.refresh();
    expect(cap.admit(50 * GB)).toBeNull();
    expect(cap.appBudgets()).toBeNull();
  });
});

describe("GET/POST /api/screens/backup-policy", () => {
  it("shows the policy, the limit and usage; changes it with a signed order; refuses companions", async () => {
    const s = store();
    const cap = new BackupCap({ policy: s, measure: async () => new Map([["a", app(GB, 0)]]), diskBytes: async () => 30 * GB });
    await cap.refresh();
    const notes: string[] = [];
    const http = buildBackupPolicyHttp({ policy: s, cap, note: (_k, d) => void notes.push(d) });
    const get = JSON.parse(String((await http.handle("/api/screens/backup-policy", "GET", req("GET"), { companion: false }))!.body));
    expect(get).toMatchObject({ policy: { policy: "unset" }, cap: { limitBytes: null, usedBytes: GB }, peer: null });
    const p = signed({ policy: "peer", phoneReserveBytes: 0 });
    http.setPeerStatus(async () => ({ state: "placing", healthyBricks: 3, totalBricks: 5 }));
    const post = await http.handle("/api/screens/backup-policy", "POST", req("POST", p), { companion: false });
    expect(post!.status).toBe(200);
    const v = JSON.parse(String(post!.body));
    expect(v).toMatchObject({ policy: { policy: "peer" }, cap: { limitBytes: 10 * GB, reservedForPeersBytes: 20 * GB }, peer: { state: "placing" } });
    expect(notes).toEqual(["Backup policy: Peer-distributed backups."]);
    const bad = await http.handle("/api/screens/backup-policy", "POST", req("POST", signed({ issuedAt: 3000 }, stranger)), { companion: false });
    expect(bad!.status).toBe(403);
    expect(JSON.parse(String(bad!.body)).error).toMatch(/admin device/);
    expect((await http.handle("/api/screens/backup-policy", "GET", req("GET"), { companion: true }))!.status).toBe(403);
    // A limit the server is already over can't be chosen: 1 GB held, a 0.5 GB phone reserve.
    const tooSmall = await http.handle("/api/screens/backup-policy", "POST", req("POST", signed({ phoneReserveBytes: GB / 2, issuedAt: 4000 })), { companion: false });
    expect(tooSmall!.status).toBe(409);
    expect(JSON.parse(String(tooSmall!.body))).toMatchObject({ code: "over-backup-limit", error: expect.stringMatching(/Reserve at least 1\.0 GB on that device/) });
    expect(s.current().policy).toBe("peer");
    expect(await http.handle("/api/screens/other", "GET", req("GET"), { companion: false })).toBeNull();
  });
});

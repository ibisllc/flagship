/**
 * Rescue session (docs/data-sovereignty.md), end to end over real TLS with
 * `.com` unreachable: the phone finds the box, proves it from the key it
 * derives itself, opens a session with a signed order, makes a backup and
 * downloads it. Every outbound `fetch` throws and the test asserts none was
 * attempted: nothing in this path may ask `.com`, `.services` or anyone else.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRescueHello,
  deriveIRK,
  ed,
  unwrapAccountFromKeyfile,
  wrapAccountToKeyfile,
  wrapUmkToKeyfile,
  deriveServerArchiveKey,
  deriveSTK,
  deriveSWK,
  openBackupWithAccountKey,
  openBackupWithPasscode,
  parseBackupBundleHeader,
  parseBackupFile,
  signAdminRootRotation,
  signDeviceCapabilityGrant,
  signInstallService,
  signRescueSession,
  signRevokeDeviceCapabilityGrant,
  verifyInstallService,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type DeviceCapabilityGrant,
  type Keypair,
  type RescueExchange,
} from "@flagship/protocol";
import { AccountDeviceBook, type ListedGrant } from "../src/accessPrincipals.js";
import { DeviceRevocations } from "../src/deviceRevocations.js";
import { applyDeliveredRotations, type AdminRootPin, type AdminRootPinStore } from "../src/adminRootRotationConsumer.js";
import { buildRescueAuthorize } from "../src/rescue/authority.js";
import { exportNotice } from "../src/rescue/exportNotice.js";
import type { PhoneAlert } from "../src/phoneAlerts.js";
import { FilePairedSessionStore } from "../src/pairedSessionStore.js";
import { buildRescue, RESCUE_SESSION_TTL_MS } from "../src/rescue/rescue.js";
import { buildServerArchiveService } from "../src/serverArchive/service.js";
import { AppCopyOps } from "../src/appCopy/ops.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../src/dataLayer/index.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { InMemoryAppEnvStore } from "../src/serviceEnvStore.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import { _handleHttpConnectionForTest, type HttpRequest, type HttpResponse } from "../src/runtime.js";
import { leafCertSha256 } from "../src/lanDirect.js";
import { writeSourceTree } from "../src/llm/serviceSource.js";
import { swkOps, testCustodian } from "./helpers/keyCustody.js";
import { selfSigned } from "./helpers/selfSignedTls.js";

const FQDN = "home.harry.flagship.services";
const SERVICE = "harry--notes";
const UMK = { seed: new Uint8Array(32).fill(9) };
const irk = deriveIRK(UMK);
const ADMIN_ROOT_SEED = new Uint8Array(32).fill(77);
const adminRoot: Keypair = { privateKey: ADMIN_ROOT_SEED, publicKey: ed.getPublicKey(ADMIN_ROOT_SEED) };
const stk = deriveSTK(deriveSWK(UMK, FQDN));
const box = testCustodian({ identityPriv: stk.privateKey, swk: new Uint8Array(32).fill(4), cgk: new Uint8Array(32).fill(5) });
const PASSCODE = "k7qm-2xhd-9twp-4frn-6cyb";
const ARCHIVE_ID = "00112233445566778899aabbccddeeff";
const CONTENT_KEY = Buffer.alloc(32, 0x5a);
const slots = () => [
  wrapPasscodeSlot(ARCHIVE_ID, CONTENT_KEY, PASSCODE, new Uint8Array(16).fill(1), new Uint8Array(12).fill(2), { m: 64, t: 1, p: 1 }),
  wrapAccountSlot(ARCHIVE_ID, CONTENT_KEY, deriveServerArchiveKey(UMK, ARCHIVE_ID), new Uint8Array(12).fill(3)),
];
const MANIFEST = {
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  runtime: { image: "flagship-vibe-harry--notes:1", port: 8080 },
  data: { stores: { postgres: true, files: true } },
  network: { subdomain: "notes" },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
};

let clock = Date.now();
const fetchSpy = vi.fn(async () => {
  throw new Error("the network is unreachable (.com and .services are down)");
});

async function archiveService(dir: string, onExport?: (e: { stage: "downloaded" | "browser-approved" }) => void) {
  const provisioner = new DataProvisioner({ postgres: new InMemoryPostgresAdmin(), files: new InMemoryFilesAdmin(), nameKey: "s".repeat(40) });
  const cmd: CommandRunner = { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) };
  const platform = new ServicePlatform({
    host: { username: "harry", irkPub: irk.publicKey },
    hostIdentityPub: box.boxPublicKey(),
    swk: swkOps(new Uint8Array(32).fill(1)),
    appRunner: new AppRunner(cmd),
    dataProvisioner: provisioner,
    startCheck: async () => ({ ok: true }),
  });
  const request = { serverId: FQDN, creator: "harry", slug: "notes", manifestJson: JSON.stringify(MANIFEST), addOwnerToMembership: true, issuedAt: Date.now() };
  const installed = await platform.install({ request, signature: signInstallService(request, irk), verify: verifyInstallService });
  if (!installed.ok) throw new Error(installed.reason);
  const ops: AppCopyOps = {
    saveImage: async () => {
      throw new Error("a backup must never carry an image");
    },
    loadImage: async () => {},
    imageExists: async () => true,
    removeImage: async () => {},
    dumpDatabase: async (s, out) => writeFile(out, `rows-of-${s.database}`),
    restoreDatabase: async () => {},
    archiveFiles: async (v, _c, out) => writeFile(out, `files-of-${v}`),
    restoreFiles: async () => {},
  };
  const clones = join(dir, "clones");
  await writeSourceTree(join(clones, SERVICE), { "flagship.app.json": JSON.stringify(MANIFEST), "server.js": "listen()" }, {});
  const events: Array<{ kind: string; ok: boolean }> = [];
  const svc = buildServerArchiveService({
    dir: join(dir, "archives"),
    wait: null,
    build: { serverFqdn: FQDN, apps: () => [platform.byServiceId(SERVICE)!], containerName: (id) => `flagship-${id}`, ops, envStore: new InMemoryAppEnvStore(), access: null, accessList: null, sourceDir: clones },
    restore: {
      serverFqdn: FQDN,
      platform,
      dataProvisioner: provisioner,
      ops,
      signInstall: (r) => box.signInstallService(r),
      envStore: null,
      access: null,
      egress: null,
      buildImage: async () => ({ ok: true as const }),
      pullImage: async () => {},
    },
    note: (kind, _d, ok = true) => void events.push({ kind, ok }),
    ...(onExport ? { onExport } : {}),
    freeBytes: async () => 1e12,
  });
  return { svc, platform, events };
}

interface Rig {
  port: number;
  certSha: string;
  rescue: ReturnType<typeof buildRescue>;
  notes: Array<{ kind: string; ok: boolean }>;
  alerts: PhoneAlert[];
  /** Grants `.com` would list; push to it to "admit" a device. */
  listed: ListedGrant[];
  book: AccountDeviceBook;
  revocations: DeviceRevocations;
  pins: { current: AdminRootPin | null; restarts: number };
  refreshBook: () => Promise<void>;
  close: () => Promise<void>;
}

/** A box: real TLS in front of the daemon's own screens handler, `adminPinned` as the config says. */
async function startBox(opts: { adminPinned: boolean; expiredCert?: boolean; coolingMs?: number }): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "rescue-"));
  const alerts: PhoneAlert[] = [];
  const notify = exportNotice({ alert: (a) => alerts.push(a), now: () => clock });
  const { svc, platform } = await archiveService(dir, notify);
  const tlsMaterial = await selfSigned(FQDN, { expired: opts.expiredCert === true });
  const notes: Array<{ kind: string; ok: boolean }> = [];
  const listed: ListedGrant[] = [];
  const revocations = new DeviceRevocations({
    path: join(dir, "device-revocations.json"),
    username: "harry",
    adminRootPub: () => (opts.adminPinned ? adminRoot.publicKey : undefined),
    now: () => clock,
  });
  const book = new AccountDeviceBook({
    path: join(dir, "account-devices.json"),
    username: "harry",
    ownerIrkPub: () => irk.publicKey,
    adminRootPub: () => (opts.adminPinned ? adminRoot.publicKey : undefined),
    isRevoked: (id) => revocations.has(id),
    fetchGrants: async () => ({ grants: listed }),
    now: () => clock,
  });
  revocations.subscribe((id) => void book.dropGrant(id));
  const pins: { current: AdminRootPin | null; restarts: number } = { current: null, restarts: 0 };
  const pinStore: AdminRootPinStore = { read: async () => pins.current, write: async (p) => void (pins.current = p) };
  const rescue = buildRescue({
    serverFqdn: FQDN,
    signAsBox: (m) => box.signAsBox(m),
    certSha256: () => leafCertSha256(tlsMaterial.cert),
    authorize: buildRescueAuthorize({
      irkPub: () => irk.publicKey,
      adminRootPub: () => (opts.adminPinned ? adminRoot.publicKey : undefined),
      username: "harry",
      adminGrants: () => book.adminGrants(),
      now: () => clock,
    }),
    ...(opts.coolingMs !== undefined ? { coolingMs: opts.coolingMs } : {}),
    revocations,
    rotations: async (entries) => {
      const out = await applyDeliveredRotations({
        username: "harry",
        seedAdminRootHex: opts.adminPinned ? Buffer.from(adminRoot.publicKey).toString("hex") : null,
        pinStore,
        entries,
        restart: () => void pins.restarts++,
        now: () => clock,
      });
      return { rotated: out.rotated, ...(out.rotated ? {} : { reason: out.reason }) };
    },
    archive: svc,
    apps: () => platform.list().map((a) => ({ serviceId: a.serviceId, name: a.manifest.name })),
    note: (kind, _d, ok = true) => void notes.push({ kind, ok }),
    onExport: notify,
    now: () => clock,
  });
  const paired = new FilePairedSessionStore(join(dir, "paired-sessions.json"));
  const screens = buildScreensHttp({ serverFqdn: FQDN, username: "harry", daemonVersion: "t", startedAt: 1, gate: paired, rescue, serverArchive: svc });
  const handler = async (req: HttpRequest): Promise<HttpResponse> => (await screens(req)) ?? { status: 404, headers: {}, body: "not found" };
  const server = tls.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, (s) => _handleHttpConnectionForTest(s, handler));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    certSha: leafCertSha256(tlsMaterial.cert)!,
    rescue,
    notes,
    alerts,
    listed,
    book,
    revocations,
    pins,
    refreshBook: () => book.refresh(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** An admin device of the account: its own key and a grant the admin root signed `ageMs` ago. */
function admitAdminDevice(rig: Rig, seedByte: number, ageMs: number, grantId = `grant-${seedByte}-abcdef`): { key: Keypair; grant: DeviceCapabilityGrant } {
  const key = deriveIRK({ seed: new Uint8Array(32).fill(seedByte) });
  const grant: DeviceCapabilityGrant = {
    grantId,
    username: "harry",
    deviceId: Buffer.alloc(16, seedByte).toString("hex"),
    devicePubKey: key.publicKey,
    scopes: ["admin"],
    issuedAt: clock - ageMs,
    expiresAt: clock - ageMs + 90 * 86_400_000,
  };
  rig.listed.push({
    grantId,
    username: "harry",
    deviceId: grant.deviceId,
    devicePubHex: Buffer.from(key.publicKey).toString("hex"),
    scopes: ["admin"],
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: Buffer.from(signDeviceCapabilityGrant(grant, adminRoot)).toString("hex"),
    signerRoot: "admin-root",
  });
  return { key, grant };
}

interface Reply {
  status: number;
  json: any;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** The leaf certificate the connection actually presented. */
  seenCertSha: string;
}

/** What the phone's HTTP stack does: connect by address, the box's name as SNI, accept ANY certificate and report which one it saw. */
function request(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown | Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(JSON.stringify(opts.body));
    const req = https.request(
      { host: "127.0.0.1", port, method, path, servername: FQDN, rejectUnauthorized: false, agent: false, headers: { ...(payload ? { "content-length": String(payload.length), "content-type": "application/json" } : {}), ...opts.headers } },
      (res) => {
        const seen = (res.socket as tls.TLSSocket).getPeerCertificate(true).raw;
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          const body = Buffer.concat(parts);
          let json: unknown = null;
          try {
            json = JSON.parse(body.toString("utf8"));
          } catch {
            /* binary */
          }
          resolve({ status: res.statusCode ?? 0, json, body, headers: res.headers, seenCertSha: createHash("sha256").update(seen).digest("hex") });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const nonce = () => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("hex");

/** The phone's half: hello, check it against the key derived from the account, sign, open the session. */
async function openSession(port: number, signer: Keypair, over: { mutate?: (o: RescueExchange) => RescueExchange } = {}): Promise<{ token: string; reply: Reply }> {
  const clientNonce = nonce();
  const h = await request(port, "POST", "/api/rescue/hello", { body: { clientNonce } });
  expect(h.status).toBe(200);
  const hello = h.json.hello as RescueExchange;
  const check = checkRescueHello(hello, Buffer.from(h.json.signatureHex, "hex"), stk.publicKey, { serverDomain: FQDN, clientNonce, seenCertSha256: h.seenCertSha, now: clock });
  expect(check).toEqual({ ok: true });
  const order = over.mutate ? over.mutate(hello) : { ...hello, issuedAt: clock };
  const reply = await request(port, "POST", "/api/rescue/session", { body: { order, signatureHex: Buffer.from(signRescueSession(order, signer)).toString("hex") } });
  return { token: reply.json?.token as string, reply };
}

const auth = (token: string) => ({ "x-flagship-rescue": token });

async function backUpAndDownload(port: number, token: string): Promise<Buffer> {
  const start = await request(port, "POST", "/api/rescue/archive/start", { headers: auth(token), body: { archiveId: ARCHIVE_ID, key: CONTENT_KEY.toString("hex"), slots: slots() } });
  expect(start.status).toBe(202);
  let state = "building";
  for (let i = 0; i < 200 && state === "building"; i++) {
    state = (await request(port, "GET", "/api/rescue/archive", { headers: auth(token) })).json.archive.state;
    if (state === "building") await new Promise((r) => setTimeout(r, 10));
  }
  expect(state).toBe("ready");
  const parts: Buffer[] = [];
  let total = Infinity;
  for (let offset = 0; offset < total; ) {
    const c = await request(port, "GET", `/api/rescue/archive/bundle?offset=${offset}`, { headers: auth(token) });
    expect(c.status).toBe(200);
    total = Number(c.headers["x-flagship-bundle-bytes"]);
    parts.push(c.body);
    offset += c.body.length;
  }
  return Buffer.concat(parts);
}

beforeAll(() => {
  vi.stubGlobal("fetch", fetchSpy);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  clock = Date.now();
  fetchSpy.mockClear();
});

describe("rescue session with .com unreachable", () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });

  it("opens with the admin root, makes a backup and downloads it, asking nobody", async () => {
    rig = await startBox({ adminPinned: true });
    const { token, reply } = await openSession(rig.port, adminRoot);
    expect(reply.status).toBe(200);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.json.expiresAt).toBe(clock + RESCUE_SESSION_TTL_MS);

    const server = await request(rig.port, "GET", "/api/rescue/server", { headers: auth(token) });
    expect(server.json).toMatchObject({ serverDomain: FQDN, apps: [{ serviceId: SERVICE, name: "notes" }] });

    const file = await backUpAndDownload(rig.port, token);
    const head = parseBackupBundleHeader(file.subarray(0, 16), file.length);
    const backup = parseBackupFile(file.subarray(head.metaOffset, head.dataOffset).toString("utf8"));
    // A stranger's account opens it with the passcode alone.
    const viaPass = openBackupWithPasscode(backup, PASSCODE);
    expect(viaPass.body).toMatchObject({ server: { domain: FQDN }, apps: [{ serviceId: SERVICE, name: "notes" }] });
    expect(viaPass.body.data.bytes).toBe(head.dataLength);
    expect(openBackupWithAccountKey(backup, deriveServerArchiveKey(UMK, ARCHIVE_ID))!.body).toEqual(viaPass.body);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rig.notes.map((n) => n.kind)).toEqual(["server.rescue.opened"]);
  });

  it("works with an expired certificate: the phone trusts the key, not the calendar", async () => {
    rig = await startBox({ adminPinned: true, expiredCert: true });
    const { token, reply } = await openSession(rig.port, adminRoot);
    expect(reply.status).toBe(200);
    const file = await backUpAndDownload(rig.port, token);
    expect(parseBackupBundleHeader(file.subarray(0, 16), file.length).dataLength).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on a box that pins no admin root the IRK opens it; on one that does, the IRK does not", async () => {
    rig = await startBox({ adminPinned: false });
    expect((await openSession(rig.port, irk)).reply.status).toBe(200);
    await rig.close();
    rig = await startBox({ adminPinned: true });
    const refused = await openSession(rig.port, irk);
    expect(refused.reply.status).toBe(403);
    expect(refused.reply.json.code).toBe("rescue-refused");
    expect(rig.notes).toEqual([{ kind: "server.rescue.refused", ok: false }]);
  });

  it("an order from someone who is not the owner is refused", async () => {
    rig = await startBox({ adminPinned: true });
    const stranger = deriveIRK({ seed: new Uint8Array(32).fill(5) });
    expect((await openSession(rig.port, stranger)).reply.status).toBe(403);
  });

  it("a hello is good for one order: a replay of the same signed order is refused", async () => {
    rig = await startBox({ adminPinned: true });
    const clientNonce = nonce();
    const h = await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce } });
    const order = { ...(h.json.hello as RescueExchange), issuedAt: clock };
    const body = { order, signatureHex: Buffer.from(signRescueSession(order, adminRoot)).toString("hex") };
    expect((await request(rig.port, "POST", "/api/rescue/session", { body })).status).toBe(200);
    expect((await request(rig.port, "POST", "/api/rescue/session", { body })).status).toBe(403);
  });

  it("an order for another connection's certificate, another nonce, another server or an old hello is refused", async () => {
    rig = await startBox({ adminPinned: true });
    const cases: Array<(o: RescueExchange) => RescueExchange> = [
      (o) => ({ ...o, certSha256: "ee".repeat(32) }),
      (o) => ({ ...o, clientNonce: nonce() }),
      (o) => ({ ...o, boxNonce: nonce() }),
      (o) => ({ ...o, serverDomain: "other.harry.flagship.services" }),
    ];
    for (const mutate of cases) {
      const r = await openSession(rig.port, adminRoot, { mutate: (o) => mutate({ ...o, issuedAt: clock }) });
      expect(r.reply.status).toBe(403);
    }
    // An order signed too long after its hello.
    const clientNonce = nonce();
    const h = await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce } });
    clock += 3 * 60_000;
    const order = { ...(h.json.hello as RescueExchange), issuedAt: clock };
    const late = await request(rig.port, "POST", "/api/rescue/session", { body: { order, signatureHex: Buffer.from(signRescueSession(order, adminRoot)).toString("hex") } });
    expect(late.status).toBe(403);
  });

  it("a machine in the middle is caught by the phone before it signs anything", async () => {
    rig = await startBox({ adminPinned: true });
    const real = rig;
    // Another box-shaped server with ITS OWN certificate that forwards everything to the real one.
    const rogueTls = await selfSigned(FQDN);
    const rogue = tls.createServer({ cert: rogueTls.cert, key: rogueTls.key }, (s) => {
      const up = tls.connect({ host: "127.0.0.1", port: real.port, servername: FQDN, rejectUnauthorized: false });
      s.pipe(up).pipe(s);
      s.on("error", () => up.destroy());
      up.on("error", () => s.destroy());
    });
    await new Promise<void>((r) => rogue.listen(0, "127.0.0.1", () => r()));
    try {
      const rogueCertSha = leafCertSha256(rogueTls.cert)!;
      const clientNonce = nonce();
      const h = await request((rogue.address() as AddressInfo).port, "POST", "/api/rescue/hello", { body: { clientNonce } });
      expect(h.status).toBe(200);
      expect(h.seenCertSha).toBe(rogueCertSha);
      // The hello is genuine (the box signed it) but names the box's certificate, not the one on this connection.
      expect(checkRescueHello(h.json.hello, Buffer.from(h.json.signatureHex, "hex"), stk.publicKey, { serverDomain: FQDN, clientNonce, seenCertSha256: h.seenCertSha, now: clock })).toEqual({ ok: false, reason: "cert-mismatch" });
      // Had the phone signed anyway, the order would carry the rogue's hash and the box would refuse it.
      const order = { ...(h.json.hello as RescueExchange), certSha256: rogueCertSha, issuedAt: clock };
      const r = await request((rogue.address() as AddressInfo).port, "POST", "/api/rescue/session", { body: { order, signatureHex: Buffer.from(signRescueSession(order, adminRoot)).toString("hex") } });
      expect(r.status).toBe(403);
    } finally {
      await new Promise<void>((r) => rogue.close(() => r()));
    }
  });

  it("the token opens the backup routes and nothing else", async () => {
    rig = await startBox({ adminPinned: true });
    const { token } = await openSession(rig.port, adminRoot);
    const h = auth(token);
    // Not the paired-session screens: the gate does not know this token.
    expect((await request(rig.port, "GET", "/api/screens/server-archive", { headers: h })).status).toBe(401);
    expect((await request(rig.port, "GET", "/api/screens/services", { headers: h })).status).toBe(401);
    // Not the rest of the archive surface.
    for (const [m, p] of [
      ["POST", "/api/rescue/archive/link"],
      ["POST", "/api/rescue/archive/approve"],
      ["POST", "/api/rescue/archive/probe-link"],
      ["POST", "/api/rescue/archive/restore"],
      ["GET", "/api/rescue/archive/backups"],
      ["POST", "/api/rescue/archive/backups/run"],
      ["GET", "/api/rescue/archive/../../screens/services"],
      ["GET", "/api/rescue/other"],
    ] as const) {
      const r = await request(rig.port, m, p, { headers: h, body: m === "POST" ? {} : undefined });
      expect([404, 401]).toContain(r.status);
    }
    // No token, a malformed one and a made-up one.
    expect((await request(rig.port, "GET", "/api/rescue/server")).status).toBe(401);
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth("zz") })).status).toBe(401);
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth("ab".repeat(32)) })).status).toBe(401);
  });

  it("a backup through the rescue route still needs a passcode", async () => {
    rig = await startBox({ adminPinned: true });
    const { token } = await openSession(rig.port, adminRoot);
    const r = await request(rig.port, "POST", "/api/rescue/archive/start", { headers: auth(token), body: { archiveId: ARCHIVE_ID, key: CONTENT_KEY.toString("hex"), slots: [slots()[1]] } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("passcode-required");
  });

  it("a session ends after an hour, and a fifth evicts the oldest", async () => {
    rig = await startBox({ adminPinned: true });
    const first = await openSession(rig.port, adminRoot);
    clock += RESCUE_SESSION_TTL_MS + 1;
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth(first.token) })).status).toBe(401);
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      tokens.push((await openSession(rig.port, adminRoot)).token);
    }
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth(tokens[0]!) })).status).toBe(401);
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth(tokens[4]!) })).status).toBe(200);
    expect(rig.rescue.openSessions()).toBe(4);
  });

  it("refusals never lock the owner out, and the activity log hears of them at most every ten seconds", async () => {
    rig = await startBox({ adminPinned: true });
    const stranger = deriveIRK({ seed: new Uint8Array(32).fill(5) });
    for (let i = 0; i < 25; i++) expect((await openSession(rig.port, stranger)).reply.status).toBe(403);
    expect(rig.notes.filter((n) => n.kind === "server.rescue.refused")).toHaveLength(1);
    expect((await openSession(rig.port, adminRoot)).reply.status).toBe(200);
    clock += 11_000;
    await openSession(rig.port, stranger);
    expect(rig.notes.filter((n) => n.kind === "server.rescue.refused")).toHaveLength(2);
  });

  it("hello needs a well-formed nonce and is bounded", async () => {
    rig = await startBox({ adminPinned: true });
    expect((await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce: "short" } })).status).toBe(400);
    expect((await request(rig.port, "POST", "/api/rescue/hello", { body: Buffer.from("not json") })).status).toBe(400);
    for (let i = 0; i < 300; i++) expect((await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce: nonce() } })).status).toBe(200);
    expect((await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce: nonce() } })).status).toBe(429);
    clock += 61_000;
    expect((await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce: nonce() } })).status).toBe(200);
  });

  it("a flood of hellos drops the oldest pending one instead of refusing the owner", async () => {
    rig = await startBox({ adminPinned: true });
    const clientNonce = nonce();
    const first = await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce } });
    for (let i = 0; i < 256; i++) await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce: nonce() } });
    const late = await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce: nonce() } });
    expect(late.status).toBe(200);
    const order = { ...(first.json.hello as RescueExchange), issuedAt: clock };
    const stale = await request(rig.port, "POST", "/api/rescue/session", { body: { order, signatureHex: Buffer.from(signRescueSession(order, adminRoot)).toString("hex") } });
    expect(stale.status).toBe(403);
    expect((await openSession(rig.port, adminRoot)).reply.status).toBe(200);
  });
});


describe("admin devices, revocation and rotation without .com", () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });

  const revoke = (grantId: string, signer: Keypair = adminRoot, issuedAt = clock) => {
    const r = { grantId, username: "harry", reason: "stolen" as const, issuedAt };
    return { revoke: r, signatureHex: Buffer.from(signRevokeDeviceCapabilityGrant(r, signer)).toString("hex") };
  };

  it("an admin device opens a session with its own key once its grant is 24 hours old, the admin key at once", async () => {
    rig = await startBox({ adminPinned: true });
    const old = admitAdminDevice(rig, 21, 25 * 3_600_000);
    const fresh = admitAdminDevice(rig, 22, 2 * 3_600_000);
    await rig.refreshBook();
    expect((await openSession(rig.port, old.key)).reply.status).toBe(200);
    const tooNew = await openSession(rig.port, fresh.key);
    expect(tooNew.reply.status).toBe(403);
    expect(tooNew.reply.json.code).toBe("admin-too-new");
    expect(tooNew.reply.json.error).toMatch(/less than 24 hours ago.*about 22 more.*admin key itself/);
    // The original key is never held back.
    expect((await openSession(rig.port, adminRoot)).reply.status).toBe(200);
    clock += 23 * 3_600_000;
    expect((await openSession(rig.port, fresh.key)).reply.status).toBe(200);
  });

  it("a device with no grant, or only a membership grant, gets nothing", async () => {
    rig = await startBox({ adminPinned: true });
    const stranger = deriveIRK({ seed: new Uint8Array(32).fill(23) });
    expect((await openSession(rig.port, stranger)).reply.status).toBe(403);
    // A member-scope grant is not admin authority.
    const key = deriveIRK({ seed: new Uint8Array(32).fill(24) });
    const g: DeviceCapabilityGrant = { grantId: "grant-24-abcdef", username: "harry", deviceId: Buffer.alloc(16, 24).toString("hex"), devicePubKey: key.publicKey, scopes: ["browse"], issuedAt: clock - 3 * 86_400_000, expiresAt: clock + 86_400_000 };
    rig.listed.push({ grantId: g.grantId, username: "harry", deviceId: g.deviceId, devicePubHex: Buffer.from(key.publicKey).toString("hex"), scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt, signatureHex: Buffer.from(signDeviceCapabilityGrant(g, adminRoot)).toString("hex") });
    await rig.refreshBook();
    expect((await openSession(rig.port, key)).reply.status).toBe(403);
  });

  it("a revocation the admin key delivers directly applies at once, kills that device's open sessions, and survives .com listing the grant again", async () => {
    rig = await startBox({ adminPinned: true });
    const dev = admitAdminDevice(rig, 31, 3 * 86_400_000);
    await rig.refreshBook();
    const open = await openSession(rig.port, dev.key);
    expect(open.reply.status).toBe(200);
    const other = await openSession(rig.port, adminRoot);
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth(open.token) })).status).toBe(200);

    const r = await request(rig.port, "POST", "/api/rescue/revoke", { body: revoke(dev.grant.grantId) });
    expect(r.status).toBe(200);
    // The race: a session opened a moment before is dead the moment the box has the order.
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth(open.token) })).status).toBe(401);
    expect((await request(rig.port, "GET", "/api/rescue/server", { headers: auth(other.token) })).status).toBe(200);
    expect((await openSession(rig.port, dev.key)).reply.status).toBe(403);
    // `.com` lists the grant again (stale, or lying): nothing changes.
    await rig.refreshBook();
    expect(rig.listed.some((g) => g.grantId === dev.grant.grantId)).toBe(true);
    expect((await openSession(rig.port, dev.key)).reply.status).toBe(403);
    expect(rig.revocations.has(dev.grant.grantId)).toBe(true);
    expect(rig.notes.map((n) => n.kind)).toContain("server.device.revoked");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a revocation survives a restart of the box", async () => {
    rig = await startBox({ adminPinned: true });
    const dev = admitAdminDevice(rig, 32, 3 * 86_400_000);
    await request(rig.port, "POST", "/api/rescue/revoke", { body: revoke(dev.grant.grantId) });
    const again = new DeviceRevocations({ path: (rig.revocations as unknown as { opts: { path: string } }).opts.path, username: "harry", adminRootPub: () => adminRoot.publicKey });
    await again.load();
    expect(again.has(dev.grant.grantId)).toBe(true);
  });

  it("only the admin key can revoke: not a device, not the IRK, not a forged or misdirected order", async () => {
    rig = await startBox({ adminPinned: true });
    const dev = admitAdminDevice(rig, 33, 3 * 86_400_000);
    const victim = admitAdminDevice(rig, 34, 3 * 86_400_000);
    await rig.refreshBook();
    for (const body of [
      revoke(victim.grant.grantId, dev.key),
      revoke(victim.grant.grantId, irk),
      revoke(victim.grant.grantId, deriveIRK({ seed: new Uint8Array(32).fill(99) })),
      { ...revoke(victim.grant.grantId), revoke: { ...revoke(victim.grant.grantId).revoke, grantId: dev.grant.grantId } },
      revoke(victim.grant.grantId, adminRoot, clock + 60 * 60_000),
      { revoke: { grantId: 5 }, signatureHex: "00" },
    ]) {
      expect((await request(rig.port, "POST", "/api/rescue/revoke", { body })).status).toBeGreaterThanOrEqual(400);
    }
    expect(rig.revocations.list()).toEqual([]);
    expect((await openSession(rig.port, victim.key)).reply.status).toBe(200);
    // A box that pins no admin key can't revoke a device this way.
    await rig.close();
    rig = await startBox({ adminPinned: false });
    expect((await request(rig.port, "POST", "/api/rescue/revoke", { body: revoke("grant-35-abcdef") })).status).toBe(403);
  });

  it("a rotation the admin key delivers directly re-pins the box and the old key is out", async () => {
    rig = await startBox({ adminPinned: true });
    const next = deriveIRK({ seed: new Uint8Array(32).fill(88) });
    const rot = { username: "harry", oldAdminRootPub: adminRoot.publicKey, newAdminRootPub: next.publicKey, issuedAt: clock };
    const entry = { seq: 1, oldAdminRootPub: Buffer.from(adminRoot.publicKey).toString("hex"), newAdminRootPub: Buffer.from(next.publicKey).toString("hex"), issuedAt: clock, signatureHex: Buffer.from(signAdminRootRotation(rot, adminRoot)).toString("hex") };
    const r = await request(rig.port, "POST", "/api/rescue/admin-root-rotation", { body: { rotations: [entry] } });
    expect(r.status).toBe(200);
    expect(rig.pins.restarts).toBe(1);
    expect(rig.pins.current?.adminRootPubHex).toBe(entry.newAdminRootPub);
    expect(rig.notes.map((n) => n.kind)).toContain("server.admin.rotated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a rotation that doesn't continue the pinned key changes nothing, whoever sends it", async () => {
    rig = await startBox({ adminPinned: true });
    const evil = deriveIRK({ seed: new Uint8Array(32).fill(66) });
    const stranger = deriveIRK({ seed: new Uint8Array(32).fill(67) });
    const rot = { username: "harry", oldAdminRootPub: stranger.publicKey, newAdminRootPub: evil.publicKey, issuedAt: clock };
    const bad = { seq: 1, oldAdminRootPub: Buffer.from(stranger.publicKey).toString("hex"), newAdminRootPub: Buffer.from(evil.publicKey).toString("hex"), issuedAt: clock, signatureHex: Buffer.from(signAdminRootRotation(rot, stranger)).toString("hex") };
    expect((await request(rig.port, "POST", "/api/rescue/admin-root-rotation", { body: { rotations: [bad] } })).status).toBe(403);
    // Right chain, wrong signer.
    const forged = { ...bad, oldAdminRootPub: Buffer.from(adminRoot.publicKey).toString("hex") };
    expect((await request(rig.port, "POST", "/api/rescue/admin-root-rotation", { body: { rotations: [forged] } })).status).toBe(403);
    expect((await request(rig.port, "POST", "/api/rescue/admin-root-rotation", { body: { rotations: [] } })).status).toBe(400);
    expect(rig.pins.current).toBeNull();
    expect(rig.pins.restarts).toBe(0);
  });
});

describe("every copy that leaves the server is told to the admin devices", () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });

  it("a rescue session raises an alert naming who opened it and the acting phone's own nonce, and the activity log has its line", async () => {
    rig = await startBox({ adminPinned: true });
    const clientNonce = nonce();
    const h = await request(rig.port, "POST", "/api/rescue/hello", { body: { clientNonce } });
    const order = { ...(h.json.hello as RescueExchange), issuedAt: clock };
    await request(rig.port, "POST", "/api/rescue/session", { body: { order, signatureHex: Buffer.from(signRescueSession(order, adminRoot)).toString("hex") } });
    expect(rig.alerts).toEqual([{ kind: "backup-exported", serviceId: "", stage: "rescue-opened", by: "the admin key", ref: clientNonce, at: clock }]);
    expect(rig.notes.map((n) => n.kind)).toEqual(["server.rescue.opened"]);
  });

  it("an admin device's session names the device", async () => {
    rig = await startBox({ adminPinned: true });
    const dev = admitAdminDevice(rig, 41, 3 * 86_400_000);
    await rig.refreshBook();
    await openSession(rig.port, dev.key);
    expect(rig.alerts[0]).toMatchObject({ stage: "rescue-opened", by: `admin device ${dev.grant.deviceId.slice(0, 8)}` });
  });

  it("finishing the download raises a second alert, through the same route a normal backup uses", async () => {
    rig = await startBox({ adminPinned: true });
    const { token } = await openSession(rig.port, adminRoot);
    await backUpAndDownload(rig.port, token);
    expect(rig.alerts.map((a) => (a as { stage: string }).stage)).toEqual(["rescue-opened", "downloaded"]);
  });
});

describe("exportNotice", () => {
  it("emits an alert each time and wakes the phones at most once a minute, with nothing in the wake", async () => {
    let t = 1_000_000;
    const alerts: unknown[] = [];
    let wakes = 0;
    const notify = exportNotice({ alert: (a) => alerts.push(a), wake: async () => void wakes++, now: () => t });
    notify({ stage: "downloaded" });
    notify({ stage: "browser-approved" });
    t += 61_000;
    notify({ stage: "downloaded" });
    expect(alerts).toHaveLength(3);
    expect(wakes).toBe(2);
    expect(JSON.stringify(alerts[0])).not.toMatch(/archive|app|notes|harry/i);
  });
  it("a failing push never loses the alert or throws", async () => {
    const alerts: unknown[] = [];
    const notify = exportNotice({ alert: (a) => alerts.push(a), wake: async () => { throw new Error("com is down"); } });
    expect(() => notify({ stage: "downloaded" })).not.toThrow();
    expect(alerts).toHaveLength(1);
  });
});

describe("a fresh install that has only the account key file", () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });
  const FAST = { m: 512, t: 1, p: 1 };
  const META = { username: "harry", createdAt: "2026-10-18T00:00:00.000Z" };

  it("rescues with the admin root and the server list the v2 file carried, asking nobody", async () => {
    rig = await startBox({ adminPinned: true });
    const file = wrapAccountToKeyfile({ umk: UMK, adminRootSeed: ADMIN_ROOT_SEED, servers: [{ domain: FQDN }] }, "correct horse battery", META, FAST);
    const restored = unwrapAccountFromKeyfile(file, "correct horse battery");
    const key: Keypair = { privateKey: restored.account.adminRootSeed!, publicKey: ed.getPublicKey(restored.account.adminRootSeed!) };
    expect(restored.account.servers.map((s) => s.domain)).toEqual([FQDN]);
    // The phone derives the box's key from the restored UMK, never asking where the box is from `.com`.
    const stkFromFile = deriveSTK(deriveSWK(restored.umk, restored.account.servers[0]!.domain));
    expect(Buffer.from(stkFromFile.publicKey)).toEqual(Buffer.from(stk.publicKey));
    const { token, reply } = await openSession(rig.port, key);
    expect(reply.status).toBe(200);
    expect(parseBackupBundleHeader((await backUpAndDownload(rig.port, token)).subarray(0, 16), 1e9).metaLength).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a v1 file (the account key alone) cannot rescue a box that pins an admin key: the IRK is refused", async () => {
    rig = await startBox({ adminPinned: true });
    const restored = unwrapAccountFromKeyfile(wrapUmkToKeyfile(UMK, "correct horse battery", META, FAST), "correct horse battery");
    expect(restored.account.adminRootSeed).toBeUndefined();
    const refused = await openSession(rig.port, deriveIRK(restored.umk));
    expect(refused.reply.status).toBe(403);
  });
});

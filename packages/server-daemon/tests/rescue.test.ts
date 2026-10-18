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
  deriveServerArchiveKey,
  deriveSTK,
  deriveSWK,
  openBackupWithAccountKey,
  openBackupWithPasscode,
  parseBackupBundleHeader,
  parseBackupFile,
  signInstallService,
  signRescueSession,
  verifyInstallService,
  verifyRescueSession,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type Keypair,
  type RescueExchange,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../src/adminAuthorityLocal.js";
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
const adminRoot: Keypair = deriveIRK({ seed: new Uint8Array(32).fill(77) });
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

async function archiveService(dir: string) {
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
    freeBytes: async () => 1e12,
  });
  return { svc, platform, events };
}

interface Rig {
  port: number;
  certSha: string;
  rescue: ReturnType<typeof buildRescue>;
  notes: Array<{ kind: string; ok: boolean }>;
  close: () => Promise<void>;
}

/** A box: real TLS in front of the daemon's own screens handler, `adminPinned` as the config says. */
async function startBox(opts: { adminPinned: boolean; expiredCert?: boolean; rogueFor?: (req: HttpRequest) => Promise<HttpResponse | null> }): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "rescue-"));
  const { svc, platform, events } = await archiveService(dir);
  const tlsMaterial = await selfSigned(FQDN, { expired: opts.expiredCert === true });
  const notes: Array<{ kind: string; ok: boolean }> = [];
  const rescue = buildRescue({
    serverFqdn: FQDN,
    signAsBox: (m) => box.signAsBox(m),
    certSha256: () => leafCertSha256(tlsMaterial.cert),
    authorize: (order, signature) =>
      authorizeSensitiveOrder({
        ownerIrkPub: irk.publicKey,
        ...(opts.adminPinned ? { adminRootPub: adminRoot.publicKey } : {}),
        username: "harry",
        order,
        signature,
        verify: verifyRescueSession,
      }),
    archive: svc,
    apps: () => platform.list().map((a) => ({ serviceId: a.serviceId, name: a.manifest.name })),
    note: (kind, _d, ok = true) => void notes.push({ kind, ok }),
    now: () => clock,
  });
  const paired = new FilePairedSessionStore(join(dir, "paired-sessions.json"));
  const screens = buildScreensHttp({ serverFqdn: FQDN, username: "harry", daemonVersion: "t", startedAt: 1, gate: paired, rescue, serverArchive: svc });
  const handler = async (req: HttpRequest): Promise<HttpResponse> => (await screens(req)) ?? { status: 404, headers: {}, body: "not found" };
  const server = tls.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, (s) => _handleHttpConnectionForTest(s, handler));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  void events;
  return {
    port: (server.address() as AddressInfo).port,
    certSha: leafCertSha256(tlsMaterial.cert)!,
    rescue,
    notes,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
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


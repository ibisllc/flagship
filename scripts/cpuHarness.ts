// Workers CPU harness: runs the REAL `.com` route handlers (route.ts for the
// edge wrapper, tryControlPlane for the control plane) over the production D1
// adapter on node:sqlite with every migration applied, and measures the CPU
// each request costs.
//
// Why: the Workers Free plan gives a request 10 ms of CPU (docs/runbooks/
// final-deploy.md "Free vs Paid"). Wall time spent waiting on D1 is free;
// JavaScript is not. So this reports, per route:
//
//   cpu      thread CPU of the whole request, sqlite engine included (ms)
//   js       the same minus the time spent inside the sqlite shim, plus a flat
//            DB_CALL_OVERHEAD_MS per D1 call for the binding's own marshalling.
//            This is the number to compare with the 10 ms limit: sqlite's own
//            work happens in D1, not in the Worker's isolate.
//   d1       D1 calls (each counts as a subrequest; Free allows 50 a request)
//
// Estimate method: Node and workerd run the same V8, and both use the same
// pure-JS @noble/ed25519 (workerd has no sync Ed25519), so JS CPU transfers
// 1:1 up to the host CPU. Absolute numbers here come from a dev laptop; the
// budget test divides them by a calibration loop so a slower CI runner does
// not trip it (apps/com/test/cpuBudget.test.ts).
//
// Library only; scripts/cpu-profile.ts is the CLI.

import {
  D1Storage,
  type D1Database,
  type D1PreparedStatement,
} from "@flagship/storage";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  accountReadTokenPath,
  deriveIRK,
  ed,
  signAccountDirectoryRequest,
  signBoxReadTokenRequest,
  signBoxTrustStatusReport,
  signDaemonStatusReport,
  signDeviceCapabilityGrant,
  signDeviceEndpointClaim,
  type AccountDirectoryRequest,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import { handleUserStream } from "@flagship/control-plane";
import { createSqliteD1 } from "../packages/storage/tests/support/sqliteD1.js";
import { tryControlPlane, type ControlPlaneEnv } from "../apps/com/src/controlPlaneRoutes.js";
import { route, type RouteEnv } from "../apps/com/src/route.js";
import { RateLimitCounter } from "../apps/com/src/rateLimitCounter.js";

export const ORIGIN = "https://flagshipserver.com";
export const WORKERS_FREE_CPU_LIMIT_MS = 10;
/** What one D1 binding call costs the Worker in JS (statement build, bind,
 *  result decode). A conservative flat figure; sqlite's own time is excluded. */
export const DB_CALL_OVERHEAD_MS = 0.45;
/** Each further statement in the same batch(). */
export const DB_BATCHED_STATEMENT_MS = 0.08;
/** A Durable Object stub.fetch from the Worker (the object's own CPU is billed to it). */
export const DO_CALL_OVERHEAD_MS = 0.45;

// ---- CPU clock -----------------------------------------------------------

type ThreadCpu = () => number;
const threadCpuMs: ThreadCpu = (() => {
  const p = process as unknown as { threadCpuUsage?: () => { user: number; system: number } };
  if (typeof p.threadCpuUsage === "function") {
    return () => {
      const u = p.threadCpuUsage!();
      return (u.user + u.system) / 1000;
    };
  }
  return () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  };
})();
export const cpuNowMs = threadCpuMs;

// ---- D1 instrumentation --------------------------------------------------

export interface DbMeter {
  /** D1 round trips: a batch() is one, however many statements it carries. */
  calls: number;
  /** Statements sent, batches counted per statement. */
  statements: number;
  /** CPU spent inside the sqlite shim, ms. */
  ms: number;
  /** The SQL of every call, in order (a batch lists its statements joined). */
  sql: string[];
  reset(): void;
}

function meteredStatement(stmt: D1PreparedStatement, meter: DbMeter, query: string): D1PreparedStatement {
  const wrap: D1PreparedStatement = {
    bind(...values: unknown[]) {
      stmt.bind(...values);
      return wrap;
    },
    async first<T = unknown>() {
      const t = cpuNowMs();
      meter.calls++;
      meter.statements++;
      meter.sql.push(query);
      try {
        return await stmt.first<T>();
      } finally {
        meter.ms += cpuNowMs() - t;
      }
    },
    async all<T = unknown>() {
      const t = cpuNowMs();
      meter.calls++;
      meter.statements++;
      meter.sql.push(query);
      try {
        return await stmt.all<T>();
      } finally {
        meter.ms += cpuNowMs() - t;
      }
    },
    async run() {
      const t = cpuNowMs();
      meter.calls++;
      meter.statements++;
      meter.sql.push(query);
      try {
        return await stmt.run();
      } finally {
        meter.ms += cpuNowMs() - t;
      }
    },
  } as D1PreparedStatement;
  (wrap as unknown as { __inner: D1PreparedStatement; __sql: string }).__inner = stmt;
  (wrap as unknown as { __sql: string }).__sql = query;
  return wrap;
}

function meteredDb(db: D1Database, meter: DbMeter): D1Database {
  return {
    prepare(query: string) {
      return meteredStatement(db.prepare(query), meter, query);
    },
    async batch(stmts: D1PreparedStatement[]) {
      const t = cpuNowMs();
      meter.calls++;
      meter.statements += stmts.length;
      meter.sql.push(`BATCH[${stmts.map((s) => (s as unknown as { __sql?: string }).__sql ?? "?").join(" ;; ")}]`);
      try {
        return await db.batch(
          stmts.map((s) => (s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s),
        );
      } finally {
        meter.ms += cpuNowMs() - t;
      }
    },
    exec: db.exec?.bind(db),
  } as D1Database;
}

// ---- the world -----------------------------------------------------------

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function key(seedByte: number): Keypair {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (seedByte + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}
const rid = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export const ACCOUNT = "plucky-avocet";
/** The install order the first server was created from (provision-status posts). */
export const ORDER_SERIAL = "cpu-harness-order-0001";
export const READ_SECRET = "cpu-harness-read-token-secret";

export interface World {
  raw: ReturnType<typeof createSqliteD1>;
  meter: DbMeter;
  /** The metered D1 the handlers see. */
  db: D1Database;
  /** Unmetered storage for seeding. */
  seed: D1Storage;
  env: ControlPlaneEnv & RouteEnv;
  irk: Keypair;
  admin: Keypair;
  devices: { id: string; key: Keypair; admin: boolean }[];
  servers: { domain: string; stk: Keypair }[];
  /** A read token minted for the admin device, valid for the world. */
  readToken: string;
  rateLimitCalls: number;
  close(): void;
}

export interface WorldOptions {
  deviceCount?: number;
  serverCount?: number;
  appsPerServer?: number;
  /** Wire the rate-limit Durable Object namespace (in-memory counters). */
  withRateLimits?: boolean;
  /** Seed an existing, already-migrated sqlite file instead of a fresh one. */
  sqliteFile?: string;
}

export async function buildWorld(opts: WorldOptions = {}): Promise<World> {
  const deviceCount = opts.deviceCount ?? 3;
  const serverCount = opts.serverCount ?? 2;
  const appsPerServer = opts.appsPerServer ?? 8;
  const raw = createSqliteD1(opts.sqliteFile);
  const meter: DbMeter = {
    calls: 0,
    statements: 0,
    ms: 0,
    sql: [],
    reset() {
      this.calls = 0;
      this.statements = 0;
      this.ms = 0;
      this.sql = [];
    },
  };
  const db = meteredDb(raw as unknown as D1Database, meter);
  const seed = new D1Storage(raw as unknown as D1Database);

  const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
  const admin = key(64);
  const now = Date.now();
  await seed.usernames.put({
    username: ACCOUNT,
    irkPubHex: hex(irk.publicKey),
    adminRootPubHex: hex(admin.publicKey),
    claimedAt: now - 86_400_000,
  });

  const devices: World["devices"] = [];
  for (let i = 0; i < deviceCount; i++) {
    const k = key(96 + i * 7);
    const id = hex(Uint8Array.from({ length: 16 }, (_, j) => (i * 16 + j + 1) & 0xff));
    const isAdmin = i === 0;
    devices.push({ id, key: k, admin: isAdmin });
    await seed.deviceIdentities.put({
      accountId: ACCOUNT,
      deviceId: id,
      devicePubHex: hex(k.publicKey),
      platformClass: i === 0 ? "ios" : i === 1 ? "android" : "web",
      createdAt: now - 80_000_000,
      lastSeenAt: now - 1000,
      revokedAt: null,
    });
    const grant: DeviceCapabilityGrant = {
      grantId: `grant-${i}`,
      username: ACCOUNT,
      deviceId: id,
      devicePubKey: k.publicKey,
      scopes: isAdmin ? ["admin", "view-directory"] : ["view-directory"],
      issuedAt: now - 1000,
      expiresAt: now + 30 * 86_400_000,
    };
    await seed.deviceCapabilityGrants.put({
      grantId: grant.grantId,
      username: ACCOUNT,
      deviceId: id,
      devicePubHex: hex(k.publicKey),
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(signDeviceCapabilityGrant(grant, isAdmin ? admin : irk)),
      revokedAt: null,
      signerRoot: isAdmin ? "admin-root" : "membership",
    });
  }

  const servers: World["servers"] = [];
  for (let i = 0; i < serverCount; i++) {
    const stk = key(200 + i * 3);
    const domain = `home${i === 0 ? "" : i + 1}.${ACCOUNT}.flagship.services`;
    servers.push({ domain, stk });
    await seed.servers.put({
      serverDomain: domain,
      username: ACCOUNT,
      identityPubKeyHex: hex(stk.publicKey),
      registeredAt: now - 50_000_000 + i,
    });
    await seed.routing.put?.({
      subdomain: domain.split(".")[0]!,
      username: ACCOUNT,
      rckPubKeyHex: hex(key(150 + i).publicKey),
      currentTargetHex: hex(stk.publicKey),
      registeredAt: now - 50_000_000,
      lastTargetUpdate: now - 40_000_000,
      lastTargetNonce: "00",
    } as never);
  }

  await seed.authCodes.put({
    serial: ORDER_SERIAL,
    username: ACCOUNT,
    serverName: "home",
    serverDomain: servers[0]!.domain,
    delegatedPubKeyHex: hex(servers[0]!.stk.publicKey),
    userPubKeyHex: hex(irk.publicKey),
    userSignatureHex: "00".repeat(64),
    issuedAt: now - 60_000_000,
    expiresAt: now - 59_000_000,
    status: "used",
    recordedAt: now - 60_000_000,
  });

  const env = {
    DB: db,
    ACCOUNT_READ_TOKEN_SECRET: READ_SECRET,
    FLAGSHIP_CA_PRIV_HEX: "ab".repeat(32),
    SITE_PUBLIC: "1",
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
  } as unknown as World["env"];

  const world: World = {
    raw,
    meter,
    db,
    seed,
    env,
    irk,
    admin,
    devices,
    servers,
    readToken: "",
    rateLimitCalls: 0,
    close: () => raw.close(),
  };

  if (opts.withRateLimits) {
    // The scale raises every budget so a measuring loop never trips one.
    (env as unknown as { RATE_LIMIT_SCALE: string }).RATE_LIMIT_SCALE = "50";
    const objects = new Map<string, RateLimitCounter>();
    const state = () => {
      const data = new Map<string, unknown>();
      return {
        storage: {
          async get<T>(k: string) {
            return data.get(k) as T | undefined;
          },
          async put<T>(k: string, v: T) {
            data.set(k, structuredClone(v));
          },
          async setAlarm() {},
          async deleteAll() {
            data.clear();
          },
        },
      };
    };
    (env as unknown as { RATE_LIMITS: unknown }).RATE_LIMITS = {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        async fetch(request: Request) {
          world.rateLimitCalls++;
          let o = objects.get(id);
          if (!o) {
            o = new RateLimitCounter(state() as never, undefined, Date.now);
            objects.set(id, o);
          }
          return o.fetch(request);
        },
      }),
    };
  }

  // Pods with realistic heartbeats: the real signed daemon-status POST.
  for (const s of servers) await postDaemonStatus(world, s, appsPerServer);
  world.readToken = await mintDeviceReadToken(world, world.devices[0]!);
  world.meter.reset();
  return world;
}

// ---- request builders ----------------------------------------------------

export function deviceHeaders(w: World, d: World["devices"][number], method: string, path: string) {
  const req: AccountDirectoryRequest = {
    accountId: ACCOUNT,
    deviceId: d.id,
    signerPubHex: hex(d.key.publicKey),
    method,
    path,
    requestId: rid(),
    issuedAt: Date.now(),
  };
  const signature = signAccountDirectoryRequest(req, d.key);
  return {
    "x-flagship-device-id": req.deviceId,
    "x-flagship-device-pub": req.signerPubHex,
    "x-flagship-request-id": req.requestId,
    "x-flagship-issued-at": String(req.issuedAt),
    "x-flagship-signature": signature,
  };
}

export function directoryRequest(w: World, d = w.devices[0]!): Request {
  const path = `/api/accounts/${ACCOUNT}/directory`;
  return new Request(`${ORIGIN}${path}`, { headers: deviceHeaders(w, d, "GET", path) });
}

export function profileRequest(w: World, d = w.devices[0]!): Request {
  const path = `/api/accounts/${ACCOUNT}/profile`;
  return new Request(`${ORIGIN}${path}`, { headers: deviceHeaders(w, d, "GET", path) });
}

export function readTokenDeviceRequest(w: World, d = w.devices[0]!): Request {
  const path = accountReadTokenPath(ACCOUNT);
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceHeaders(w, d, "POST", path) },
    body: "{}",
  });
}

export function readTokenIrkRequest(w: World): Request {
  const now = Date.now();
  const claim = {
    username: ACCOUNT,
    endpointLabel: ACCOUNT_READ_TOKEN_LABEL,
    phoneIrkPub: w.irk.publicKey,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
  };
  return new Request(`${ORIGIN}/api/accounts/${ACCOUNT}/read-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) },
      authSignature: hex(signDeviceEndpointClaim(claim, w.irk)),
    }),
  });
}

export function readTokenBoxRequest(w: World, s = w.servers[0]!): Request {
  const r = {
    username: ACCOUNT,
    serverDomain: s.domain,
    stkPubHex: hex(s.stk.publicKey),
    issuedAt: Date.now(),
    nonceHex: rid(),
  };
  return new Request(`${ORIGIN}/api/accounts/${ACCOUNT}/read-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ box: r, signature: signBoxReadTokenRequest(r as never, s.stk) }),
  });
}

export async function mintDeviceReadToken(w: World, d: World["devices"][number]): Promise<string> {
  const res = await tryControlPlane(readTokenDeviceRequest(w, d), w.env);
  if (!res || res.status !== 200) throw new Error(`harness: read-token mint failed (${res?.status})`);
  return ((await res.json()) as { token: string }).token;
}

export function authed(w: World, path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${w.readToken}`, ...(init.headers ?? {}) },
  });
}

export async function postDaemonStatus(w: World, s: World["servers"][number], apps = 8): Promise<Response> {
  return (await tryControlPlane(daemonStatusRequest(w, s, apps), w.env))!;
}

export function daemonStatusRequest(w: World, s = w.servers[0]!, apps = 8): Request {
  const report = {
    serverDomain: s.domain,
    certSha256: hex(crypto.getRandomValues(new Uint8Array(32))),
    certValidUntil: Date.now() + 60 * 86_400_000,
    certIssuer: "Let's Encrypt R12",
    appsServed: Array.from({ length: apps }, (_, i) => `app-${i}.${ACCOUNT}`),
    nonce: rid(),
    issuedAt: Date.now(),
  };
  const trust = {
    serverDomain: s.domain,
    relayVerdict: "trusted",
    lockedDown: false,
    failingCertHash: null,
    coveringExceptionCertHash: null,
    nonce: rid(),
    issuedAt: Date.now(),
  };
  return new Request(`${ORIGIN}/api/daemon-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: report,
      signature: hex(signDaemonStatusReport(report as never, s.stk)),
      leadsServices: report.appsServed.slice(0, 3),
      runsServices: report.appsServed,
      orderIssuedAt: Date.now() - 1000,
      trustStatus: {
        report: trust,
        signatureHex: hex(signBoxTrustStatusReport(trust as never, s.stk)),
      },
    }),
  });
}

// ---- scenarios -----------------------------------------------------------

export interface Scenario {
  id: string;
  label: string;
  /** Who calls it and how often, for the requests/day table. */
  caller: string;
  /** Statuses that count as a valid run (a refusal still costs CPU, but a
   *  scenario that silently stops reaching its handler is a harness bug). */
  expect: number[];
  /** Build the world options this scenario needs. */
  world?: WorldOptions;
  /** Work that must happen before each timed run and is not part of it. */
  prepare?: (w: World) => Promise<unknown>;
  /** One run. Returns the HTTP status. */
  run(w: World, prepared?: unknown): Promise<number>;
  /** The request one run sends, for runners that go over HTTP (workerd). */
  request?: (w: World) => Request;
  /** Run through route() (rate limits, CORS, security headers) instead of tryControlPlane. */
  via?: "route";
}

async function viaCp(w: World, req: Request): Promise<number> {
  const res = await tryControlPlane(req, w.env);
  if (!res) return 0;
  await res.arrayBuffer();
  return res.status;
}

async function viaRoute(w: World, req: Request): Promise<number> {
  const res = await route(req, w.env, { waitUntil: (p) => void p.catch(() => {}) });
  await res.arrayBuffer();
  return res.status;
}

const routeAs = (w: World, req: Request) => viaRoute(w, req);

function withIp(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set("cf-connecting-ip", "203.0.113.9");
  return new Request(req.url, { method: req.method, headers, body: req.body, duplex: "half" } as RequestInit);
}

function http(
  id: string,
  label: string,
  caller: string,
  request: (w: World) => Request,
  extra: Partial<Scenario> = {},
): Scenario {
  return {
    id,
    label,
    caller,
    expect: extra.expect ?? [200],
    request,
    // The client's signing is not the server's CPU: build the request first.
    prepare: async (w) => request(w),
    run:
      extra.via === "route"
        ? (w, req) => routeAs(w, withIp(req as Request))
        : (w, req) => viaCp(w, req as Request),
    ...extra,
  };
}

/** A migration session of the first server onto the second, in the phase a box polls it. */
async function seedMigration(w: World): Promise<void> {
  const [from, to] = w.servers;
  await w.raw
    .prepare(
      "INSERT OR REPLACE INTO server_migrations (server_domain, username, old_stk_pub_hex, order_json, order_signature_hex, " +
        "disposition, phase, initiated_at, new_server_domain, new_stk_pub_hex, attached_at, pre_seeded_at, ready_at, freeze_at) " +
        "VALUES (?, ?, ?, ?, ?, 'wipe', 'pre-seeded', ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(from!.domain, ACCOUNT, "11".repeat(32), "{}", "22".repeat(64), 1, to!.domain, "33".repeat(32), 2, 3, 4)
    .run();
}

/** Routes the final gym recorded far over the Free plan's 10 ms (migration reads, health, usage, eviction chain). */
const migrationScenarios: Scenario[] = [
  {
    ...http("migration-read", "GET /api/server/<d>/migration (the phone and both boxes poll a live migration)", "apps and both boxes, every few seconds during a move", (w) =>
      new Request(`${ORIGIN}/api/server/${w.servers[0]!.domain}/migration`)),
    prepare: async (w) => {
      await seedMigration(w);
      return new Request(`${ORIGIN}/api/server/${w.servers[0]!.domain}/migration`);
    },
  },
  {
    ...http("migration-assignment-live", "GET /api/server/<d>/migration-assignment on the new box (a session names it)", "the new box, every few seconds during a move", (w) =>
      new Request(`${ORIGIN}/api/server/${w.servers[1]!.domain}/migration-assignment`)),
    prepare: async (w) => {
      await seedMigration(w);
      return new Request(`${ORIGIN}/api/server/${w.servers[1]!.domain}/migration-assignment`);
    },
  },
];

export const SCENARIOS: Scenario[] = [
  ...migrationScenarios,
  http("directory", "GET /api/accounts/<u>/directory (Trusted devices)", "apps, on opening Trusted devices", (w) =>
    directoryRequest(w)),
  http("directory-member", "directory read by a non-admin view-directory device", "apps", (w) =>
    directoryRequest(w, w.devices[1]!)),
  http("profile", "GET /api/accounts/<u>/profile", "apps, per sign-in and settings", (w) => profileRequest(w)),
  http("device-grants", "GET /api/users/<u>/device-grants (read token)", "boxes, per access-sync", (w) =>
    authed(w, `/api/users/${ACCOUNT}/device-grants`)),
  http("read-token-device", "POST read-token mint (device-signed)", "apps, every 30 days per device", (w) =>
    readTokenDeviceRequest(w)),
  http("read-token-irk", "POST read-token mint (IRK-signed)", "apps without a device key", (w) =>
    readTokenIrkRequest(w)),
  http("read-token-box", "POST read-token mint (box STK-signed)", "boxes, daily", (w) => readTokenBoxRequest(w)),
  http("pods", "GET /api/users/<u>/pods (read token use)", "apps and boxes", (w) =>
    authed(w, `/api/users/${ACCOUNT}/pods`)),
  http("stream-first", "GET /api/users/<u>/stream, first connect (no hold)", "apps, per foreground long-poll", (w) =>
    authed(w, `/api/users/${ACCOUNT}/stream`)),
  http("stream-stale", "stream with a stale cursor: one light check, then the full answer", "apps, after a missed change", (w) =>
    authed(w, `/api/users/${ACCOUNT}/stream?cursor=${"00".repeat(32)}`)),
  {
    id: "stream-hold",
    label: "GET /api/users/<u>/stream held 25 s with nothing changing",
    caller: "apps, every 25 s while in the foreground",
    expect: [200],
    prepare: async (w) => {
      const first = await tryControlPlane(authed(w, `/api/users/${ACCOUNT}/stream`), w.env);
      return ((await first!.json()) as { cursor: string }).cursor;
    },
    run: async (w, cursor) => {
      let t = 0;
      const t0 = Date.now();
      const res = await tryControlPlane(
        authed(w, `/api/users/${ACCOUNT}/stream?cursor=${cursor as string}`),
        w.env,
        { stream: { now: () => t0 + t, sleep: async (ms: number) => void (t += ms) } },
      );
      await res!.arrayBuffer();
      return res!.status;
    },
  },
  http("audit", "GET /api/users/<u>/audit", "apps, opening Activity", (w) =>
    authed(w, `/api/users/${ACCOUNT}/audit`)),
  http("account-resolve", "GET /api/account/resolve/<u>", "apps, at sign-in", () =>
    new Request(`${ORIGIN}/api/account/resolve/${ACCOUNT}`)),
  http("users-check", "POST /api/users/check", "apps, while typing a name", () =>
    new Request(`${ORIGIN}/api/users/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ACCOUNT }),
    })),
  http("username-lookup", "GET /api/username/<u>", "apps and boxes", () =>
    new Request(`${ORIGIN}/api/username/${ACCOUNT}`)),
  http("edge-health", "GET /api/health (no D1: the per-request floor)", "monitors", () =>
    new Request(`${ORIGIN}/api/health`), { via: "route" }),
  ...[
    ["swk-deposit", "swk-deposit"],
    ["cgk-deposit", "cgk-deposit"],
    ["pairing-deposit", "pairing-deposit"],
    ["update", "update"],
    ["self-delete", "self-delete?stk=" + "00".repeat(32)],
    ["decommission", "decommission"],
    ["migration-assignment", "migration-assignment"],
    ["transfer-rehome", "transfer/rehome"],
  ].map(([id, tail]) =>
    http(`lane-${id}`, `GET /api/server/<d>/${tail} (box polls an empty lane)`, "every box, every 5 min", (w) =>
      new Request(`${ORIGIN}/api/server/${w.servers[0]!.domain}/${tail}`), { expect: [200, 204, 400, 404] })),
  http("apps-aliases", "GET /api/users/<u>/apps/aliases (read token)", "boxes, every minute", (w) =>
    authed(w, `/api/users/${ACCOUNT}/apps/aliases`)),
  http("notices", "GET /api/notices (maintainer-signed notice)", "apps, on a poll", () =>
    new Request(`${ORIGIN}/api/notices`), { via: "route", expect: [200, 204, 304] }),
  http("edge-account-resolve", "account resolve through route() (two rate-limit counter calls)", "apps, at sign-in", () =>
    new Request(`${ORIGIN}/api/account/resolve/${ACCOUNT}`), { via: "route", world: { withRateLimits: true } }),
  {
    id: "ratelimit-counter",
    label: "one RateLimitCounter hit (the Durable Object's own work, three windows)",
    caller: "the Durable Object, per rate-limited call and axis",
    expect: [200],
    run: async (w) => {
      const ns = (w.env as unknown as { RATE_LIMITS: { get(id: string): { fetch(r: Request): Promise<Response> } } })
        .RATE_LIMITS;
      const res = await ns.get("account-resolve|ip|203.0.113.9").fetch(
        new Request("https://rate-limits.internal/hit", {
          method: "POST",
          body: JSON.stringify({ rules: [{ limit: 600, windowSec: 60 }, { limit: 3000, windowSec: 3600 }, { limit: 9000, windowSec: 86400 }] }),
        }),
      );
      await res.arrayBuffer();
      return res.status;
    },
    world: { withRateLimits: true },
  },
  http("order-status", "POST /api/order/<serial>/status (a box reports an install phase)", "a box, during an install", () =>
    new Request(`${ORIGIN}/api/order/${ORDER_SERIAL}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "installing" }),
    })),
  http("order-health", "GET /api/order/<serial>/health (Studio's VM list)", "Studio, per refresh", () =>
    new Request(`${ORIGIN}/api/order/${ORDER_SERIAL}/health`)),
  http("daemon-status", "POST /api/daemon-status (box heartbeat, 2 signatures)", "every box, every 5 min", (w) =>
    daemonStatusRequest(w)),
  http("edge-pods", "pods through route() (edge wrapper + rate limits)", "apps and boxes", (w) =>
    authed(w, `/api/users/${ACCOUNT}/pods`), { via: "route", world: { withRateLimits: true } }),
  http("edge-directory", "directory through route() (edge wrapper + rate limits)", "apps", (w) =>
    directoryRequest(w), { via: "route", world: { withRateLimits: true } }),
];

// ---- measurement ---------------------------------------------------------

export interface Measure {
  id: string;
  label: string;
  caller: string;
  runs: number;
  cpuMs: number;
  jsMs: number;
  /** Smallest JS-only CPU over the runs (sqlite excluded): the steady figure,
   *  least disturbed by whatever else the machine is doing. */
  minJsNoDbMs: number;
  d1Calls: number;
  d1Statements: number;
  status: number;
  sql: string[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export async function measureScenario(
  sc: Scenario,
  opts: { warmup?: number; runs?: number; world?: World } = {},
): Promise<Measure> {
  const warmup = opts.warmup ?? 6;
  const runs = opts.runs ?? 25;
  const w = opts.world ?? (await buildWorld(sc.world));
  try {
    let status = 0;
    for (let i = 0; i < warmup; i++) status = await sc.run(w, await sc.prepare?.(w));
    const cpu: number[] = [];
    const js: number[] = [];
    const noDb: number[] = [];
    const calls: number[] = [];
    const stmts: number[] = [];
    let sql: string[] = [];
    for (let i = 0; i < runs; i++) {
      const prepared = await sc.prepare?.(w);
      w.meter.reset();
      const doBefore = w.rateLimitCalls;
      const t = cpuNowMs();
      status = await sc.run(w, prepared);
      const total = cpuNowMs() - t;
      cpu.push(total);
      noDb.push(Math.max(0, total - w.meter.ms));
      js.push(
        Math.max(0, total - w.meter.ms) +
          w.meter.calls * DB_CALL_OVERHEAD_MS +
          Math.max(0, w.meter.statements - w.meter.calls) * DB_BATCHED_STATEMENT_MS +
          (w.rateLimitCalls - doBefore) * DO_CALL_OVERHEAD_MS,
      );
      calls.push(w.meter.calls);
      stmts.push(w.meter.statements);
      sql = w.meter.sql;
      if (!sc.expect.includes(status)) {
        throw new Error(`${sc.id}: unexpected status ${status} (wanted ${sc.expect.join("/")})`);
      }
    }
    return {
      id: sc.id,
      label: sc.label,
      caller: sc.caller,
      runs,
      cpuMs: median(cpu),
      jsMs: median(js),
      minJsNoDbMs: Math.min(...noDb),
      d1Calls: median(calls),
      d1Statements: median(stmts),
      status,
      sql,
    };
  } finally {
    if (!opts.world) w.close();
  }
}

/** A fixed, machine-speed yardstick: a mix of hashing, JSON, regex and an
 *  Ed25519 verify, the same kinds of work the handlers do. */
export async function calibrationMs(): Promise<number> {
  const k = key(9);
  const msg = new Uint8Array(160).fill(3);
  const sig = ed.sign(msg, k.privateKey);
  const obj = {
    a: Array.from({ length: 40 }, (_, i) => ({ id: `id-${i}`, v: i * 3, s: "x".repeat(20) })),
  };
  const once = () => {
    const t = cpuNowMs();
    for (let i = 0; i < 4; i++) ed.verify(sig, msg, k.publicKey);
    for (let i = 0; i < 300; i++) {
      const j = JSON.stringify(obj);
      JSON.parse(j);
      /^\/api\/users\/([^/]+)\/pods$/.test(`/api/users/${i}/pods`);
    }
    return cpuNowMs() - t;
  };
  for (let i = 0; i < 3; i++) once();
  const xs: number[] = [];
  for (let i = 0; i < 15; i++) xs.push(once());
  return Math.min(...xs);
}

export { signDeviceEndpointClaim, handleUserStream };

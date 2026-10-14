/**
 * Member sessions on the live app path (docs/app-apis.md §5): the connection
 * handler the TLS server uses, with the real app gates (knock endpoints +
 * restricted-mode enforcement), the real member-session resolver and the
 * real access + session stores. The owner and invited people sign in through
 * the knock page with their phone; the app sees who they are.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveIRK, ed, signAppApiKeyGrant, signKnockAuthorization, type Keypair } from "@flagship/protocol";
import { AppConnectionLimiter, handleAppConnection } from "../src/appConnection.js";
import { AppApiKeyStore, apiKeyAuthorizer, buildAppApiKeysHttp } from "../src/appApiKeys.js";
import { buildAppSessionResolver } from "../src/appMemberSession.js";
import { AppMembership } from "../src/membership.js";
import { appConnectionOptions, carriesAppApiKey } from "../src/runtime.js";
import {
  ServiceAccessStore,
  ServiceSessionStore,
  buildAccessEnforcementHandler,
  decideServiceAccess,
} from "../src/serviceAccess.js";
import { buildServiceAccessWeb } from "../src/serviceAccessWeb.js";
import { matchesPublicRoute } from "../src/serviceProxy.js";
import type { InstalledService } from "../src/servicePlatform.js";
import type { HttpRequest } from "../src/runtime.js";
import { boxSigner, swkOps } from "./helpers/keyCustody.js";

const SERVER = "home.alice.flagship.services";
const HOST = `game1.${SERVER}`;
const SVC = "alice-game1";
const injectorKey = kp(5);
const ownerIrk = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const ownerAid = kp(7);
const memberAid = kp(8);
const strangerAid = kp(9);

function kp(fill: number): Keypair {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

let dir: string;
let access: ServiceAccessStore;
let sessions: ServiceSessionStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-member-"));
  closers.push(() => rm(dir, { recursive: true, force: true }));
  access = new ServiceAccessStore(join(dir, "access.json"), { ownerAidHex: hex(ownerAid.publicKey) });
  sessions = new ServiceSessionStore(join(dir, "sessions.json"));
});

function makeApp(port: number, defaultRole = "member"): InstalledService {
  return {
    serviceId: SVC,
    creator: "alice",
    slug: "game1",
    urlLabel: "game1",
    containerPort: port,
    manifest: { name: "game1", access: { enabled: true, default_role: defaultRole, public_routes: ["/pub"] } },
    membership: new AppMembership(SVC, "alice", ownerIrk.publicKey, swkOps(new Uint8Array(32).fill(3))),
  } as unknown as InstalledService;
}

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

/** The container: records what it was sent. */
async function container(): Promise<{ port: number; seen: () => IncomingHttpHeaders; hits: () => number }> {
  let seen: IncomingHttpHeaders = {};
  let hits = 0;
  const server = createHttpServer((req, res) => {
    seen = req.headers;
    hits++;
    req.resume();
    req.on("end", () => res.end("from the app"));
  });
  const port = await listen(server);
  closers.push(() => server.closeAllConnections());
  return { port, seen: () => seen, hits: () => hits };
}

/** The box: the app gates and proxy wired as index.ts + runtime.ts wire them. */
async function box(app: InstalledService, apiKeys: AppApiKeyStore | null = null) {
  const accessWeb = buildServiceAccessWeb({ serverId: SERVER, store: access, sessions });
  const enforcement = buildAccessEnforcementHandler(
    { decide: (ref, req) => decideServiceAccess({ serverId: SERVER, store: access, sessions }, ref, req), store: access },
    (_req, appServiceRef) => appServiceRef ?? null,
    accessWeb.maybeServeKnock,
    (req, ref) => carriesAppApiKey(req) || (ref === SVC && matchesPublicRoute(req.path, app.manifest.access.public_routes ?? [])),
  );
  const identity = {
    resolveSession: buildAppSessionResolver({ sessions, access }),
    deniedPage: accessWeb.maybeServeKnock,
    accessMode: (id: string) =>
      access.failedOpen() ? null : access.mode(id) === "open" ? ("open" as const) : ("members-only" as const),
  };
  const sockets = new Set<Socket>();
  const server = createNetServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    handleAppConnection(
      sock,
      appConnectionOptions(app, {
        gates: [accessWeb.handle, enforcement],
        injector: boxSigner(injectorKey),
        apiKeys,
        identity,
        limiter: new AppConnectionLimiter(),
      }),
    );
  });
  const port = await listen(server);
  closers.push(() => sockets.forEach((s) => s.destroy()));
  return { port, accessWeb };
}

function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { host: HOST, ...headers };
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    const r = httpRequest({ host: "127.0.0.1", port, path, method, headers: h, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const NAV = { accept: "text/html,application/xhtml+xml" };

function cookieValue(setCookie: string[] | undefined, name: string): string {
  const c = (setCookie ?? []).find((v) => v.startsWith(`${name}=`));
  if (!c) throw new Error(`no ${name} cookie`);
  return c.split(";")[0]!;
}

/**
 * Sign in the way a person does: open the app's sign-in link in the browser
 * (in either mode), approve the knock page with the phone (AID-signed), and
 * let the page's poll pick up the session cookie. Returns the browser's
 * cookie, or the phone's error status when the box refuses the approval.
 */
async function signIn(
  b: Awaited<ReturnType<typeof box>>,
  aid: Keypair,
): Promise<{ cookie: string } | { refused: number }> {
  const knock = await send(b.port, "/__flagship/sign-in", NAV);
  expect(knock.status).toBe(200);
  const holder = cookieValue(knock.headers["set-cookie"], "Flagship-Knock");
  const pageId = /var PAGE = "([0-9a-f]{32})"/.exec(knock.body)![1]!;
  const authorization = { serverId: SERVER, serviceRef: SVC, pageId, visitorAID: aid.publicKey, issuedAt: Date.now() };
  const approve = await b.accessWeb.handle({
    method: "POST",
    path: "/api/service-access/knock/authorize",
    headers: {},
    body: Buffer.from(
      JSON.stringify({
        authorization: { ...authorization, visitorAID: hex(aid.publicKey) },
        sig: hex(signKnockAuthorization(authorization, aid)),
      }),
    ),
  });
  if (approve!.status !== 200) return { refused: approve!.status };
  const poll = await send(b.port, `/__flagship/knock/${pageId}/status`, { cookie: holder });
  expect(JSON.parse(poll.body).status).toBe("authorized");
  return { cookie: cookieValue(poll.headers["set-cookie"], "Flagship-App-Session") };
}

async function cookieOf(b: Awaited<ReturnType<typeof box>>, aid: Keypair): Promise<string> {
  const r = await signIn(b, aid);
  if (!("cookie" in r)) throw new Error(`sign-in refused: ${r.refused}`);
  return r.cookie;
}

function verifyInjected(h: IncomingHttpHeaders, extra: string[] = []): boolean {
  const anon = h["x-flagship-visitor"] === "anonymous";
  if (anon !== (h["x-flagship-user"] === undefined && h["x-flagship-role"] === undefined)) return false;
  const user = anon ? "anonymous" : h["x-flagship-user"];
  const role = anon ? "anonymous" : h["x-flagship-role"];
  const fields = ["flagship/inject/v1", h["x-flagship-app-id"], user, role, h["x-flagship-timestamp"], ...extra];
  const sig = Buffer.from(String(h["x-flagship-signature"]), "hex");
  return ed.verify(new Uint8Array(sig), new TextEncoder().encode(fields.join("|")), injectorKey.publicKey);
}

describe("the owner opens their own app", () => {
  it("signs in through the knock page and reaches a private path as owner, on an open app", async () => {
    const up = await container();
    const app = makeApp(up.port);
    const b = await box(app);
    const cookie = await cookieOf(b, ownerAid);
    const r = await send(b.port, "/private", { ...NAV, cookie });
    expect(r.status).toBe(200);
    expect(r.body).toBe("from the app");
    const h = up.seen();
    expect(h["x-flagship-user"]).toBe(app.membership.stableIdFor(ownerAid.publicKey));
    expect(h["x-flagship-user"]).toMatch(/^[0-9a-f]{32}$/);
    expect(h["x-flagship-role"]).toBe("owner");
    expect(h["x-flagship-visitor"]).toBe("member");
    expect(h["x-flagship-app-id"]).toBe(SVC);
    expect(verifyInjected(h)).toBe(true);
    // Same-origin writes keep the identity.
    const post = await send(b.port, "/private", { cookie, origin: `https://${HOST}`, "content-type": "application/json" }, "POST", "{}");
    expect(post.status).toBe(200);
    expect(up.seen()["x-flagship-role"]).toBe("owner");
  });

  it("gets through a restricted app's gate too, and is owner even when the manifest's default role is owner", async () => {
    const up = await container();
    const app = makeApp(up.port, "owner");
    await access.setMode(SVC, "restricted");
    const b = await box(app);
    const cookie = await cookieOf(b, ownerAid);
    expect((await send(b.port, "/private", { cookie })).status).toBe(200);
    expect(up.seen()["x-flagship-role"]).toBe("owner");
  });
});

describe("invited members", () => {
  it("an allow-listed person signs in with the app's default role, or the role they were given", async () => {
    const up = await container();
    const app = makeApp(up.port);
    await access.setMode(SVC, "restricted");
    await access.addAllowed(SVC, hex(memberAid.publicKey));
    const b = await box(app);
    const cookie = await cookieOf(b, memberAid);
    expect((await send(b.port, "/private", { cookie })).status).toBe(200);
    const h = up.seen();
    expect(h["x-flagship-role"]).toBe("member");
    expect(h["x-flagship-user"]).toBe(app.membership.stableIdFor(memberAid.publicKey));
    expect(h["x-flagship-user"]).not.toBe(app.membership.stableIdFor(ownerAid.publicKey));
    expect(verifyInjected(h)).toBe(true);
    app.membership.members.internalAdd(memberAid.publicKey, "manager");
    await send(b.port, "/private", { cookie });
    expect(up.seen()["x-flagship-role"]).toBe("manager");
  });

  it("an invited person never gets the owner role", async () => {
    const up = await container();
    const app = makeApp(up.port, "owner");
    await access.addAllowed(SVC, hex(memberAid.publicKey));
    const b = await box(app);
    const cookie = await cookieOf(b, memberAid);
    await send(b.port, "/private", { cookie });
    expect(up.seen()["x-flagship-role"]).toBe("master");
    app.membership.members.internalAdd(memberAid.publicKey, "owner");
    await send(b.port, "/private", { cookie });
    expect(up.seen()["x-flagship-role"]).toBe("master");
  });

  it("removing someone signs them out on their next request", async () => {
    const up = await container();
    const app = makeApp(up.port);
    await access.setMode(SVC, "restricted");
    await access.addAllowed(SVC, hex(memberAid.publicKey));
    const b = await box(app);
    const cookie = await cookieOf(b, memberAid);
    expect((await send(b.port, "/private", { cookie })).status).toBe(200);
    await access.removeAllowed(SVC, hex(memberAid.publicKey));
    const r = await send(b.port, "/private", { cookie });
    expect(r.status).toBe(403);
    expect(up.hits()).toBe(1);
    // A browser gets the knock page again.
    const nav = await send(b.port, "/private", { ...NAV, cookie });
    expect(nav.body).toContain("Access is restricted");
    expect(up.hits()).toBe(1);
  });
});

describe("everyone else is anonymous", () => {
  it("on a members-only app a stranger gets the knock page off the public routes and can't get a session", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    await access.setMode(SVC, "restricted");
    const api = await send(b.port, "/private");
    expect(api.status).toBe(403);
    const nav = await send(b.port, "/private", NAV);
    expect(nav.status).toBe(200);
    expect(nav.body).toContain("Access is restricted");
    expect(up.hits()).toBe(0);
    expect(await signIn(b, strangerAid)).toEqual({ refused: 401 });
    // Forged identity headers never reach the app.
    const pub = await send(b.port, "/pub", {
      "x-flagship-user": "owner-id",
      "x-flagship-role": "owner",
      "x-flagship-visitor": "member",
      "x_flagship_role": "owner",
    });
    expect(pub.status).toBe(200);
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    expect(up.seen()["x-flagship-user"]).toBeUndefined();
    expect(up.seen()["x-flagship-role"]).toBeUndefined();
    expect(up.seen()["x_flagship_role"]).toBeUndefined();
    expect(verifyInjected(up.seen())).toBe(true);
    expect(up.hits()).toBe(1);
  });

  it("on a members-only app an anonymous visitor reaches only the declared public routes", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    await access.setMode(SVC, "restricted");
    const forged = { "x-flagship-visitor": "member", "x-flagship-role": "owner", x_flagship_user: "owner-id" };
    for (const [method, path] of [["GET", "/pub"], ["POST", "/pub"], ["GET", "/pub/"], ["GET", "/pub?x=1"]] as const) {
      const r = await send(b.port, path, forged, method, method === "POST" ? "{}" : undefined);
      expect(r.status).toBe(200);
      expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
      expect(up.seen()["x-flagship-user"]).toBeUndefined();
      expect(up.seen()["x-flagship-role"]).toBeUndefined();
      expect(up.seen()["x_flagship_user"]).toBeUndefined();
      expect(verifyInjected(up.seen())).toBe(true);
    }
    const hits = up.hits();
    for (const path of [
      "/private",
      "/pub/../private",
      "/pub/%2e%2e/private",
      "/pub/..;/private",
      "/pub%2f..%2fprivate",
      "/pub/x",
      "/PUB",
      "/pubx",
    ]) {
      const r = await send(b.port, path, forged);
      expect(r.status, path).toBe(403);
      const ws = await send(b.port, path, {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });
      expect(ws.status, `upgrade ${path}`).toBe(403);
    }
    expect(up.hits()).toBe(hits);
  });

  it("on an open app every anonymous request reaches the app, marked anonymous", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    const forged = { "x-flagship-visitor": "member", "x-flagship-role": "owner", "x-flagship-user": "owner-id", x_flagship_role: "owner" };
    for (const [method, path] of [["GET", "/private"], ["POST", "/admin/delete"], ["PUT", "/pub"], ["DELETE", "/x/y?z=1"]] as const) {
      const r = await send(b.port, path, forged, method, method === "GET" ? undefined : "{}");
      expect(r.status, `${method} ${path}`).toBe(200);
      expect(r.body).toBe("from the app");
      expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
      expect(up.seen()["x-flagship-user"]).toBeUndefined();
      expect(up.seen()["x-flagship-role"]).toBeUndefined();
      expect(up.seen()["x_flagship_role"]).toBeUndefined();
      expect(verifyInjected(up.seen())).toBe(true);
    }
    // A browser navigation is forwarded too: no knock page on an open app.
    const nav = await send(b.port, "/private", NAV);
    expect(nav.body).toBe("from the app");
  });

  it("an app whose mode can't be read is members-only", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "access.json"), "{not json");
    await access.load();
    expect(access.failedOpen()).toBe(true);
    const up = await container();
    const b = await box(makeApp(up.port));
    expect((await send(b.port, "/private")).status).toBe(403);
    expect((await send(b.port, "/private", NAV)).body).toContain("Access is restricted");
    expect(up.hits()).toBe(0);
    expect((await send(b.port, "/pub")).status).toBe(200);
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
  });

  it("a session for another app, an expired one or a made-up one is anonymous", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    const other = await sessions.issue("alice-other", hex(ownerAid.publicKey), Date.now(), 60_000);
    const expired = await sessions.issue(SVC, hex(ownerAid.publicKey), Date.now() - 120_000, 60_000);
    for (const token of [other, expired, "f".repeat(64)]) {
      const r = await send(b.port, "/private", { cookie: `Flagship-App-Session=${token}` });
      expect(r.status).toBe(200);
      expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
      expect(up.seen()["x-flagship-user"]).toBeUndefined();
    }
    await access.setMode(SVC, "restricted");
    for (const token of [other, expired, "f".repeat(64)]) {
      expect((await send(b.port, "/private", { cookie: `Flagship-App-Session=${token}` })).status).toBe(403);
      await send(b.port, "/pub", { cookie: `Flagship-App-Session=${token}` });
      expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    }
  });

  it("on an open app a cross-origin write from a sibling app arrives anonymous", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    const cookie = await cookieOf(b, ownerAid);
    const priv = await send(b.port, "/private", { cookie, origin: `https://notes.${SERVER}`, "content-type": "application/json" }, "POST", "{}");
    expect(priv.status).toBe(200);
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    expect(up.seen()["x-flagship-user"]).toBeUndefined();
  });

  it("on a members-only app a cross-origin write or WebSocket upgrade from a sibling app loses the member session", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    await access.setMode(SVC, "restricted");
    const cookie = await cookieOf(b, ownerAid);
    const sibling = `https://notes.${SERVER}`;
    const priv = await send(b.port, "/private", { cookie, origin: sibling, "content-type": "application/json" }, "POST", "{}");
    expect(priv.status).toBe(403);
    const pub = await send(b.port, "/pub", { cookie, origin: sibling, "content-type": "application/json" }, "POST", "{}");
    expect(pub.status).toBe(200);
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    expect(up.seen()["x-flagship-user"]).toBeUndefined();
    const ws = await send(b.port, "/private", {
      cookie,
      origin: sibling,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    });
    expect(ws.status).toBe(403);
    expect(up.hits()).toBe(1);
  });
});

describe("API keys", () => {
  const owner = ownerIrk;
  async function key(): Promise<{ store: AppApiKeyStore; key: string }> {
    const store = new AppApiKeyStore(null, null);
    const http = buildAppApiKeysHttp({
      serverDomain: SERVER,
      store,
      authorize: apiKeyAuthorizer({ username: "alice", ownerIrkPub: owner.publicKey }),
      installed: () => true,
    });
    const grant = { serverDomain: SERVER, serviceId: SVC, keyId: "00000000000000aa", scope: "write" as const, expiresAt: 0, issuedAt: Date.now() };
    const body = JSON.stringify({ grant, signature: hex(signAppApiKeyGrant(grant, owner)), label: "cron" });
    const path = `/api/screens/services/${SVC}/api-keys`;
    const req: HttpRequest = { method: "POST", path, headers: {}, body: Buffer.from(body) };
    const r = await http.handle(path, "POST", req, { companion: false });
    return { store, key: String(JSON.parse(String(r!.body)).key) };
  }

  it("still reach private paths, on an open app and through a restricted gate", async () => {
    const up = await container();
    const { store, key: k } = await key();
    const b = await box(makeApp(up.port), store);
    const forged = { "x-flagship-user": "owner-id", "x-flagship-api-scope": "write", "x-flagship-visitor": "member" };
    expect((await send(b.port, "/private", { authorization: `Bearer ${k}`, ...forged })).status).toBe(200);
    expect(up.seen()["x-flagship-user"]).toBe("apikey:00000000000000aa");
    expect(up.seen()["x-flagship-role"]).toBe("api");
    expect(up.seen()["x-flagship-visitor"]).toBe("api");
    expect(up.seen()["x-flagship-api-scope"]).toBe("write");
    expect(up.seen()["authorization"]).toBeUndefined();
    expect(verifyInjected(up.seen(), ["write"])).toBe(true);
    await access.setMode(SVC, "restricted");
    expect((await send(b.port, "/private", { authorization: `Bearer ${k}` })).status).toBe(200);
    expect(up.seen()["x-flagship-role"]).toBe("api");
  });
});

describe("open apps: members sign in on purpose (docs/service-access-gating.md, Open mode + members)", () => {
  /** Approve a knock page the way a phone does; returns the session cookie or the refusal status. */
  async function approveKnock(
    b: Awaited<ReturnType<typeof box>>,
    page: { headers: IncomingHttpHeaders; body: string },
    aid: Keypair,
  ): Promise<{ cookie: string } | { refused: number }> {
    const holder = cookieValue(page.headers["set-cookie"], "Flagship-Knock");
    const pageId = /var PAGE = "([0-9a-f]{32})"/.exec(page.body)![1]!;
    const authorization = { serverId: SERVER, serviceRef: SVC, pageId, visitorAID: aid.publicKey, issuedAt: Date.now() };
    const approve = await b.accessWeb.handle({
      method: "POST",
      path: "/api/service-access/knock/authorize",
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          authorization: { ...authorization, visitorAID: hex(aid.publicKey) },
          sig: hex(signKnockAuthorization(authorization, aid)),
        }),
      ),
    });
    if (approve!.status !== 200) return { refused: approve!.status };
    const poll = await send(b.port, `/__flagship/knock/${pageId}/status`, { cookie: holder });
    return { cookie: cookieValue(poll.headers["set-cookie"], "Flagship-App-Session") };
  }

  it("a member signs in from the sign-in link and the app sees the role the owner set", async () => {
    const up = await container();
    const app = makeApp(up.port);
    await access.addAllowed(SVC, hex(memberAid.publicKey));
    await access.setRole(SVC, { kind: "aid", aid: hex(memberAid.publicKey) }, `aid:${hex(memberAid.publicKey)}`, "member", 1);
    const b = await box(app);
    // Anonymous on the public page until they sign in.
    await send(b.port, "/pub");
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    expect(up.seen()["x-flagship-role"]).toBeUndefined();
    const page = await send(b.port, "/__flagship/sign-in?next=/pub?tab=2");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<h1>Sign in</h1>");
    expect(page.body).toContain('var NEXT = "/pub?tab=2"');
    const r = await approveKnock(b, page, memberAid);
    if (!("cookie" in r)) throw new Error(`refused ${r.refused}`);
    await send(b.port, "/pub", { cookie: r.cookie, "x-flagship-role": "master", "x-flagship-visitor": "anonymous" });
    expect(up.seen()["x-flagship-role"]).toBe("member");
    expect(up.seen()["x-flagship-visitor"]).toBe("member");
    expect(verifyInjected(up.seen())).toBe(true);
    // The owner's rank beats the legacy membership store.
    app.membership.members.internalAdd(memberAid.publicKey, "master");
    await send(b.port, "/pub", { cookie: r.cookie });
    expect(up.seen()["x-flagship-role"]).toBe("member");
    // Already signed in: the link goes straight back.
    const again = await send(b.port, "/__flagship/sign-in?next=/pub", { cookie: r.cookie });
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe("/pub");
    // Removed from the members: an anonymous visitor again (the app stays open).
    await access.removeAllowed(SVC, hex(memberAid.publicKey));
    const after = await send(b.port, "/pub", { cookie: r.cookie });
    expect(after.status).toBe(200);
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    expect(up.seen()["x-flagship-role"]).toBeUndefined();
  });

  it("someone who isn't a member can't sign in on an open app", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    const page = await send(b.port, "/__flagship/sign-in");
    expect(await approveKnock(b, page, strangerAid)).toEqual({ refused: 401 });
  });

  it("sign-out ends the session and returns to a same-origin path only", async () => {
    const up = await container();
    const b = await box(makeApp(up.port));
    const cookie = await cookieOf(b, ownerAid);
    const out = await send(b.port, "/__flagship/sign-out?next=//evil.example/x", { cookie });
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe("/");
    expect(String(out.headers["set-cookie"])).toContain("Flagship-App-Session=;");
    await send(b.port, "/pub", { cookie });
    expect(up.seen()["x-flagship-visitor"]).toBe("anonymous");
    expect(up.seen()["x-flagship-role"]).toBeUndefined();
    const page = await send(b.port, "/__flagship/sign-in?next=https://evil.example/");
    expect(page.body).toContain('var NEXT = "/"');
  });
});

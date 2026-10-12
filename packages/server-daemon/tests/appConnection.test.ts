/**
 * The streaming app path (docs/app-apis.md §1–4): SSE delivered as the app
 * sends it, streamed uploads, WebSocket upgrades decided and stamped like any
 * request, API keys, the sibling-app guard, and the connection limits.
 */
import { createHash } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { deriveIRK, ed, signAppApiKeyGrant, type Keypair } from "@flagship/protocol";
import { AppConnectionLimiter, handleAppConnection, type AppConnectionLimits } from "../src/appConnection.js";
import { AppApiKeyStore, apiKeyAuthorizer, buildAppApiKeysHttp } from "../src/appApiKeys.js";
import { prepareAppRequest, type AppProxyDeps } from "../src/serviceProxy.js";
import type { InstalledService } from "../src/servicePlatform.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";
import { boxSigner } from "./helpers/keyCustody.js";

const HOST = "game1.home.alice.flagship.services";
const OWN = `https://${HOST}`;
const SVC = "alice-game1";
const injectorKey: Keypair = { privateKey: new Uint8Array(32).fill(5), publicKey: ed.getPublicKey(new Uint8Array(32).fill(5)) };

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function fakeApp(port: number, publicRoutes: string[] = []): InstalledService {
  return {
    serviceId: SVC,
    urlLabel: "game1",
    containerPort: port,
    manifest: { name: "game1", access: { enabled: true, default_role: "viewer", public_routes: publicRoutes } },
    membership: { members: { isMember: () => true } },
  } as unknown as InstalledService;
}

/** A member session when the request carries `cookie: member=1`. */
const memberSession: AppProxyDeps["resolveSession"] = (req) =>
  (req.headers.cookie ?? "").includes("member=1")
    ? { memberPub: new Uint8Array(32).fill(1), stableId: "member-1", role: "member" }
    : null;

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

async function upstream(handler: Parameters<typeof createHttpServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createHttpServer(handler);
  const port = await listen(server);
  closers.push(() => server.closeAllConnections());
  return { server, port };
}

async function proxy(
  app: InstalledService,
  opts: {
    deps?: Partial<AppProxyDeps>;
    limiter?: AppConnectionLimiter;
    limits?: Partial<AppConnectionLimits>;
    gate?: (req: HttpRequest) => Promise<HttpResponse | null>;
  } = {},
): Promise<number> {
  const deps: AppProxyDeps = { injector: boxSigner(injectorKey), resolveSession: memberSession, ...opts.deps };
  const sockets = new Set<import("node:net").Socket>();
  const server = createNetServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    handleAppConnection(sock, {
      serviceId: app.serviceId,
      gate: opts.gate ?? (async () => null),
      prepare: (req, info) => prepareAppRequest(app, req, deps, info),
      upstream: { host: "127.0.0.1", port: app.containerPort },
      limiter: opts.limiter ?? new AppConnectionLimiter(),
      ...(opts.limits ? { limits: opts.limits } : {}),
    });
  });
  const port = await listen(server);
  closers.push(() => sockets.forEach((s) => s.destroy()));
  return port;
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: Buffer | Buffer[],
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: HOST, ...headers }, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    r.on("error", reject);
    if (Array.isArray(body)) {
      for (const b of body) r.write(b);
      r.end();
    } else r.end(body);
  });
}

function verifyInjected(h: IncomingHttpHeaders, extra: string[] = []): boolean {
  const fields = ["flagship/inject/v1", h["x-flagship-app-id"], h["x-flagship-user"], h["x-flagship-role"], h["x-flagship-timestamp"], ...extra];
  const sig = Buffer.from(String(h["x-flagship-signature"]), "hex");
  return ed.verify(new Uint8Array(sig), new TextEncoder().encode(fields.join("|")), injectorKey.publicKey);
}

describe("streaming responses", () => {
  it("delivers Server-Sent Events incrementally, while the app is still sending", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let seen: IncomingHttpHeaders = {};
    const up = await upstream(async (req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: one\n\n");
      await held;
      res.write("data: two\n\n");
      res.end();
    });
    const port = await proxy(fakeApp(up.port, ["/events"]));
    const events: string[] = [];
    const ended = new Promise<IncomingHttpHeaders>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "/events", headers: { host: HOST }, agent: false }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          events.push(d);
          if (d.includes("one")) release(); // the app only sends "two" after "one" reached the client
        });
        res.on("end", () => resolve(res.headers));
      });
      r.on("error", reject);
      r.end();
    });
    const headers = await ended;
    expect(events.join("")).toBe("data: one\n\ndata: two\n\n");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(headers["content-type"]).toBe("text/event-stream");
    expect(headers["transfer-encoding"]).toBe("chunked");
    expect(headers["connection"]).toBe("close");
    expect(seen["x-flagship-user"]).toBe("anonymous");
    expect(verifyInjected(seen)).toBe(true);
  });

  it("passes a Content-Length body and every Set-Cookie through", async () => {
    const up = await upstream((_req, res) => {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.setHeader("access-control-allow-origin", "https://other.example");
      res.setHeader("content-length", "5");
      res.end("hello");
    });
    const port = await proxy(fakeApp(up.port, ["/"]));
    const r = await get(port, "/");
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello");
    expect(r.headers["content-length"]).toBe("5");
    expect(r.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    // No CORS rules of the box's own: the app's headers pass through untouched.
    expect(r.headers["access-control-allow-origin"]).toBe("https://other.example");
  });

  it("answers HTTP/1.0 close-delimited", async () => {
    const up = await upstream((_req, res) => {
      res.write("part1-");
      res.end("part2");
    });
    const port = await proxy(fakeApp(up.port, ["/"]));
    const raw = await new Promise<string>((resolve) => {
      const s = netConnect(port, "127.0.0.1", () => s.write(`GET / HTTP/1.0\r\nHost: ${HOST}\r\n\r\n`));
      const parts: Buffer[] = [];
      s.on("data", (d) => parts.push(d));
      s.on("close", () => resolve(Buffer.concat(parts).toString()));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(raw.toLowerCase()).not.toContain("transfer-encoding");
    expect(raw.endsWith("\r\n\r\npart1-part2")).toBe(true);
  });
});

describe("streaming request bodies", () => {
  async function hashingUpstream() {
    return upstream((req, res) => {
      const h = createHash("sha256");
      let n = 0;
      req.on("data", (d: Buffer) => {
        h.update(d);
        n += d.length;
      });
      req.on("end", () => res.end(JSON.stringify({ n, sha: h.digest("hex"), te: req.headers["transfer-encoding"] ?? null })));
    });
  }

  it("streams a large Content-Length upload intact", async () => {
    const up = await hashingUpstream();
    const port = await proxy(fakeApp(up.port, ["/upload"]));
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    const r = await get(port, "/upload", { "content-length": String(big.length) }, "POST", big);
    expect(JSON.parse(r.body)).toEqual({ n: big.length, sha: createHash("sha256").update(big).digest("hex"), te: null });
  });

  it("streams a chunked upload intact", async () => {
    const up = await hashingUpstream();
    const port = await proxy(fakeApp(up.port, ["/upload"]));
    const parts = [Buffer.from("hello "), Buffer.alloc(200_000, 1), Buffer.from(" world")];
    const r = await get(port, "/upload", { "transfer-encoding": "chunked" }, "POST", parts);
    const all = Buffer.concat(parts);
    expect(JSON.parse(r.body)).toEqual({ n: all.length, sha: createHash("sha256").update(all).digest("hex"), te: "chunked" });
  });

  it("buffers a small body so the gates can read it", async () => {
    const up = await hashingUpstream();
    let gateBody = "";
    const port = await proxy(fakeApp(up.port, ["/f"]), {
      gate: async (req) => {
        gateBody = req.body.toString();
        return null;
      },
    });
    const r = await get(port, "/f", { "content-length": "3" }, "POST", Buffer.from("abc"));
    expect(gateBody).toBe("abc");
    expect(JSON.parse(r.body).n).toBe(3);
  });
});

/** A WebSocket echo app that records the upgrade request's headers. */
async function wsEchoApp() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createHttpServer((_req, res) => res.end("plain"));
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    seen.push(req.headers);
    ws.on("message", (m, isBinary) => ws.send(m, { binary: isBinary }));
  });
  const port = await listen(server);
  closers.push(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  return { port, seen };
}

function openWs(port: number, path: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { host: HOST, ...headers } });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
    closers.push(() => ws.terminate());
  });
}

function echo(ws: WebSocket, msg: string): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (d) => resolve(d.toString()));
    ws.send(msg);
  });
}

describe("WebSocket upgrades", () => {
  it("passes an upgrade through with signed member identity and echoes both ways", async () => {
    const app = await wsEchoApp();
    const port = await proxy(fakeApp(app.port));
    const ws = await openWs(port, "/ws", { cookie: "member=1", origin: OWN, "x-flagship-user": "forged" });
    expect(await echo(ws, "hello")).toBe("hello");
    expect(await echo(ws, "x".repeat(100_000))).toHaveLength(100_000);
    const h = app.seen[0]!;
    expect(h["x-flagship-user"]).toBe("member-1");
    expect(h["x-flagship-role"]).toBe("member");
    expect(h["x-flagship-app-id"]).toBe(SVC);
    expect(verifyInjected(h)).toBe(true);
    ws.close();
  });

  it("denies an upgrade the request would be denied for, before the app sees it", async () => {
    const app = await wsEchoApp();
    const port = await proxy(fakeApp(app.port));
    await expect(openWs(port, "/ws", {})).rejects.toThrow(/status 403/);
    expect(app.seen).toHaveLength(0);
  });

  it("treats an upgrade from another origin as anonymous (sibling-app guard), never blocking it", async () => {
    const app = await wsEchoApp();
    const port = await proxy(fakeApp(app.port, ["/ws"]));
    const ws = await openWs(port, "/ws", { cookie: "member=1", origin: "https://notes.home.alice.flagship.services" });
    expect(await echo(ws, "hi")).toBe("hi");
    expect(app.seen[0]!["x-flagship-user"]).toBe("anonymous");
    // Off a private path the same cross-origin upgrade is simply anonymous, so denied.
    const priv = await proxy(fakeApp(app.port));
    await expect(
      openWs(priv, "/ws", { cookie: "member=1", origin: "https://notes.home.alice.flagship.services" }),
    ).rejects.toThrow(/status 403/);
  });

  it("closes an idle upgraded connection", async () => {
    const app = await wsEchoApp();
    const port = await proxy(fakeApp(app.port, ["/ws"]), { limits: { idleTimeoutMs: 150 } });
    const ws = await openWs(port, "/ws", {});
    const closedAt = await new Promise<number>((r) => ws.once("close", () => r(Date.now())));
    expect(closedAt).toBeGreaterThan(0);
  });

  it("caps concurrent connections per app (503 beyond the cap)", async () => {
    const app = await wsEchoApp();
    const limiter = new AppConnectionLimiter(1);
    const port = await proxy(fakeApp(app.port, ["/ws", "/"]), { limiter });
    const ws = await openWs(port, "/ws", {});
    expect(limiter.active(SVC)).toBe(1);
    const r = await get(port, "/");
    expect(r.status).toBe(503);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(limiter.active(SVC)).toBe(0);
    expect((await get(port, "/")).body).toBe("plain");
  });
});

describe("request limits", () => {
  it("431 for an oversized head", async () => {
    const up = await upstream((_req, res) => res.end("x"));
    const port = await proxy(fakeApp(up.port, ["/"]), { limits: { maxHeaderBytes: 1024 } });
    const raw = await new Promise<string>((resolve) => {
      const s = netConnect(port, "127.0.0.1", () => s.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nX-Big: ${"a".repeat(4096)}\r\n\r\n`));
      const parts: Buffer[] = [];
      s.on("data", (d) => parts.push(d));
      s.on("close", () => resolve(Buffer.concat(parts).toString()));
      s.on("error", () => resolve(Buffer.concat(parts).toString()));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 431 /);
  });

  it("400 for both Transfer-Encoding and Content-Length (no smuggling)", async () => {
    const up = await upstream((_req, res) => res.end("x"));
    const port = await proxy(fakeApp(up.port, ["/"]));
    const raw = await new Promise<string>((resolve) => {
      const s = netConnect(port, "127.0.0.1", () =>
        s.write(`POST / HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`),
      );
      const parts: Buffer[] = [];
      s.on("data", (d) => parts.push(d));
      s.on("close", () => resolve(Buffer.concat(parts).toString()));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
  });
});

describe("API keys through the live proxy", () => {
  const FQDN = "home.alice.flagship.services";
  const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });

  async function keyFor(scope: "read" | "write"): Promise<{ store: AppApiKeyStore; key: string }> {
    const store = new AppApiKeyStore(null, null);
    const http = buildAppApiKeysHttp({
      serverDomain: FQDN,
      store,
      authorize: apiKeyAuthorizer({ username: "alice", ownerIrkPub: owner.publicKey }),
      installed: () => true,
    });
    const grant = { serverDomain: FQDN, serviceId: SVC, keyId: "00000000000000aa", scope, expiresAt: 0, issuedAt: Date.now() };
    const body = JSON.stringify({ grant, signature: Buffer.from(signAppApiKeyGrant(grant, owner)).toString("hex"), label: "cron" });
    const path = `/api/screens/services/${SVC}/api-keys`;
    const r = await http.handle(path, "POST", { method: "POST", path, headers: {}, body: Buffer.from(body) }, { companion: false });
    return { store, key: String(JSON.parse(String(r!.body)).key) };
  }

  it("a valid key reaches a private path as apikey:<keyId>, with the header stripped and the scope signed", async () => {
    let seen: IncomingHttpHeaders = {};
    const up = await upstream((req, res) => {
      seen = req.headers;
      res.end("ok");
    });
    const { store, key } = await keyFor("read");
    const port = await proxy(fakeApp(up.port), { deps: { apiKeys: store } });
    const r = await get(port, "/api/data", { authorization: `Bearer ${key}` });
    expect(r.status).toBe(200);
    expect(seen.authorization).toBeUndefined();
    expect(seen["x-flagship-user"]).toBe("apikey:00000000000000aa");
    expect(seen["x-flagship-role"]).toBe("api");
    expect(seen["x-flagship-api-scope"]).toBe("read");
    expect(verifyInjected(seen, ["read"])).toBe(true);
    expect(verifyInjected(seen)).toBe(false);
  });

  it("read key on a write method → 403; wrong key → 401; revoked → 401; the app is never reached", async () => {
    let hits = 0;
    const up = await upstream((_req, res) => {
      hits++;
      res.end("ok");
    });
    const { store, key } = await keyFor("read");
    const port = await proxy(fakeApp(up.port, ["/*"]), { deps: { apiKeys: store } });
    const post = await get(port, "/api/data", { authorization: `Bearer ${key}`, "content-length": "2" }, "POST", Buffer.from("{}"));
    expect(post.status).toBe(403);
    expect(JSON.parse(post.body).error).toMatch(/read-only/);
    const wrong = await get(port, "/", { authorization: `Bearer fsk_00000000000000aa_${"A".repeat(43)}` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["www-authenticate"]).toMatch(/Bearer/);
    await store.revoke(SVC, "00000000000000aa");
    expect((await get(port, "/", { authorization: `Bearer ${key}` })).status).toBe(401);
    expect(hits).toBe(0);
    // The app's own bearer tokens pass through untouched.
    expect((await get(port, "/", { authorization: "Bearer app-token" })).status).toBe(200);
    expect(hits).toBe(1);
  });
});

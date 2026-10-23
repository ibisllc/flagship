import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import { extractPairedSessionToken } from "../../src/pairedSessionStore.js";
import { buildScreensUpgradeHandler } from "../../src/screens/screensWs.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { TabRegistry } from "../../src/browser/tabRegistry.js";
import { FakeCdpServer } from "../browser/fakeCdpServer.js";
import { ScreensEventBus } from "../../src/screens/screensEvents.js";
import type { HttpRequest, HttpResponse, UpgradeRequest } from "../../src/runtime.js";

// ---------- extractPairedSessionToken ----------

describe("extractPairedSessionToken", () => {
  function r(over: Partial<HttpRequest>): HttpRequest {
    return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
  }
  it("reads Authorization: Flagship-Session", () => {
    expect(
      extractPairedSessionToken(r({ headers: { authorization: "Flagship-Session abc" } })),
    ).toBe("abc");
  });
  it("reads x-flagship-session header", () => {
    expect(
      extractPairedSessionToken(r({ headers: { "x-flagship-session": "xyz" } })),
    ).toBe("xyz");
  });
  it("reads ?sessionToken= query string", () => {
    expect(
      extractPairedSessionToken(r({ path: "/x?sessionToken=qtok" })),
    ).toBe("qtok");
  });
  it("returns null when nothing is present", () => {
    expect(extractPairedSessionToken(r({}))).toBeNull();
  });
  it("authorization wins when multiple are present", () => {
    expect(
      extractPairedSessionToken(
        r({
          path: "/x?sessionToken=q",
          headers: { authorization: "Flagship-Session A", "x-flagship-session": "X" },
        }),
      ),
    ).toBe("A");
  });
});

// ---------- screensWs end-to-end --------------------------------------

class FakeGate {
  constructor(private readonly tokens: Set<string>) {}
  check(req: HttpRequest): HttpResponse | null {
    const tok = extractPairedSessionToken(req);
    if (!tok || !this.tokens.has(tok)) {
      return { status: 401, headers: { "content-type": "application/json" }, body: '{"error":"unauthorized"}' };
    }
    return null;
  }
}

interface TestServer {
  port: number;
  close: () => void;
  upgrades: UpgradeRequest[];
}

const tearDowns: Array<() => void> = [];

afterAll(() => {
  for (const td of tearDowns) td();
});

async function startTcpServer(handler: (args: UpgradeRequest) => boolean): Promise<TestServer> {
  const upgrades: UpgradeRequest[] = [];
  const server: Server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const headerBlock = buf.subarray(0, sep).toString("utf8");
      const headBuffer = buf.subarray(sep + 4);
      const lines = headerBlock.split(/\r\n/);
      const reqLine = lines[0]!.split(" ");
      const method = reqLine[0] ?? "";
      const path = reqLine[1] ?? "/";
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const idx = lines[i]!.indexOf(":");
        if (idx === -1) continue;
        headers[lines[i]!.slice(0, idx).trim().toLowerCase()] = lines[i]!.slice(idx + 1).trim();
      }
      sock.off("data", onData);
      const args: UpgradeRequest = {
        socket: sock as never,
        method,
        path,
        headers,
        headBuffer,
      };
      upgrades.push(args);
      const accepted = handler(args);
      if (!accepted) {
        sock.write("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\n\r\n");
        sock.end();
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const td = () => server.close();
  tearDowns.push(td);
  return { port: addr.port, close: td, upgrades };
}

function connect(port: number, path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`);
}

describe("screensWs — vibe-code/:id/stream", () => {
  it("rejects with 401 when the session token is missing or wrong", async () => {
    const registry = new VibeCodeSessionRegistry();
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
      vibeCodeRegistry: registry,
    });
    const server = await startTcpServer(handler);
    const ws = connect(server.port, `/api/screens/vibe-code/${session.meta.sessionId}/stream`);
    const code = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? -1);
        res.resume();
      });
      ws.once("error", () => resolve(-2));
    });
    expect(code).toBe(401);
  });

  it("returns 404 for a non-existent session", async () => {
    const registry = new VibeCodeSessionRegistry();
    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
      vibeCodeRegistry: registry,
    });
    const server = await startTcpServer(handler);
    const ws = connect(server.port, `/api/screens/vibe-code/no-such/stream?sessionToken=good-tok`);
    const code = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? -1);
        res.resume();
      });
      ws.once("error", () => resolve(-2));
    });
    expect(code).toBe(404);
  });

  it("accepts authorized upgrade + bridges session events to WS frames", async () => {
    const registry = new VibeCodeSessionRegistry();
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    session.pushUserMessage("describe");
    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
      vibeCodeRegistry: registry,
    });
    const server = await startTcpServer(handler);
    const ws = connect(server.port, `/api/screens/vibe-code/${session.meta.sessionId}/stream?sessionToken=good-tok`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const frames: unknown[] = [];
    ws.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
    });

    // Drive the session: a tiny fully-formed stream → expect token + manifest + done.
    session.feedAssistant("hello\n");
    session.feedAssistant("=== flagship.app.json ===\n");
    session.feedAssistant("{\"name\":\"x\"}\n");
    session.feedAssistant("=== END ===\n");
    session.endAssistant();
    // Then mark deployed.
    session.markDeployed({ serviceId: "alice-x", url: "https://x.home.alice.flagship.services" });

    // Wait for the deploy frame to land, with a generous timeout.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 200);
      ws.on("message", () => {
        const has = frames.some((f) => (f as { kind: string }).kind === "deploy");
        if (has) {
          clearTimeout(t);
          resolve();
        }
      });
    });

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));

    const kinds = frames.map((f) => (f as { kind: string }).kind);
    expect(kinds).toContain("token");
    expect(kinds).toContain("manifest-emit");
    expect(kinds).toContain("deploy");
    expect(kinds).toContain("done");
    const deployFrame = frames.find((f) => (f as { kind: string }).kind === "deploy") as { url: string };
    expect(deployFrame.url).toContain("home.alice.flagship.services");
  });

  it("a stream is registered against its session's grant and closes when that session ends", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AuthorityHub, GrantIndex, OperationLedger } = await import("../../src/authority/index.js");
    const { buildTrackWork, sessionGrantId } = await import("../../src/authority/sessionWork.js");
    const dir = await mkdtemp(join(tmpdir(), "ws-work-"));
    const idx = new GrantIndex(join(dir, "g.json"));
    await idx.load();
    await idx.issue({ id: sessionGrantId("good-tok", false), kind: "owner-session", issuer: "account", subject: "s", accountGeneration: 1, audience: "box", capability: "owner", policyRevision: 1, issuedAt: Date.now() });
    const ledger = new OperationLedger(join(dir, "o.json"), { grantsLive: () => true, currentRevision: () => 0, verifyApproval: () => false });
    await ledger.load();
    const hub = new AuthorityHub(idx, ledger);
    const registry = new VibeCodeSessionRegistry();
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    const server = await startTcpServer(
      buildScreensUpgradeHandler({
        gate: new FakeGate(new Set(["good-tok"])),
        vibeCodeRegistry: registry,
        trackWork: buildTrackWork(hub, () => false),
      }),
    );
    const ws = connect(server.port, `/api/screens/vibe-code/${session.meta.sessionId}/stream?sessionToken=good-tok`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    expect(hub.openWorkFor(sessionGrantId("good-tok", false))).toEqual([`build stream ${session.meta.sessionId}`]);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await hub.revoke(sessionGrantId("good-tok", false), "session removed");
    expect(await closed).toBe(1008);
    expect(hub.openWorkFor(sessionGrantId("good-tok", false))).toEqual([]);
  });

  it("non-stream paths return false (let the chain fall through)", async () => {
    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
      vibeCodeRegistry: new VibeCodeSessionRegistry(),
    });
    const dummy: UpgradeRequest = {
      socket: { write: () => {}, end: () => {} } as never,
      method: "GET",
      path: "/api/screens/server-detail",
      headers: { "x-flagship-session": "good-tok" },
      headBuffer: Buffer.alloc(0),
    };
    expect(handler(dummy)).toBe(false);
  });
});

describe("screensWs — browser-tabs/:tabId/stream (P1.11)", () => {
  it("returns 503 when no browser bundle is wired", async () => {
    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
    });
    const server = await startTcpServer(handler);
    const ws = connect(server.port, `/api/screens/browser-tabs/tab-1/stream?sessionToken=good-tok`);
    const code = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? -1);
        res.resume();
      });
      ws.once("error", () => resolve(-2));
    });
    expect(code).toBe(503);
  });

  it("returns 404 when the tab has no app owner (cross-tenant lookup)", async () => {
    const cdp = new FakeCdpServer();
    const ep = await cdp.start();
    const browser = new BrowserManager({ endpoint: ep.endpoint });
    await browser.start();
    const tabRegistry = new TabRegistry(browser);
    tabRegistry.start();
    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
      browser,
      tabRegistry,
    });
    const server = await startTcpServer(handler);
    const ws = connect(server.port, `/api/screens/browser-tabs/no-such-tab/stream?sessionToken=good-tok`);
    const code = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? -1);
        res.resume();
      });
      ws.once("error", () => resolve(-2));
    });
    expect(code).toBe(404);
    await browser.stop();
    tabRegistry.stop();
    await cdp.stop();
  });

  it("accepts upgrade + forwards screencast frames + dispatches input", async () => {
    const cdp = new FakeCdpServer();
    const ep = await cdp.start();
    const browser = new BrowserManager({ endpoint: ep.endpoint });
    await browser.start();

    // Register the tab as owned by an app (mirroring what apiHandlers
    // does after openTab) so the cross-tenant gate in screensWs lets
    // it through.
    const tabRegistry = new TabRegistry(browser);
    tabRegistry.start();
    tabRegistry.assignTab("tab-A", "alice-game");

    let attachedSession: string | null = null;
    cdp.on("Target.attachToTarget", (_p, _s) => {
      attachedSession = "session-fake";
      return { sessionId: "session-fake" };
    });
    let screencastStarted = false;
    cdp.on("Page.startScreencast", () => {
      screencastStarted = true;
      return {};
    });
    let stoppedScreencast = false;
    cdp.on("Page.stopScreencast", () => {
      stoppedScreencast = true;
      return {};
    });
    let lastInput: { method: string; params: unknown } | null = null;
    cdp.on("Input.dispatchMouseEvent", (params) => {
      lastInput = { method: "Input.dispatchMouseEvent", params };
      return {};
    });

    const handler = buildScreensUpgradeHandler({
      gate: new FakeGate(new Set(["good-tok"])),
      browser,
      tabRegistry,
    });
    const server = await startTcpServer(handler);
    const ws = connect(server.port, `/api/screens/browser-tabs/tab-A/stream?sessionToken=good-tok`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
    });

    // Wait for startScreencast to land + then push a fake frame event.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (screencastStarted && attachedSession) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    cdp.emitEvent("Page.screencastFrame", {
      data: Buffer.from("fake-jpeg").toString("base64"),
      sessionId: 1,
      metadata: { offsetTop: 0, deviceWidth: 1024, deviceHeight: 768 },
    }, attachedSession ?? undefined);

    // Wait for the frame to arrive on the WS.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (frames.some((f) => f.kind === "frame")) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    expect(frames.find((f) => f.kind === "frame")?.dataBase64).toBe(
      Buffer.from("fake-jpeg").toString("base64"),
    );

    // Send an input event WS-side and assert the CDP server saw it.
    ws.send(JSON.stringify({
      kind: "input",
      input: { kind: "mouseDown", x: 10, y: 20, button: "left" },
    }));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (lastInput) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    expect(lastInput?.method).toBe("Input.dispatchMouseEvent");
    expect((lastInput?.params as { type: string }).type).toBe("mousePressed");

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    // After WS close the daemon stops the screencast.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (stoppedScreencast) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    expect(stoppedScreencast).toBe(true);

    await browser.stop();
    tabRegistry.stop();
    await cdp.stop();
  });
});

describe("screensWs — /api/screens/events", () => {
  const statusOf = (ws: WebSocket) =>
    new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? -1);
        res.resume();
      });
      ws.once("error", () => resolve(-2));
    });

  it("401 without a paired session, 503 without a bus", async () => {
    const gate = new FakeGate(new Set(["good-tok"]));
    const a = await startTcpServer(buildScreensUpgradeHandler({ gate, events: new ScreensEventBus() }));
    expect(await statusOf(connect(a.port, "/api/screens/events?sessionToken=bad"))).toBe(401);
    const b = await startTcpServer(buildScreensUpgradeHandler({ gate }));
    expect(await statusOf(connect(b.port, "/api/screens/events?sessionToken=good-tok"))).toBe(503);
  });

  it("sends each access-request event as one JSON frame and unsubscribes on close", async () => {
    const bus = new ScreensEventBus();
    const server = await startTcpServer(buildScreensUpgradeHandler({ gate: new FakeGate(new Set(["good-tok"])), events: bus }));
    const ws = connect(server.port, "/api/screens/events?sessionToken=good-tok");
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const frame = new Promise<unknown>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
    bus.publish({ type: "access-request", serviceId: "alice-weather" });
    expect(await frame).toEqual({ type: "access-request", serviceId: "alice-weather" });
    expect(bus.subscriberCount).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.subscriberCount).toBe(0);
  });
});

// ---------- N06: single-use upgrade tickets ----------

import { UpgradeTicketStore, TICKET_TTL_MS } from "../../src/screens/upgradeTickets.js";

describe("upgrade tickets", () => {
  it("a ticket works once, for its route and its Origin only", () => {
    let t = 1_000;
    const s = new UpgradeTicketStore(() => t);
    const a = s.issue({ token: "tok", route: "/api/screens/events", origin: "https://webapp.example" });
    expect(s.consume(a, "/api/screens/events", "https://evil.example")).toBeNull(); // wrong Origin, and now spent
    expect(s.consume(a, "/api/screens/events", "https://webapp.example")).toBeNull();
    const b = s.issue({ token: "tok", route: "/api/screens/events", origin: "https://webapp.example" });
    expect(s.consume(b, "/api/screens/browser-tabs/1/stream", "https://webapp.example")).toBeNull(); // wrong route
    const c = s.issue({ token: "tok", route: "/api/screens/events", origin: "https://webapp.example" });
    expect(s.consume(c, "/api/screens/events", "https://webapp.example")).toBe("tok");
    expect(s.consume(c, "/api/screens/events", "https://webapp.example")).toBeNull(); // replay
    const d = s.issue({ token: "tok", route: "/api/screens/events", origin: null });
    t += TICKET_TTL_MS + 1;
    expect(s.consume(d, "/api/screens/events", null)).toBeNull(); // expired
  });

  it("the stream upgrade refuses the session token in the URL and accepts a ticket once", async () => {
    const tickets = new UpgradeTicketStore();
    const events = new ScreensEventBus();
    const handler = buildScreensUpgradeHandler({ gate: new FakeGate(new Set(["good-tok"])), events, tickets });
    const server = await startTcpServer(handler);
    const statusOf = (ws: WebSocket) =>
      new Promise<number>((resolve) => {
        ws.once("open", () => resolve(101));
        ws.once("unexpected-response", (_r, res) => { resolve(res.statusCode ?? -1); res.resume(); });
        ws.once("error", () => resolve(-2));
      });
    expect(await statusOf(connect(server.port, "/api/screens/events?sessionToken=good-tok"))).toBe(400);
    const ticket = tickets.issue({ token: "good-tok", route: "/api/screens/events", origin: null });
    const ok = connect(server.port, `/api/screens/events?ticket=${ticket}`);
    expect(await statusOf(ok)).toBe(101);
    ok.close();
    expect(await statusOf(connect(server.port, `/api/screens/events?ticket=${ticket}`))).toBe(401); // replayed
    expect(await statusOf(connect(server.port, "/api/screens/events"))).toBe(401); // none at all
    const viaHeader = new WebSocket(`ws://127.0.0.1:${server.port}/api/screens/events`, { headers: { "x-flagship-session": "good-tok" } });
    expect(await statusOf(viaHeader)).toBe(101); // a native client's header still works
    viaHeader.close();
  });
});

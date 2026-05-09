import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import { extractPairedSessionToken } from "../../src/pairedSessionStore.js";
import { buildScreensUpgradeHandler } from "../../src/screens/screensWs.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
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
    session.markDeployed({ appId: "alice--x", url: "https://x.home.alice.flagship.services" });

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

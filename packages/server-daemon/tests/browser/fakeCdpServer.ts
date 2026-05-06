/**
 * Minimal in-process CDP server stand-in for BrowserManager tests.
 *
 * Listens on an OS-assigned port; serves `/json/version` and a single
 * `/devtools/browser/<id>` WebSocket. Tests register handlers per-method;
 * unhandled methods get a `result: {}` echo so simple assertions work.
 *
 * The server is just enough CDP fidelity to exercise BrowserManager's
 * request/response correlation, session attach, event delivery, and
 * close behavior. It is NOT a real Chromium.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

export type CdpMethodHandler = (
  params: unknown,
  sessionId: string | undefined,
) => unknown;

export class FakeCdpServer {
  private http!: Server;
  private wss!: WebSocketServer;
  private clientSocket: WebSocket | null = null;
  private handlers = new Map<string, CdpMethodHandler>();
  /** Auto-allocated session ids per attached target. */
  private sessionByTab = new Map<string, string>();
  private nextSessionNum = 1;

  /** Start listening; returns the {endpoint, wsUrl} a BrowserManager would use. */
  async start(): Promise<{ endpoint: string; wsUrl: string }> {
    return new Promise((resolve) => {
      this.http = createServer((req, res) => {
        if (req.url === "/json/version") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              Browser: "FakeChromium/0",
              "Protocol-Version": "1.3",
              webSocketDebuggerUrl: this.wsAddress(),
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
      this.wss = new WebSocketServer({ server: this.http, path: "/devtools/browser/fake" });
      this.wss.on("connection", (ws) => {
        this.clientSocket = ws;
        ws.on("message", (raw) => this.handleIncoming(raw.toString("utf8")));
      });
      this.installDefaultHandlers();
      this.http.listen(0, "127.0.0.1", () => {
        const addr = this.http.address() as AddressInfo;
        resolve({
          endpoint: `http://127.0.0.1:${addr.port}`,
          wsUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/fake`,
        });
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.http.close(() => resolve());
      });
    });
  }

  /** Install / override a method handler. */
  on(method: string, handler: CdpMethodHandler): void {
    this.handlers.set(method, handler);
  }

  /** Push a synthetic CDP event to the connected client. */
  emitEvent(method: string, params: unknown, sessionId?: string): void {
    if (!this.clientSocket || this.clientSocket.readyState !== WebSocket.OPEN) return;
    const env: Record<string, unknown> = { method, params };
    if (sessionId) env.sessionId = sessionId;
    this.clientSocket.send(JSON.stringify(env));
  }

  private wsAddress(): string {
    const addr = this.http.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}/devtools/browser/fake`;
  }

  private installDefaultHandlers(): void {
    this.on("Target.setDiscoverTargets", () => ({}));
    this.on("Target.createTarget", (params) => {
      const targetId = `target-${this.nextSessionNum++}`;
      void params;
      return { targetId };
    });
    this.on("Target.closeTarget", () => ({ success: true }));
    this.on("Target.attachToTarget", (params) => {
      const p = params as { targetId: string };
      const sessionId = `session-${this.nextSessionNum++}`;
      this.sessionByTab.set(p.targetId, sessionId);
      return { sessionId };
    });
    this.on("Target.getTargets", () => ({
      targetInfos: [
        { targetId: "tab-x", type: "page", title: "x", url: "https://example.com/" },
      ],
    }));
    this.on("Page.enable", () => ({}));
    this.on("Runtime.enable", () => ({}));
    this.on("Page.navigate", () => ({ frameId: "frame-1", loaderId: "loader-1" }));
    this.on("Page.captureScreenshot", () => ({
      data: Buffer.from("fake-png-bytes").toString("base64"),
    }));
    this.on("Input.insertText", () => ({}));
    // Runtime.evaluate is content-dependent; tests override this when needed.
    this.on("Runtime.evaluate", () => ({ result: { type: "boolean", value: true } }));
  }

  private handleIncoming(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;
    if (!method || typeof id !== "number") return;
    const handler = this.handlers.get(method);
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    let result: unknown;
    try {
      result = handler ? handler(msg.params, sessionId) : {};
    } catch (e) {
      this.send({ id, error: { code: -1, message: (e as Error).message } });
      return;
    }
    this.send({ id, result, ...(sessionId ? { sessionId } : {}) });
  }

  private send(env: unknown): void {
    if (!this.clientSocket || this.clientSocket.readyState !== WebSocket.OPEN) return;
    this.clientSocket.send(JSON.stringify(env));
  }
}

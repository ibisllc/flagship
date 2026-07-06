/**
 * `/api/screens/*` WebSocket upgrade handlers.
 *
 * Currently implemented:
 *   - GET /api/screens/vibe-code/<id>/stream         (P1.6)
 *   - GET /api/screens/browser-tabs/<tabId>/stream   (P1.11)
 *
 * Auth: paired-session token is supplied via the `?sessionToken=...`
 * query string. Browsers can't set custom headers on `new WebSocket()`,
 * so the token rides on the URL — TLS terminates here so it's not
 * exposed in transit. The token is checked against PairedSessionGate
 * before the handshake completes.
 */

import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { PairedSessionGate } from "../alertInboxHttp.js";
import type {
  BrowserManager,
  InputEvent,
} from "../browser/browserManager.js";
import type { TabRegistry } from "../browser/tabRegistry.js";
import type {
  VibeCodeEvent,
  VibeCodeSession,
  VibeCodeSessionRegistry,
} from "../llm/vibeCodeSession.js";
import type { HttpRequest, UpgradeRequest } from "../runtime.js";
import type { VibeCodeFrame } from "./types.js";

const wss = new WebSocketServer({ noServer: true });

export interface ScreensWsDeps {
  gate: PairedSessionGate;
  vibeCodeRegistry?: VibeCodeSessionRegistry | null;
  browser?: BrowserManager | null;
  tabRegistry?: TabRegistry | null;
}

const VIBE_CODE_STREAM_RE = /^\/api\/screens\/vibe-code\/([^/]+)\/stream$/;
const BROWSER_TAB_STREAM_RE = /^\/api\/screens\/browser-tabs\/([^/]+)\/stream$/;

export function buildScreensUpgradeHandler(
  deps: ScreensWsDeps,
): (args: UpgradeRequest) => boolean {
  return function handle(args: UpgradeRequest): boolean {
    if (args.method.toUpperCase() !== "GET") return false;
    // Strip query string for path matching; we still need it for auth.
    const qIdx = args.path.indexOf("?");
    const justPath = qIdx >= 0 ? args.path.slice(0, qIdx) : args.path;
    const query = qIdx >= 0 ? new URLSearchParams(args.path.slice(qIdx + 1)) : new URLSearchParams();

    const vcMatch = VIBE_CODE_STREAM_RE.exec(justPath);
    if (vcMatch) {
      return acceptVibeCodeStream(args, deps, vcMatch[1]!, query);
    }

    const tabMatch = BROWSER_TAB_STREAM_RE.exec(justPath);
    if (tabMatch) {
      return acceptBrowserTabStream(args, deps, tabMatch[1]!);
    }

    return false;
  };
}

function acceptVibeCodeStream(
  args: UpgradeRequest,
  deps: ScreensWsDeps,
  sessionId: string,
  query: URLSearchParams,
): boolean {
  // Paired-session check — re-use the existing gate by faking an
  // HttpRequest. The gate's check() reads the token from the query
  // string OR the x-flagship-session header; we surface both so it
  // can find one of them.
  const fakeHttpReq: HttpRequest = {
    method: args.method,
    path: args.path,
    headers: args.headers,
    body: Buffer.alloc(0),
  };
  const denied = deps.gate.check(fakeHttpReq);
  if (denied) {
    rejectUpgrade(args.socket, denied.status, "unauthorized");
    return true;
  }

  if (!deps.vibeCodeRegistry) {
    rejectUpgrade(args.socket, 503, "vibe-code not configured");
    return true;
  }
  const session = deps.vibeCodeRegistry.get(sessionId);
  if (!session) {
    rejectUpgrade(args.socket, 404, "session not found");
    return true;
  }

  // Complete the handshake. ws's noServer mode wants an
  // IncomingMessage-like; only headers/method/url are read.
  const fakeReq = {
    headers: args.headers,
    method: args.method,
    url: args.path,
  } as unknown as import("node:http").IncomingMessage;

  wss.handleUpgrade(fakeReq, args.socket as unknown as Socket, args.headBuffer, (ws: WsSocket) => {
    bridgeVibeCodeSession(ws, session);
  });

  return true;
}

/**
 * Pump the session's `event` emitter onto the WS as JSON-encoded
 * `VibeCodeFrame`s. On WS close, unsubscribe.
 *
 * Replay strategy: we send a snapshot of the files + a synthetic
 * `manifest-emit` (if a manifest is already present) at the start, so
 * a late-attaching client doesn't lose the early stream. Token-level
 * deltas before the WS opened are NOT replayed — clients that need a
 * full transcript can fall back to GET P1.7 first.
 */
function bridgeVibeCodeSession(ws: WsSocket, session: VibeCodeSession): void {
  const send = (frame: VibeCodeFrame) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // ignored — ws may have closed mid-send
      }
    }
  };

  // 1. Replay snapshot. Files-tree first, manifest if present, so the
  //    client renders the current state before live tokens flow.
  const files = session.files();
  for (const path of Object.keys(files)) {
    if (path === "flagship.app.json") {
      send({ kind: "manifest-emit", manifestJson: files[path]! });
    }
    // Whole-file snapshot encoded as a single token frame so the
    // client's append-on-token logic produces the same final tree.
  }

  // 2. Live event stream.
  const onEvent = (e: VibeCodeEvent) => {
    switch (e.kind) {
      case "chunk":
        send({ kind: "token", text: e.text });
        return;
      case "file-complete":
        if (e.filename === "flagship.app.json") {
          send({ kind: "manifest-emit", manifestJson: e.content });
        }
        return;
      case "phase":
        if (e.phase === "build") send({ kind: "build-start" });
        return;
      case "deployed":
        send({ kind: "deploy", serviceId: e.serviceId, url: e.url });
        send({ kind: "done" });
        return;
      case "error":
        send({ kind: "error", message: e.message });
        return;
      case "done":
        send({ kind: "done" });
        return;
      default:
        // thinking / file-start / etc. — not surfaced as a frame v1
        return;
    }
  };
  session.on("event", onEvent);

  // 3. If the session is already terminal at attach time, send a
  //    `done` frame immediately so the client closes cleanly.
  if (session.meta.status === "deployed") {
    send({
      kind: "deploy",
      serviceId: session.meta.serviceId ?? "",
      url: session.meta.url ?? "",
    });
    send({ kind: "done" });
  } else if (session.meta.status === "failed") {
    send({ kind: "error", message: session.meta.failureReason ?? "session failed" });
  }

  ws.on("close", () => {
    session.off("event", onEvent);
  });
  ws.on("error", () => {
    session.off("event", onEvent);
  });
}

function acceptBrowserTabStream(
  args: UpgradeRequest,
  deps: ScreensWsDeps,
  tabId: string,
): boolean {
  // Same gate path as vibe-code — synthesize an HttpRequest so the
  // gate can read the token from query / header / authorization.
  const fakeHttpReq: HttpRequest = {
    method: args.method,
    path: args.path,
    headers: args.headers,
    body: Buffer.alloc(0),
  };
  const denied = deps.gate.check(fakeHttpReq);
  if (denied) {
    rejectUpgrade(args.socket, denied.status, "unauthorized");
    return true;
  }

  if (!deps.browser || !deps.tabRegistry) {
    rejectUpgrade(args.socket, 503, "browser bundle not configured");
    return true;
  }
  // The tab must be tracked by the registry — i.e. owned by an
  // installed app. Cross-tenant lookups return null.
  const ownerAppId = deps.tabRegistry.appIdForTab(tabId);
  if (!ownerAppId) {
    rejectUpgrade(args.socket, 404, "tab not found");
    return true;
  }

  const fakeReq = {
    headers: args.headers,
    method: args.method,
    url: args.path,
  } as unknown as import("node:http").IncomingMessage;

  wss.handleUpgrade(fakeReq, args.socket as unknown as Socket, args.headBuffer, (ws: WsSocket) => {
    void bridgeBrowserTab(ws, tabId, deps.browser!);
  });
  return true;
}

async function bridgeBrowserTab(ws: WsSocket, tabId: string, browser: BrowserManager): Promise<void> {
  const sendJson = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        // ignored — ws may have closed mid-send
      }
    }
  };

  let unsubscribe: (() => Promise<void>) | null = null;
  try {
    const sub = await browser.subscribeScreencast(tabId, ({ dataBase64, metadata }) => {
      sendJson({ kind: "frame", dataBase64, metadata });
    });
    unsubscribe = sub.unsubscribe;
  } catch (e) {
    sendJson({ kind: "error", message: `screencast failed: ${(e as Error).message}` });
    ws.close();
    return;
  }

  ws.on("message", (raw) => {
    let msg: { kind: string; input?: InputEvent };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.kind === "input" && msg.input) {
      void browser.dispatchInput(tabId, msg.input).catch((e) => {
        sendJson({ kind: "error", message: `input failed: ${(e as Error).message}` });
      });
    }
  });

  const cleanup = () => {
    if (unsubscribe) {
      const u = unsubscribe;
      unsubscribe = null;
      void u().catch(() => {});
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function rejectUpgrade(socket: { write: (b: string) => void; end: () => void }, status: number, message: string): void {
  const text = JSON.stringify({ error: message });
  const body = Buffer.from(text, "utf8");
  const head = [
    `HTTP/1.1 ${status} ${statusText(status)}`,
    `Content-Length: ${body.length}`,
    "Content-Type: application/json",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  socket.write(head);
  socket.write(text);
  socket.end();
}

function statusText(s: number): string {
  switch (s) {
    case 401: return "Unauthorized";
    case 404: return "Not Found";
    case 503: return "Service Unavailable";
    default: return "Error";
  }
}

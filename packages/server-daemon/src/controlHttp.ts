/**
 * The control API's HTTP reader (SEC N01).
 *
 * The daemon used to parse HTTP by hand on the box's TLS sockets: it
 * overwrote duplicate headers, took `parseInt` of Content-Length, buffered
 * without limits or deadlines, and dispatched the handler again for every
 * extra byte that arrived while an async handler was pending. Framing now
 * belongs to Node's maintained parser (llhttp, strict mode), and this module
 * adds only what the product needs on top of it:
 *
 *  - one request per connection, dispatched exactly once, then `Connection:
 *    close`: trailing or pipelined bytes are never a second request;
 *  - duplicate, conflicting or ambiguous security-bearing headers are refused
 *    (the Host header must be single and match the TLS server name);
 *  - bounded header size and time, and a body cap per route class;
 *  - nothing a caller sends nominates a header out of existence or names the
 *    peer: `Connection`-nominated and forwarding headers are dropped.
 *
 * TLS, SNI routing and ACME stay on the box; this sits behind them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const MAX_HEADER_BYTES = 32 * 1024;
export const CONTROL_JSON_BYTES = 1024 * 1024;
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Body caps. Control JSON is small; the listed routes carry bounded chunks or
 * attachments and get explicit, larger ceilings (their handlers still check
 * their own exact limits). Everything else keeps the control-JSON cap.
 */
const LARGE_BODY_ROUTES: ReadonlyArray<readonly [prefix: string, limit: number]> = [
  ["/api/screens/server-archive", 16 * 1024 * 1024],
  ["/api/screens/services/copy", 16 * 1024 * 1024],
  ["/api/app-copy/", 16 * 1024 * 1024],
  ["/api/peer-backup/", 16 * 1024 * 1024],
  ["/api/access-sync/", 4 * 1024 * 1024],
  ["/api/screens/vibe-code/", 96 * 1024 * 1024],
  ["/api/llm/sessions", 96 * 1024 * 1024],
  ["/api/build/", 96 * 1024 * 1024],
  ["/api/screens/app-backup/", 16 * 1024 * 1024],
];

export function bodyLimitFor(path: string): number {
  const p = path.split("?")[0]!;
  for (const [prefix, limit] of LARGE_BODY_ROUTES) if (p.startsWith(prefix)) return limit;
  return CONTROL_JSON_BYTES;
}

// Headers whose repetition is meaningful; every other duplicate is refused.
const LIST_HEADERS = new Set([
  "accept", "accept-charset", "accept-encoding", "accept-language", "access-control-request-headers",
  "cache-control", "pragma", "te", "vary", "via", "warning", "if-match", "if-none-match", "link",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "sec-websocket-protocol",
  "sec-websocket-extensions", "connection", "upgrade",
]);

const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "forwarded", "x-real-ip", "true-client-ip", "cf-connecting-ip"];
const KEEP_NOMINATED = new Set(["upgrade", "keep-alive", "close"]);

export type FramingProblem = { status: number; reason: string };

/** Refuse what must not reach a handler. `expectedHost` is the TLS server name when known. */
export function inspectRequest(
  rawHeaders: readonly string[],
  url: string | undefined,
  expectedHost: string | null,
): FramingProblem | null {
  if (!url || !url.startsWith("/") || url.startsWith("//") || /[\u0000- \u007f]/.test(url)) {
    return { status: 400, reason: "bad request target" };
  }
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    if (seen.has(name) && !LIST_HEADERS.has(name)) return { status: 400, reason: `duplicate ${name}` };
    seen.add(name);
  }
  if (seen.has("transfer-encoding")) return { status: 400, reason: "transfer-encoding is not accepted" };
  const host = rawHeaders.find((_v, i) => i % 2 === 0 && rawHeaders[i]!.toLowerCase() === "host") !== undefined
    ? rawHeaders[rawHeaders.findIndex((n, i) => i % 2 === 0 && n.toLowerCase() === "host") + 1]!
    : null;
  if (host === null) return { status: 400, reason: "missing host" };
  const name = hostWithoutPort(host);
  if (name === null) return { status: 400, reason: "bad host" };
  if (expectedHost && name !== expectedHost.toLowerCase()) return { status: 421, reason: "host does not match the connection" };
  return null;
}

export function hostWithoutPort(host: string): string | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(host.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Headers as the handlers see them: one value each, nothing nominated or forwarded. */
export function cleanHeaders(req: IncomingMessage): Record<string, string> {
  const nominated = new Set(
    String(req.headers["connection"] ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && !KEEP_NOMINATED.has(t)),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || nominated.has(k) || FORWARDING_HEADERS.includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export interface ControlHttpOptions {
  /** WebSocket hook: returning true hands the socket over; false answers 400. */
  onUpgrade?: (args: {
    socket: Duplex;
    method: string;
    path: string;
    headers: Record<string, string>;
    headBuffer: Buffer;
  }) => boolean;
}

interface Ctx {
  handler: (req: HttpRequest) => Promise<HttpResponse>;
  opts: ControlHttpOptions | undefined;
  expectedHost: string | null;
}

const contexts = new WeakMap<Duplex, Ctx>();
let shared: Server | null = null;

function server(): Server {
  if (shared) return shared;
  const s = createServer({
    maxHeaderSize: MAX_HEADER_BYTES,
    insecureHTTPParser: false,
    keepAlive: false,
  });
  s.headersTimeout = HEADERS_TIMEOUT_MS;
  s.requestTimeout = REQUEST_TIMEOUT_MS;
  s.keepAliveTimeout = 1;
  s.maxRequestsPerSocket = 1;
  s.timeout = 0;
  s.on("request", (req, res) => void onRequest(req, res));
  s.on("upgrade", (req, socket, head) => onUpgrade(req, socket, head));
  s.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status = err.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? "Request Header Fields Too Large" : "Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  shared = s;
  return s;
}

/** Serve one connection: parse, dispatch once, answer, close. */
export function serveControlHttp(
  socket: Duplex,
  handler: (req: HttpRequest) => Promise<HttpResponse>,
  opts?: ControlHttpOptions,
): void {
  const sni = (socket as { servername?: unknown }).servername;
  contexts.set(socket, { handler, opts, expectedHost: typeof sni === "string" && sni ? sni : null });
  socket.on("error", () => {});
  server().emit("connection", socket);
}

function reject(res: ServerResponse, status: number, reason: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader("connection", "close");
  res.setHeader("content-type", "text/plain");
  res.shouldKeepAlive = false;
  res.end(reason);
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = contexts.get(req.socket);
  if (!ctx) {
    reject(res, 500, "internal error");
    return;
  }
  const problem = inspectRequest(req.rawHeaders, req.url, ctx.expectedHost);
  if (problem) {
    req.resume();
    reject(res, problem.status, problem.reason);
    return;
  }
  const path = req.url!;
  const limit = bodyLimitFor(path);
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit) {
    req.resume();
    reject(res, 413, "request body too large");
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > limit) over = true;
    else chunks.push(c);
  });
  await new Promise<void>((resolve) => {
    req.on("end", resolve);
    req.on("error", resolve);
    req.on("close", resolve);
  });
  if (over) {
    reject(res, 413, "request body too large");
    return;
  }
  if (!req.complete) {
    res.destroy();
    return;
  }
  await respond(res, ctx, {
    method: req.method ?? "GET",
    path,
    headers: cleanHeaders(req),
    body: Buffer.concat(chunks),
  });
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const ctx = contexts.get(socket);
  const problem = inspectRequest(req.rawHeaders, req.url, ctx?.expectedHost ?? null);
  const websocket = String(req.headers["upgrade"] ?? "").toLowerCase() === "websocket";
  if (!ctx || problem || !websocket || !ctx.opts?.onUpgrade) {
    const status = problem?.status ?? 400;
    socket.end(`HTTP/1.1 ${status} ${status === 421 ? "Misdirected Request" : "Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  const accepted = ctx.opts.onUpgrade({
    socket,
    method: req.method ?? "GET",
    path: req.url!,
    headers: cleanHeaders(req),
    headBuffer: head,
  });
  if (!accepted) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

async function respond(res: ServerResponse, ctx: Ctx, req: HttpRequest): Promise<void> {
  let resp: HttpResponse;
  try {
    resp = await ctx.handler(req);
  } catch {
    const id = randomBytes(6).toString("hex");
    resp = { status: 500, headers: { "content-type": "text/plain" }, body: `internal error (${id})` };
  }
  try {
    const body = typeof resp.body === "string" ? Buffer.from(resp.body) : resp.body;
    const head = req.method.toUpperCase() === "HEAD";
    const noBody = head || resp.status === 204 || resp.status === 304 || (resp.status >= 100 && resp.status < 200);
    const length = resp.stream ? resp.stream.length : body.length;
    res.statusCode = resp.status;
    for (const [k, v] of Object.entries(resp.headers ?? { "content-type": "text/plain" })) {
      const lk = k.toLowerCase();
      if (lk === "content-length" || lk === "connection" || lk === "transfer-encoding") continue;
      res.setHeader(k, v);
    }
    res.setHeader("content-length", String(length));
    res.setHeader("connection", "close");
    res.shouldKeepAlive = false;
    if (resp.stream && !noBody && resp.stream.length > 0) {
      res.flushHeaders();
      const src = resp.stream.open();
      src.on("error", () => res.destroy());
      res.on("close", () => (src as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.());
      src.pipe(res);
      return;
    }
    res.end(noBody ? undefined : body);
  } catch {
    if (!res.headersSent) reject(res, 500, "internal error");
    else res.destroy();
  }
}

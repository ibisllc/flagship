/**
 * The live connection path for app traffic (docs/app-apis.md §1): one
 * HTTP/1.1 request per TLS connection, decided like any other request, then
 *
 *   - responses stream to the client as the container sends them (SSE, long
 *     downloads, chunked replies): a Content-Length body is passed through
 *     as-is, anything else is re-chunked (close-delimited for HTTP/1.0);
 *   - large or chunked request bodies stream to the container;
 *   - a WebSocket upgrade is decided and stamped with identity like a normal
 *     request, then bytes flow both ways until either side closes.
 *
 * Limits: request head size (431), time to send the head, an idle timeout on
 * live connections, and a per-app cap on concurrent forwarded connections
 * (503). Every response is `Connection: close` (no keep-alive: one request,
 * one decision, one connection).
 *
 * The daemon's own surface keeps its buffered handler (`runtime.ts`).
 */
import { STATUS_CODES, request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { PreparedAppRequest } from "./serviceProxy.js";

export interface AppConnectionLimits {
  /** Largest request head (request line + headers). Default 64 KiB. */
  maxHeaderBytes: number;
  /** Time a client has to send the whole head. Default 30 s. */
  headerTimeoutMs: number;
  /** A forwarded connection with no bytes either way for this long is closed. Default 10 min. */
  idleTimeoutMs: number;
  /** A body with a Content-Length up to this is read before the decision; larger ones stream. Default 1 MiB. */
  bufferBodyBytes: number;
}

export const DEFAULT_APP_CONNECTION_LIMITS: AppConnectionLimits = {
  maxHeaderBytes: 64 * 1024,
  headerTimeoutMs: 30_000,
  idleTimeoutMs: 10 * 60_000,
  bufferBodyBytes: 1024 * 1024,
};

/** Concurrent forwarded connections (streams, uploads, WebSockets) per app. */
export class AppConnectionLimiter {
  private readonly open = new Map<string, number>();
  constructor(readonly maxPerApp = 256) {}

  /** A release function, or null when the app is at its cap. */
  tryAcquire(serviceId: string): (() => void) | null {
    const n = this.open.get(serviceId) ?? 0;
    if (n >= this.maxPerApp) return null;
    this.open.set(serviceId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(serviceId) ?? 1) - 1;
      if (left <= 0) this.open.delete(serviceId);
      else this.open.set(serviceId, left);
    };
  }

  active(serviceId: string): number {
    return this.open.get(serviceId) ?? 0;
  }
}

export interface AppConnectionOptions {
  serviceId: string;
  /** The app gates (service access, knock endpoints): a response here wins. */
  gate: (req: HttpRequest) => Promise<HttpResponse | null>;
  /** Access decision + identity headers (`prepareAppRequest`). */
  prepare: (req: HttpRequest, info: { upgrade: boolean }) => Promise<PreparedAppRequest>;
  /** Where the container listens. */
  upstream: { host: string; port: number };
  limiter: AppConnectionLimiter;
  limits?: Partial<AppConnectionLimits>;
}

/** Request headers that describe this hop only; never forwarded. */
const HOP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "http2-settings",
]);
/** Response headers the box rewrites. */
const HOP_RESPONSE = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

const CRLF = Buffer.from("\r\n");
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface ParsedHead {
  method: string;
  path: string;
  version: "1.0" | "1.1";
  headers: Record<string, string>;
}

function parseHead(block: string): ParsedHead | null {
  const lines = block.split("\r\n");
  const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\/\S*) HTTP\/1\.([01])$/.exec(lines[0] ?? "");
  if (!m) return null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const idx = line.indexOf(":");
    if (idx <= 0) return null;
    const k = line.slice(0, idx);
    if (!TOKEN_RE.test(k)) return null; // also rejects obs-fold (leading space)
    const key = k.toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (/[^\t\x20-\x7e\x80-\xff]/.test(v)) return null;
    const prev = headers[key];
    headers[key] = prev === undefined ? v : `${prev}${key === "cookie" ? "; " : ", "}${v}`;
  }
  return { method: m[1]!, path: m[2]!, version: m[3] === "0" ? "1.0" : "1.1", headers };
}

function isWebSocketUpgrade(h: Record<string, string>): boolean {
  const upgrade = (h["upgrade"] ?? "").toLowerCase();
  const connection = (h["connection"] ?? "").toLowerCase();
  return upgrade === "websocket" && connection.split(",").some((t) => t.trim() === "upgrade");
}

function writeBuffered(socket: Duplex, resp: HttpResponse, method: string): void {
  const body = typeof resp.body === "string" ? Buffer.from(resp.body) : resp.body;
  const hdrs = resp.headers ?? { "content-type": "text/plain" };
  const lines = [
    `HTTP/1.1 ${resp.status} ${STATUS_CODES[resp.status] ?? "Unknown"}`,
    `Content-Length: ${body.length}`,
    "Connection: close",
  ];
  for (const [k, v] of Object.entries(hdrs)) {
    const kl = k.toLowerCase();
    if (kl === "content-length" || kl === "connection" || kl === "transfer-encoding") continue;
    lines.push(`${k}: ${v}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (method.toUpperCase() !== "HEAD") socket.write(body);
  socket.end();
}

function plain(status: number, text: string): HttpResponse {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body: text };
}

/** Streaming decoder for a chunked request body. */
class ChunkedDecoder {
  private state: "size" | "data" | "data-crlf" | "trailers" | "done" = "size";
  private line = "";
  private left = 0;

  /** Feed bytes; returns decoded data, or throws on a malformed body. `done` is set at the end. */
  push(chunk: Buffer, out: (data: Buffer) => void): void {
    let i = 0;
    while (i < chunk.length && this.state !== "done") {
      if (this.state === "data") {
        const n = Math.min(this.left, chunk.length - i);
        out(chunk.subarray(i, i + n));
        i += n;
        this.left -= n;
        if (this.left === 0) this.state = "data-crlf";
        continue;
      }
      const c = chunk[i++]!;
      this.line += String.fromCharCode(c);
      if (this.line.length > 4096) throw new Error("chunk line too long");
      if (!this.line.endsWith("\r\n")) continue;
      const text = this.line.slice(0, -2);
      this.line = "";
      if (this.state === "size") {
        const m = /^([0-9a-fA-F]{1,12})(;.*)?$/.exec(text);
        if (!m) throw new Error("bad chunk size");
        this.left = parseInt(m[1]!, 16);
        this.state = this.left === 0 ? "trailers" : "data";
      } else if (this.state === "data-crlf") {
        if (text !== "") throw new Error("missing CRLF after chunk");
        this.state = "size";
      } else if (this.state === "trailers") {
        if (text === "") this.state = "done";
      }
    }
  }

  get done(): boolean {
    return this.state === "done";
  }
}

type BodyPlan =
  | { kind: "none" }
  | { kind: "buffered"; body: Buffer }
  | { kind: "length"; length: number; initial: Buffer }
  | { kind: "chunked"; initial: Buffer };

/** Serve one app request on `socket` (a terminated TLS socket). */
export function handleAppConnection(socket: Duplex, opts: AppConnectionOptions): void {
  const limits = { ...DEFAULT_APP_CONNECTION_LIMITS, ...(opts.limits ?? {}) };
  let buf: Buffer = Buffer.alloc(0);
  let done = false;
  const sock = socket as Duplex & {
    setTimeout?: (ms: number, cb?: () => void) => void;
    setNoDelay?: (v: boolean) => void;
  };
  socket.on("error", () => {});
  sock.setNoDelay?.(true);
  // Until the decision: an inactivity limit, plus a hard deadline for the head.
  sock.setTimeout?.(limits.headerTimeoutMs, () => socket.destroy());
  const headDeadline = setTimeout(() => socket.destroy(), limits.headerTimeoutMs);
  headDeadline.unref?.();
  socket.once("close", () => clearTimeout(headDeadline));

  const fail = (status: number, text: string, method = "GET") => {
    if (done) return;
    done = true;
    clearTimeout(headDeadline);
    socket.off("data", onHead);
    writeBuffered(socket, plain(status, text), method);
  };

  const onHead = (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) {
      if (buf.length > limits.maxHeaderBytes) fail(431, "request header fields too large");
      return;
    }
    if (sep > limits.maxHeaderBytes) {
      fail(431, "request header fields too large");
      return;
    }
    socket.off("data", onHead);
    socket.pause();
    clearTimeout(headDeadline);
    const head = parseHead(buf.subarray(0, sep).toString("latin1"));
    const rest = buf.subarray(sep + 4);
    buf = Buffer.alloc(0);
    if (!head) {
      fail(400, "bad request");
      return;
    }
    void serve(head, rest).catch((e: unknown) => {
      if (done) return socket.destroy();
      done = true;
      writeBuffered(socket, plain(500, `internal error: ${e instanceof Error ? e.message : String(e)}`), head.method);
    });
  };
  socket.on("data", onHead);

  async function serve(head: ParsedHead, rest: Buffer): Promise<void> {
    const h = head.headers;
    const upgrade = isWebSocketUpgrade(h);
    const te = h["transfer-encoding"];
    const cl = h["content-length"];
    if (te !== undefined && cl !== undefined) return fail(400, "both Transfer-Encoding and Content-Length", head.method);
    let plan: BodyPlan = { kind: "none" };
    if (te !== undefined) {
      if (te.toLowerCase() !== "chunked") return fail(501, "unsupported transfer-encoding", head.method);
      plan = { kind: "chunked", initial: rest };
    } else if (cl !== undefined) {
      if (!/^\d{1,15}$/.test(cl)) return fail(400, "bad content-length", head.method);
      const length = Number(cl);
      if (length > 0) plan = { kind: "length", length, initial: rest };
    }
    if (upgrade && plan.kind !== "none") return fail(400, "an upgrade request has no body", head.method);
    if (plan.kind !== "none" && (h["expect"] ?? "").toLowerCase() === "100-continue") {
      socket.write("HTTP/1.1 100 Continue\r\n\r\n");
    }
    if (plan.kind === "length" && plan.length <= limits.bufferBodyBytes) {
      const body = await readExactly(plan.length, plan.initial);
      if (body === null) return;
      plan = { kind: "buffered", body };
    }

    const req: HttpRequest = {
      method: head.method,
      path: head.path,
      headers: h,
      body: plan.kind === "buffered" ? plan.body : Buffer.alloc(0),
    };
    const gated = await opts.gate(req);
    if (gated) {
      done = true;
      return writeBuffered(socket, gated, head.method);
    }
    const prepared = await opts.prepare(req, { upgrade });
    if (prepared.kind === "respond") {
      done = true;
      return writeBuffered(socket, prepared.response, head.method);
    }
    const release = opts.limiter.tryAcquire(opts.serviceId);
    if (!release) {
      done = true;
      return writeBuffered(
        socket,
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" }, body: "too many open connections to this app" },
        head.method,
      );
    }
    done = true;
    socket.once("close", release);
    sock.setTimeout?.(limits.idleTimeoutMs, () => socket.destroy());
    const headers = forwardRequestHeaders(prepared.headers, upgrade);
    if (upgrade) forwardUpgrade(head, headers, rest);
    else forwardRequest(head, headers, plan);
  }

  /** Read `n` body bytes (paused socket); null if the client went away. */
  function readExactly(n: number, initial: Buffer): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      let have = 0;
      const take = (b: Buffer): boolean => {
        const part = b.subarray(0, n - have);
        parts.push(part);
        have += part.length;
        return have >= n;
      };
      if (take(initial)) return resolve(Buffer.concat(parts));
      const onData = (b: Buffer) => {
        if (take(b)) {
          cleanup();
          socket.pause();
          resolve(Buffer.concat(parts));
        }
      };
      const onClose = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("close", onClose);
      };
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.resume();
    });
  }

  function forwardRequest(head: ParsedHead, headers: Record<string, string>, plan: BodyPlan): void {
    if (plan.kind === "buffered") headers["content-length"] = String(plan.body.length);
    else if (plan.kind === "length") headers["content-length"] = String(plan.length);
    else if (plan.kind === "chunked") headers["transfer-encoding"] = "chunked";
    const upstreamReq = httpRequest({
      host: opts.upstream.host,
      port: opts.upstream.port,
      method: head.method,
      path: head.path,
      headers,
      agent: false,
    });
    let responded = false;
    upstreamReq.on("response", (res) => {
      responded = true;
      relayResponse(head, res);
    });
    upstreamReq.on("error", (e) => {
      if (!responded) writeBuffered(socket, plain(502, `bad gateway: ${e.message}`), head.method);
      else socket.destroy();
    });
    socket.once("close", () => upstreamReq.destroy());

    if (plan.kind === "buffered") {
      upstreamReq.end(plan.body);
      socket.resume(); // drain anything after the request; nothing more is read from it
      return;
    }
    if (plan.kind === "none") {
      upstreamReq.end();
      socket.resume();
      return;
    }
    // Streamed body, with backpressure from the container.
    let finished = false;
    const write = (b: Buffer) => {
      if (b.length === 0) return;
      if (!upstreamReq.write(b)) socket.pause();
    };
    upstreamReq.on("drain", () => {
      if (!finished) socket.resume();
    });
    const finish = () => {
      finished = true;
      upstreamReq.end();
    };
    if (plan.kind === "length") {
      let left = plan.length;
      const feed = (b: Buffer) => {
        if (finished) return;
        const part = b.subarray(0, left);
        left -= part.length;
        write(part);
        if (left === 0) finish();
      };
      feed(plan.initial);
      socket.on("data", feed);
    } else {
      const dec = new ChunkedDecoder();
      const feed = (b: Buffer) => {
        if (finished) return;
        try {
          dec.push(b, write);
        } catch {
          upstreamReq.destroy();
          if (!responded) writeBuffered(socket, plain(400, "malformed chunked body"), head.method);
          finished = true;
          return;
        }
        if (dec.done) finish();
      };
      feed(plan.initial);
      socket.on("data", feed);
    }
    socket.resume();
  }

  function relayResponse(head: ParsedHead, res: IncomingMessage): void {
    const status = res.statusCode ?? 502;
    const bodyless = head.method.toUpperCase() === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
    const connectionTokens = new Set(
      (headerValue(res, "connection") ?? "")
        .toLowerCase()
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    );
    const lines = [`HTTP/1.1 ${status} ${res.statusMessage || STATUS_CODES[status] || "Unknown"}`];
    let hasLength = false;
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
      const k = res.rawHeaders[i]!;
      const kl = k.toLowerCase();
      if (HOP_RESPONSE.has(kl) || connectionTokens.has(kl)) continue;
      if (kl === "content-length") hasLength = true;
      lines.push(`${k}: ${res.rawHeaders[i + 1]!}`);
    }
    const chunked = !bodyless && !hasLength && head.version === "1.1";
    if (chunked) lines.push("Transfer-Encoding: chunked");
    lines.push("Connection: close");
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (bodyless) {
      res.resume();
      res.on("end", () => socket.end());
      return;
    }
    res.on("data", (d: Buffer) => {
      const ok = socket.write(chunked ? Buffer.concat([Buffer.from(`${d.length.toString(16)}\r\n`), d, CRLF]) : d);
      if (!ok) {
        res.pause();
        socket.once("drain", () => res.resume());
      }
    });
    res.on("end", () => {
      if (chunked) socket.write("0\r\n\r\n");
      socket.end();
    });
    res.on("error", () => socket.destroy());
    socket.once("close", () => res.destroy());
  }

  function forwardUpgrade(head: ParsedHead, headers: Record<string, string>, early: Buffer): void {
    const upstreamReq = httpRequest({
      host: opts.upstream.host,
      port: opts.upstream.port,
      method: head.method,
      path: head.path,
      headers,
      agent: false,
    });
    let answered = false;
    upstreamReq.on("upgrade", (res, upstream, upstreamHead) => {
      answered = true;
      const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage || "Switching Protocols"}`];
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]!}: ${res.rawHeaders[i + 1]!}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (early.length > 0) upstream.write(early);
      upstream.on("error", () => socket.destroy());
      const closeBoth = () => {
        upstream.destroy();
        socket.destroy();
      };
      upstream.once("close", closeBoth);
      socket.once("close", closeBoth);
      socket.once("end", () => upstream.end());
      upstream.once("end", () => socket.end());
      upstream.pipe(socket, { end: false });
      socket.pipe(upstream, { end: false });
      socket.resume();
    });
    upstreamReq.on("response", (res) => {
      // The app answered without switching protocols: relay that answer, then close.
      answered = true;
      relayResponse(head, res);
    });
    upstreamReq.on("error", (e) => {
      if (!answered) writeBuffered(socket, plain(502, `bad gateway: ${e.message}`), head.method);
      else socket.destroy();
    });
    socket.once("close", () => {
      if (!answered) upstreamReq.destroy();
    });
    upstreamReq.end();
  }
}

/**
 * The headers the container receives: hop-by-hop ones dropped (and any the
 * client's Connection header named), `Connection: close`, and for an upgrade
 * the `Upgrade: websocket` handshake kept.
 */
function forwardRequestHeaders(prepared: Record<string, string>, upgrade: boolean): Record<string, string> {
  const named = new Set(
    (prepared["connection"] ?? "")
      .toLowerCase()
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(prepared)) {
    const kl = k.toLowerCase();
    if (HOP_REQUEST.has(kl)) continue;
    if (named.has(kl) && !kl.startsWith("x-flagship-") && !kl.startsWith("sec-websocket-")) continue;
    out[kl] = v;
  }
  if (upgrade) {
    out["connection"] = "Upgrade";
    out["upgrade"] = "websocket";
  } else {
    out["connection"] = "close";
  }
  return out;
}

function headerValue(res: IncomingMessage, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
}

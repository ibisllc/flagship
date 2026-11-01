/**
 * The daemon's side of the Rust ingress's app proxy (flagship-ingress `proxy.rs`, G4): the ingress
 * parses a request head for an app and asks here, on a Unix socket, whether the request may reach
 * the app and with which identity. The decision is exactly the TS proxy's (`appConnectionOptions`:
 * the app gates, `prepareAppRequest` with sessions, API keys and keyd-signed identity, the per-app
 * connection cap and an endpoint-table lease); only the carrying of bytes moves to Rust.
 *
 * One JSON line in, one JSON line out, then the socket stays open for the life of the proxied
 * connection: it holds the app's connection slot and the endpoint lease, and an invalidated
 * endpoint (a new deploy, a stop, an uninstall) closes it, which closes the client's connection.
 *
 * Whatever is not a plain "forward" (a gate or the proxy answers, a box path, no endpoint, the
 * app at its cap, the proxy flag off, anything unexpected) answers `daemon`: the ingress then
 * hands the untouched connection to the daemon's upstream socket and the TS path serves it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AppConnectionOptions } from "./appConnection.js";
import { endpoints, type EndpointLease } from "./endpoints.js";
import type { HttpRequest } from "./runtime.js";
import type { InstalledService } from "./servicePlatform.js";

export interface DecideRequest {
  sni: string;
  method: string;
  target: string;
  version: "1.0" | "1.1";
  headers: Record<string, string>;
  upgrade: boolean;
  body: "none" | "length" | "chunked";
}

export type DecideAnswer =
  | { action: "daemon"; why: string }
  | { action: "proxy"; host: string; port: number; set: Array<[string, string]>; remove: string[] };

export interface DecideDeps {
  /** The app the SNI names, as the TLS handler resolves it. */
  appForSni(sni: string): InstalledService | undefined;
  /** The TS proxy's options for that app (gates, prepare, upstream, limiter). */
  options(app: InstalledService): AppConnectionOptions;
  /** The owner's proxy setting (rustStack/ownership.ts): off ⇒ every request is the daemon's. */
  enabled(): boolean;
}

/** How many requests the ingress asked about, by answer (shown to the owner and the gym). */
export const decisionStats = { proxy: 0, daemon: 0 };

/** Paths the box itself serves on an app's name: always the daemon's. */
const BOX_PATHS = ["/__flagship/", "/.flagship/", "/api/service-access/"];

const MAX_LINE = 256 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** Parse and check the ingress's question; null when it is not what the ingress sends. */
export function parseDecideRequest(line: string): DecideRequest | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (j.v !== 1 || typeof j.sni !== "string" || j.sni.length > 253 || !/^[a-z0-9.*-]*$/.test(j.sni)) return null;
  if (typeof j.method !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(j.method)) return null;
  if (typeof j.target !== "string" || !j.target.startsWith("/")) return null;
  if (j.version !== "1.0" && j.version !== "1.1") return null;
  if (typeof j.upgrade !== "boolean" || (j.body !== "none" && j.body !== "length" && j.body !== "chunked")) return null;
  if (!Array.isArray(j.headers)) return null;
  // A plain object, like parseHead's: the ingress never sends the two names a prototype resolves.
  const headers: Record<string, string> = {};
  for (const pair of j.headers as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") return null;
    const [k, v] = pair as [string, string];
    if (!TOKEN.test(k) || k === "__proto__" || k === "constructor" || Object.prototype.hasOwnProperty.call(headers, k)) return null;
    headers[k] = v;
  }
  return { sni: j.sni, method: j.method, target: j.target, version: j.version, headers, upgrade: j.upgrade, body: j.body };
}

const isIdentity = (k: string) => k.toLowerCase().replace(/_/g, "-").startsWith("x-flagship-");

/**
 * Decide one request. On "proxy" the returned `hold` must be bound to the decision socket: it is
 * released when the socket closes, and the socket is destroyed when the endpoint is invalidated.
 */
export async function decide(
  req: DecideRequest,
  deps: DecideDeps,
): Promise<{ answer: DecideAnswer; hold?: { lease: EndpointLease | null; release: () => void } }> {
  const r = await decideInner(req, deps);
  decisionStats[r.answer.action]++;
  return r;
}

async function decideInner(
  req: DecideRequest,
  deps: DecideDeps,
): Promise<{ answer: DecideAnswer; hold?: { lease: EndpointLease | null; release: () => void } }> {
  const daemon = (why: string) => ({ answer: { action: "daemon" as const, why } });
  if (!deps.enabled()) return daemon("the Rust proxy is off");
  const app = deps.appForSni(req.sni);
  if (!app) return daemon("not an app");
  const pathOnly = req.target.split("?")[0]!;
  if (BOX_PATHS.some((p) => pathOnly.startsWith(p))) return daemon("a box path");
  const opts = deps.options(app);
  const http: HttpRequest = { method: req.method, path: req.target, headers: { ...req.headers }, body: Buffer.alloc(0) };
  // The gates and the decision see the head only; any that answers sends the whole request to the
  // daemon, which runs them again with the body.
  if (await opts.gate(http)) return daemon("a gate answers");
  const prepared = await opts.prepare(http, { upgrade: req.upgrade });
  if (prepared.kind !== "forward") return daemon("the proxy answers");
  const release = opts.limiter.tryAcquire(opts.serviceId);
  if (!release) return daemon("the app is at its connection cap");
  let host: string;
  let port: number;
  let lease: EndpointLease | null = null;
  if ("endpoint" in opts.upstream) {
    lease = endpoints.acquire(opts.upstream.endpoint);
    if (!lease) {
      release();
      return daemon("no endpoint");
    }
    host = lease.endpoint.host;
    port = lease.endpoint.port;
  } else {
    host = opts.upstream.host;
    port = opts.upstream.port;
  }
  const set: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(prepared.headers)) if (k.toLowerCase().startsWith("x-flagship-")) set.push([k.toLowerCase(), v]);
  const remove = Object.keys(req.headers).filter((k) => !isIdentity(k) && !(k in prepared.headers));
  return { answer: { action: "proxy", host, port, set, remove }, hold: { lease, release } };
}

/** Listen for the ingress's questions on `socketPath` (in the same group as the upstream socket). */
export function listenForDecisions(socketPath: string, deps: DecideDeps, group?: string, log: (m: string) => void = () => {}): Promise<Server> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((sock: Socket) => {
    let buf = "";
    const timer = setTimeout(() => sock.destroy(), 10_000);
    sock.setEncoding("utf8");
    sock.on("error", () => sock.destroy());
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (buf.length > MAX_LINE) sock.destroy();
        return;
      }
      sock.off("data", onData);
      clearTimeout(timer);
      const req = parseDecideRequest(buf.slice(0, nl));
      if (!req) {
        sock.end(`${JSON.stringify({ action: "daemon", why: "bad request" })}\n`);
        return;
      }
      void decide(req, deps)
        .then(({ answer, hold }) => {
          if (sock.destroyed) {
            hold?.lease?.release();
            hold?.release();
            return;
          }
          if (!hold) {
            sock.end(`${JSON.stringify(answer)}\n`);
            return;
          }
          sock.once("close", () => {
            hold.lease?.release();
            hold.release();
          });
          hold.lease?.bind(sock);
          sock.write(`${JSON.stringify(answer)}\n`);
          // Anything more from the ingress is not part of the protocol; the end of the
          // proxied connection is the ingress closing.
          sock.on("data", () => sock.destroy());
        })
        .catch((e: Error) => {
          log(`[rust-proxy] decision failed: ${e.message}`);
          sock.end(`${JSON.stringify({ action: "daemon", why: "error" })}\n`);
        });
    };
    sock.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o660);
      if (group) execFileSync("chgrp", [group, socketPath]);
      resolve(server);
    });
  });
}

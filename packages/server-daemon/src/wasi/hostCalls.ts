/**
 * What the box does for a WASI app's host calls (wasi/broker.ts). The
 * worker already refused hosts the manifest doesn't declare; here the box
 * checks again and adds what only it knows:
 *
 * http_fetch: the host must be in the manifest's `network.egress` AND
 *   allowed by the owner-signed access list, exactly like a container app's
 *   connection through the egress gateway (a host the list doesn't mention
 *   raises the same access request to the owner). The address it resolves to
 *   must be public, checked at connect time, so an approved name can't be
 *   pointed at the box's loopback or LAN. No redirects are followed; the
 *   answer is capped.
 * db_query: one statement on one of the app's own databases, as the app's
 *   own role, with a statement timeout and a row cap: the same authority a
 *   container app has over its database, nothing more.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { decideAccess, isPublicAddress, type AccessRule } from "@flagship/protocol";
import type { PostgresStore } from "../dataLayer/provisioner.js";
import { loopbackPgUrl, realPgConnect, type PgConnect } from "../dataLayer/appSql.js";
import { CapabilityDenied, type CapabilityHandlers } from "./broker.js";

export interface WasiAppContext {
  /** Owner env and platform values the worker asks for at start (never on disk). */
  secretEnv: Record<string, string>;
  /** The manifest's `network.egress` hosts. */
  egressHosts: readonly string[];
  /** The app's databases, by store name. */
  postgres: Readonly<Record<string, PostgresStore>>;
}

export interface FetchAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: "base64";
  truncated?: boolean;
}

export type Fetcher = (a: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}) => Promise<FetchAnswer>;

export interface WasiHostCallDeps {
  context(serviceId: string): WasiAppContext | undefined;
  /** The owner-signed access rules of the app (egress approvals). */
  accessRules(serviceId: string): readonly AccessRule[];
  /** A declared host the owner's list doesn't mention: raise the access request. */
  onUnmatched?(serviceId: string, host: string): void;
  fetcher?: Fetcher;
  pgConnect?: PgConnect;
}

export const MAX_FETCH_BODY = 1024 * 1024;
export const MAX_FETCH_ANSWER = 4 * 1024 * 1024;
export const MAX_ROWS = 1000;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_REQUEST_HEADERS = /^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|x-flagship-.*|forwarded|x-forwarded-.*)$/i;
const PASSED_ANSWER_HEADERS = new Set(["content-type", "content-language", "etag", "last-modified", "cache-control", "location", "retry-after"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A DNS lookup that only ever returns public addresses (checked when the socket connects). */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: LookupAddress[] | string, f?: number) => void)(err, "", 0);
    const list = (addresses as LookupAddress[]).filter((a) => isPublicAddress(a.address));
    if (list.length === 0) {
      const e = Object.assign(new Error(`${hostname} resolves to a private address`), { code: "ENOTFOUND" });
      return (callback as (e: Error | null, a: string, f?: number) => void)(e, "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as (e: Error | null, a: LookupAddress[]) => void)(null, list);
    return (callback as (e: Error | null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

export const realFetcher: Fetcher = ({ url, method, headers, body, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method, headers, lookup: publicOnlyLookup, timeout: timeoutMs },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => {
          const buf = Buffer.concat(chunks);
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (PASSED_ANSWER_HEADERS.has(k) && typeof v === "string") out[k] = v;
          }
          const text = buf.toString("utf8");
          const isText = Buffer.from(text, "utf8").equals(buf);
          resolve({
            status: res.statusCode ?? 0,
            headers: out,
            body: isText ? text : buf.toString("base64"),
            ...(isText ? {} : { bodyEncoding: "base64" as const }),
            ...(truncated ? { truncated: true } : {}),
          });
        };
        res.on("end", finish);
        res.on("close", () => (truncated ? finish() : undefined));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

export function wasiHostCalls(deps: WasiHostCallDeps): CapabilityHandlers {
  const ctx = (serviceId: string) => {
    const c = deps.context(serviceId);
    if (!c) throw new CapabilityDenied("this app is not running on this server");
    return c;
  };
  return {
    async hello(serviceId) {
      return { ...ctx(serviceId).secretEnv };
    },

    async httpFetch(serviceId, request, deadlineMs) {
      const c = ctx(serviceId);
      if (!isObject(request)) throw new CapabilityDenied("a fetch takes {method, url, headers?, body?}");
      const method = String(request.method ?? "GET").toUpperCase();
      if (!METHODS.has(method)) throw new CapabilityDenied(`method ${method} is not allowed`);
      let url: URL;
      try {
        url = new URL(String(request.url ?? ""));
      } catch {
        throw new CapabilityDenied("url is not a URL");
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
        throw new CapabilityDenied("url must be http(s)://host/... with no user name");
      }
      const host = url.hostname.toLowerCase();
      if (!c.egressHosts.includes(host)) throw new CapabilityDenied(`${host} is not in this app's network.egress`);
      const d = decideAccess(deps.accessRules(serviceId), host);
      if (d.result !== "allow") {
        if (d.rule === null) deps.onUnmatched?.(serviceId, host);
        throw new CapabilityDenied(
          d.rule === null ? `the server's owner has not allowed ${host} for this app yet` : `the app's access list denies ${host}`,
        );
      }
      const headers: Record<string, string> = {};
      if (request.headers !== undefined) {
        if (!isObject(request.headers) || Object.keys(request.headers).length > 32) throw new CapabilityDenied("headers must be an object of at most 32 strings");
        for (const [k, v] of Object.entries(request.headers)) {
          if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n\0]/.test(v) || v.length > 8192) throw new CapabilityDenied(`header ${k} is not allowed`);
          if (BLOCKED_REQUEST_HEADERS.test(k)) throw new CapabilityDenied(`header ${k} is set by the box`);
          headers[k] = v;
        }
      }
      let body: string | undefined;
      if (request.body !== undefined) {
        if (typeof request.body !== "string" || Buffer.byteLength(request.body) > MAX_FETCH_BODY) throw new CapabilityDenied("body must be a string of at most 1 MiB");
        if (method === "GET" || method === "HEAD") throw new CapabilityDenied(`a ${method} has no body`);
        body = request.body;
      }
      const timeoutMs = Math.max(100, Math.min(30_000, deadlineMs - Date.now()));
      return (deps.fetcher ?? realFetcher)({ url, method, headers, ...(body !== undefined ? { body } : {}), timeoutMs, maxBytes: MAX_FETCH_ANSWER });
    },

    async dbQuery(serviceId, request, deadlineMs) {
      const c = ctx(serviceId);
      if (!isObject(request) || typeof request.sql !== "string") throw new CapabilityDenied("a query takes {sql, params?, store?}");
      const stores = Object.keys(c.postgres);
      if (stores.length === 0) throw new CapabilityDenied("this app declares no database");
      const storeName = request.store === undefined ? stores[0]! : String(request.store);
      const store = c.postgres[storeName];
      if (!store) throw new CapabilityDenied(`this app has no database named ${storeName}`);
      const sql = request.sql;
      if (sql.length === 0 || sql.length > 64 * 1024) throw new CapabilityDenied("sql must be 1 to 65536 characters");
      if (/^\s*copy\b/i.test(sql)) throw new CapabilityDenied("COPY isn't available to host calls");
      const params = request.params ?? [];
      if (!Array.isArray(params) || params.length > 100 || params.some((p) => p !== null && typeof p !== "string" && typeof p !== "number" && typeof p !== "boolean")) {
        throw new CapabilityDenied("params must be at most 100 strings, numbers, booleans or nulls");
      }
      const timeoutMs = Math.max(100, Math.min(30_000, deadlineMs - Date.now()));
      const client = await (deps.pgConnect ?? realPgConnect)({ pgUrl: loopbackPgUrl(store.url), timeoutMs });
      try {
        const raw = await client.query({ text: sql, values: params, queryMode: "extended" });
        const r = Array.isArray(raw) ? raw[raw.length - 1]! : raw;
        const names = (r.fields ?? []).map((f) => f.name);
        const rows = (r.rows ?? []).slice(0, MAX_ROWS).map((row) => {
          if (Array.isArray(row)) return Object.fromEntries(names.map((n, i) => [n, row[i]]));
          return row;
        });
        return { command: r.command ?? "", rowCount: r.rowCount ?? null, rows, truncated: (r.rows?.length ?? 0) > MAX_ROWS };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

// Shared plumbing for the live gym drivers: config, HTTP, and a per-group
// check recorder whose results land in gym-results/<run>/<group>.json.
import { spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || process.env.LIVE_E2E_CONTROL || "gym.flagshipserver.com";
export const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || process.env.LIVE_E2E_SERVICES || "gym.flagship.services";
export const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
export const KEK = process.env.GYM_DEMO_IRK_KEK || "";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Resp {
  status: number;
  text: string;
  json: any;
  setCookies: string[];
  headers: Headers;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** The box applies this write at most once whatever happens (e.g. adding an id to a set): retry it like a read. */
  idempotent?: boolean;
}

/**
 * One request. A connection that fails before any response (the hub tunnel
 * blipping, a box busy building) is retried twice, 5 s apart; the final error
 * names the cause. A request that got a response is never retried, and neither is a write that may have
 * reached the box (a timeout or a reset after the request left): the box may have done it, and doing it twice
 * ("You already have a service called …") fails a run for the harness's own doing.
 */
export async function http(url: string, init: HttpInit = {}, timeoutMs = 45_000): Promise<Resp> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await httpOnce(url, init, timeoutMs);
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const why = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
      const method = String(init.method ?? "GET").toUpperCase();
      const neverSent = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", NEVER_SENT].includes(String(cause?.code ?? ""));
      const retryable = method === "GET" || method === "HEAD" || neverSent || init.idempotent === true;
      if (attempt >= 3 || !retryable) throw new Error(`fetch failed (${why}) after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${url}`);
      await sleep(5000);
    }
  }
}

const NEVER_SENT = "FLAGSHIP_BEFORE_HANDSHAKE";

/**
 * A write on a connection of its own. fetch keeps connections open and reuses them; a server may close one after an
 * odd request (the adversarial group sends many), and the next write sent on it fails with ECONNRESET after the bytes
 * may have left, so it can't be retried (gym 17: six adversarial writes in a row). A fresh connection per write cannot
 * land on a closed one. Reads stay on fetch, which retries a reused connection that turns out closed.
 */
function writeOnce(url: string, init: HttpInit, timeoutMs: number): Promise<Resp> {
  return new Promise<Resp>((resolve, reject) => {
    const u = new URL(url);
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body);
    const req = httpsRequest(
      {
        method: init.method ?? "POST",
        host: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers: { ...(init.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}) },
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) for (const x of v) headers.append(k, x);
            else if (v !== undefined) headers.set(k, String(v));
          }
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode ?? 0, text, json, setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [], headers });
        });
      },
    );
    // TLS ends on the box, so nothing of the request can have reached it before the handshake finished: a reset
    // there (gym 18: Fly's dfw→iad backhaul dropping fresh connections) is retried like a refused connection.
    let handshaken = false;
    req.on("socket", (s) => s.once("secureConnect", () => (handshaken = true)));
    // The same error shape fetch gives (the caller reads `cause.code`).
    const fail = (code: string, message: string) =>
      reject(Object.assign(new Error(`fetch failed: ${message}`), { cause: { code: handshaken ? code : NEVER_SENT, message: handshaken ? message : `${code} before the TLS handshake finished` } }));
    req.on("timeout", () => {
      req.destroy();
      fail("UND_ERR_HEADERS_TIMEOUT", "timed out");
    });
    req.on("error", (e: NodeJS.ErrnoException) => fail(e.code ?? "ERR", e.message));
    if (body) req.write(body);
    req.end();
  });
}

async function httpOnce(url: string, init: HttpInit, timeoutMs: number): Promise<Resp> {
  const method = String(init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && url.startsWith("https://")) return writeOnce(url, init, timeoutMs);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { idempotent: _idempotent, ...req } = init;
    const r = await fetch(url, { ...req, body: req.body as BodyInit | undefined, signal: ctrl.signal, redirect: "manual" });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    const h = r.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof h.getSetCookie === "function" ? h.getSetCookie() : ([h.get("set-cookie")].filter(Boolean) as string[]);
    return { status: r.status, text, json, setCookies, headers: r.headers };
  } finally {
    clearTimeout(t);
  }
}

/** Never throws: a transport failure reads as status 0 with the cause. */
export async function tryHttp(url: string, init: HttpInit = {}, timeoutMs = 45_000): Promise<Resp> {
  try {
    return await http(url, init, timeoutMs);
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    const msg = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
    return { status: 0, text: `fetch failed: ${msg}`, json: null, setCookies: [], headers: new Headers() };
  }
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 30_000, opts: { idempotent?: boolean } = {}): Promise<Resp> {
  return http(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), ...opts }, timeoutMs);
}

export function adminHeaders(): Record<string, string> {
  return { "x-admin-secret": ADMIN };
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function cookieVal(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

export function short(s: unknown, n = 160): string {
  return String(typeof s === "string" ? s : JSON.stringify(s)).replace(/\s+/g, " ").slice(0, n);
}

export interface CheckResult {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
  ms: number;
}

/** One group's ordered checks. A check throws to fail; `skip()` marks it inconclusive. */
export class Recorder {
  readonly results: CheckResult[] = [];
  constructor(readonly group: string) {}

  log(s: string): void {
    process.stdout.write(`[${this.group}] ${s}\n`);
  }

  async check(name: string, fn: () => Promise<string | void> | string | void): Promise<boolean> {
    const t = Date.now();
    try {
      const detail = (await fn()) || "";
      this.results.push({ name, ok: true, detail, ms: Date.now() - t });
      this.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
      return true;
    } catch (e) {
      const detail = e instanceof SkipError ? e.message : e instanceof Error ? e.message : String(e);
      const skipped = e instanceof SkipError;
      this.results.push({ name, ok: false, skipped, detail, ms: Date.now() - t });
      this.log(`${skipped ? "·" : "✗"} ${name} — ${skipped ? "SKIPPED: " : ""}${detail}`);
      return false;
    }
  }

  skip(name: string, why: string): void {
    this.results.push({ name, ok: false, skipped: true, detail: why, ms: 0 });
    this.log(`· ${name} — SKIPPED: ${why}`);
  }

  get passed(): number {
    return this.results.filter((r) => r.ok).length;
  }
  get failed(): number {
    return this.results.filter((r) => !r.ok && !r.skipped).length;
  }
  get skipped(): number {
    return this.results.filter((r) => r.skipped).length;
  }
}

export class SkipError extends Error {}

export function runDir(label: string): string {
  const dir = process.env.GYM_RUN_DIR || join("gym-results", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  process.env.GYM_RUN_DIR = dir;
  return dir;
}

export function writeJson(dir: string, file: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
}

/** issuer / subject / SANs of a live host's served cert. */
export function certInfo(fqdn: string): { issuer: string; subject: string; sans: string[] } {
  const out = spawnSync(
    "bash",
    ["-c", `echo | openssl s_client -connect ${fqdn}:443 -servername ${fqdn} 2>/dev/null | openssl x509 -noout -issuer -subject -text 2>/dev/null`],
    { encoding: "utf8", timeout: 25_000 },
  );
  const t = out.stdout || "";
  const issuer = (/issuer=(.*)/.exec(t) || [])[1]?.trim() || "";
  const subject = (/subject=(.*)/.exec(t) || [])[1]?.trim() || "";
  const sanLine = (/DNS:[^\n]*/.exec(t) || [])[0] || "";
  const sans = sanLine.split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
  return { issuer, subject, sans };
}

/** Whether a cert's SAN list covers `name`: listed itself, or by a `*.` wildcard one label up. */
export function sanCovers(sans: string[], name: string): boolean {
  const dot = name.indexOf(".");
  return sans.includes(name) || (dot > 0 && sans.includes(`*${name.slice(dot)}`));
}

/** Raw HTTP/1.1 over openssl, with SNI and Host chosen independently (null = no Host). */
export function rawTlsGet(sni: string, host: string | null, path: string): { status: number; text: string } {
  const hostLine = host === null ? "" : `Host: ${host}\\r\\n`;
  const req = `GET ${path} HTTP/1.1\\r\\n${hostLine}Connection: close\\r\\n\\r\\n`;
  const out = spawnSync(
    "bash",
    ["-c", `printf '${req}' | openssl s_client -quiet -connect ${sni}:443 -servername ${sni} 2>/dev/null | head -c 1500`],
    { encoding: "utf8", timeout: 25_000 },
  );
  const raw = out.stdout || "";
  const m = /HTTP\/1\.[01] (\d{3})/.exec(raw);
  const sep = raw.indexOf("\r\n\r\n");
  return { status: m ? Number(m[1]) : 0, text: sep >= 0 ? raw.slice(sep + 4) : raw };
}

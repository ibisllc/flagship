/**
 * A phone, simulated in node, for the bare `<account>.<apex>` route (plan H3, docs/architecture-v2/phone-route.md):
 * it opens `/phone-tunnel`, begins, signs the `route-claim/v1` the relay offers with its account device key, and
 * serves relayed visitor streams. In `tls` mode it terminates TLS itself (node:tls over each relayed stream) with
 * its own key and certificate and answers a tiny HTTP endpoint, so a visitor can check the TLS peer is the phone.
 * Used by apps/web/tests/phoneRoute.test.ts and the live gym group release03/phoneRoute.ts.
 */
import { Duplex } from "node:stream";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { WebSocket } from "ws";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_OPEN,
} from "@flagship/tunnel-protocol";
import { connect as tlsConnect } from "node:tls";
import {
  canonicalPhonePresence,
  canonicalRouteRelease,
  checkPhonePresence,
  ed,
  phoneBeginGrants,
  phoneBeginMessage,
  phoneEndpointCheck,
  phoneWebCheck,
  PHONE_WEB_ORIGINS_GYM,
  signServingRecord,
  type PhoneBeginGrant,
  type PhonePresence,
  type RouteClaim,
} from "@flagship/protocol";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface SimStream {
  id: number;
  sni: string;
  received: Buffer[];
  closed: boolean;
  write(b: Uint8Array): void;
  close(): void;
}

export type Control = Record<string, unknown> & { type: string };

export interface SimPhoneOptions {
  account: string;
  /** The account device key's seed (32 bytes): the key the phone's admin grant names. */
  seed: Uint8Array;
  /** Terminate TLS on the phone with this key and certificate (PEM) and answer HTTP; else echo raw bytes. */
  tls?: { key: string; cert: string };
  /** Sent on every relayed HTTP answer, so a visitor can tell phones apart. */
  label?: string;
  /** Extra headers on the tunnel's WebSocket upgrade (e.g. Fly's `fly-force-instance-id` to pin a relay machine). */
  headers?: Record<string, string>;
  /** The admin grant chain sent in `begin` (relay-mesh.md §8.2); a mesh relay refuses a phone without one. */
  grants?: PhoneBeginGrant[];
  /** Read the chain from `.com`'s `/api/users/:u/device-grants` before every `begin`, as the apps do. */
  com?: { control: string; readHeaders: () => Promise<Record<string, string>> };
  /** The website origins the endpoint lets reach `live` / `deliver` (default the gym's, PHONE_WEB_ORIGINS_GYM). */
  origins?: readonly string[];
}

/** The phone's own admin grants from `.com` (`https://<control>/api/users/<u>/device-grants`), as the apps pick them. */
export async function fetchBeginGrants(control: string, account: string, devicePub: string, headers: Record<string, string>): Promise<PhoneBeginGrant[]> {
  try {
    const res = await fetch(`https://${control}/api/users/${encodeURIComponent(account.toLowerCase())}/device-grants`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    return phoneBeginGrants(await res.json(), account, devicePub, Date.now());
  } catch {
    return [];
  }
}

export class SimPhone {
  readonly pub: string;
  readonly control: Control[] = [];
  readonly streams = new Map<number, SimStream>();
  closedWith: { code: number; reason: string } | null = null;
  /** The claim the relay granted (what a release must name). */
  granted: RouteClaim | null = null;
  /** Devices that said hello while this phone held the name: key → last seen (ms). */
  readonly seen = new Map<string, number>();
  /** The last claim this phone sent, signature included (a replay test resends it on another session). */
  lastClaim: { claim: RouteClaim; signature: string } | null = null;
  /** The endpoint every relayed stream is answered by in `tls` mode (Appendix H scenario 11). */
  readonly endpoint: PhoneEndpointSim;
  private waiters: Array<{ match: (m: Control) => boolean; resolve: (m: Control) => void }> = [];
  private closedResolve!: () => void;
  readonly closed: Promise<void>;

  private constructor(private readonly ws: WebSocket, readonly opts: SimPhoneOptions) {
    this.pub = hexOf(ed.getPublicKey(opts.seed));
    this.grants = opts.grants ?? [];
    this.endpoint = new PhoneEndpointSim({
      account: opts.account,
      label: opts.label ?? this.pub.slice(0, 8),
      phoneRoutePub: this.pub,
      onHello: (device) => this.seen.set(device, Date.now()),
      ...(opts.origins ? { origins: opts.origins } : {}),
    });
    this.closed = new Promise((r) => (this.closedResolve = r));
    ws.on("message", (raw: Buffer, isBinary: boolean) => (isBinary ? this.onFrame(raw) : this.onControl(raw)));
    ws.on("close", (code, reason) => {
      this.closedWith = { code, reason: reason.toString() };
      for (const s of this.streams.values()) s.closed = true;
      this.closedResolve();
    });
    ws.on("error", () => undefined);
  }

  /** `url` is the relay's `ws(s)://host:port/phone-tunnel`. Resolves after the relay's hello. */
  static async connect(url: string, opts: SimPhoneOptions): Promise<SimPhone> {
    const ws = new WebSocket(url, { headers: opts.headers ?? {} });
    const phone = new SimPhone(ws, opts);
    await phone.next((m) => m.type === "hello", 10_000);
    return phone;
  }

  next(match: (m: Control) => boolean, ms = 10_000): Promise<Control> {
    const had = this.control.find(match);
    if (had) {
      this.control.splice(this.control.indexOf(had), 1);
      return Promise.resolve(had);
    }
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`phone ${this.pub.slice(0, 8)}: no matching control message within ${ms} ms`));
        }
      }, ms).unref?.();
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The grants this phone's `begin` carries (from `opts.grants`, or `.com` when `opts.com` is set). */
  grants: PhoneBeginGrant[] = [];

  /** Step 1 only: the relay's challenge. The begin always carries `grants` (a relay without the mesh ignores it). */
  async begin(account = this.opts.account): Promise<Control> {
    if (this.opts.com) this.grants = await fetchBeginGrants(this.opts.com.control, this.opts.account, this.pub, await this.opts.com.readHeaders());
    this.send({ ...phoneBeginMessage(account, this.grants), account });
    return this.next((m) => m.type === "challenge" || m.type === "refused");
  }

  /** The claim this phone would sign for `challenge`, with its signature. */
  sign(challenge: Control, over: Partial<RouteClaim> = {}): { claim: RouteClaim; signature: string } {
    const claim: RouteClaim = {
      account: String(challenge.account),
      phoneRoutePub: this.pub,
      hostname: String(challenge.hostname),
      generation: Number(challenge.generation),
      sessionNonce: String(challenge.sessionNonce),
      issuedAt: Date.now(),
      ...over,
    };
    return { claim, signature: hexOf(signServingRecord("route-claim", claim, (m) => ed.sign(m, this.opts.seed))) };
  }

  async sendClaim(c: { claim: RouteClaim; signature: string }): Promise<Control> {
    this.lastClaim = c;
    this.send({ type: "claim", ...c });
    const r = await this.next((m) => m.type === "granted" || m.type === "refused");
    if (r.type === "granted") this.granted = c.claim;
    return r;
  }

  /** Give the held route up: a release signed over the granted claim's fields. */
  async release(over: Partial<RouteClaim> = {}): Promise<Control> {
    const g = this.granted;
    if (!g) throw new Error("this phone holds nothing");
    const release = { ...g, issuedAt: Date.now(), ...over };
    const signature = hexOf(ed.sign(canonicalRouteRelease(release), this.opts.seed));
    this.send({ type: "release", release, signature });
    const r = await this.next((m) => m.type === "released" || m.type === "refused");
    if (r.type === "released") this.granted = null;
    return r;
  }

  /** Begin, sign, claim: `granted` or `refused`. */
  async acquire(): Promise<Control> {
    const ch = await this.begin();
    if (ch.type !== "challenge") return ch;
    return this.sendClaim(this.sign(ch));
  }

  close(): void {
    this.ws.close(1000, "background");
  }

  terminate(): void {
    this.ws.terminate();
  }

  private onControl(raw: Buffer): void {
    let m: Control;
    try {
      m = JSON.parse(raw.toString("utf8")) as Control;
    } catch {
      return;
    }
    const w = this.waiters.find((x) => x.match(m));
    if (w) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve(m);
    } else {
      this.control.push(m);
    }
  }

  private onFrame(raw: Buffer): void {
    const r = decodeFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    if (r.kind !== "ok") return;
    const f = r.frame;
    if (f.type === FRAME_OPEN) {
      const stream = this.openStream(f.streamId, new TextDecoder().decode(f.payload));
      this.streams.set(f.streamId, stream);
      return;
    }
    const s = this.streams.get(f.streamId);
    if (!s) return;
    if (f.type === FRAME_DATA) {
      s.received.push(Buffer.from(f.payload));
      (s as SimStream & { feed?: (b: Buffer) => void }).feed?.(Buffer.from(f.payload));
    } else if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      s.closed = true;
      (s as SimStream & { end?: () => void }).end?.();
    }
  }

  private openStream(id: number, sni: string): SimStream {
    const ws = this.ws;
    const s: SimStream & { feed?: (b: Buffer) => void; end?: () => void } = {
      id,
      sni,
      received: [],
      closed: false,
      write: (b) => {
        if (!s.closed && ws.readyState === ws.OPEN) ws.send(encodeFrame(dataFrame(id, b)));
      },
      close: () => {
        if (s.closed) return;
        s.closed = true;
        if (ws.readyState === ws.OPEN) ws.send(encodeFrame(closeFrame(id, false)));
      },
    };
    if (!this.opts.tls) {
      // Raw mode: answer each chunk with `<label>:<bytes>` so a visitor sees which phone it reached.
      s.feed = (b) => s.write(Buffer.concat([Buffer.from(`${this.opts.label ?? this.pub.slice(0, 8)}:`), b]));
      return s;
    }
    // TLS ends here, on the phone: node:tls over the relayed byte stream.
    const raw = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        s.write(chunk);
        cb();
      },
      final(cb) {
        s.close();
        cb();
      },
    });
    s.feed = (b) => raw.push(b);
    s.end = () => raw.push(null);
    const tls = new TLSSocket(raw, { isServer: true, key: this.opts.tls.key, cert: this.opts.tls.cert });
    let buf = Buffer.alloc(0);
    let answered = false;
    tls.on("data", (d: Buffer) => {
      if (answered) return;
      buf = Buffer.concat([buf, d]);
      const req = parseHttpRequest(buf);
      if (!req) return;
      answered = true;
      void Promise.resolve(this.endpoint.respond(req, sni))
        .catch(() => answer(500, { code: "sim-error" }))
        .then((a) => tls.end(a));
    });
    tls.on("error", () => s.close());
    return s;
  }
}

/** A throwaway P-256 key and self-signed certificate for exactly `hostname` (openssl), for the sim's TLS mode. */
export function selfSignedPhoneCert(hostname: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "phone-cert-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2",
      "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * "I'm here": a device's signed hello to `https://<account>.<apex>/` through the relay at `ip`. Resolves with the
 * holder's label (a phone answered) or null (nobody holds the name).
 */
export async function sayHello(o: { ip: string; port?: number; hostname: string; account: string; seed: Uint8Array; ca: string[] }): Promise<string | null> {
  const devicePub = hexOf(ed.getPublicKey(o.seed));
  const issuedAt = Date.now();
  const sig = hexOf(ed.sign(canonicalPhonePresence({ account: o.account, devicePub, hostname: o.hostname, issuedAt }), o.seed));
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    // Phones' self-signed certificates share one subject, so a CA list of several cannot verify each: accept the
    // handshake and require the peer to be one of the known phone certificates instead.
    const s = tlsConnect({ host: o.ip, port: o.port ?? 443, servername: o.hostname, rejectUnauthorized: false });
    s.setTimeout(8_000, () => finish(null));
    s.on("secureConnect", () => {
      if (!isPhoneCert(s.getPeerCertificate()?.fingerprint256, o.ca)) return finish(null);
      s.write(`GET / HTTP/1.1\r\nhost: ${o.hostname}\r\nx-flagship-presence-device: ${devicePub}\r\nx-flagship-presence-at: ${issuedAt}\r\nx-flagship-presence-sig: ${sig}\r\nconnection: close\r\n\r\n`);
    });
    s.on("data", (d) => (text += d.toString()));
    s.on("end", () => finish(/^HTTP\/1\.1 2\d\d/.test(text) ? (/"phone":"([^"]+)"/.exec(text)?.[1] ?? "?") : null));
    s.on("error", () => finish(null));
  });
}

// ── the phone's endpoint (docs/architecture-v2/phone-route.md §4; Appendix H scenario 11) ─────────────

export interface HttpRequestHead {
  method: string;
  path: string;
  /** Lower-case names; a repeated header keeps its LAST value, as Android's `HttpHead.parse` does. */
  headers: Record<string, string>;
  body: string;
}

/** One whole HTTP/1.1 request (head and Content-Length body) from `buf`, or null while incomplete. */
export function parseHttpRequest(buf: Buffer): HttpRequestHead | null {
  const s = buf.toString("latin1");
  const end = s.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const lines = s.slice(0, end).split("\r\n");
  const [method = "", path = ""] = (lines[0] ?? "").split(" ");
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const len = Number(headers["content-length"] ?? 0) || 0;
  if (buf.length < end + 4 + len) return null;
  return { method, path, headers, body: buf.subarray(end + 4, end + 4 + len).toString("utf8") };
}

/** The exact-name cookie value (case-sensitive name, first match), as Android's `HttpHead.cookie`. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i) === name) return p.slice(i + 1);
  }
  return null;
}

/**
 * The phone endpoint, in node, as the 0.3 apps serve it (Android `PhoneEndpoint.kt`, iOS `PhoneEndpoint*.swift`;
 * docs/voici-and-messages.md §8.2): the shared `phoneWebCheck` decides first (Host exactly the phone's name, 421;
 * an Origin only from the listed voi.ci origins, 403 with no CORS; `GET /api/phone/live`, `OPTIONS` + `POST
 * /api/phone/deliver` with CORS for that origin only). Anything else falls to `phoneEndpointCheck` with no session
 * (the one-time-code session, `/api/phone/session` + `/api/phone/ping` and its `__Host-` cookie, is retired): a safe
 * read with no Origin is answered (`GET /` signed hello, the well-known), everything else is refused. No cookie is
 * read or set. GET / and the well-known also carry `phone` (the sim's label) so a visitor can tell phones apart.
 * With `web` unset (no voi.ci page on this phone) `live` and `deliver` answer 404, as the apps without a handler do.
 */
export class PhoneEndpointSim {
  constructor(
    private readonly o: {
      account: string;
      label: string;
      phoneRoutePub: string;
      onHello?: (device: string) => void;
      now?: () => number;
      origins?: readonly string[];
    },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** The origins `live` / `deliver` accept when no `web` handler brings its own. */
  get origins(): readonly string[] {
    return this.o.origins ?? PHONE_WEB_ORIGINS_GYM;
  }

  /** The voi.ci operations (deliver, live), when the sim plays a phone with a page (lib/voiciPhone.ts). */
  web: { respond(req: HttpRequestHead, hostname: string): string | Promise<string> | null } | null = null;

  respond(req: HttpRequestHead, hostname: string): string | Promise<string> {
    const host = (req.headers.host ?? "").split(":")[0]!;
    const path = req.path.split("?")[0]!;
    if (this.web) {
      const viaWeb = this.web.respond(req, hostname);
      if (viaWeb) return viaWeb;
    } else {
      const v = phoneWebCheck(
        {
          method: req.method,
          path,
          host,
          origin: req.headers.origin ?? null,
          contentType: req.headers["content-type"] ?? null,
          acrMethod: req.headers["access-control-request-method"] ?? null,
          acrHeaders: req.headers["access-control-request-headers"] ?? null,
        },
        { hostname, origins: this.origins },
      );
      if (v.kind === "refuse") return answer(v.status, { error: "refused", code: v.code });
      if (v.kind === "preflight") return answer(204, null, headerLines(v.headers));
      if (v.kind === "live" || v.kind === "deliver") return answer(404, { error: "not found", code: "not-found" }, headerLines(v.corsHeaders));
    }
    const verdict = phoneEndpointCheck(
      { method: req.method, host, origin: req.headers.origin ?? null, sessionCookie: null, csrf: null, upgrade: req.headers.upgrade !== undefined, establish: false },
      { hostname, sessionToken: null, csrfToken: null },
    );
    if (verdict !== "allow") return answer(403, { code: verdict });
    if (req.method === "GET" && path === "/") {
      return answer(200, { present: true, recorded: this.hello(req, hostname), phone: this.o.label, account: this.o.account, sni: hostname });
    }
    if (req.method === "GET" && path === "/.well-known/flagship-phone") {
      return answer(200, { account: this.o.account, hostname, phoneRoutePub: this.o.phoneRoutePub, phone: this.o.label });
    }
    return answer(404, { code: "not-found" });
  }

  private hello(req: HttpRequestHead, hostname: string): boolean {
    const device = req.headers["x-flagship-presence-device"];
    const at = Number(req.headers["x-flagship-presence-at"]);
    const sig = req.headers["x-flagship-presence-sig"];
    if (!device || !sig || !Number.isSafeInteger(at)) return false;
    const p: PhonePresence = { account: this.o.account, devicePub: device, hostname, issuedAt: at };
    if (!checkPhonePresence(p, sig, hostname, this.now())) return false;
    this.o.onHello?.(device);
    return true;
  }
}

function headerLines(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`)
    .join("");
}

const REASONS: Record<number, string> = { 200: "OK", 204: "No Content", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 421: "Misdirected Request", 429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable" };

/** One whole HTTP/1.1 answer as the sim sends it; `extra` is raw header lines (each ending in CRLF). */
export function answer(status: number, body: unknown, extra = ""): string {
  const json = status === 204 ? "" : JSON.stringify(body);
  const reason = REASONS[status] ?? "Status";
  return (
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(json)}\r\n` +
    "cache-control: no-store\r\nx-content-type-options: nosniff\r\ncontent-security-policy: default-src 'none'; frame-ancestors 'none'\r\n" +
    `referrer-policy: no-referrer\r\n${extra}connection: close\r\n\r\n${json}`
  );
}

export interface PhoneHttpAnswer {
  status: number;
  /** Lower-case names; repeated headers joined with "\n". */
  headers: Record<string, string>;
  body: string;
}

/**
 * One raw HTTPS request to the phone's name through the relay at `ip`, headers exactly as given (a browser's view of
 * the request a sibling page makes). Null when nothing answered (no holder, or the stream was closed).
 */
export async function phoneRequest(o: {
  ip: string;
  port?: number;
  sni: string;
  ca: string[];
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<PhoneHttpAnswer | null> {
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (v: PhoneHttpAnswer | null) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    const s = tlsConnect({ host: o.ip, port: o.port ?? 443, servername: o.sni, ca: o.ca, checkServerIdentity: () => undefined });
    s.setTimeout(8_000, () => finish(null));
    s.on("secureConnect", () => {
      const body = o.body ?? "";
      const lines = Object.entries(o.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      const len = body || o.method === "POST" ? `content-length: ${Buffer.byteLength(body)}\r\n` : "";
      s.write(`${o.method} ${o.path} HTTP/1.1\r\n${lines}${len}connection: close\r\n\r\n${body}`);
    });
    s.on("data", (d) => (text += d.toString("latin1")));
    s.on("end", () => finish(parseHttpAnswer(text)));
    s.on("error", () => finish(null));
  });
}

export function parseHttpAnswer(text: string): PhoneHttpAnswer | null {
  const end = text.indexOf("\r\n\r\n");
  const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
  if (end < 0 || !m) return null;
  const headers: Record<string, string> = {};
  for (const l of text.slice(0, end).split("\r\n").slice(1)) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    const v = l.slice(i + 1).trim();
    headers[k] = headers[k] === undefined ? v : `${headers[k]}\n${v}`;
  }
  return { status: Number(m[1]), headers, body: text.slice(end + 4) };
}

/** Is `fingerprint256` (as node's getPeerCertificate gives it) the fingerprint of one of `pems`? */
export function isPhoneCert(fingerprint256: string | undefined, pems: string[]): boolean {
  return !!fingerprint256 && pems.some((p) => new X509Certificate(p).fingerprint256 === fingerprint256);
}

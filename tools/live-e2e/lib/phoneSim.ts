/**
 * A phone, simulated in node, for the bare `<account>.<apex>` route (plan H3, docs/architecture-v2/phone-route.md):
 * it opens `/phone-tunnel`, begins, signs the `route-claim/v1` the relay offers with its account device key, and
 * serves relayed visitor streams. In `tls` mode it terminates TLS itself (node:tls over each relayed stream) with
 * its own key and certificate and answers a tiny HTTP endpoint, so a visitor can check the TLS peer is the phone.
 * Used by apps/web/tests/phoneRoute.test.ts and the live gym group release03/phoneRoute.ts.
 */
import { Duplex } from "node:stream";
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
  signServingRecord,
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
  private waiters: Array<{ match: (m: Control) => boolean; resolve: (m: Control) => void }> = [];
  private closedResolve!: () => void;
  readonly closed: Promise<void>;

  private constructor(private readonly ws: WebSocket, readonly opts: SimPhoneOptions) {
    this.pub = hexOf(ed.getPublicKey(opts.seed));
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
    const ws = new WebSocket(url);
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

  /** Step 1 only: the relay's challenge. */
  async begin(account = this.opts.account): Promise<Control> {
    this.send({ type: "begin", account });
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
    let head = "";
    tls.on("data", (d: Buffer) => {
      head += d.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const h = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(head)?.[1]?.trim();
      const device = h("x-flagship-presence-device");
      const at = Number(h("x-flagship-presence-at"));
      const sig = h("x-flagship-presence-sig");
      let recorded = false;
      if (device && sig && Number.isSafeInteger(at)) {
        const p: PhonePresence = { account: this.opts.account, devicePub: device, hostname: sni, issuedAt: at };
        if (checkPhonePresence(p, sig, sni, Date.now())) {
          this.seen.set(device, Date.now());
          recorded = true;
        }
      }
      const body = JSON.stringify({ phone: this.opts.label ?? this.pub.slice(0, 8), account: this.opts.account, sni, recorded });
      tls.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
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
    const s = tlsConnect({ host: o.ip, port: o.port ?? 443, servername: o.hostname, ca: o.ca, checkServerIdentity: () => undefined });
    s.setTimeout(8_000, () => finish(null));
    s.on("secureConnect", () =>
      s.write(`GET / HTTP/1.1\r\nhost: ${o.hostname}\r\nx-flagship-presence-device: ${devicePub}\r\nx-flagship-presence-at: ${issuedAt}\r\nx-flagship-presence-sig: ${sig}\r\nconnection: close\r\n\r\n`),
    );
    s.on("data", (d) => (text += d.toString()));
    s.on("end", () => finish(/^HTTP\/1\.1 2\d\d/.test(text) ? (/"phone":"([^"]+)"/.exec(text)?.[1] ?? "?") : null));
    s.on("error", () => finish(null));
  });
}

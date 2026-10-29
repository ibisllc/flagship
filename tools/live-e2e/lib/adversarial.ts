// Helpers for the live adversarial group (groups/release03/adversarial.ts, V01): the forged
// signature shapes every signed route is fed, how an app's egress probe answer is read, whether a
// served certificate stays inside one account's names, and a raw HTTPS request whose path and SNI
// are sent exactly as written (fetch would normalise `%2e%2e`, `./` and `//` before they left).
import { connect } from "node:tls";

/** A signature shape a verifier must refuse. `signature: undefined` means the field is left out. */
export interface SignatureVariant {
  label: string;
  signature: string | undefined;
}

export const ZERO_SIG = "00".repeat(64);

/** The same signature with one bit of its first byte flipped. */
export function flipSig(hex: string): string {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 2) throw new Error("not a hex signature");
  const first = (Number.parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
  return first + hex.slice(2);
}

/**
 * The shapes every signed route must refuse, built around one VALID signature over the request
 * (which the caller never sends as is): all zeros, one flipped bit, left out, the wrong length, not
 * hex, and each foreign signer's valid signature over the same bytes.
 */
export function signatureVariants(validHex: string, foreign: Record<string, string>): SignatureVariant[] {
  return [
    { label: "all-zero signature", signature: ZERO_SIG },
    { label: "one bit flipped", signature: flipSig(validHex) },
    { label: "signature left out", signature: undefined },
    { label: "truncated signature", signature: validHex.slice(0, 64) },
    { label: "not hex", signature: "zz".repeat(64) },
    ...Object.entries(foreign).map(([who, sig]) => ({ label: `signed by ${who}`, signature: sig })),
  ];
}

/** True for a refusal: a 4xx, never a 2xx, 3xx or a 5xx (a crash is not a refusal). */
export function isRefusal(status: number): boolean {
  return status >= 400 && status < 500;
}

export type EgressVerdict = "reached" | "connected" | "fenced" | "unclear";

/**
 * What the runtimes group's python app `/probe?host=` answer means. `reached` and `connected` are
 * escapes: a TLS error (wrong version, certificate, EOF in the handshake) means a TCP connection was
 * made to the address. A proxy refusal, a refused or dropped connection, or a name that does not
 * resolve means the fence held.
 */
export function classifyEgressProbe(p: { reached?: unknown; error?: unknown } | null | undefined): EgressVerdict {
  if (!p || typeof p !== "object") return "unclear";
  if (p.reached === true) return "reached";
  const e = String(p.error ?? "");
  // The gateway intercepts every :443 connection, so the TCP connect always succeeds; for an address with no name it closes
  // before any handshake (an EOF with nothing said). Anything that answered with TLS of its own (a certificate, a version, an
  // alert) is someone real on the other side.
  if (/unexpected_eof|eof occurred in violation/i.test(e)) return "fenced";
  if (/ssl|certificate|wrong.version|handshake|tlsv|alert/i.test(e)) return "connected";
  if (/tunnel connection failed|\b40[37]\b|forbidden|refused|denied|blocked|not allowed|timed? ?out|unreachable|no route|name or service not known|nodename nor servname|getaddrinfo|name resolution|invalid url|bad request/i.test(e)) {
    return "fenced";
  }
  return "unclear";
}

/** Every SAN is one of this account's names (`<x>.<user>.<apex>`, `*.<user>.<apex>` or deeper). */
export function sansConfined(sans: readonly string[], user: string, apex: string): boolean {
  const suffix = `.${user}.${apex}`.toLowerCase();
  return sans.length > 0 && sans.every((s) => s.toLowerCase().endsWith(suffix));
}

/** The status line of a raw HTTP/1.x answer (0 when there is none). */
export function statusOf(raw: string): number {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  return m ? Number(m[1]) : 0;
}

/**
 * One HTTP/1.1 request over TLS with the path and headers sent byte for byte. `sni` picks the relay
 * route (and the box); `host` is the Host header. Certificate checks are off on purpose: this only
 * reads what the box answers, and the TLS checks have their own probes.
 */
export function rawHttps(o: { sni: string; host: string; method?: string; path: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; text: string }> {
  const lines = [`${o.method ?? "GET"} ${o.path} HTTP/1.1`, `Host: ${o.host}`, ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""];
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      sock.destroy();
      const sep = raw.indexOf("\r\n\r\n");
      resolve({ status: statusOf(raw), text: sep >= 0 ? raw.slice(sep + 4) : raw });
    };
    const sock = connect({ host: o.sni, port: 443, servername: o.sni, rejectUnauthorized: false }, () => sock.write(lines.join("\r\n")));
    const t = setTimeout(finish, o.timeoutMs ?? 20_000);
    sock.on("data", (d: Buffer) => {
      raw += d.toString("utf8");
      if (raw.length > 64_000) finish();
    });
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", finish);
  });
}

/** Whether a WebSocket upgrade opens. An open socket is closed again at once. */
export function wsOutcome(url: string, ms = 15_000): Promise<"open" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve("refused");
      return;
    }
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve("timeout");
    }, ms);
    ws.onopen = () => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve("open");
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve("refused");
    };
    ws.onclose = () => {
      clearTimeout(t);
      resolve("refused");
    };
  });
}

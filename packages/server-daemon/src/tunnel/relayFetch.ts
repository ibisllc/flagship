import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Duplex, Readable } from "node:stream";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { FetchLike, StreamingFetchLike } from "@flagship/llm-providers";
import { RelayError, relayUnavailable } from "./outboundStream.js";

/** What the relay fetch needs from the tunnel: the supervised client fits. */
export interface OutboundConnector {
  outboundAvailable(): boolean;
  openOutbound(host: string, port: number): Promise<Duplex>;
}

export interface RelayFetchOptions {
  connector: OutboundConnector;
  /** Test seam: extra trust anchors. Production uses the system store. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Abort a request whose socket goes quiet this long. Default 5 min. */
  idleTimeoutMs?: number;
}

/** The pair of fetches the LLM harness routes relay-on credentials through. */
export interface ProviderRelay {
  available(): boolean;
  fetch: FetchLike;
  streamingFetch: StreamingFetchLike;
}

type Init = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer;
};

/**
 * HTTPS to an AI provider through the Flagship hub (docs/ai-privacy-and-staging.md
 * §4). The hub opens TCP to `host:443`; this side runs TLS over that stream
 * with SNI = host and normal certificate verification against the system
 * roots, so the hub carries only ciphertext and the provider sees the hub's
 * address. One request per stream (`connection: close`); redirects are not
 * followed (a 3xx comes back as a non-ok response).
 */
export function providerRelay(opts: RelayFetchOptions): ProviderRelay {
  const fetch: FetchLike = async (input, init) => {
    const res = await relayRequest(input, init, opts);
    const text = once(() => readAll(res));
    return {
      ok: isOk(res),
      status: res.statusCode ?? 0,
      text,
      json: async () => JSON.parse(await text()) as unknown,
    };
  };
  const streamingFetch: StreamingFetchLike = async (input, init) => {
    const res = await relayRequest(input, init, opts);
    return {
      ok: isOk(res),
      status: res.statusCode ?? 0,
      text: () => readAll(res),
      lines: () => readLines(res),
    };
  };
  return {
    available: () => opts.connector.outboundAvailable(),
    fetch,
    streamingFetch,
  };
}

async function relayRequest(input: string, init: Init | undefined, opts: RelayFetchOptions): Promise<Readable & { statusCode?: number }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RelayError("unsupported", "the AI provider address isn't a valid URL");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new RelayError(
      "unsupported",
      `the Flagship relay only carries https on port 443, so the AI call to ${host} wasn't sent (turn the relay off for this key to use this address)`,
    );
  }
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) {
    throw new RelayError(
      "unsupported",
      `the Flagship relay only carries host names, so the AI call to ${host} wasn't sent`,
    );
  }
  if (!opts.connector.outboundAvailable()) throw relayUnavailable();

  const raw = await opts.connector.openOutbound(host, 443);
  const sock = tlsConnect({
    socket: raw as unknown as import("node:net").Socket,
    servername: host,
    ALPNProtocols: ["http/1.1"],
    ...(opts.ca ? { ca: opts.ca } : {}),
  });
  try {
    await secureConnect(sock);
  } catch (e) {
    sock.destroy();
    raw.destroy();
    const code = (e as { code?: string }).code;
    throw new RelayError(
      "tls",
      `couldn't open a verified secure connection to ${host} through the Flagship relay${code ? ` (${code})` : ""}, so the AI call wasn't sent`,
    );
  }

  const body = toBuffer(init?.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = host;
  headers.connection = "close";
  headers["accept-encoding"] ??= "gzip, deflate, br";
  if (body) headers["content-length"] = String(body.length);

  const idleMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(
      {
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers,
        createConnection: () => sock,
      },
      resolve,
    );
    req.setTimeout(idleMs, () => req.destroy(new RelayError("timeout", `the AI call to ${host} went quiet and was stopped`)));
    req.on("error", (e) =>
      reject(e instanceof RelayError ? e : new RelayError("lost", `the AI call to ${host} through the Flagship relay failed (${(e as { code?: string }).code ?? "connection error"})`)),
    );
    req.end(body);
  });
  res.once("close", () => sock.destroy());
  return decode(res);
}

function decode(res: IncomingMessage): Readable & { statusCode?: number } {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
  const z =
    enc === "gzip" || enc === "x-gzip"
      ? createGunzip()
      : enc === "deflate"
        ? createInflate()
        : enc === "br"
          ? createBrotliDecompress()
          : null;
  if (!z) return res;
  res.on("error", (e) => z.destroy(e));
  const out = res.pipe(z) as Readable & { statusCode?: number };
  out.statusCode = res.statusCode;
  return out;
}

function isOk(res: { statusCode?: number }): boolean {
  const s = res.statusCode ?? 0;
  return s >= 200 && s < 300;
}

function secureConnect(sock: TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => {
      sock.off("secureConnect", onOk);
      reject(e);
    };
    const onOk = () => {
      sock.off("error", onErr);
      resolve();
    };
    sock.once("secureConnect", onOk);
    sock.once("error", onErr);
  });
}

function toBuffer(body: Init["body"]): Buffer | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function* readLines(stream: Readable): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  for await (const c of stream) {
    buf += decoder.decode(c as Uint8Array, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) yield buf;
}

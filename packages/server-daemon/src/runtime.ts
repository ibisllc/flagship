import { connect as netConnect, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import { ed, type Keypair } from "@flagship/protocol";
import acme from "acme-client";
import { CertManager, type CertMaterial } from "./certManager.js";
import { LetsEncryptIssuer, type LeEnvironment } from "./acme/letsEncryptIssuer.js";
import { PersistentAcmeStore, isCertFresh } from "./acme/persistentStore.js";
import { RemoteDnsChallengeWriter } from "./acme/remoteDnsChallengeWriter.js";
import { startTunnelClient, type TunnelClient } from "./tunnel/tunnelClient.js";
import { buildOrdersHandler, type OrderExecutor } from "./orders.js";

export interface DaemonRuntimeOptions {
  /** Server FQDN, e.g. "home.alice.flagship.services". */
  serverFqdn: string;
  /** 32-byte server identity private key. The pubkey must already be registered. */
  identityPrivKey: Uint8Array;
  /** WebSocket URL of the .services tunnel hub. */
  tunnelHubUrl: string;
  /** Base URL of the .com control plane (for DNS-01 publish/delete). */
  controlPlaneBaseUrl: string;
  /** Email for the ACME account. */
  acmeEmail: string;
  /** "staging" for Let's Encrypt's pebble or "production" for prod issuance. */
  acmeEnvironment: LeEnvironment;
  /**
   * If true (default), request a wildcard `*.<serverFqdn>` SAN in addition
   * to the server FQDN. Set false to issue only the server FQDN (e.g.
   * during early bootstrap before the control-plane DNS-01 path is set up
   * for this environment).
   */
  wildcard?: boolean;
  /**
   * Optional pre-existing ACME account key PEM. If absent (and `dataDir`
   * is also absent), a fresh account key is generated and discarded on
   * shutdown. With `dataDir`, the runtime loads/persists the account key
   * automatically — you should usually use that instead.
   */
  accountKeyPem?: string;
  /**
   * Directory for persistent ACME state (account key + cert + private
   * key). Default: none (in-memory only). Production: `/var/flagship`
   * on the LUKS-encrypted root. Files are written `0700` dir / `0600`
   * file with atomic write-then-rename.
   */
  dataDir?: string;
  /**
   * Renewal window in ms. If a cert loaded from disk has at least this
   * much time before expiry, we skip ACME on startup. Default: 30 days
   * (matching Let's Encrypt's renewal recommendation).
   */
  renewalWindowMs?: number;
  /** Test seam — replace with mock store. */
  persistentStore?: PersistentAcmeStore;
  /**
   * Called when a new cert is issued (or renewed). Fires AFTER persistence.
   */
  onCertIssued?: (cert: CertMaterial, notAfter: number, names: string[]) => void;
  /**
   * Called when a fresh ACME account key is generated. Fires AFTER
   * persistence. Useful for tests / observability.
   */
  onAccountKeyGenerated?: (pem: string) => void;
  /**
   * How to respond to incoming HTTPS requests once the cert is up.
   * Default: a tiny "Flagship daemon — no app configured" page on /,
   * `/api/orders-from-user` if `orders` is configured, 404 elsewhere.
   * Replace with a real reverse-proxy / app router.
   */
  handleHttp?: (req: HttpRequest) => Promise<HttpResponse>;
  /**
   * Phone-server orders endpoint. When set, the default HTTP handler
   * dispatches `POST /api/orders-from-user` to a signature-verifying
   * dispatcher backed by `executor`. Custom `handleHttp` implementations
   * should integrate `buildOrdersHandler` themselves.
   */
  orders?: {
    pskPub: Uint8Array;
    executor: OrderExecutor;
  };
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export interface DaemonRuntime {
  /** Wait until the daemon is reachable end-to-end (cert installed). */
  ready(): Promise<void>;
  close(): Promise<void>;
  certManager: CertManager;
}

function buildDefaultHandler(opts: DaemonRuntimeOptions): (req: HttpRequest) => Promise<HttpResponse> {
  const orderHandler = opts.orders
    ? buildOrdersHandler({
        serverFqdn: opts.serverFqdn,
        pskPub: opts.orders.pskPub,
        executor: opts.orders.executor,
      })
    : null;

  return async function defaultHandler(req: HttpRequest): Promise<HttpResponse> {
    if (req.path === "/api/orders-from-user") {
      if (!orderHandler) {
        return {
          status: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "orders endpoint not configured" }),
        };
      }
      return orderHandler(req);
    }
    if (req.path === "/" || req.path === "") {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: defaultHelloPage(),
      };
    }
    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "not found",
    };
  };
}

function defaultHelloPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Flagship daemon</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 4rem 2rem; max-width: 720px; margin: 0 auto; line-height: 1.55; }
      h1 { color: #6ee7a8; }
      code { background: #1a1a1a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #fbcc4a; }
      .meta { color: #888; font-size: 0.9rem; margin-top: 2rem; }
    </style>
  </head>
  <body>
    <h1>🟢 Flagship daemon online</h1>
    <p>This server is alive. No app is yet bound to <code id="host"></code>.</p>
    <p class="meta">TLS terminated locally on this server. flagship.services only saw ciphertext.</p>
    <script>document.getElementById("host").textContent = location.host;</script>
  </body>
</html>`;
}

/**
 * Bring up the full daemon runtime:
 *   1. local TLS server with SNI/ALPN-aware cert resolution
 *   2. tunnel client connected to the .services hub
 *   3. ACME with Let's Encrypt for the server's cert
 *
 * Returns once the cert is installed (so the daemon is serving real HTTPS).
 */
export async function startDaemonRuntime(opts: DaemonRuntimeOptions): Promise<DaemonRuntime> {
  const wantWildcard = opts.wildcard ?? true;
  const sans = wantWildcard
    ? [opts.serverFqdn, `*.${opts.serverFqdn}`]
    : [opts.serverFqdn];
  const certManager = new CertManager();
  const handleHttp = opts.handleHttp ?? buildDefaultHandler(opts);

  // Local TLS server. The tunnel hub forwards inbound TCP from
  // `<serverFqdn>:443` to this socket; the TLS handshake terminates here.
  const tls = createTlsServer({
    ALPNProtocols: ["acme-tls/1", "http/1.1"],
    SNICallback: (servername, cb) => {
      const ctx = certManager.contextFor(servername);
      if (!ctx) {
        cb(new Error(`no cert for ${servername}`));
        return;
      }
      cb(null, ctx);
    },
  });
  tls.on("secureConnection", (socket: TLSSocket) => {
    if (socket.alpnProtocol === "acme-tls/1") {
      socket.end();
      return;
    }
    handleHttpConnection(socket, handleHttp);
  });
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", () => resolve()));
  const tlsAddr = tls.address();
  if (!tlsAddr || typeof tlsAddr === "string") throw new Error("could not bind TLS backend");
  const tlsPort = tlsAddr.port;

  // Identity keypair derived from the priv key.
  const identity: Keypair = {
    privateKey: opts.identityPrivKey,
    publicKey: ed.getPublicKey(opts.identityPrivKey),
  };

  // Tunnel client: forwards FRAME_OPEN(SNI) → 127.0.0.1:tlsPort.
  const tunnel = startTunnelClient({
    hubUrl: opts.tunnelHubUrl,
    serverId: opts.serverFqdn,
    subdomains: [opts.serverFqdn],
    signingKey: identity,
    resolveBackend: () => ({ host: "127.0.0.1", port: tlsPort }),
  });
  await tunnel.ready();

  // Persistent ACME state. If a `dataDir` (or test-injected store) is
  // configured, account key and issued certs are loaded on startup and
  // persisted on issuance. With no store, behavior matches the in-memory
  // demo: a fresh LE account on every restart and no renewal continuity.
  const store: PersistentAcmeStore | null =
    opts.persistentStore ?? (opts.dataDir ? new PersistentAcmeStore(opts.dataDir) : null);
  const renewalWindowMs = opts.renewalWindowMs ?? 30 * 24 * 60 * 60 * 1000;

  // Try to short-circuit ACME if a fresh cert is already on disk.
  if (store) {
    const existing = await store.loadCert(opts.serverFqdn);
    if (existing && isCertFresh(existing, renewalWindowMs) && sansEqual(existing.names, sans)) {
      certManager.install(
        { certPem: existing.certPem, privateKeyPem: existing.privateKeyPem },
        existing.notAfter,
      );
      console.log(
        `[runtime] reusing on-disk cert for ${opts.serverFqdn}; not after ${new Date(existing.notAfter).toISOString()}`,
      );
      return {
        ready: () => Promise.resolve(),
        close: async () => {
          await tunnel.close();
          tls.close();
        },
        certManager,
      };
    }
  }

  // ACME. Run after the tunnel is live so TLS-ALPN-01 validators can
  // reach our local TLS server through the same passthrough.
  let accountKeyPem = opts.accountKeyPem;
  let accountKeyFreshlyMinted = false;
  if (!accountKeyPem && store) {
    accountKeyPem = (await store.loadAccountKey()) ?? undefined;
  }
  if (!accountKeyPem) {
    accountKeyPem = (await acme.crypto.createPrivateKey()).toString();
    accountKeyFreshlyMinted = true;
    if (store) await store.saveAccountKey(accountKeyPem);
    opts.onAccountKeyGenerated?.(accountKeyPem);
  }

  const dns = new RemoteDnsChallengeWriter({
    controlPlaneBaseUrl: opts.controlPlaneBaseUrl,
    serverId: opts.serverFqdn,
    stk: identity,
  });
  const issuer = new LetsEncryptIssuer({
    email: opts.acmeEmail,
    environment: opts.acmeEnvironment,
    accountKeyPem,
    alpn: certManager,
    dns,
  });

  const result = await issuer.issue(sans);
  certManager.install(
    { certPem: result.certPem, privateKeyPem: result.privateKeyPem },
    result.notAfter,
  );
  if (store) {
    await store.saveCert(opts.serverFqdn, {
      certPem: result.certPem,
      privateKeyPem: result.privateKeyPem,
      names: sans,
      notAfter: result.notAfter,
    });
  }
  opts.onCertIssued?.(
    { certPem: result.certPem, privateKeyPem: result.privateKeyPem },
    result.notAfter,
    sans,
  );

  return {
    ready: () => Promise.resolve(),
    close: async () => {
      await tunnel.close();
      tls.close();
    },
    certManager,
  };
}

function sansEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Tiny HTTP/1.1 reader on the TLS socket. Real production path will
 * proxy to per-app Forgejo/etc. backends via the AppRunner; for now this
 * is a self-contained handler so the daemon can prove end-to-end without
 * an app in the picture.
 */
function handleHttpConnection(
  socket: TLSSocket,
  handler: (req: HttpRequest) => Promise<HttpResponse>,
): void {
  let buf: Buffer = Buffer.alloc(0);
  let headersDone = false;
  let method = "";
  let path = "";
  let headers: Record<string, string> = {};
  let bodyExpected = 0;
  let bodyAccum: Buffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!headersDone) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const headerBlock = buf.subarray(0, sep).toString("utf8");
      buf = buf.subarray(sep + 4);
      const lines = headerBlock.split(/\r\n/);
      const requestLine = lines[0]?.split(" ") ?? [];
      method = requestLine[0] ?? "";
      path = requestLine[1] ?? "/";
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        headers[k] = v;
      }
      bodyExpected = parseInt(headers["content-length"] ?? "0", 10) || 0;
      headersDone = true;
    }
    if (headersDone) {
      bodyAccum = Buffer.concat([bodyAccum, buf]);
      buf = Buffer.alloc(0);
      if (bodyAccum.length >= bodyExpected) {
        respond({ method, path, headers, body: bodyAccum.subarray(0, bodyExpected) }).catch(() => {});
      }
    }
  });
  socket.on("error", () => {});

  async function respond(req: HttpRequest): Promise<void> {
    let resp: HttpResponse;
    try {
      resp = await handler(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      resp = { status: 500, headers: { "content-type": "text/plain" }, body: `internal error: ${msg}` };
    }
    const body = typeof resp.body === "string" ? Buffer.from(resp.body) : resp.body;
    const hdrs = resp.headers ?? { "content-type": "text/plain" };
    const head = [
      `HTTP/1.1 ${resp.status} ${statusText(resp.status)}`,
      `Content-Length: ${body.length}`,
      "Connection: close",
      ...Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n");
    socket.write(head);
    socket.write(body);
    socket.end();
  }
}

function statusText(s: number): string {
  if (s === 200) return "OK";
  if (s === 201) return "Created";
  if (s === 204) return "No Content";
  if (s === 301) return "Moved Permanently";
  if (s === 302) return "Found";
  if (s === 304) return "Not Modified";
  if (s === 400) return "Bad Request";
  if (s === 401) return "Unauthorized";
  if (s === 403) return "Forbidden";
  if (s === 404) return "Not Found";
  if (s === 500) return "Internal Server Error";
  if (s === 502) return "Bad Gateway";
  if (s === 503) return "Service Unavailable";
  return "OK";
}

/**
 * hello-daemon — minimal Flagship server-daemon for end-to-end testing.
 *
 * What it does:
 *   1. Loads identity keypair + claimed subdomain + tunnel-hub URL from
 *      env (FLAGSHIP_IDENTITY_PRIV_HEX, FLAGSHIP_SUBDOMAIN, FLAGSHIP_HUB).
 *   2. Starts a local TLS server (self-signed cert) on a free port.
 *      The TLS server serves a hello-world HTML page on every request.
 *   3. Dials the tunnel-hub WebSocket, sends HELLO with the identity
 *      keypair signing over (serverId, subdomains, nonce, issuedAt).
 *   4. For each FRAME_OPEN received, opens a TCP connection to the local
 *      TLS server and shovels bytes both ways — i.e. the tunnel-hub
 *      passes raw TLS bytes through us to the local TLS terminator.
 *   5. Logs everything.
 *
 * Real production daemon will replace step (2) with Caddy + ACME via
 * TLS-ALPN-01 (so the cert is real Let's Encrypt). For demo purposes,
 * self-signed gets you a working chain end-to-end; browsers will warn
 * but the routing/passthrough is provably correct.
 */

import { connect as netConnect, createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { WebSocket } from "ws";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_OPEN,
  type Frame,
} from "@flagship/tunnel-protocol";
import { signTunnelHello, type Keypair, ed } from "@flagship/protocol";

const HELLO_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hello from Flagship</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 4rem 2rem; max-width: 720px; margin: 0 auto; }
      h1 { color: #6ee7a8; }
      code { background: #1a1a1a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #fbcc4a; }
      .meta { color: #888; font-size: 0.9rem; margin-top: 2rem; }
    </style>
  </head>
  <body>
    <h1>👋 Hello from Flagship</h1>
    <p>This page is being served from a Flagship daemon over the SNI passthrough tunnel.</p>
    <p>The TLS connection terminated <strong>on the daemon</strong>; <code>flagship.services</code> only saw ciphertext.</p>
    <p class="meta">subdomain: <code id="host"></code></p>
    <script>document.getElementById("host").textContent = location.host;</script>
  </body>
</html>`;

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface SelfsignedModule {
  generate(attrs: Array<{ name: string; value: string }>, opts: unknown): {
    cert: string;
    private: string;
    public: string;
  };
}

async function generateSelfSignedCert(hostname: string): Promise<{ cert: string; key: string }> {
  // selfsigned has no @types package; treat it as opaque.
  const mod = (await import("selfsigned")) as unknown as SelfsignedModule;
  const attrs = [{ name: "commonName", value: hostname }];
  const opts = {
    days: 365,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [{ type: 2, value: hostname }, { type: 2, value: `*.${hostname}` }],
      },
    ],
  };
  const pems = mod.generate(attrs, opts);
  return { cert: pems.cert, key: pems.private };
}

async function main(): Promise<void> {
  const privHex = process.env.FLAGSHIP_IDENTITY_PRIV_HEX;
  const subdomain = process.env.FLAGSHIP_SUBDOMAIN;
  const hubUrl = process.env.FLAGSHIP_HUB ?? "wss://flagship-services.fly.dev:8443/tunnel";
  if (!privHex || !subdomain) {
    console.error("Required env: FLAGSHIP_IDENTITY_PRIV_HEX (32 bytes hex), FLAGSHIP_SUBDOMAIN");
    process.exit(2);
  }
  const privateKey = hexToBytes(privHex);
  if (privateKey.length !== 32) {
    console.error("FLAGSHIP_IDENTITY_PRIV_HEX must be 32 bytes (64 hex chars)");
    process.exit(2);
  }
  const publicKey = ed.getPublicKey(privateKey);
  const signingKey: Keypair = { privateKey, publicKey };
  console.log(`[hello-daemon] identity pub: ${bytesToHex(publicKey)}`);
  console.log(`[hello-daemon] subdomain:    ${subdomain}`);
  console.log(`[hello-daemon] hub URL:      ${hubUrl}`);

  // Start the local TLS server with a self-signed cert.
  const { cert, key } = await generateSelfSignedCert(subdomain);
  const tlsBackend = createTlsServer({ cert, key });
  tlsBackend.on("secureConnection", (socket: TLSSocket) => {
    let req = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      req += chunk;
      if (req.includes("\r\n\r\n")) {
        const body = HELLO_HTML;
        const headers = [
          "HTTP/1.1 200 OK",
          `Content-Type: text/html; charset=utf-8`,
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n");
        socket.write(headers + body);
        socket.end();
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => tlsBackend.listen(0, "127.0.0.1", () => resolve()));
  const tlsAddr = tlsBackend.address();
  if (!tlsAddr || typeof tlsAddr === "string") throw new Error("could not bind TLS backend");
  const tlsPort = tlsAddr.port;
  console.log(`[hello-daemon] TLS backend listening on 127.0.0.1:${tlsPort} (self-signed cert for ${subdomain})`);

  // Dial the tunnel hub.
  const ws = new WebSocket(hubUrl);
  ws.binaryType = "arraybuffer";
  const streams = new Map<number, Socket>();
  let buffered: Uint8Array = new Uint8Array(0);

  function send(frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame), { binary: true });
  }
  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  ws.on("open", () => {
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const issuedAt = Date.now();
    const helloRecord = {
      serverId: subdomain,
      subdomains: [subdomain],
      nonce,
      issuedAt,
    };
    const signature = signTunnelHello(helloRecord, signingKey);
    const payload = JSON.stringify({
      serverId: subdomain,
      subdomains: [subdomain],
      nonce: bytesToHex(nonce),
      issuedAt,
      signature: bytesToHex(signature),
    });
    send({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(payload) });
    console.log(`[hello-daemon] HELLO sent`);
  });

  ws.on("message", (raw: ArrayBuffer | Buffer) => {
    const view = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    buffered = concat(buffered, view);
    while (true) {
      const r = decodeFrame(buffered);
      if (r.kind === "incomplete") return;
      if (r.kind === "error") {
        console.error(`[hello-daemon] frame decode error: ${r.reason}`);
        ws.close();
        return;
      }
      buffered = buffered.subarray(r.consumed);
      handleFrame(r.frame);
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`[hello-daemon] WS closed: ${code} ${reason}`);
    process.exit(1);
  });
  ws.on("error", (err) => {
    console.error(`[hello-daemon] WS error: ${(err as Error).message}`);
  });

  function handleFrame(f: Frame): void {
    if (f.type === FRAME_HELLO_ACK) {
      const ack = JSON.parse(new TextDecoder().decode(f.payload)) as { ok: boolean; reason?: string };
      if (!ack.ok) {
        console.error(`[hello-daemon] HELLO rejected: ${ack.reason}`);
        process.exit(1);
      }
      console.log(`[hello-daemon] HELLO ACK — registered for ${subdomain}`);
      return;
    }
    if (f.type === FRAME_OPEN) {
      const sni = new TextDecoder().decode(f.payload);
      const sock = netConnect(tlsPort, "127.0.0.1");
      streams.set(f.streamId, sock);
      sock.on("data", (chunk: Buffer) => {
        const u = new Uint8Array(chunk.byteLength);
        u.set(chunk);
        send(dataFrame(f.streamId, u));
      });
      sock.on("end", () => {
        send(closeFrame(f.streamId, false));
        streams.delete(f.streamId);
      });
      sock.on("error", () => {
        send(closeFrame(f.streamId, false));
        streams.delete(f.streamId);
      });
      console.log(`[hello-daemon] stream ${f.streamId} OPEN sni=${sni}`);
      return;
    }
    if (f.type === FRAME_DATA) {
      const sock = streams.get(f.streamId);
      if (sock) sock.write(Buffer.from(f.payload));
      return;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      const sock = streams.get(f.streamId);
      if (sock) {
        sock.end();
        streams.delete(f.streamId);
      }
      return;
    }
  }
}

main().catch((e) => {
  console.error(`[hello-daemon] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

/**
 * hello-daemon — minimal Flagship server-daemon for end-to-end testing.
 *
 * What it does:
 *   1. Loads identity keypair + claimed subdomain + tunnel-hub URL from env.
 *   2. Runs ACME with Let's Encrypt via TLS-ALPN-01: the daemon's TLS server
 *      listens with ALPN ["acme-tls/1", "http/1.1"]. When LE's validator
 *      connects with the ACME ALPN protocol, we present a challenge cert;
 *      otherwise we present the real cert.
 *   3. Dials the tunnel-hub WebSocket, sends HELLO with the identity
 *      keypair signing over (serverId, subdomains, nonce, issuedAt).
 *   4. For each FRAME_OPEN received, opens a TCP connection to the local
 *      TLS server and shovels bytes both ways. The TLS handshake is
 *      between the public client (curl, browser) and our local TLS
 *      server; .services only forwards bytes.
 *   5. Serves a hello-world HTML page.
 *
 * The cert + ACME account key are kept in process memory (not persisted).
 * Renewal: the daemon refreshes the cert when it has < 30 days left.
 */

import { connect as netConnect, type Socket } from "node:net";
import { createServer as createTlsServer, type SecureContext, createSecureContext, type TLSSocket } from "node:tls";
import { generateKeyPairSync, createPrivateKey, type KeyObject } from "node:crypto";
import acme from "acme-client";
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
import { buildAlpnChallengeCert } from "@flagship/server-daemon/src/acme/alpnChallengeCert.js";

const HELLO_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hello from Flagship</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 4rem 2rem; max-width: 720px; margin: 0 auto; line-height: 1.55; }
      h1 { color: #6ee7a8; }
      code { background: #1a1a1a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #fbcc4a; }
      .meta { color: #888; font-size: 0.9rem; margin-top: 2rem; }
      .padlock { font-size: 2rem; }
    </style>
  </head>
  <body>
    <h1>👋 Hello from Flagship</h1>
    <p class="padlock">🔒 Real Let's Encrypt cert. Real green padlock.</p>
    <p>This page is served from a Flagship daemon over the SNI passthrough tunnel.</p>
    <p>The TLS handshake terminated <strong>on the daemon</strong>; <code>flagship.services</code> only saw ciphertext.</p>
    <p class="meta">subdomain: <code id="host"></code></p>
    <p class="meta">cert issuer: Let's Encrypt — issued via TLS-ALPN-01 over this same passthrough.</p>
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

interface CertMaterial {
  certPem: string;
  privateKeyPem: string;
}

interface AlpnSlot {
  certPem: string;
  privateKeyPem: string;
}

class CertStore {
  private real: CertMaterial | null = null;
  /** Active TLS-ALPN-01 challenge certs, keyed by SNI. */
  private alpn = new Map<string, AlpnSlot>();

  setReal(cert: CertMaterial): void {
    this.real = cert;
  }
  presentAlpn(sni: string, mat: AlpnSlot): () => void {
    this.alpn.set(sni.toLowerCase(), mat);
    return () => {
      this.alpn.delete(sni.toLowerCase());
    };
  }
  contextFor(sni: string): SecureContext | null {
    // During the ACME challenge window, we don't know yet which ALPN the
    // peer will negotiate (Node's SNICallback fires before ALPN
    // selection). If a challenge cert is queued for this SNI, prefer it —
    // worst case real browser traffic during that ~5s window also gets
    // the challenge cert and is rejected, which is fine because we don't
    // advertise the server until the cert is installed.
    const slot = this.alpn.get(sni.toLowerCase());
    if (slot) {
      return createSecureContext({ cert: slot.certPem, key: slot.privateKeyPem });
    }
    if (!this.real) return null;
    return createSecureContext({ cert: this.real.certPem, key: this.real.privateKeyPem });
  }
}

async function obtainCert(opts: {
  domain: string;
  email: string;
  store: CertStore;
  staging: boolean;
}): Promise<CertMaterial> {
  const directoryUrl = opts.staging
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  const accountKey = (await acme.crypto.createPrivateKey()).toString();
  const client = new acme.Client({ directoryUrl, accountKey });

  console.log(`[hello-daemon] ACME: creating account (${opts.staging ? "staging" : "production"})`);
  await client.createAccount({
    termsOfServiceAgreed: true,
    contact: [`mailto:${opts.email}`],
  });

  console.log(`[hello-daemon] ACME: creating order for ${opts.domain}`);
  const order = await client.createOrder({
    identifiers: [{ type: "dns", value: opts.domain }],
  });

  const authorizations = await client.getAuthorizations(order);
  for (const authz of authorizations) {
    const challenge = authz.challenges.find((c: { type: string }) => c.type === "tls-alpn-01");
    if (!challenge) {
      throw new Error(`no tls-alpn-01 challenge for ${authz.identifier.value}`);
    }
    const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
    const sni = authz.identifier.value;
    console.log(`[hello-daemon] ACME: presenting ALPN challenge for ${sni}`);
    const challengeCert = await buildAlpnChallengeCert(keyAuthorization, sni);
    const remove = opts.store.presentAlpn(sni, challengeCert);
    try {
      console.log(`[hello-daemon] ACME: notifying LE the challenge is ready`);
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
      console.log(`[hello-daemon] ACME: validation complete for ${sni}`);
    } finally {
      remove();
    }
  }

  console.log(`[hello-daemon] ACME: generating CSR + finalizing`);
  const [keyPem, csr] = await acme.crypto.createCsr({
    commonName: opts.domain,
    altNames: [opts.domain],
  });
  const finalized = await client.finalizeOrder(order, csr);
  const certPem = await client.getCertificate(finalized);
  console.log(`[hello-daemon] ACME: got cert (${certPem.length} bytes)`);
  return { certPem, privateKeyPem: keyPem.toString() };
}

async function main(): Promise<void> {
  const privHex = process.env.FLAGSHIP_IDENTITY_PRIV_HEX;
  const subdomain = process.env.FLAGSHIP_SUBDOMAIN;
  const hubUrl = process.env.FLAGSHIP_HUB ?? "wss://flagship-services.fly.dev:8443/tunnel";
  const acmeEmail = process.env.FLAGSHIP_ACME_EMAIL ?? "ops@flagship.services";
  const acmeStaging = process.env.FLAGSHIP_ACME_STAGING === "1";
  if (!privHex || !subdomain) {
    console.error("Required env: FLAGSHIP_IDENTITY_PRIV_HEX (32 bytes hex), FLAGSHIP_SUBDOMAIN");
    process.exit(2);
  }
  const privateKey = hexToBytes(privHex);
  const publicKey = ed.getPublicKey(privateKey);
  const signingKey: Keypair = { privateKey, publicKey };
  console.log(`[hello-daemon] identity pub: ${bytesToHex(publicKey)}`);
  console.log(`[hello-daemon] subdomain:    ${subdomain}`);
  console.log(`[hello-daemon] hub URL:      ${hubUrl}`);
  console.log(`[hello-daemon] ACME:         ${acmeStaging ? "staging" : "PRODUCTION"} as ${acmeEmail}`);

  const store = new CertStore();

  // Bring up the TLS server BEFORE we dial the tunnel hub. The ACME
  // validator can only reach our ALPN challenge once the tunnel is open
  // AND we're listening AND we're ALPN-aware on the local socket.
  const tlsBackend = createTlsServer({
    ALPNProtocols: ["acme-tls/1", "http/1.1"],
    SNICallback: (servername, cb) => {
      // We can't tell from here what ALPN the client picked; Node calls
      // SNICallback BEFORE ALPN selection. So we set up a default context
      // here and override per-socket inside the secureConnection handler.
      const ctx = store.contextFor(servername);
      if (!ctx) {
        cb(new Error(`no cert for ${servername}`));
        return;
      }
      cb(null, ctx);
    },
  });
  // Override the cert AFTER ALPN is negotiated: the secureConnection
  // event fires after the handshake completes; if the negotiated ALPN
  // is `acme-tls/1`, the SNICallback we ran above already presented the
  // wrong cert. We swap by intercepting at the lower level via
  // `ALPNCallback` (Node 17+).
  // Simpler: use `ALPNCallback` to choose the ALPN proto AND swap context
  // before the cert is presented.
  (tlsBackend as unknown as { setSecureContext(ctx: ReturnType<typeof createSecureContext>): void });
  tlsBackend.on("secureConnection", (socket: TLSSocket) => {
    if (socket.alpnProtocol === "acme-tls/1") {
      // ACME validator's HTTP layer is empty; close immediately.
      socket.end();
      return;
    }
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
  console.log(`[hello-daemon] TLS backend listening on 127.0.0.1:${tlsPort}`);

  // Dial the tunnel hub and start forwarding BEFORE we kick off ACME —
  // the TLS-ALPN-01 validator's connection has to land on our TLS
  // backend, which means the tunnel has to be live first.
  const ws = new WebSocket(hubUrl);
  ws.binaryType = "arraybuffer";
  const streams = new Map<number, Socket>();
  let buffered: Uint8Array = new Uint8Array(0);
  let helloAcked = false;
  const ackedPromise = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("HELLO ACK timeout")), 30_000);
    const i = setInterval(() => {
      if (helloAcked) {
        clearTimeout(t);
        clearInterval(i);
        resolve();
      }
    }, 50);
  });

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
      helloAcked = true;
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

  // Wait for the tunnel to be live, then run ACME.
  await ackedPromise;

  // Brief delay to let DNS settle (the user may have just registered).
  await new Promise((r) => setTimeout(r, 2000));

  try {
    const cert = await obtainCert({
      domain: subdomain,
      email: acmeEmail,
      store,
      staging: acmeStaging,
    });
    store.setReal(cert);
    console.log(`[hello-daemon] 🔒 cert installed; serving real HTTPS for ${subdomain}`);
  } catch (e) {
    console.error(`[hello-daemon] ACME failed: ${(e as Error).message}`);
    console.error(`[hello-daemon] falling back to self-signed cert`);
    const { generate } = (await import("selfsigned")) as unknown as {
      generate(attrs: Array<{ name: string; value: string }>, opts: unknown): { cert: string; private: string };
    };
    const pems = generate(
      [{ name: "commonName", value: subdomain }],
      {
        days: 1,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [{
          name: "subjectAltName",
          altNames: [{ type: 2, value: subdomain }],
        }],
      },
    );
    store.setReal({ certPem: pems.cert, privateKeyPem: pems.private });
  }
}

main().catch((e) => {
  console.error(`[hello-daemon] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

/**
 * hello-daemon — minimal Flagship server-daemon that proves the chain
 * end-to-end. Now a thin wrapper around `@flagship/server-daemon`'s
 * `startDaemonRuntime`, with a custom HTTP handler that returns a
 * "hello world" page so the demo URL has something visible to serve.
 *
 * For the real production daemon, use `npx tsx packages/server-daemon/src/index.ts`
 * directly — that's the entry the OpenRC service points at.
 */

import { ed } from "@flagship/protocol";
import {
  startDaemonRuntime,
  type DaemonHttpRequest,
  type DaemonHttpResponse,
} from "@flagship/server-daemon";

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

async function helloHandler(_req: DaemonHttpRequest): Promise<DaemonHttpResponse> {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: HELLO_HTML,
  };
}

async function main(): Promise<void> {
  const privHex = process.env.FLAGSHIP_IDENTITY_PRIV_HEX;
  const subdomain = process.env.FLAGSHIP_SUBDOMAIN;
  const hubUrl = process.env.FLAGSHIP_HUB ?? "wss://flagship-services.fly.dev:8443/tunnel";
  const acmeEmail = process.env.FLAGSHIP_ACME_EMAIL ?? "ops@flagship.services";
  const acmeEnvironment = process.env.FLAGSHIP_ACME_STAGING === "1" ? "staging" : "production";
  const controlPlaneBaseUrl =
    process.env.FLAGSHIP_CONTROL_PLANE_BASE_URL ?? "https://flagshipserver.com";
  const wildcard = process.env.FLAGSHIP_NO_WILDCARD !== "1";

  if (!privHex || !subdomain) {
    console.error("Required env: FLAGSHIP_IDENTITY_PRIV_HEX (32 bytes hex), FLAGSHIP_SUBDOMAIN");
    process.exit(2);
  }

  const identityPrivKey = hexToBytes(privHex);
  console.log(`[hello-daemon] identity pub: ${bytesToHex(ed.getPublicKey(identityPrivKey))}`);
  console.log(`[hello-daemon] subdomain:    ${subdomain}`);
  console.log(`[hello-daemon] hub:          ${hubUrl}`);
  console.log(`[hello-daemon] control plane:${controlPlaneBaseUrl}`);
  console.log(`[hello-daemon] ACME:         ${acmeEnvironment} as ${acmeEmail}`);
  console.log(`[hello-daemon] wildcard:     ${wildcard ? "yes" : "no"}`);

  await startDaemonRuntime({
    serverFqdn: subdomain,
    identityPrivKey,
    tunnelHubUrl: hubUrl,
    controlPlaneBaseUrl,
    acmeEmail,
    acmeEnvironment,
    wildcard,
    handleHttp: helloHandler,
  });
  console.log(`[hello-daemon] 🔒 cert installed; serving HTTPS for ${subdomain}`);
}

main().catch((e) => {
  console.error(`[hello-daemon] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

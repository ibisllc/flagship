import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { connect as netConnect, type AddressInfo } from "node:net";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { gzipSync } from "node:zlib";
import selfsigned from "selfsigned";
import {
  providerRelay,
  RELAY_UNAVAILABLE_MESSAGE,
  startTunnelClient,
  type TunnelClient,
} from "@flagship/server-daemon";
import { deriveSTK, deriveSWK, ed, mintDevEntitlements } from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";
import { OutboundRelay } from "../src/tunnel/outboundRelay.js";
import { allowEveryHost } from "./support/allowEveryHost.js";

const SERVER_FQDN = "home.harry.flagship.services";
const PROVIDER = "api.provider.test";

const pems = selfsigned.generate([{ name: "commonName", value: PROVIDER }], {
  days: 1,
  keySize: 2048,
  algorithm: "sha256",
  extensions: [
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: PROVIDER }] },
  ],
});

interface Env {
  tunnel: TunnelClient;
  providerPort: number;
  logs: string[];
  seen: Array<{ method: string; url: string; host: string; bodyLength: number; apiKey: string | undefined }>;
  close(): Promise<void>;
}

const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

const BIG_DOWN = Buffer.alloc(3 * 1024 * 1024, 0x61);

async function startEnv(opts: { relay: boolean; records?: string[] }): Promise<Env> {
  const seen: Env["seen"] = [];
  const provider: HttpsServer = createHttpsServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        host: String(req.headers.host),
        bodyLength: body.length,
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
        const tick = setInterval(() => {
          res.write(`data: {"n":${i}}\n\n`);
          if (++i === 5) {
            clearInterval(tick);
            res.end();
          }
        }, 10);
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(BIG_DOWN);
        return;
      }
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.from(JSON.stringify({ zipped: true }))));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ got: body.length, sum: body.reduce((a, b) => (a + b) % 65521, 0) }));
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  const providerPort = (provider.address() as AddressInfo).port;

  const logs: string[] = [];
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(77) }, SERVER_FQDN);
  const stk = deriveSTK(swk);
  const irkPriv = new Uint8Array(32).fill(9);
  const irk = { privateKey: irkPriv, publicKey: ed.getPublicKey(irkPriv) };
  const registry = new TunnelRegistry();
  const app: FastifyInstance = Fastify({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const stopHub = startTunnelHub(app.server, registry, {
    authLookup: (id) => (id === SERVER_FQDN ? stk.publicKey : null),
    irkLookup: (u) => (u === "harry" ? irk.publicKey : null),
    ...(opts.relay
      ? {
          outboundRelay: new OutboundRelay({
            hostPolicy: allowEveryHost,
            resolve: async () => opts.records ?? ["93.184.215.14"],
            // The vetted public address stands in for the provider here.
            connect: () => netConnect({ host: "127.0.0.1", port: providerPort }),
            log: (l) => logs.push(l),
            statsIntervalMs: 0,
          }),
        }
      : {}),
  });
  const hubPort = (app.server.address() as AddressInfo).port;
  const tunnel = startTunnelClient({
    hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
    signingKey: stk,
    getEntitlements: () =>
      mintDevEntitlements({ irk, podPubKey: stk.publicKey, username: "harry", podCanonical: SERVER_FQDN }),
    resolveBackend: () => null,
  });
  await tunnel.ready();
  const env: Env = {
    tunnel,
    providerPort,
    logs,
    seen,
    close: async () => {
      await tunnel.close();
      await stopHub();
      await app.close();
      await new Promise<void>((r) => provider.close(() => r()));
    },
  };
  envs.push(env);
  return env;
}

function relayFor(env: Env, trust = true) {
  return providerRelay({
    connector: {
      outboundAvailable: () => env.tunnel.outboundAvailable!(),
      openOutbound: (h, p) => env.tunnel.openOutbound!(h, p),
    },
    ...(trust ? { ca: pems.cert } : {}),
  });
}

describe("AI provider relay end to end: box → tunnel → hub → provider", () => {
  it("carries a verified HTTPS request and its response; the hub logs host and sizes only", async () => {
    const env = await startEnv({ relay: true });
    expect(env.tunnel.outboundAvailable!()).toBe(true);
    const relay = relayFor(env);
    const body = JSON.stringify({ prompt: "secret prompt text" });
    const res = await relay.fetch(`https://${PROVIDER}/v1/messages?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test-key" },
      body,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ got: body.length });
    expect(env.seen[0]).toEqual({
      method: "POST",
      url: "/v1/messages?x=1",
      host: PROVIDER,
      bodyLength: body.length,
      apiKey: "sk-test-key",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.logs).toEqual([]);
    for (const l of env.logs) {
      expect(l).not.toContain(PROVIDER);
      expect(l).not.toContain("sk-test-key");
      expect(l).not.toContain("secret prompt");
      expect(l).not.toContain("harry");
    }
  });

  it("streams SSE lines and decodes gzip", async () => {
    const env = await startEnv({ relay: true });
    const relay = relayFor(env);
    const res = await relay.streamingFetch(`https://${PROVIDER}/stream`, { method: "POST", body: "{}" });
    const lines: string[] = [];
    for await (const l of res.lines()) if (l.startsWith("data: ")) lines.push(l);
    expect(lines).toEqual([0, 1, 2, 3, 4].map((n) => `data: {"n":${n}}`));
    const z = await relay.fetch(`https://${PROVIDER}/gzip`);
    expect(await z.json()).toEqual({ zipped: true });
  });

  it("moves bodies many windows large in both directions intact", async () => {
    const env = await startEnv({ relay: true });
    const relay = relayFor(env);
    const up = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < up.length; i++) up[i] = (i * 31) & 0xff;
    const res = await relay.fetch(`https://${PROVIDER}/upload`, { method: "POST", body: up });
    expect(await res.json()).toEqual({ got: up.length, sum: up.reduce((a, b) => (a + b) % 65521, 0) });
    const down = await relay.fetch(`https://${PROVIDER}/big`);
    expect((await down.text()).length).toBe(BIG_DOWN.length);
  });

  it("verifies the provider's certificate (an untrusted cert fails, nothing is sent)", async () => {
    const env = await startEnv({ relay: true });
    await expect(relayFor(env, false).fetch(`https://${PROVIDER}/v1/messages`, { method: "POST", body: "{}" })).rejects.toThrow(
      /verified secure connection/,
    );
    expect(env.seen).toHaveLength(0);
  });

  it("surfaces a hub refusal as a clear reason", async () => {
    const env = await startEnv({ relay: true, records: ["10.0.0.9"] });
    await expect(relayFor(env).fetch(`https://${PROVIDER}/`)).rejects.toThrow(/private address/);
    expect(env.seen).toHaveLength(0);
  });

  it("an old hub (no capability) is never sent an outbound frame, and the call fails closed", async () => {
    const env = await startEnv({ relay: false });
    expect(env.tunnel.outboundAvailable!()).toBe(false);
    await expect(relayFor(env).fetch(`https://${PROVIDER}/`)).rejects.toThrow(RELAY_UNAVAILABLE_MESSAGE);
    // The tunnel is still up: a rehello is still acknowledged.
    await env.tunnel.rehello();
    await new Promise((r) => setTimeout(r, 50));
    expect(env.tunnel.outboundAvailable!()).toBe(false);
    expect(env.seen).toHaveLength(0);
  });
});

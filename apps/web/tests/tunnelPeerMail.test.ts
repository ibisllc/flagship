/**
 * Peer-backup mailboxes through the hub (docs/peer-backup.md §5.3): a box
 * announces a PIK-signed mailbox, an owner POSTs a sealed envelope to
 * /pb/m/<id>, the hub carries it over the tunnel and returns the reply.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { startTunnelClient, type TunnelClient } from "@flagship/server-daemon";
import {
  canonicalPbMailboxAnnounce,
  deriveSTK,
  deriveSWK,
  ed,
  encodePbMailPlaintext,
  mintDevEntitlements,
  openPbMailRequest,
  openPbMailResponse,
  pbGenerateXKeypair,
  pbMailboxEpoch,
  pbMailboxId,
  sealPbMailRequest,
  sealPbMailResponse,
} from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";
import { MailboxRegistry, verifyMailboxAnnouncements } from "../src/tunnel/mailboxRelay.js";
import { registerMailboxRelay } from "../src/routes/mailboxRelayRoute.js";

const SERVER_FQDN = "home.holder.flagship.services";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Env {
  base: string;
  tunnel: TunnelClient;
  mailboxes: MailboxRegistry;
  mailboxId: string;
  close(): Promise<void>;
}

const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

async function startEnv(opts: { forge?: boolean } = {}): Promise<Env> {
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(41) }, SERVER_FQDN);
  const stk = deriveSTK(swk);
  const irkPriv = new Uint8Array(32).fill(8);
  const irk = { privateKey: irkPriv, publicKey: ed.getPublicKey(irkPriv) };
  const pikSeed = new Uint8Array(32).fill(3);
  const pikPubHex = hex(ed.getPublicKey(pikSeed));
  const x = pbGenerateXKeypair();
  const registry = new TunnelRegistry();
  const mailboxes = new MailboxRegistry();
  const app: FastifyInstance = Fastify({ logger: false });
  registerMailboxRelay(app, { mailboxes });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const stopHub = startTunnelHub(app.server, registry, {
    authLookup: (id) => (id === SERVER_FQDN ? stk.publicKey : null),
    irkLookup: (u) => (u === "holder" ? irk.publicKey : null),
    mailboxes,
  });
  const port = (app.server.address() as AddressInfo).port;
  const epoch = pbMailboxEpoch(Date.now());
  const tunnel = startTunnelClient({
    hubUrl: `ws://127.0.0.1:${port}/tunnel`,
    signingKey: stk,
    getEntitlements: () => mintDevEntitlements({ irk, podPubKey: stk.publicKey, username: "holder", podCanonical: SERVER_FQDN }),
    resolveBackend: () => null,
    mailboxAnnouncements: async () => [
      {
        pikPubHex,
        epoch,
        sigHex: hex(ed.sign(canonicalPbMailboxAnnounce(pikPubHex, epoch), opts.forge ? new Uint8Array(32).fill(4) : pikSeed)),
      },
    ],
    // The holder: open the request, answer with its bytes reversed.
    onMail: async (mailboxId, envelope) => {
      const { plaintext, keys } = openPbMailRequest(x.secretKey, mailboxId, envelope);
      return sealPbMailResponse(keys, mailboxId, plaintext.slice().reverse());
    },
  });
  await tunnel.ready();
  const env: Env = {
    base: `http://127.0.0.1:${port}`,
    tunnel,
    mailboxes,
    mailboxId: pbMailboxId(pikPubHex, epoch),
    close: async () => {
      await tunnel.close();
      await stopHub();
      await app.close();
    },
  };
  (env as Env & { xPub: Uint8Array }).xPub = x.publicKey;
  envs.push(env);
  return env;
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("peer-backup mailboxes through the hub", () => {
  it("carries a sealed envelope bigger than a frame to the holder and its reply back", async () => {
    const env = await startEnv();
    await waitFor(() => env.mailboxes.has(env.mailboxId));
    expect(env.mailboxes.has(env.mailboxId)).toBe(true);
    const body = new Uint8Array(1024 * 1024 + 300_007).map((_, i) => (i * 31) & 255);
    const plain = encodePbMailPlaintext({ header: { op: "brick.put" }, body });
    const { envelope, keys } = sealPbMailRequest((env as Env & { xPub: Uint8Array }).xPub, env.mailboxId, plain);
    const res = await fetch(`${env.base}/pb/m/${env.mailboxId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: envelope,
    });
    expect(res.status).toBe(200);
    const reply = openPbMailResponse(keys, env.mailboxId, new Uint8Array(await res.arrayBuffer()));
    expect(reply).toEqual(plain.slice().reverse());
  });

  it("answers 404 for a mailbox nobody announced, and after the tunnel closes", async () => {
    const env = await startEnv();
    await waitFor(() => env.mailboxes.has(env.mailboxId));
    const other = await fetch(`${env.base}/pb/m/${"ab".repeat(16)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(100),
    });
    expect(other.status).toBe(404);
    await env.tunnel.close();
    await waitFor(() => !env.mailboxes.has(env.mailboxId));
    expect(env.mailboxes.has(env.mailboxId)).toBe(false);
  });

  it("ignores an announcement the PIK didn't sign", async () => {
    const env = await startEnv({ forge: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(env.mailboxes.size()).toBe(0);
  });

  it("refuses announcements outside the current epoch window", () => {
    const seed = new Uint8Array(32).fill(5);
    const pik = hex(ed.getPublicKey(seed));
    const now = Date.now();
    const e = pbMailboxEpoch(now);
    const ann = (epoch: number) => ({ pikPubHex: pik, epoch, sigHex: hex(ed.sign(canonicalPbMailboxAnnounce(pik, epoch), seed)) });
    expect(verifyMailboxAnnouncements([ann(e), ann(e + 1)], now)).toEqual([pbMailboxId(pik, e), pbMailboxId(pik, e + 1)]);
    expect(verifyMailboxAnnouncements([ann(e + 5)], now)).toBeNull();
  });
});

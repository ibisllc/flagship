import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { startTunnelClient, type TunnelClient } from "@flagship/server-daemon";
import {
  deriveSTK,
  deriveSWK,
  ed,
  mintDevEntitlements,
  type Keypair,
} from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startTunnelHub, type TunnelHubOptions } from "../src/tunnel/tunnelHub.js";

const HOME_FQDN = "home.alice.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function deriveStkFor(serverFqdn: string, seed: number) {
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(seed) }, serverFqdn);
  return deriveSTK(swk);
}

function hex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

interface Setup {
  app: FastifyInstance;
  registry: TunnelRegistry;
  hubPort: number;
  stopHub: () => Promise<void>;
  irk: Keypair;
}

async function makeHub(
  evictionLookup?: TunnelHubOptions["evictionLookup"],
): Promise<Setup> {
  const registry = new TunnelRegistry();
  const app = Fastify({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const irk = makeKey();
  const stopHub = startTunnelHub(app.server, registry, {
    authLookup: (sid) =>
      sid === HOME_FQDN ? deriveStkFor(HOME_FQDN, 1).publicKey : null,
    irkLookup: (username) => (username === "alice" ? irk.publicKey : null),
    ...(evictionLookup ? { evictionLookup } : {}),
  });
  const hubPort = (app.server.address() as AddressInfo).port;
  return { app, registry, hubPort, stopHub, irk };
}

async function teardown(s: Setup) {
  await s.stopHub();
  await s.app.close();
}

function startClient(args: {
  hubPort: number;
  stk: Keypair;
  irk: Keypair;
}): TunnelClient {
  return startTunnelClient({
    hubUrl: `ws://127.0.0.1:${args.hubPort}/tunnel`,
    signingKey: args.stk,
    getEntitlements: () =>
      mintDevEntitlements({
        irk: args.irk,
        podPubKey: args.stk.publicKey,
        username: "alice",
        podCanonical: HOME_FQDN,
      }),
    resolveBackend: () => null,
  });
}

describe("tunnel hub: graceful-decommission eviction gate (§8)", () => {
  let s: Setup;
  afterEach(async () => {
    if (s) await teardown(s);
  });

  it('rejects an evicted box STK with reason "replaced"', async () => {
    const stk = deriveStkFor(HOME_FQDN, 1);
    const evictedHex = hex(stk.publicKey);
    s = await makeHub(async () => new Set([evictedHex]));
    const t = startClient({ hubPort: s.hubPort, stk, irk: s.irk });
    await expect(t.ready()).rejects.toThrow(/replaced/);
    expect(s.registry.size()).toBe(0);
    await t.close();
  });

  it("registers a NON-evicted STK at the same podCanonical", async () => {
    const stk = deriveStkFor(HOME_FQDN, 1);
    // Eviction chain lists a DIFFERENT (predecessor) STK, not this box.
    const someOtherStk = hex(makeKey().publicKey);
    s = await makeHub(async () => new Set([someOtherStk]));
    const t = startClient({ hubPort: s.hubPort, stk, irk: s.irk });
    await t.ready();
    expect(s.registry.findBySni(HOME_FQDN)).toBeDefined();
    await t.close();
  });

  it("FAILS OPEN when evictionLookup returns null (a .com outage)", async () => {
    const stk = deriveStkFor(HOME_FQDN, 1);
    // null ⇒ couldn't reach .com ⇒ registration must proceed, not brick.
    s = await makeHub(async () => null);
    const t = startClient({ hubPort: s.hubPort, stk, irk: s.irk });
    await t.ready();
    expect(s.registry.findBySni(HOME_FQDN)).toBeDefined();
    await t.close();
  });

  it("consults evictionLookup only AFTER entitlement verification (a forged entitlement fails first)", async () => {
    const stk = deriveStkFor(HOME_FQDN, 1);
    const evictedHex = hex(stk.publicKey);
    let evictionConsulted = false;
    s = await makeHub(async () => {
      evictionConsulted = true;
      return new Set([evictedHex]);
    });
    // Sign the entitlement with the WRONG IRK — the signature check (which
    // runs before the eviction gate) must reject it, and the eviction
    // lookup must never be consulted.
    const wrongIrk = makeKey();
    const t = startClient({ hubPort: s.hubPort, stk, irk: wrongIrk });
    await expect(t.ready()).rejects.toThrow();
    expect(evictionConsulted).toBe(false);
    expect(s.registry.size()).toBe(0);
    await t.close();
  });
});

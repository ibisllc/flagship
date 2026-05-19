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
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";

const HOME_FQDN = "home.alice.flagship.services";
const OFFICE_FQDN = "office.alice.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function deriveStkFor(serverFqdn: string, seed = 1) {
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(seed) }, serverFqdn);
  return deriveSTK(swk);
}

interface Setup {
  app: FastifyInstance;
  registry: TunnelRegistry;
  hubPort: number;
  stopHub: () => Promise<void>;
  irk: Keypair;
}

async function makeHub(opts?: { idleCloseMs?: number }): Promise<Setup> {
  const registry = new TunnelRegistry();
  const app = Fastify({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const irk = makeKey();
  const stopHub = startTunnelHub(app.server, registry, {
    authLookup: (sid) => {
      // map serverId → STK pubkey based on naming convention used in tests
      if (sid === HOME_FQDN) return deriveStkFor(HOME_FQDN, 1).publicKey;
      if (sid === OFFICE_FQDN) return deriveStkFor(OFFICE_FQDN, 2).publicKey;
      return null;
    },
    irkLookup: (username) => (username === "alice" ? irk.publicKey : null),
    idleCloseMs: opts?.idleCloseMs,
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
  podFqdn: string;
  stk: Keypair;
  irk: Keypair;
  serviceCanonicals?: string[];
  onDomainGranted?: (e: { fqdn: string; ownerServerId: string }) => void;
}): TunnelClient {
  return startTunnelClient({
    hubUrl: `ws://127.0.0.1:${args.hubPort}/tunnel`,
    signingKey: args.stk,
    getEntitlements: () =>
      mintDevEntitlements({
        irk: args.irk,
        podPubKey: args.stk.publicKey,
        username: "alice",
        podCanonical: args.podFqdn,
        serviceCanonicals: args.serviceCanonicals,
      }),
    resolveBackend: () => null,
    onDomainGranted: args.onDomainGranted,
  });
}

describe("tunnel hub: per-pod identity + entitlement validation", () => {
  let s: Setup;
  beforeEach(async () => { s = await makeHub(); });
  afterEach(async () => { await teardown(s); });

  it("rejects when the IRK signature is from a different IRK than the lookup says", async () => {
    const wrongIrk = makeKey();
    const stk = deriveStkFor(HOME_FQDN, 1);
    const t = startClient({
      hubPort: s.hubPort,
      podFqdn: HOME_FQDN,
      stk,
      irk: wrongIrk, // signs with the wrong IRK
    });
    await expect(t.ready()).rejects.toThrow();
    await t.close();
  });

  it("accepts a properly-signed entitlement and registers the pod", async () => {
    const stk = deriveStkFor(HOME_FQDN, 1);
    const t = startClient({
      hubPort: s.hubPort,
      podFqdn: HOME_FQDN,
      stk,
      irk: s.irk,
      serviceCanonicals: ["notes.home.alice.flagship.services"],
    });
    await t.ready();
    expect(s.registry.findBySni(HOME_FQDN)).toBeDefined();
    expect(s.registry.findBySni("notes.home.alice.flagship.services")).toBeDefined();
    expect(s.registry.findBySni("notes.alice.flagship.services")).toBeDefined();
    await t.close();
  });
});

describe("tunnel hub: FCFS allocation", () => {
  let s: Setup;
  beforeEach(async () => { s = await makeHub({ idleCloseMs: 500 }); });
  afterEach(async () => { await teardown(s); });

  it("first-come-first-served on user-zone shortened: second pod doesn't displace first", async () => {
    const homeStk = deriveStkFor(HOME_FQDN, 1);
    const officeStk = deriveStkFor(OFFICE_FQDN, 2);
    const home = startClient({
      hubPort: s.hubPort,
      podFqdn: HOME_FQDN,
      stk: homeStk,
      irk: s.irk,
      serviceCanonicals: ["notes.home.alice.flagship.services"],
    });
    await home.ready();
    const office = startClient({
      hubPort: s.hubPort,
      podFqdn: OFFICE_FQDN,
      stk: officeStk,
      irk: s.irk,
      serviceCanonicals: ["notes.office.alice.flagship.services"],
    });
    await office.ready();
    const holder = s.registry.findBySni("notes.alice.flagship.services");
    expect(holder?.podCanonical).toBe(HOME_FQDN); // first wins
    await home.close();
    await office.close();
  });

  it("socket death redistributes the orphaned slot to the survivor", async () => {
    const homeStk = deriveStkFor(HOME_FQDN, 1);
    const officeStk = deriveStkFor(OFFICE_FQDN, 2);
    const home = startClient({
      hubPort: s.hubPort,
      podFqdn: HOME_FQDN,
      stk: homeStk,
      irk: s.irk,
      serviceCanonicals: ["notes.home.alice.flagship.services"],
    });
    await home.ready();
    const office = startClient({
      hubPort: s.hubPort,
      podFqdn: OFFICE_FQDN,
      stk: officeStk,
      irk: s.irk,
      serviceCanonicals: ["notes.office.alice.flagship.services"],
    });
    await office.ready();
    expect(s.registry.findBySni("notes.alice.flagship.services")?.podCanonical).toBe(HOME_FQDN);
    await home.close();
    await waitFor(
      () => s.registry.findBySni("notes.alice.flagship.services")?.podCanonical === OFFICE_FQDN,
    );
    await office.close();
  });
});

async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  const timeout = opts.timeoutMs ?? 2_000;
  const step = opts.stepMs ?? 20;
  while (!cond()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, step));
  }
}

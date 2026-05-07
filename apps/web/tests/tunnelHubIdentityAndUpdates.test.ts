import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { startTunnelClient, type TunnelClient } from "@flagship/server-daemon";
import { deriveSTK, deriveSWK } from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";

const ALICE_FQDN = "home.alice.flagship.services";
const BOB_FQDN = "home.bob.flagship.services";

function deriveStkFor(serverFqdn: string, seed = 1) {
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(seed) }, serverFqdn);
  return deriveSTK(swk);
}

interface Setup {
  app: FastifyInstance;
  registry: TunnelRegistry;
  hubPort: number;
  stopHub: () => Promise<void>;
  authLookups: Map<string, Uint8Array>;
}

async function makeHub(opts?: { idleCloseMs?: number }): Promise<Setup> {
  const registry = new TunnelRegistry();
  const app = Fastify({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const authLookups = new Map<string, Uint8Array>();
  const stopHub = startTunnelHub(app.server, registry, {
    authLookup: (sid) => authLookups.get(sid) ?? null,
    idleCloseMs: opts?.idleCloseMs,
  });
  const hubPort = (app.server.address() as AddressInfo).port;
  return { app, registry, hubPort, stopHub, authLookups };
}

async function teardown(s: Setup) {
  await s.stopHub();
  await s.app.close();
}

describe("tunnel hub: per-pod identity check", () => {
  let s: Setup;
  beforeEach(async () => {
    s = await makeHub();
  });
  afterEach(async () => {
    await teardown(s);
  });

  it("rejects a HELLO whose serverId doesn't end in <user>.flagship.services", async () => {
    const stk = deriveStkFor("srv-test");
    s.authLookups.set("srv-test", stk.publicKey);
    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: "srv-test",
      controlledDomains: ["app.flagship.services"],
      signingKey: stk,
      resolveBackend: () => null,
    });
    await expect(t.ready()).rejects.toThrow();
    await t.close();
  });

  it("rejects an FQDN whose middle label doesn't match the pod's username", async () => {
    const stk = deriveStkFor(ALICE_FQDN);
    s.authLookups.set(ALICE_FQDN, stk.publicKey);
    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      // Trying to claim something under bob's zone — must fail.
      controlledDomains: ["app.bob.flagship.services"],
      signingKey: stk,
      resolveBackend: () => null,
    });
    await expect(t.ready()).rejects.toThrow(/zone/);
    await t.close();
  });

  it("accepts FQDNs under the pod's own user zone", async () => {
    const stk = deriveStkFor(ALICE_FQDN);
    s.authLookups.set(ALICE_FQDN, stk.publicKey);
    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      controlledDomains: [ALICE_FQDN, `*.${ALICE_FQDN}`, "notes.alice.flagship.services"],
      signingKey: stk,
      resolveBackend: () => null,
    });
    await t.ready();
    expect(s.registry.findBySni(ALICE_FQDN)).toBeDefined();
    expect(s.registry.findBySni("notes.alice.flagship.services")).toBeDefined();
    expect(s.registry.findBySni("any.home.alice.flagship.services")).toBeDefined();
    await t.close();
  });
});

describe("tunnel hub: HELLO updates and last-HELLO-wins", () => {
  let s: Setup;
  beforeEach(async () => {
    s = await makeHub({ idleCloseMs: 500 });
  });
  afterEach(async () => {
    await teardown(s);
  });

  it("updateControlledDomains atomically replaces the route table", async () => {
    const stk = deriveStkFor(ALICE_FQDN);
    s.authLookups.set(ALICE_FQDN, stk.publicKey);
    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      controlledDomains: [ALICE_FQDN, "a.alice.flagship.services"],
      signingKey: stk,
      resolveBackend: () => null,
    });
    await t.ready();
    expect(s.registry.findBySni("a.alice.flagship.services")).toBeDefined();

    t.updateControlledDomains([ALICE_FQDN, "b.alice.flagship.services"]);
    await waitFor(() => s.registry.findBySni("a.alice.flagship.services") === undefined);
    expect(s.registry.findBySni("b.alice.flagship.services")).toBeDefined();
    await t.close();
  });

  it("a second tunnel takes over an FQDN held by the first (last-HELLO-wins)", async () => {
    const stk1 = deriveStkFor(ALICE_FQDN, 1);
    s.authLookups.set(ALICE_FQDN, stk1.publicKey);
    const t1 = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      controlledDomains: ["x.alice.flagship.services"],
      signingKey: stk1,
      resolveBackend: () => null,
    });
    await t1.ready();
    const tunnel1 = s.registry.findBySni("x.alice.flagship.services");
    expect(tunnel1).toBeDefined();

    // Different pod (different serverId) under the same user, with its own STK.
    const ALICE_FQDN2 = "office.alice.flagship.services";
    const stk2 = deriveStkFor(ALICE_FQDN2, 2);
    s.authLookups.set(ALICE_FQDN2, stk2.publicKey);
    const t2 = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN2,
      controlledDomains: ["x.alice.flagship.services"],
      signingKey: stk2,
      resolveBackend: () => null,
    });
    await t2.ready();
    await waitFor(
      () => s.registry.findBySni("x.alice.flagship.services") !== tunnel1,
    );
    const winner = s.registry.findBySni("x.alice.flagship.services");
    expect(winner?.serverId).toBe(ALICE_FQDN2);
    await t1.close();
    await t2.close();
  });

  it("idle-closes a tunnel whose HELLO update leaves the list empty", async () => {
    const stk = deriveStkFor(ALICE_FQDN);
    s.authLookups.set(ALICE_FQDN, stk.publicKey);
    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      controlledDomains: [ALICE_FQDN],
      signingKey: stk,
      resolveBackend: () => null,
    });
    await t.ready();
    expect(s.registry.size()).toBe(1);
    t.updateControlledDomains([]);
    // idleCloseMs=500 in the harness; give it a generous window.
    await waitFor(() => s.registry.size() === 0, { timeoutMs: 3_000 });
    await t.close();
  });
});

describe("tunnel hub: domain-granted broadcast (FRAME 0x12)", () => {
  let s: Setup;
  beforeEach(async () => {
    s = await makeHub({ idleCloseMs: 500 });
  });
  afterEach(async () => {
    await teardown(s);
  });

  it("notifies every connected tunnel — including the new owner — when a domain is granted", async () => {
    // First tunnel claims x. Capture its received grants.
    const stk1 = deriveStkFor(ALICE_FQDN, 1);
    s.authLookups.set(ALICE_FQDN, stk1.publicKey);
    const aliceGrants: Array<{ fqdn: string; ownerServerId: string }> = [];
    const t1 = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      controlledDomains: ["x.alice.flagship.services"],
      signingKey: stk1,
      resolveBackend: () => null,
      onDomainGranted: (e) => aliceGrants.push(e),
    });
    await t1.ready();
    // First tunnel should hear about its own grant of x.
    await waitFor(() =>
      aliceGrants.some(
        (g) =>
          g.fqdn === "x.alice.flagship.services" &&
          g.ownerServerId === ALICE_FQDN,
      ),
    );

    // Second tunnel arrives and claims y under the same user.
    const ALICE_FQDN2 = "office.alice.flagship.services";
    const stk2 = deriveStkFor(ALICE_FQDN2, 2);
    s.authLookups.set(ALICE_FQDN2, stk2.publicKey);
    const officeGrants: Array<{ fqdn: string; ownerServerId: string }> = [];
    const t2 = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN2,
      controlledDomains: ["y.alice.flagship.services"],
      signingKey: stk2,
      resolveBackend: () => null,
      onDomainGranted: (e) => officeGrants.push(e),
    });
    await t2.ready();

    // Both tunnels should now have received the y → office grant.
    await waitFor(() =>
      aliceGrants.some(
        (g) =>
          g.fqdn === "y.alice.flagship.services" &&
          g.ownerServerId === ALICE_FQDN2,
      ),
    );
    await waitFor(() =>
      officeGrants.some(
        (g) =>
          g.fqdn === "y.alice.flagship.services" &&
          g.ownerServerId === ALICE_FQDN2,
      ),
    );
    await t1.close();
    await t2.close();
  });

  it("a HELLO update with new fqdns triggers fresh grant broadcasts", async () => {
    const stk = deriveStkFor(ALICE_FQDN);
    s.authLookups.set(ALICE_FQDN, stk.publicKey);
    const grants: Array<{ fqdn: string; ownerServerId: string }> = [];
    const t = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${s.hubPort}/tunnel`,
      serverId: ALICE_FQDN,
      controlledDomains: [ALICE_FQDN],
      signingKey: stk,
      resolveBackend: () => null,
      onDomainGranted: (e) => grants.push(e),
    });
    await t.ready();
    grants.length = 0;
    t.updateControlledDomains([ALICE_FQDN, "z.alice.flagship.services"]);
    await waitFor(() =>
      grants.some(
        (g) =>
          g.fqdn === "z.alice.flagship.services" &&
          g.ownerServerId === ALICE_FQDN,
      ),
    );
    await t.close();
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

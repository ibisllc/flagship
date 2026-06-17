/**
 * End-to-end relay-blessing wire test (task #5): a real hub with a
 * blessingSource attaches the ServiceBlessing + a hubSig over the box's
 * HELLO nonce on HELLO_ACK; the box's tunnel client surfaces them via
 * onHelloAckTrust, and the hubSig verifies against the hub key over the
 * SAME nonce the box sent. OBSERVE: the box still becomes ready (registers).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { startTunnelClient, type TunnelClient } from "@flagship/server-daemon";
import {
  deriveSTK,
  deriveSWK,
  ed,
  mintDevEntitlements,
  signServiceBlessing,
  type Keypair,
  type ServiceBlessing,
} from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startTunnelHub, type RelayBlessingSource } from "../src/tunnel/tunnelHub.js";

const HOME_FQDN = "home.alice.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function deriveStkFor(serverFqdn: string, seed = 1) {
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(seed) }, serverFqdn);
  return deriveSTK(swk);
}
function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

describe("relay blessing — hub attaches it on HELLO_ACK (e2e)", () => {
  let app: FastifyInstance;
  let registry: TunnelRegistry;
  let stopHub: () => Promise<void>;
  let hubPort: number;
  let irk: Keypair;
  let client: TunnelClient | null = null;

  // The hub's self-key + a .com-CA-signed blessing over it.
  const hubKeyPriv = ed.utils.randomPrivateKey();
  const hubKeyPub = ed.getPublicKey(hubKeyPriv);
  const caPriv = new Uint8Array(32).fill(0xca);
  const caPub = ed.getPublicKey(caPriv);
  const blessing: ServiceBlessing = signServiceBlessing(
    {
      hubKeyPub: hex(hubKeyPub),
      hubHost: "flagship.services",
      nonce: "n1",
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 26 * 60 * 60_000,
    },
    { privateKey: caPriv, publicKey: caPub },
  );
  const blessingSource: RelayBlessingSource = {
    currentBlessing: () => blessing,
    signNonce: (nonce) => hex(ed.sign(nonce, hubKeyPriv)),
  };

  beforeEach(async () => {
    registry = new TunnelRegistry();
    app = Fastify({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    irk = makeKey();
    stopHub = startTunnelHub(app.server, registry, {
      authLookup: (sid) => (sid === HOME_FQDN ? deriveStkFor(HOME_FQDN, 1).publicKey : null),
      irkLookup: (u) => (u === "alice" ? irk.publicKey : null),
      blessingSource,
    });
    hubPort = (app.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    if (client) await client.close();
    await stopHub();
    await app.close();
  });

  it("delivers a blessing + a hubSig that verifies over the box nonce; box still registers", async () => {
    const stk = deriveStkFor(HOME_FQDN, 1);
    let trust: { serviceBlessing: unknown; hubSig?: string; nonce: Uint8Array } | null = null;
    client = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: stk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: stk.publicKey,
          username: "alice",
          podCanonical: HOME_FQDN,
        }),
      resolveBackend: () => null,
      onHelloAckTrust: (e) => {
        trust = e;
      },
    });
    await client.ready(); // OBSERVE: registers despite the new trust path
    expect(registry.findBySni(HOME_FQDN)).toBeDefined();

    expect(trust).not.toBeNull();
    const got = trust!.serviceBlessing as ServiceBlessing;
    expect(got.hubKeyPub).toBe(hex(hubKeyPub));
    expect(trust!.hubSig).toBeDefined();
    // The hubSig verifies against the hub key over the box's HELLO nonce —
    // proof-of-possession over the very nonce this box generated.
    const sig = Buffer.from(trust!.hubSig!, "hex");
    expect(ed.verify(sig, trust!.nonce, hubKeyPub)).toBe(true);
  });
});

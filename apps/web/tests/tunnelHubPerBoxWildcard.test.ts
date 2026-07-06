/**
 * A′ per-box wildcard claims at the tunnel hub (cert-model migration).
 *
 * Under A′ a box claims `[<server>.<user>.flagship.services,
 * *.<server>.<user>.flagship.services]` — its own canonical plus its
 * own per-box wildcard, matching the wildcard cert it mints. The hub:
 *   - ACCEPTS `*.<podCanonical>` and consumes it (routing for
 *     `<service>.<podCanonical>` rides the registry's one-label-strip
 *     fallback to the pod canonical — same one-label scope as the cert);
 *   - REJECTS any other wildcard claim (the retired user-zone
 *     `*.<user>`, another box's `*.<server>.<user>`) so no box can
 *     widen its routing past its own IRK+STK-verified name;
 *   - keeps tier-2 `<service>.<user>` resolution on the slot
 *     allocator, which never depended on any wildcard claim.
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
  type Keypair,
  type ServiceEntitlement,
  type ServiceGrant,
} from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { buildClaimedCanonicals, startTunnelHub } from "../src/tunnel/tunnelHub.js";

const HOME_FQDN = "home.alice.flagship.services";
const OFFICE_FQDN = "office.alice.flagship.services";
const HOME_WILDCARD = "*.home.alice.flagship.services";
const USER_WILDCARD = "*.alice.flagship.services";
const APP_HOME = "photos.home.alice.flagship.services";
const SHORTENED = "photos.alice.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function deriveStkFor(fqdn: string, seed: number): Keypair {
  return deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(seed) }, fqdn));
}

describe("buildClaimedCanonicals — A′ wildcard claim validation", () => {
  const PC = HOME_FQDN;

  function entitlement(canonicals: string[]): ServiceEntitlement {
    return {
      username: "alice",
      podPubKey: new Uint8Array(32),
      canonicals,
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }

  it("accepts and consumes the pod's own per-box wildcard", () => {
    const r = buildClaimedCanonicals(PC, entitlement([APP_HOME, HOME_WILDCARD]), [], "alice");
    expect(r).toEqual({ ok: true, canonicals: [PC, APP_HOME] });
  });

  it("rejects the user-zone wildcard", () => {
    const r = buildClaimedCanonicals(PC, entitlement([USER_WILDCARD]), [], "alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/wildcard claim/);
  });

  it("rejects another box's per-box wildcard", () => {
    const r = buildClaimedCanonicals(PC, entitlement([`*.${OFFICE_FQDN}`]), [], "alice");
    expect(r.ok).toBe(false);
  });

  it("rejects a non-leading '*' anywhere in a claim", () => {
    const r = buildClaimedCanonicals(
      PC,
      entitlement(["notes.*.alice.flagship.services"]),
      [],
      "alice",
    );
    expect(r.ok).toBe(false);
  });

  it("validated grant route hosts join the union; the own-wildcard host is consumed", () => {
    const grant: ServiceGrant = {
      grantId: "g1",
      username: "alice",
      serviceCanonical: APP_HOME,
      serverDomains: [HOME_FQDN],
      serverIdentities: [],
      routes: [
        { url: `${APP_HOME}/`, scope: "canonical" },
        { url: `${HOME_WILDCARD}/`, scope: "non-canonical" },
      ],
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const r = buildClaimedCanonicals(PC, null, [grant], "alice");
    expect(r).toEqual({ ok: true, canonicals: [PC, APP_HOME] });
  });

  it("rejects a non-wildcard canonical in another user's zone (cross-zone hijack)", () => {
    // A self-consistent service entitlement that names a FQDN in
    // bob's zone must be rejected: alice's box may never claim
    // routing for bob.
    const r = buildClaimedCanonicals(
      PC,
      entitlement(["photos.bob.flagship.services"]),
      [],
      "alice",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/foreign-zone/);
  });

  it("accepts both the hierarchical and the tier-2 canonical in the pod's own zone", () => {
    const r = buildClaimedCanonicals(
      PC,
      entitlement([APP_HOME, SHORTENED]),
      [],
      "alice",
    );
    expect(r).toEqual({ ok: true, canonicals: [PC, APP_HOME, SHORTENED] });
  });
});

describe("tunnel hub — A′ per-box wildcard claims (end-to-end)", () => {
  let app: FastifyInstance;
  let registry: TunnelRegistry;
  let stopHub: () => Promise<void>;
  let hubPort: number;
  let irk: Keypair;
  const clients: TunnelClient[] = [];

  beforeEach(async () => {
    registry = new TunnelRegistry();
    app = Fastify({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    irk = makeKey();
    const homeStk = deriveStkFor(HOME_FQDN, 1);
    const officeStk = deriveStkFor(OFFICE_FQDN, 2);
    stopHub = startTunnelHub(app.server, registry, {
      authLookup: (sid) => {
        if (sid === HOME_FQDN) return homeStk.publicKey;
        if (sid === OFFICE_FQDN) return officeStk.publicKey;
        return null;
      },
      irkLookup: (u) => (u === "alice" ? irk.publicKey : null),
    });
    hubPort = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    await stopHub();
    await app.close();
  });

  function connect(args: {
    podFqdn: string;
    seed: number;
    serviceCanonicals: () => string[];
  }): TunnelClient {
    const stk = deriveStkFor(args.podFqdn, args.seed);
    const c = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: stk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: stk.publicKey,
          username: "alice",
          podCanonical: args.podFqdn,
          serviceCanonicals: args.serviceCanonicals(),
        }),
      resolveBackend: () => null,
    });
    clients.push(c);
    return c;
  }

  it("a box claiming [<canonical>, *.<canonical>] registers and receives hierarchical service SNI", async () => {
    const home = connect({
      podFqdn: HOME_FQDN,
      seed: 1,
      serviceCanonicals: () => [APP_HOME, HOME_WILDCARD],
    });
    await home.ready();
    const pod = registry.findBySni(HOME_FQDN);
    expect(pod?.podCanonical).toBe(HOME_FQDN);
    // Tier 1: <service>.<server>.<user> — the per-box wildcard's scope.
    expect(registry.findBySni("notes.home.alice.flagship.services")?.podCanonical).toBe(HOME_FQDN);
    expect(registry.findBySni(APP_HOME)?.podCanonical).toBe(HOME_FQDN);
    // Tier 2: <service>.<user> still resolves via the slot allocator.
    expect(registry.findBySni(SHORTENED)?.podCanonical).toBe(HOME_FQDN);
    // The wildcard never registers as a literal, and a literal-`*`
    // SNI never resolves.
    expect(registry.findBySni(HOME_WILDCARD)).toBeUndefined();
    // Two labels deep is outside the per-box wildcard's (and cert's) scope.
    expect(registry.findBySni("a.notes.home.alice.flagship.services")).toBeUndefined();
  });

  it("rejects a HELLO claiming the user-zone wildcard (no hijack surface)", async () => {
    const office = connect({
      podFqdn: OFFICE_FQDN,
      seed: 2,
      serviceCanonicals: () => [USER_WILDCARD],
    });
    await expect(office.ready()).rejects.toThrow(/wildcard claim/);
    expect(registry.size()).toBe(0);
  });

  it("rejects a HELLO claiming another box's per-box wildcard", async () => {
    const home = connect({
      podFqdn: HOME_FQDN,
      seed: 1,
      serviceCanonicals: () => [APP_HOME],
    });
    await home.ready();
    const office = connect({
      podFqdn: OFFICE_FQDN,
      seed: 2,
      serviceCanonicals: () => [HOME_WILDCARD],
    });
    await expect(office.ready()).rejects.toThrow(/wildcard claim/);
    // Home's traffic is untouched.
    expect(registry.findBySni("notes.home.alice.flagship.services")?.podCanonical).toBe(HOME_FQDN);
    expect(registry.size()).toBe(1);
  });

  it("rejects a wildcard podCanonical outright (claim ≠ identity)", async () => {
    const wildStk = deriveStkFor(USER_WILDCARD, 3);
    const c = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: wildStk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: wildStk.publicKey,
          username: "alice",
          podCanonical: USER_WILDCARD,
        }),
      resolveBackend: () => null,
    });
    clients.push(c);
    await expect(c.ready()).rejects.toThrow(/not a valid pod name under the data-plane apex/);
    expect(registry.size()).toBe(0);
  });

  it("HELLO update: a foreign wildcard is nacked and leaves the prior registration intact", async () => {
    let canonicals = [APP_HOME, HOME_WILDCARD];
    const home = connect({
      podFqdn: HOME_FQDN,
      seed: 1,
      serviceCanonicals: () => canonicals,
    });
    await home.ready();
    expect(registry.findBySni(SHORTENED)?.podCanonical).toBe(HOME_FQDN);

    // Bad update: tries to add a service AND the user-zone wildcard.
    canonicals = ["music.home.alice.flagship.services", USER_WILDCARD];
    await home.rehello();
    // Good update afterwards proves the hub is still serving us and
    // gives a deterministic point to assert the bad one was dropped.
    canonicals = [APP_HOME, "video.home.alice.flagship.services", HOME_WILDCARD];
    await home.rehello();
    await waitFor(
      () => registry.findBySni("video.alice.flagship.services")?.podCanonical === HOME_FQDN,
      1000,
    );
    // The rejected update's slot never materialized.
    expect(registry.findBySni("music.alice.flagship.services")).toBeUndefined();
    expect(registry.findBySni(SHORTENED)?.podCanonical).toBe(HOME_FQDN);
  });
});

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

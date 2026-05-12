/**
 * Tunnel-hub failover priority registry tests (#87).
 *
 * The hub's allocator now tracks a per-slot priority queue:
 *   - first pod to claim an FQDN becomes head (active)
 *   - subsequent pods queue at the tail
 *   - head disconnect promotes the next entry
 *   - explicit `requestTransfer` is the ONE place a tail can preempt
 *
 * The tests cover both the standalone allocator semantics and the
 * end-to-end behavior through the WS tunnel hub.
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
} from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";
import { AppUserAllocator } from "../src/tunnel/allocator.js";

const HOME_FQDN = "home.alice.flagship.services";
const OFFICE_FQDN = "office.alice.flagship.services";
const TRAVEL_FQDN = "travel.alice.flagship.services";
const APP_HOME = "photos.home.alice.flagship.services";
const APP_OFFICE = "photos.office.alice.flagship.services";
const APP_TRAVEL = "photos.travel.alice.flagship.services";
const SHORTENED = "photos.alice.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function deriveStkFor(fqdn: string, seed: number): Keypair {
  return deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(seed) }, fqdn));
}

describe("AppUserAllocator — per-slot priority queue (#87)", () => {
  it("first pod to claim becomes head; second pod queues at tail without preempting", () => {
    const al = new AppUserAllocator();
    al.addPod({ podCanonical: HOME_FQDN, canonicals: [APP_HOME] });
    al.addPod({ podCanonical: OFFICE_FQDN, canonicals: [APP_OFFICE] });
    const set = { slug: "photos", author: "alice", user: "alice" };
    expect(al.candidatesFor(set, SHORTENED)).toEqual([HOME_FQDN, OFFICE_FQDN]);
    // The HOLDER stays the head — HOME — even though OFFICE just registered.
    const snap = al.snapshotByKey(set)!;
    const slot = snap.slotHolders.find((s) => s.fqdn === SHORTENED);
    expect(slot?.podCanonical).toBe(HOME_FQDN);
  });

  it("head disconnect promotes next in queue (active-passive failover)", () => {
    const al = new AppUserAllocator();
    al.addPod({ podCanonical: HOME_FQDN, canonicals: [APP_HOME] });
    al.addPod({ podCanonical: OFFICE_FQDN, canonicals: [APP_OFFICE] });
    al.addPod({ podCanonical: TRAVEL_FQDN, canonicals: [APP_TRAVEL] });
    const set = { slug: "photos", author: "alice", user: "alice" };
    expect(al.candidatesFor(set, SHORTENED)).toEqual([
      HOME_FQDN,
      OFFICE_FQDN,
      TRAVEL_FQDN,
    ]);
    // Head leaves; OFFICE promotes.
    const removal = al.removePod(HOME_FQDN);
    expect(removal.redistributed).toContainEqual({
      fqdn: SHORTENED,
      from: HOME_FQDN,
      to: OFFICE_FQDN,
    });
    expect(al.candidatesFor(set, SHORTENED)).toEqual([
      OFFICE_FQDN,
      TRAVEL_FQDN,
    ]);
    // Next disconnect promotes TRAVEL.
    al.removePod(OFFICE_FQDN);
    expect(al.candidatesFor(set, SHORTENED)).toEqual([TRAVEL_FQDN]);
    const after = al.snapshotByKey(set)!;
    expect(
      after.slotHolders.find((s) => s.fqdn === SHORTENED)?.podCanonical,
    ).toBe(TRAVEL_FQDN);
  });

  it("reconnect of a previously-disconnected pod rejoins at the TAIL", () => {
    const al = new AppUserAllocator();
    al.addPod({ podCanonical: HOME_FQDN, canonicals: [APP_HOME] });
    al.addPod({ podCanonical: OFFICE_FQDN, canonicals: [APP_OFFICE] });
    const set = { slug: "photos", author: "alice", user: "alice" };
    al.removePod(HOME_FQDN);
    expect(al.candidatesFor(set, SHORTENED)).toEqual([OFFICE_FQDN]);
    // HOME reconnects — joins at tail. OFFICE stays head (no flap on
    // a pod that briefly disconnects).
    al.addPod({ podCanonical: HOME_FQDN, canonicals: [APP_HOME] });
    expect(al.candidatesFor(set, SHORTENED)).toEqual([OFFICE_FQDN, HOME_FQDN]);
  });

  it("explicit transfer is the ONE preemption: tail moves to head and becomes holder", () => {
    const al = new AppUserAllocator();
    al.addPod({ podCanonical: HOME_FQDN, canonicals: [APP_HOME] });
    al.addPod({ podCanonical: OFFICE_FQDN, canonicals: [APP_OFFICE] });
    al.addPod({ podCanonical: TRAVEL_FQDN, canonicals: [APP_TRAVEL] });
    const set = { slug: "photos", author: "alice", user: "alice" };
    expect(al.candidatesFor(set, SHORTENED)[0]).toBe(HOME_FQDN);
    // Phone tells TRAVEL it can take SHORTENED.
    const r = al.requestTransfer({ podCanonical: TRAVEL_FQDN, fqdn: SHORTENED });
    expect(r).toMatchObject({ ok: true, previousHolder: HOME_FQDN });
    expect(al.candidatesFor(set, SHORTENED)[0]).toBe(TRAVEL_FQDN);
    const snap = al.snapshotByKey(set)!;
    expect(
      snap.slotHolders.find((s) => s.fqdn === SHORTENED)?.podCanonical,
    ).toBe(TRAVEL_FQDN);
  });

  it("dropping a non-head pod doesn't touch the slot holder or other queue entries", () => {
    const al = new AppUserAllocator();
    al.addPod({ podCanonical: HOME_FQDN, canonicals: [APP_HOME] });
    al.addPod({ podCanonical: OFFICE_FQDN, canonicals: [APP_OFFICE] });
    al.addPod({ podCanonical: TRAVEL_FQDN, canonicals: [APP_TRAVEL] });
    const set = { slug: "photos", author: "alice", user: "alice" };
    const before = al.snapshotByKey(set)!;
    al.removePod(OFFICE_FQDN);
    const after = al.snapshotByKey(set)!;
    expect(after.slotHolders.find((s) => s.fqdn === SHORTENED)?.podCanonical).toBe(
      before.slotHolders.find((s) => s.fqdn === SHORTENED)?.podCanonical,
    );
    expect(al.candidatesFor(set, SHORTENED)).toEqual([HOME_FQDN, TRAVEL_FQDN]);
  });
});

describe("Tunnel hub — failover priority (#87, end-to-end)", () => {
  let app: FastifyInstance;
  let registry: TunnelRegistry;
  let stopHub: () => Promise<void>;
  let hubPort: number;
  let irk: Keypair;

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
    await stopHub();
    await app.close();
  });

  it("two pods HELLO same SNI: first stays head; first disconnects → second promotes", async () => {
    const homeStk = deriveStkFor(HOME_FQDN, 1);
    const officeStk = deriveStkFor(OFFICE_FQDN, 2);
    const home = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: homeStk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: homeStk.publicKey,
          username: "alice",
          podCanonical: HOME_FQDN,
          appCanonicals: [APP_HOME],
        }),
      resolveBackend: () => null,
    });
    await home.ready();
    // HOME is head of SHORTENED.
    expect(
      registry.findBySni(SHORTENED)?.podCanonical,
    ).toBe(HOME_FQDN.toLowerCase());

    // OFFICE joins next — head doesn't change.
    const office = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: officeStk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: officeStk.publicKey,
          username: "alice",
          podCanonical: OFFICE_FQDN,
          appCanonicals: [APP_OFFICE],
        }),
      resolveBackend: () => null,
    });
    await office.ready();
    expect(
      registry.findBySni(SHORTENED)?.podCanonical,
    ).toBe(HOME_FQDN.toLowerCase());

    // HOME disconnects — OFFICE promotes.
    await home.close();
    await waitFor(
      () => registry.findBySni(SHORTENED)?.podCanonical === OFFICE_FQDN.toLowerCase(),
      1000,
    );
    expect(
      registry.findBySni(SHORTENED)?.podCanonical,
    ).toBe(OFFICE_FQDN.toLowerCase());
    await office.close();
  });

  it("reconnect after disconnect rejoins at the tail; original head does NOT preempt", async () => {
    const homeStk = deriveStkFor(HOME_FQDN, 1);
    const officeStk = deriveStkFor(OFFICE_FQDN, 2);
    const home1 = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: homeStk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: homeStk.publicKey,
          username: "alice",
          podCanonical: HOME_FQDN,
          appCanonicals: [APP_HOME],
        }),
      resolveBackend: () => null,
    });
    await home1.ready();
    const office = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: officeStk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: officeStk.publicKey,
          username: "alice",
          podCanonical: OFFICE_FQDN,
          appCanonicals: [APP_OFFICE],
        }),
      resolveBackend: () => null,
    });
    await office.ready();
    await home1.close();
    await waitFor(
      () => registry.findBySni(SHORTENED)?.podCanonical === OFFICE_FQDN.toLowerCase(),
      1000,
    );
    // HOME reconnects — must NOT preempt OFFICE.
    const home2 = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${hubPort}/tunnel`,
      signingKey: homeStk,
      getEntitlements: () =>
        mintDevEntitlements({
          irk,
          podPubKey: homeStk.publicKey,
          username: "alice",
          podCanonical: HOME_FQDN,
          appCanonicals: [APP_HOME],
        }),
      resolveBackend: () => null,
    });
    await home2.ready();
    // Give the hub a chance to reprocess any HELLO updates.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      registry.findBySni(SHORTENED)?.podCanonical,
    ).toBe(OFFICE_FQDN.toLowerCase());
    await home2.close();
    await office.close();
  });
});

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

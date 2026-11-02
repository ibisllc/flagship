// The relay-mesh group's sims (lib/boxSim.ts mesh mode, lib/meshSim.ts) against two TS mesh relays in process, wired as
// start() wires them (wireMeshRelay) on the mock feed of apps/web/tests/support/meshFixture.ts: the sim box attaches,
// a visitor through the other relay reaches it with its bytes verbatim, it follows a co-locate hint make-before-break,
// and MeshSimRelay bridges in, sees the box announced, has its forged attachment refused and its query flood answered busy.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ed, emptyMoveHintRateState, signRelayMeshRecord, type BoxAttachment } from "@flagship/protocol";
import { TunnelRegistry } from "../../../apps/web/src/tunnel/registry.js";
import { MeshNode } from "../../../apps/web/src/tunnel/mesh/node.js";
import { RelayBlessingProvider } from "../../../apps/web/src/tunnel/hubBlessingProvider.js";
import { wireMeshRelay } from "../../../apps/web/src/server.js";
import { APEX, hex, keypair, MeshFixture, type FixtureRelay } from "../../../apps/web/tests/support/meshFixture.js";
import { moveSimBox, RawVisitor, simAnswer, simHelloPayload, SimBox, withMeshCapability, type SimServer } from "../lib/boxSim.js";
import { caKeysOf, MeshSimRelay, parseEndpointRelays, simRelayFromEnv, type GymRelay } from "../lib/meshSim.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe("meshSim pure parts", () => {
  it("parses the endpoints' relays (sorted, an address required, the direct name defaulted)", () => {
    const r = parseEndpointRelays(
      { relays: [{ relayId: "gym-b", ipv6: ["2a09::1"] }, { relayId: "gym-a", tunnelHost: "GYM-A.tunnel.gym.x", ipv4: ["1.2.3.4"] }, { relayId: "gym-c" }, { relayId: "Bad" }] },
      "gym.x",
    );
    expect(r.map((x) => [x.relayId, x.ip, x.tunnelHost, x.base])).toEqual([
      ["gym-a", "1.2.3.4", "gym-a.tunnel.gym.x", "https://gym-a.tunnel.gym.x:8443"],
      ["gym-b", "2a09::1", "gym-b.tunnel.gym.x", "https://gym-b.tunnel.gym.x:8443"],
    ]);
    expect(parseEndpointRelays({ tunnelHub: "x" })).toEqual([]);
  });

  it("takes the CA keys a directory names, and the sim key only from a well-formed env", () => {
    expect(caKeysOf({ signedBy: "AA", signatures: [{ pubkey: "bb" }, { pubkey: "aa" }] }).sort()).toEqual(["aa", "bb"]);
    expect(simRelayFromEnv({})).toMatchObject({ why: expect.stringContaining("GYM_MESH_SIM_SEED") });
    expect(simRelayFromEnv({ GYM_MESH_SIM_SEED: "zz" })).toMatchObject({ why: expect.stringContaining("64 hex") });
    const ok = simRelayFromEnv({ GYM_MESH_SIM_SEED: "11".repeat(32) });
    expect("relayId" in ok && ok.relayId).toBe("gym-0sim");
  });

  it("adds mesh-v1 to a HELLO once", () => {
    expect(withMeshCapability({ capabilities: ["drain-v1"] }).capabilities).toEqual(["drain-v1", "mesh-v1"]);
    expect(withMeshCapability({ capabilities: ["mesh-v1"] }).capabilities).toEqual(["mesh-v1"]);
    expect(withMeshCapability({}).capabilities).toEqual(["mesh-v1"]);
  });
});

interface Relay {
  id: string;
  http: Server;
  httpPort: number;
  sniPort: number;
  node: MeshNode;
  wired: Awaited<ReturnType<typeof wireMeshRelay>>;
}

const fx = new MeshFixture();
const relays = new Map<string, Relay>();
const ports = new Map<string, number>();
const boxes: SimBox[] = [];

async function listen(f: FixtureRelay): Promise<Server> {
  const http = createServer();
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  ports.set(f.relayId, (http.address() as AddressInfo).port);
  return http;
}

async function startRelay(f: FixtureRelay, http: Server): Promise<Relay> {
  const httpPort = ports.get(f.relayId)!;
  const blessing = new RelayBlessingProvider({ keypair: f.key, relayId: f.relayId, servicesApex: APEX, comBaseUrl: "http://127.0.0.1:1", caKeys: () => [fx.caPub], log: () => undefined });
  blessing.adopt(fx.blessings.get(f.relayId));
  const registry = new TunnelRegistry({ apex: APEX });
  const node = new MeshNode({
    relayId: f.relayId,
    relayKind: f.kind,
    servicesApex: APEX,
    logKey: fx.logPub,
    caKeys: () => [fx.caPub],
    blessing,
    feedSource: fx.source(),
    registry,
    peerUrl: (p) => `ws://127.0.0.1:${ports.get(p.relayId)}/mesh`,
    feedPollMs: 100,
    queryTimeoutMs: 400,
    legacyWaitMs: 300,
    directoryPollMs: 500,
    minMoveMs: 0,
    log: () => undefined,
  });
  const wired = await wireMeshRelay({ httpServer: http, registry, node, blessing, servicesApex: APEX, tunnelTcpPort: 0, host: "127.0.0.1", holdTimeoutMs: 1_000, checkMs: 100 });
  wired.start();
  const r: Relay = { id: f.relayId, http, httpPort, sniPort: wired.router!.port, node, wired };
  relays.set(f.relayId, r);
  return r;
}

const R = (id: string) => relays.get(id)!;
const sim: { relayId: string; seed: Uint8Array } = { relayId: "aa-sim", seed: crypto.getRandomValues(new Uint8Array(32)) };

describe("the relay-mesh group's sims against two TS mesh relays", () => {
  beforeAll(async () => {
    const simFx: FixtureRelay = { relayId: sim.relayId, kind: "full", region: "iad", seedHex: hex(sim.seed), key: { privateKey: sim.seed, publicKey: ed.getPublicKey(sim.seed) } };
    fx.addRelay("ra");
    fx.addRelay("rb");
    fx.relays.push(simFx);
    fx.mintDirectory();
    const servers = [await listen(fx.relays[0]!), await listen(fx.relays[1]!)];
    await startRelay(fx.relays[0]!, servers[0]!);
    await startRelay(fx.relays[1]!, servers[1]!);
    await waitFor(() => R("ra").node.bridges.live().length === 1 && R("rb").node.bridges.live().length === 1, 10_000, "bridged").catch((e) => {
      throw new Error(`${(e as Error).message}: ${JSON.stringify([...relays.values()].map((r) => [r.id, r.node.readiness(), r.node.bridges.handshakeFailures]))}`);
    });
  }, 20_000);

  afterAll(async () => {
    for (const b of boxes) b.terminate();
    for (const r of relays.values()) {
      await r.wired.stop();
      r.http.closeAllConnections?.();
      await new Promise<void>((res) => r.http.close(() => res()));
    }
  });

  const admin = keypair();
  fx.authority("simuser", hex(admin.publicKey), hex(admin.publicKey));
  const server = (label: string): SimServer => {
    const stk = keypair();
    const fqdn = `${label}.simuser.${APEX}`;
    fx.registerBox(fqdn, hex(stk.publicKey));
    return { label, fqdn, stk, stkHex: hex(stk.publicKey) };
  };
  const payload = (s: SimServer, canonicals: string[] = []) => () =>
    simHelloPayload({ username: "simuser", server: s, irk: admin, canonicals, serving: { servingAdminKey: hex(admin.publicKey), servingPolicy: null } });
  const synced = () => waitFor(() => [...relays.values()].every((r) => r.node.feed.state.sequence === fx.entries.length && r.node.fresh()), 5_000, "synced");
  const visit = async (relay: Relay, sni: string) => {
    const v = await RawVisitor.open("127.0.0.1", sni, relay.sniPort);
    const a = await v.firstAnswer(2_000);
    await sleep(100);
    v.end();
    return { label: a?.label ?? null, v };
  };

  it("a mesh SimBox attaches; a visitor through the other relay reaches it and its ClientHello arrives verbatim", async () => {
    const s = server("x1");
    await synced();
    const b = await SimBox.connect(`ws://127.0.0.1:${R("ra").httpPort}/tunnel`, await payload(s)(), { label: "X1", mesh: { server: s }, echo: true });
    boxes.push(b);
    expect(b.accepted).toBe(true);
    expect(b.meshAcked).toBe(true);
    expect(b.relayId).toBe("ra");
    expect(b.attachResults[0]).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(s.fqdn)?.attachment.relayId === "ra", 3_000, "announced");
    const { label, v } = await visit(R("rb"), s.fqdn);
    expect(label).toBe("X1");
    expect(v.received.equals(Buffer.concat([Buffer.from(simAnswer("X1", s.fqdn), "latin1"), Buffer.from(v.sent)]))).toBe(true);
  });

  it("follows a co-locate hint make-before-break with moveSimBox", async () => {
    const app = `notes.simuser.${APEX}`;
    const s1 = server("h1");
    const s2 = server("h2");
    await synced();
    const b1 = await SimBox.connect(`ws://127.0.0.1:${R("ra").httpPort}/tunnel`, await payload(s1, [app])(), { label: "H1", mesh: { server: s1 } });
    boxes.push(b1);
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(s1.fqdn) !== null, 3_000, "h1 announced");
    await sleep(10);
    const b2 = await SimBox.connect(`ws://127.0.0.1:${R("rb").httpPort}/tunnel`, await payload(s2, [app])(), { label: "H2", mesh: { server: s2 } });
    boxes.push(b2);
    const h = await b2.waitHint("co-locate", 5_000);
    expect(h?.hint).toMatchObject({ reason: "co-locate", fromRelayId: "rb", toRelayId: "ra" });
    const moved = await moveSimBox(b2, h!, {
      server: s2,
      servicesApex: APEX,
      payload: payload(s2, [app]),
      directory: fx.directory,
      directoryFetchedAt: Date.now(),
      caKeys: [fx.caPub],
      rate: emptyMoveHintRateState(),
      graceMs: 200,
      url: (_h, id) => `ws://127.0.0.1:${ports.get(id)}/tunnel`,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    boxes.push(moved.box);
    expect(moved.box.relayId).toBe("ra");
    expect(moved.rate.coLocateAt.length).toBe(1);
    await waitFor(() => b2.closedWith !== null, 2_000, "old tunnel closed after the grace");
    // The same hint again is rate-limited by the box's own state.
    const again = await moveSimBox(moved.box, h!, { server: s2, servicesApex: APEX, payload: payload(s2, [app]), directory: fx.directory, directoryFetchedAt: Date.now(), caKeys: [fx.caPub], rate: moved.rate });
    expect(again.ok).toBe(false);
  });

  it("MeshSimRelay bridges in, sees announcements, has a forged attachment refused and a query flood answered busy", async () => {
    const s = server("r1");
    await synced();
    const b = await SimBox.connect(`ws://127.0.0.1:${R("ra").httpPort}/tunnel`, await payload(s)(), { label: "R1", mesh: { server: s } });
    boxes.push(b);
    R("ra").node.flushAnnouncements();
    const peer: GymRelay = { relayId: "rb", tunnelHost: `rb.tunnel.${APEX}`, ipv4: ["127.0.0.1"], ipv6: [], ip: "127.0.0.1", base: "" };
    const rogue = await MeshSimRelay.connect({ ...sim, peer, blessing: fx.blessings.get(sim.relayId)!, url: `ws://127.0.0.1:${R("rb").httpPort}/mesh` });
    try {
      await waitFor(() => rogue.items.has(s.fqdn), 3_000, "the peer's dump names R1");
      const peerRec = R("rb").node.bridges.peer(sim.relayId)!;
      const was = peerRec.rejected;
      const now = Date.now();
      const forged: BoxAttachment = { serverFqdn: s.fqdn, boxPub: s.stkHex, regGen: 1, relayId: sim.relayId, attachedAt: now, issuedAt: now, notAfter: now + 60_000 };
      const thief = crypto.getRandomValues(new Uint8Array(32));
      rogue.send({ type: "announce", items: [{ kind: "box", attachment: forged, signature: signRelayMeshRecord("relay-attachment", forged, (m) => ed.sign(m, thief)) }] });
      await waitFor(() => peerRec.rejected > was, 2_000, "rejected");
      expect(R("rb").node.store.winner(s.fqdn)?.attachment.relayId).toBe("ra");
      const flood = await rogue.flood(s.fqdn, 1_500, 3_000);
      expect(flood.busy).toBeGreaterThan(0);
      expect((await visit(R("rb"), s.fqdn)).label).toBe("R1");
    } finally {
      rogue.close();
    }
  });
});

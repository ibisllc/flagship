/**
 * The tunnel hub with the serving authority wired (docs/architecture-v2/serving-wiring.md §2): the HELLO's
 * `servingAdminKey` / `servingPolicy`, refusals, a revocation ending the tunnel, and a lease's end closing the box's
 * app streams while its control stream stays.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  applyRevocationEntries,
  deriveSTK,
  deriveSWK,
  ed,
  mintDevEntitlements,
  rootEntitlementCertId,
  serviceEntitlementCertId,
  signTunnelHelloV2,
  type Keypair,
} from "@flagship/protocol";
import {
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  HELLO_REFUSED_TRY_AGAIN,
  parseHelloAck,
  type Frame,
} from "@flagship/tunnel-protocol";
import { TunnelRegistry, type StreamCallbacks } from "../src/tunnel/registry.js";
import { startTunnelHub } from "../src/tunnel/tunnelHub.js";
import { ServingGate, type ComServingRecord } from "../src/tunnel/servingGate.js";
import { comRecord, edKey, hex, lease, policy, revocation, type Ed } from "./support/serving.js";

const HOME = "home.alice.flagship.services";
const NOTES = "notes.home.alice.flagship.services";

function key(): Keypair {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const stk = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(7) }, HOME));
const irk = key();

interface Rig {
  app: FastifyInstance;
  registry: TunnelRegistry;
  port: number;
  stop: () => Promise<void>;
  gate: ServingGate;
}

async function rig(fetchRecord: () => Promise<ComServingRecord | null>, gateOpts: { refuseNewAfterMs?: number } = {}): Promise<Rig> {
  const registry = new TunnelRegistry();
  const app = Fastify({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const gate = new ServingGate({ fetchRecord, ...gateOpts });
  const stop = startTunnelHub(app.server, registry, {
    authLookup: (sid) => (sid === HOME ? stk.publicKey : null),
    irkLookup: (u) => (u === "alice" ? irk.publicKey : null),
    serving: gate,
  });
  return { app, registry, port: (app.server.address() as AddressInfo).port, stop, gate };
}

interface Box {
  ws: WebSocket;
  frames: Frame[];
  ack: Promise<{ ok: boolean; reason?: string }>;
  closed: Promise<number>;
}

async function connectBox(port: number, serving: Record<string, unknown>): Promise<Box> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  const frames: Frame[] = [];
  let buf = new Uint8Array(0);
  let resolveAck!: (a: { ok: boolean; reason?: string }) => void;
  const ack = new Promise<{ ok: boolean; reason?: string }>((r) => (resolveAck = r));
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("message", (raw: Buffer) => {
    const joined = new Uint8Array(buf.length + raw.length);
    joined.set(buf);
    joined.set(raw, buf.length);
    buf = joined;
    for (;;) {
      const d = decodeFrame(buf);
      if (d.kind !== "ok") break;
      buf = buf.subarray(d.consumed);
      frames.push(d.frame);
      if (d.frame.type === FRAME_HELLO_ACK) resolveAck(parseHelloAck(d.frame.payload)!);
    }
  });
  await new Promise<void>((r) => ws.on("open", () => r()));
  const bundle = mintDevEntitlements({ irk, podPubKey: stk.publicKey, username: "alice", podCanonical: HOME, serviceCanonicals: [NOTES] });
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const issuedAt = Date.now();
  const rootId = await rootEntitlementCertId(bundle.rootEntitlement);
  const svcId = await serviceEntitlementCertId(bundle.serviceEntitlement!);
  const signature = signTunnelHelloV2(
    { serverId: HOME, rootEntitlementCertId: rootId, serviceEntitlementCertId: svcId, nonce, issuedAt },
    stk,
  );
  const se = bundle.serviceEntitlement!;
  const payload = {
    version: 2,
    serverId: HOME,
    rootEntitlement: { username: "alice", podPubKey: hex(stk.publicKey), podCanonical: HOME, issuedAt: bundle.rootEntitlement.issuedAt },
    rootEntitlementSig: hex(bundle.rootEntitlementSig),
    rootEntitlementCertId: rootId,
    serviceEntitlement: { username: "alice", podPubKey: hex(se.podPubKey), canonicals: se.canonicals, issuedAt: se.issuedAt, expiresAt: se.expiresAt },
    serviceEntitlementSig: hex(bundle.serviceEntitlementSig!),
    serviceEntitlementCertId: svcId,
    nonce: hex(nonce),
    issuedAt,
    signature: hex(signature),
    ...serving,
  };
  ws.send(encodeFrame({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(JSON.stringify(payload)) }));
  return { ws, frames, ack, closed };
}

const boxPub = hex(stk.publicKey);

describe("tunnel hub + serving authority", () => {
  let r: Rig | undefined;
  const boxes: Box[] = [];
  afterEach(async () => {
    for (const b of boxes.splice(0)) b.ws.terminate();
    r?.gate.stop();
    await r?.stop();
    await r?.app.close();
    r = undefined;
  });

  it("serves apps for a box whose servingAdminKey matches .com's", async () => {
    const admin = edKey();
    r = await rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await connectBox(r.port, { servingAdminKey: admin.pub, servingPolicy: null });
    boxes.push(b);
    expect(await b.ack).toMatchObject({ ok: true });
    expect(r.registry.findBySni(NOTES)?.podCanonical).toBe(HOME);
    expect(r.gate.stats()).toMatchObject({ boxes: 1, serving: 1, appsStopped: 0 });
  });

  it("a box with no servingAdminKey keeps its control name but no app route", async () => {
    const admin = edKey();
    r = await rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await connectBox(r.port, {});
    boxes.push(b);
    expect(await b.ack).toMatchObject({ ok: true });
    expect(r.registry.findBySni(HOME)?.podCanonical).toBe(HOME);
    expect(r.registry.findBySni(NOTES)).toBeUndefined();
    expect(r.registry.findBySni("notes.alice.flagship.services")).toBeUndefined();
    expect(r.gate.stats()).toMatchObject({ serving: 0, appsStopped: 1 });
  });

  it("refuses a box whose pinned admin key differs from .com's", async () => {
    const admin = edKey();
    r = await rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await connectBox(r.port, { servingAdminKey: edKey().pub });
    boxes.push(b);
    expect(await b.ack).toEqual({ ok: false, reason: "admin-keys-differ" });
    expect(await b.closed).toBe(1008);
    expect(r.registry.size()).toBe(0);
  });

  it("answers try-again (close 1013) while contact with .com's feed is lost", async () => {
    r = await rig(async () => comRecord({ adminKey: edKey().pub }), { refuseNewAfterMs: 0 });
    const b = await connectBox(r.port, {});
    boxes.push(b);
    expect(await b.ack).toEqual({ ok: false, reason: HELLO_REFUSED_TRY_AGAIN });
    expect(await b.closed).toBe(1013);
  });

  it("a pushed revocation ends the box's tunnel at once", async () => {
    const admin = edKey();
    const rk = edKey();
    r = await rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await connectBox(r.port, { servingAdminKey: admin.pub });
    boxes.push(b);
    expect(await b.ack).toMatchObject({ ok: true });
    const applied = applyRevocationEntries(r.gate.revocations, [revocation(1, "alice", boxPub, rk)], rk.pub);
    if (!applied.ok) throw new Error(applied.reason);
    r.gate.adoptRevocations(applied.state);
    expect(await b.closed).toBe(1008);
    await waitFor(() => r!.registry.size() === 0);
  });

  it("at the lease's end the app streams close and app names stop, while the control stream and name stay", async () => {
    const admin: Ed = edKey();
    const p = policy({ account: "alice", box: boxPub, admin });
    const now = Date.now();
    r = await rig(async () => comRecord({ adminKey: admin.pub, policy: p, leases: [lease(p, admin, now, now + 500)] }));
    const b = await connectBox(r.port, { servingAdminKey: admin.pub, servingPolicy: p });
    boxes.push(b);
    expect(await b.ack).toMatchObject({ ok: true });

    const tunnel = r.registry.findBySni(NOTES)!;
    expect(tunnel).toBeDefined();
    const ended: string[] = [];
    const cb = (name: string): StreamCallbacks => ({ onData: () => undefined, onRemoteClose: () => ended.push(name) });
    const appId = tunnel.nextStreamId();
    tunnel.attachStream(appId, cb("app"), NOTES);
    const controlId = tunnel.nextStreamId();
    tunnel.attachStream(controlId, cb("control"), HOME);

    await waitFor(() => ended.length > 0, 3_000);
    expect(ended).toEqual(["app"]);
    await waitFor(() => b.frames.some((f) => f.type === FRAME_CLOSE && f.streamId === appId));
    expect(b.frames.some((f) => f.type === FRAME_CLOSE && f.streamId === controlId)).toBe(false);
    expect(r.registry.findBySni(NOTES)).toBeUndefined();
    expect(r.registry.findBySni(HOME)).toBe(tunnel);
    expect(Date.now() - now).toBeLessThan(5_000);
  });
});

async function waitFor(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((res) => setTimeout(res, 10));
  }
}

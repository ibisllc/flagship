import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startTunnelClient } from "@flagship/server-daemon";
import {
  CAPABILITY_DRAIN_V1,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_DRAIN_NOTICE,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_OUTBOUND_OPEN,
  FRAME_PB_MAILBOX_ANNOUNCE,
  FRAME_PB_MAIL_RESP,
  FRAME_REQUEST_TRANSFER,
  parseDrainNotice,
  parseHelloAck,
  type Frame,
} from "@flagship/tunnel-protocol";
import {
  deriveSTK,
  deriveSWK,
  ed,
  mintDevEntitlements,
  rootEntitlementCertId,
  signTunnelHelloV2,
  type Keypair,
} from "@flagship/protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import {
  HUB_MAX_WS_MESSAGE,
  startTunnelHub,
  type TunnelHubHandle,
  type TunnelHubOptions,
} from "../src/tunnel/tunnelHub.js";

const HOME = "home.alice.flagship.services";
const OFFICE = "office.alice.flagship.services";

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

const irk: Keypair = (() => {
  const priv = new Uint8Array(32).fill(9);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
})();

async function helloPayload(pod: string, capabilities?: string[]): Promise<Uint8Array> {
  const stk = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(3) }, pod));
  const b = mintDevEntitlements({ irk, podPubKey: stk.publicKey, username: "alice", podCanonical: pod });
  const certId = await rootEntitlementCertId(b.rootEntitlement);
  const nonce = new Uint8Array(32).fill(7);
  const issuedAt = Date.now();
  const signature = signTunnelHelloV2(
    { serverId: pod, rootEntitlementCertId: certId, serviceEntitlementCertId: "", nonce, issuedAt },
    stk,
  );
  return new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      serverId: pod,
      rootEntitlement: {
        username: "alice",
        podPubKey: hex(stk.publicKey),
        podCanonical: pod,
        issuedAt: b.rootEntitlement.issuedAt,
      },
      rootEntitlementSig: hex(b.rootEntitlementSig),
      rootEntitlementCertId: certId,
      serviceEntitlement: null,
      serviceEntitlementSig: null,
      serviceEntitlementCertId: "",
      nonce: hex(nonce),
      issuedAt,
      signature: hex(signature),
      ...(capabilities ? { capabilities } : {}),
    }),
  );
}

/** A box speaking raw frames, so a test can send what no real box would. */
interface RawBox {
  ws: WebSocket;
  frames: Frame[];
  closed: Promise<{ code: number }>;
  send(type: Frame["type"], payload: Uint8Array | string, streamId?: number): void;
  next(type: number): Promise<Frame>;
}

async function rawBox(port: number, pod: string, capabilities?: string[]): Promise<RawBox> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  const frames: Frame[] = [];
  const waiters: Array<{ type: number; resolve: (f: Frame) => void }> = [];
  ws.on("message", (raw: Buffer) => {
    const r = decodeFrame(new Uint8Array(raw), { drainNotice: true });
    if (r.kind !== "ok") return;
    frames.push(r.frame);
    for (const w of [...waiters]) {
      if (w.type === r.frame.type) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(r.frame);
      }
    }
  });
  const closed = new Promise<{ code: number }>((res) => ws.once("close", (code) => res({ code })));
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const box: RawBox = {
    ws,
    frames,
    closed,
    send(type, payload, streamId = 0) {
      const p = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
      ws.send(encodeFrame({ streamId, type, payload: p }));
    },
    next(type) {
      const seen = frames.find((f) => f.type === type);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
  box.send(FRAME_HELLO, await helloPayload(pod, capabilities));
  const ack = parseHelloAck((await box.next(FRAME_HELLO_ACK)).payload);
  expect(ack?.ok).toBe(true);
  return box;
}

let app: FastifyInstance | null = null;
let hub: TunnelHubHandle | null = null;
const boxes: RawBox[] = [];

async function makeHub(opts: TunnelHubOptions = {}) {
  const registry = new TunnelRegistry();
  app = Fastify({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  hub = startTunnelHub(app.server, registry, opts);
  return { registry, port: (app.server.address() as AddressInfo).port, hub };
}

async function connect(port: number, pod: string, capabilities?: string[]) {
  const b = await rawBox(port, pod, capabilities);
  boxes.push(b);
  return b;
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const b of boxes.splice(0)) b.ws.terminate();
  await hub?.();
  await app?.close();
  hub = null;
  app = null;
});

describe("tunnel hub: hostile frames from a registered box", () => {
  it("survives REQUEST_TRANSFER with a null payload and every other non-object JSON", async () => {
    const { port, registry } = await makeHub();
    const box = await connect(port, HOME);
    for (const body of ["null", "123", "[]", '"x"', '{"fqdn":5}', '{"fqdn":""}', "{", ""]) {
      box.send(FRAME_REQUEST_TRANSFER, body);
    }
    box.send(FRAME_PB_MAILBOX_ANNOUNCE, "null");
    box.send(FRAME_OUTBOUND_OPEN, "null", 0x80000001);
    box.send(FRAME_PB_MAIL_RESP, new Uint8Array(0), 77);
    box.send(FRAME_CLOSE, new Uint8Array(0), 4242);
    await settle();
    expect(box.ws.readyState).toBe(WebSocket.OPEN);
    expect(registry.findBySni(HOME)).toBeDefined();
    // The hub (and the process) still takes new tunnels.
    await connect(port, OFFICE);
    expect(registry.findBySni(OFFICE)).toBeDefined();
  });

  it("closes only the connection whose handler threw", async () => {
    const { port, registry } = await makeHub({
      evictionLookup: async (pod) => {
        if (pod === OFFICE) throw new Error("lookup exploded");
        return null;
      },
    });
    const home = await connect(port, HOME);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
    const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
    await new Promise((r) => ws.once("open", r));
    ws.send(encodeFrame({ streamId: 0, type: FRAME_HELLO, payload: await helloPayload(OFFICE) }));
    expect(await closed).toBe(1011);
    expect(home.ws.readyState).toBe(WebSocket.OPEN);
    expect(registry.findBySni(HOME)).toBeDefined();
    expect(registry.findBySni(OFFICE)).toBeUndefined();
  });

  it("refuses a WebSocket message larger than the largest frame needs", async () => {
    const { port } = await makeHub();
    const box = await connect(port, HOME);
    box.ws.send(new Uint8Array(HUB_MAX_WS_MESSAGE + 1));
    expect((await box.closed).code).toBe(1009);
  });

  it("decodes a frame split over many small messages", async () => {
    const { port, registry } = await makeHub();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
    const acks: Frame[] = [];
    ws.on("message", (raw: Buffer) => {
      const r = decodeFrame(new Uint8Array(raw));
      if (r.kind === "ok") acks.push(r.frame);
    });
    await new Promise((r) => ws.once("open", r));
    const bytes = encodeFrame({ streamId: 0, type: FRAME_HELLO, payload: await helloPayload(HOME) });
    for (let i = 0; i < bytes.length; i += 7) ws.send(bytes.subarray(i, i + 7));
    for (let i = 0; i < 40 && acks.length === 0; i++) await settle(25);
    expect(parseHelloAck(acks[0]!.payload)?.ok).toBe(true);
    expect(registry.findBySni(HOME)).toBeDefined();
    ws.terminate();
  });
});

describe("tunnel hub: reconnect race", () => {
  it("the old socket's late close leaves the new tunnel registered", async () => {
    const { port, registry } = await makeHub();
    const first = await connect(port, HOME);
    const before = registry.findBySni(HOME);
    const second = await connect(port, HOME);
    const after = registry.findBySni(HOME);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    first.ws.close();
    await first.closed;
    await settle();
    expect(registry.findBySni(HOME)).toBe(after);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    second.ws.close();
    await second.closed;
    await settle();
    expect(registry.findBySni(HOME)).toBeUndefined();
  });

  it("a refresh HELLO on the superseded socket does not take the name back", async () => {
    const { port, registry } = await makeHub();
    const first = await connect(port, HOME);
    await connect(port, HOME);
    const current = registry.findBySni(HOME);
    await settle(5);
    first.frames.length = 0;
    first.send(FRAME_HELLO, await helloPayload(HOME));
    const ack = parseHelloAck((await first.next(FRAME_HELLO_ACK)).payload);
    expect(ack).toMatchObject({ ok: false, reason: "tunnel superseded by a newer connection" });
    expect(registry.findBySni(HOME)).toBe(current);
  });
});

describe("tunnel hub: drain", () => {
  it("negotiates drain-v1 only with a box that offers it", async () => {
    const { port } = await makeHub();
    const modern = await connect(port, HOME, [CAPABILITY_DRAIN_V1, "made-up-v9"]);
    const old = await connect(port, OFFICE);
    expect(parseHelloAck(modern.frames[0]!.payload)?.capabilities).toEqual([CAPABILITY_DRAIN_V1]);
    expect(parseHelloAck(old.frames[0]!.payload)?.capabilities).toBeUndefined();
  });

  it("notifies drain-v1 boxes, refuses new tunnels, then closes everyone after the grace", async () => {
    const { port, hub } = await makeHub();
    const modern = await connect(port, HOME, [CAPABILITY_DRAIN_V1]);
    const old = await connect(port, OFFICE);
    const started = Date.now();
    const drained = hub.drain(300);
    const notice = await modern.next(FRAME_DRAIN_NOTICE);
    expect(parseDrainNotice(notice.payload)).toBe(300);

    const late = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
    const refused = await new Promise<number>((res) => {
      late.once("unexpected-response", (_req, resp) => res(resp.statusCode ?? 0));
      late.once("open", () => res(101));
      late.once("error", () => res(-1));
    });
    expect(refused).toBe(503);

    expect(old.ws.readyState).toBe(WebSocket.OPEN);
    const [m, o] = await Promise.all([modern.closed, old.closed, drained]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(m.code).toBe(1012);
    expect(o.code).toBe(1012);
    expect(old.frames.some((f) => f.type === FRAME_DRAIN_NOTICE)).toBe(false);
    expect(hub.connectionCount()).toBe(0);
  });

  it("finishes early once every tunnel has left", async () => {
    const { port, hub } = await makeHub();
    const modern = await connect(port, HOME, [CAPABILITY_DRAIN_V1]);
    const started = Date.now();
    const drained = hub.drain(10_000);
    await modern.next(FRAME_DRAIN_NOTICE);
    modern.ws.close();
    await drained;
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("drain-v1 between the real box client and the hub", () => {
  it("the box offers drain-v1 and hears the notice with the hub's grace", async () => {
    const { port, hub } = await makeHub();
    const stk = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(3) }, HOME));
    const graces: number[] = [];
    const client = startTunnelClient({
      hubUrl: `ws://127.0.0.1:${port}/tunnel`,
      signingKey: stk,
      getEntitlements: () =>
        mintDevEntitlements({ irk, podPubKey: stk.publicKey, username: "alice", podCanonical: HOME }),
      resolveBackend: () => null,
      onDrain: (g) => graces.push(g),
    });
    await client.ready();
    const drained = hub.drain(400);
    for (let i = 0; i < 40 && graces.length === 0; i++) await settle(10);
    expect(graces).toEqual([400]);
    await drained;
    await client.close();
  });
});

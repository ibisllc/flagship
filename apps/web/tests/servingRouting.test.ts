/**
 * Serving-authority enforcement in the allocator, registry and SNI router (docs/architecture-v2/serving-wiring.md
 * §2): a box whose apps are stopped keeps its exact control name, holds no app slot, is never an heir, and its app
 * names close exactly like names nobody registered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect, type Socket } from "node:net";
import { FRAME_OPEN, type Frame } from "@flagship/tunnel-protocol";
import { AppUserAllocator, parseSetKey } from "../src/tunnel/allocator.js";
import { TunnelRegistry, type RegisteredTunnel, type ServingView, type StreamCallbacks } from "../src/tunnel/registry.js";
import { startSniRouter, type RunningSniRouter } from "../src/tunnel/sniRouter.js";

const KITCHEN = "kitchen.john.flagship.services";
const WOODSHED = "woodshed.john.flagship.services";
const NOTES_K = "notes.kitchen.john.flagship.services";
const NOTES_W = "notes.woodshed.john.flagship.services";
const NOTES = "notes.john.flagship.services";

describe("allocator: canonical-app allocation skips a box whose apps are stopped", () => {
  it("a stopped box claims no slot; a serving one does", () => {
    const a = new AppUserAllocator();
    a.addPod({ podCanonical: KITCHEN, canonicals: [KITCHEN, NOTES_K], appsAllowed: false });
    expect(a.findHolderByFqdn(NOTES)).toBeUndefined();
    expect(a.findHolderByFqdn(KITCHEN)).toBe(KITCHEN);
    a.addPod({ podCanonical: WOODSHED, canonicals: [WOODSHED, NOTES_W] });
    expect(a.findHolderByFqdn(NOTES)).toBe(WOODSHED);
  });

  it("stopping the holder fails the slot over to a serving sibling, never to a stopped one", () => {
    const a = new AppUserAllocator();
    a.addPod({ podCanonical: KITCHEN, canonicals: [KITCHEN, NOTES_K] });
    a.addPod({ podCanonical: WOODSHED, canonicals: [WOODSHED, NOTES_W], appsAllowed: false });
    expect(a.findHolderByFqdn(NOTES)).toBe(KITCHEN);
    a.setAppsAllowed(KITCHEN, false);
    expect(a.findHolderByFqdn(NOTES)).toBeUndefined();
    a.setAppsAllowed(WOODSHED, true);
    expect(a.findHolderByFqdn(NOTES)).toBe(WOODSHED);
    // Kitchen coming back does not take the slot from the serving holder…
    a.setAppsAllowed(KITCHEN, true);
    expect(a.findHolderByFqdn(NOTES)).toBe(WOODSHED);
    // …but is its heir when that holder leaves.
    a.removePod(WOODSHED);
    expect(a.findHolderByFqdn(NOTES)).toBe(KITCHEN);
  });

  it("a short service name a stopped box declared stays unheld, and failover on disconnect skips it", () => {
    const a = new AppUserAllocator();
    a.addPod({ podCanonical: KITCHEN, canonicals: [KITCHEN, NOTES] });
    a.addPod({ podCanonical: WOODSHED, canonicals: [WOODSHED, NOTES], appsAllowed: false });
    a.removePod(KITCHEN);
    expect(a.findHolderByFqdn(NOTES)).toBeUndefined();
    const key = parseSetKey(NOTES)!;
    expect(a.candidatesFor(key, NOTES)).toEqual([WOODSHED]);
    a.setAppsAllowed(WOODSHED, true);
    expect(a.findHolderByFqdn(NOTES)).toBe(WOODSHED);
  });

  it("a stopped box cannot take a slot by transfer", () => {
    const a = new AppUserAllocator();
    a.addPod({ podCanonical: KITCHEN, canonicals: [KITCHEN, NOTES_K] });
    a.addPod({ podCanonical: WOODSHED, canonicals: [WOODSHED, NOTES_W], appsAllowed: false });
    expect(a.requestTransfer({ podCanonical: WOODSHED, fqdn: NOTES })).toEqual({ ok: false, reason: "apps stopped" });
    expect(a.findHolderByFqdn(NOTES)).toBe(KITCHEN);
  });
});

// ── router ───────────────────────────────────────────────────────────────

function buildClientHello(sni: string): Uint8Array {
  const host = new TextEncoder().encode(sni);
  const entry = cat(new Uint8Array([0]), u16(host.length), host);
  const list = cat(u16(entry.length), entry);
  const ext = cat(u16(0), u16(list.length), list);
  const exts = cat(u16(ext.length), ext);
  const body = cat(new Uint8Array([3, 3]), new Uint8Array(32), new Uint8Array([0]), u16(2), new Uint8Array([0, 0x9c]), new Uint8Array([1, 0]), exts);
  const hs = cat(new Uint8Array([1]), new Uint8Array([(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body);
  return cat(new Uint8Array([0x16, 3, 1]), u16(hs.length), hs);
}
function u16(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 255, v & 255]);
}
function cat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of a) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

function mockTunnel(podCanonical: string, view?: () => ServingView) {
  let next = 1;
  const sent: Frame[] = [];
  const streams = new Map<number, { cb: StreamCallbacks; sni?: string }>();
  const t: RegisteredTunnel & { sent: Frame[]; streams: typeof streams } = {
    podCanonical,
    sent,
    streams,
    send: (f) => sent.push(f),
    attachStream: (id, cb, sni) => streams.set(id, { cb, sni }),
    detachStream: (id) => streams.delete(id),
    nextStreamId: () => next++,
    ...(view ? { serving: view } : {}),
  };
  return t;
}

const FAST = { holdTimeoutMs: 600, holdPollIntervalMs: 25 };

describe("SNI router: a stopped box's app names close like unknown names; its control name routes", () => {
  let router: RunningSniRouter | undefined;
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await router?.close();
    router = undefined;
  });

  async function probe(port: number, sni: string): Promise<{ ms: number; received: number }> {
    const t0 = Date.now();
    let received = 0;
    const sock = netConnect(port, "127.0.0.1");
    sockets.push(sock);
    sock.on("data", (d) => (received += d.length));
    sock.on("error", () => undefined);
    const closed = new Promise<void>((r) => sock.on("close", () => r()));
    sock.write(Buffer.from(buildClientHello(sni)));
    await closed;
    return { ms: Date.now() - t0, received };
  }

  it("registry gate: control name while control, every other name only while apps", () => {
    let view: ServingView = { control: true, apps: true };
    const reg = new TunnelRegistry();
    const home = mockTunnel(KITCHEN, () => view);
    reg.register({ tunnel: home, canonicals: [KITCHEN, NOTES_K] });
    expect(reg.findBySni(NOTES_K)).toBe(home);
    expect(reg.findBySni(`photos.${KITCHEN}`)).toBe(home);
    expect(reg.findBySni(NOTES)).toBe(home);
    view = { control: true, apps: false };
    expect(reg.findBySni(KITCHEN)).toBe(home);
    expect(reg.findBySni(NOTES_K)).toBeUndefined();
    expect(reg.findBySni(`photos.${KITCHEN}`)).toBeUndefined();
    reg.addRedirection("notes.example.org", KITCHEN);
    expect(reg.findBySni("notes.example.org")).toBeUndefined();
    view = { control: false, apps: false };
    expect(reg.findBySni(KITCHEN)).toBeUndefined();
  });

  it("routes the control name and drops app names in the same silence and time as a name nobody has", async () => {
    const reg = new TunnelRegistry();
    const home = mockTunnel(KITCHEN, () => ({ control: true, apps: false }));
    reg.register({ tunnel: home, canonicals: [KITCHEN, NOTES_K] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    const probes = await Promise.all([
      probe(router.port, NOTES_K),
      probe(router.port, `photos.${KITCHEN}`),
      probe(router.port, NOTES),
      probe(router.port, "ghost.john.flagship.services"),
      probe(router.port, "anything.nobody.flagship.services"),
    ]);
    for (const p of probes) {
      expect(p.received).toBe(0);
      expect(p.ms).toBeGreaterThanOrEqual(FAST.holdTimeoutMs - 60);
      expect(p.ms).toBeLessThan(FAST.holdTimeoutMs + 700);
    }
    const spread = Math.max(...probes.map((p) => p.ms)) - Math.min(...probes.map((p) => p.ms));
    expect(spread).toBeLessThan(300);
    // A nudge to john's own box may go out (as for the ghost name); no visitor stream does.
    const opened = home.sent.filter((f) => f.type === FRAME_OPEN).map((f) => new TextDecoder().decode(f.payload));
    for (const sni of [NOTES_K, `photos.${KITCHEN}`, NOTES]) expect(opened).not.toContain(sni);
    expect([...home.streams.values()].filter((s) => s.sni)).toHaveLength(0);

    const sock = netConnect(router.port, "127.0.0.1");
    sockets.push(sock);
    sock.on("error", () => undefined);
    sock.write(Buffer.from(buildClientHello(KITCHEN)));
    await waitFor(() => [...home.streams.values()].some((s) => s.sni === KITCHEN));
  });
});

async function waitFor(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

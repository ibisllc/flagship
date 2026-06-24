import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect, type Socket } from "node:net";
import { FRAME_DATA, FRAME_OPEN, type Frame } from "@flagship/tunnel-protocol";
import {
  TunnelRegistry,
  type RegisteredTunnel,
  type StreamCallbacks,
} from "../src/tunnel/registry.js";
import { startSniRouter, type RunningSniRouter } from "../src/tunnel/sniRouter.js";

// ── ClientHello builder (copied from tunnelIntegration.test.ts) ─────────────
function buildClientHello(sni: string): Uint8Array {
  const hostBytes = new TextEncoder().encode(sni);
  const nameEntry = concat(new Uint8Array([0]), u16(hostBytes.length), hostBytes);
  const list = concat(u16(nameEntry.length), nameEntry);
  const sniExt = concat(u16(0), u16(list.length), list);
  const extensions = concat(u16(sniExt.length), sniExt);
  const body = concat(
    new Uint8Array([0x03, 0x03]),
    new Uint8Array(32),
    new Uint8Array([0]),
    u16(2),
    new Uint8Array([0x00, 0x9c]),
    new Uint8Array([1, 0]),
    extensions,
  );
  const handshake = concat(new Uint8Array([0x01]), u24(body.length), body);
  return concat(
    new Uint8Array([0x16]),
    new Uint8Array([0x03, 0x01]),
    u16(handshake.length),
    handshake,
  );
}
function u16(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}
function u24(v: number): Uint8Array {
  return new Uint8Array([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

// ── A mock connected box that records every frame the hub sends it. ─────────
function mockTunnel(podCanonical: string): RegisteredTunnel & {
  sent: Frame[];
  streams: Map<number, StreamCallbacks>;
} {
  let next = 1;
  const streams = new Map<number, StreamCallbacks>();
  const sent: Frame[] = [];
  return {
    podCanonical,
    sent,
    streams,
    send(frame: Frame) {
      sent.push(frame);
    },
    attachStream(id, cb) {
      streams.set(id, cb);
    },
    detachStream(id) {
      streams.delete(id);
    },
    nextStreamId() {
      return next++;
    },
  };
}

function reassembleAllData(t: { sent: Frame[] }): string {
  const parts: Uint8Array[] = [];
  for (const f of t.sent) if (f.type === FRAME_DATA) parts.push(f.payload);
  return new TextDecoder().decode(concat(...parts));
}

/** The SNI an OPEN frame opened with (stored verbatim in the frame payload). */
function openSni(f: Frame): string {
  return new TextDecoder().decode(f.payload);
}
function opensFor(t: { sent: Frame[] }, sni: string): Frame[] {
  return t.sent.filter((f) => f.type === FRAME_OPEN && openSni(f) === sni);
}

/** Connect, write a ClientHello for `sni`, return the socket (closed by test). */
function dial(port: number, sni: string): { sock: Socket; closed: Promise<void> } {
  const sock = netConnect(port, "127.0.0.1");
  const closed = new Promise<void>((resolve) => {
    sock.on("close", () => resolve());
    sock.on("error", () => {});
  });
  sock.write(Buffer.from(buildClientHello(sni)));
  return { sock, closed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

const FAST = { holdTimeoutMs: 600, holdPollIntervalMs: 25 };

describe("SNI router — park-on-miss → nudge → wait-for-claim → drop", () => {
  let router: RunningSniRouter | undefined;
  let sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets = [];
    if (router) await router.close();
    router = undefined;
  });

  it("a normal HIT still pipes directly (no regression, no nudge)", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel("home.harry.flagship.services");
    reg.register({ tunnel: box, canonicals: ["home.harry.flagship.services"] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    const { sock } = dial(router.port, "home.harry.flagship.services");
    sockets.push(sock);

    // It opened a pipe stream and forwarded the ClientHello — never a nudge.
    await waitFor(() => box.sent.some((f) => f.type === FRAME_OPEN));
    const text = reassembleAllData(box);
    expect(text).not.toContain("/internal/route-nudge");
    // The OPEN carried the real SNI, and the ClientHello bytes (0x16…) flowed.
    expect(opensFor(box, "home.harry.flagship.services").length).toBe(1);
  });

  it("MISS for a meta-URL with online boxes PARKS + NUDGES, then PIPES when a claim lands mid-wait", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel("home.harry.flagship.services");
    reg.register({ tunnel: box, canonicals: ["home.harry.flagship.services"] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    // notes.harry.flagship.services is a tier-2 leader-route nobody holds yet.
    const META = "notes.harry.flagship.services";
    const { sock, closed } = dial(router.port, META);
    sockets.push(sock);

    // The box receives a POST /internal/route-nudge {domain} — and NOTHING is
    // piped yet (still parked).
    await waitFor(() => reassembleAllData(box).includes("/internal/route-nudge"));
    const nudgeText = reassembleAllData(box);
    expect(nudgeText).toContain("POST /internal/route-nudge HTTP/1.1");
    expect(nudgeText).toContain(`{"domain":"${META}"}`);
    // No pipe OPEN with the META SNI yet (only the nudge stream exists).
    expect(box.sent.filter((f) => f.type === FRAME_OPEN).length).toBe(1);

    // Mid-wait, the box elects itself and registers the name (its HELLO would
    // do this in prod). The parked stream must now pipe through.
    reg.register({
      tunnel: box,
      canonicals: ["home.harry.flagship.services", META],
    });
    await waitFor(() => opensFor(box, META).length >= 1);
    // The socket stayed OPEN (it was piped, not dropped).
    expect(sock.destroyed).toBe(false);
    void closed;
  });

  it("TIMEOUT with no claim DESTROYS the parked socket", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel("home.harry.flagship.services");
    reg.register({ tunnel: box, canonicals: ["home.harry.flagship.services"] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    const { sock, closed } = dial(router.port, "ghostsvc.harry.flagship.services");
    sockets.push(sock);

    // Nudged…
    await waitFor(() => reassembleAllData(box).includes("/internal/route-nudge"));
    // …but no claim ever lands → after the hold timeout the socket is dropped.
    await closed;
    expect(sock.destroyed).toBe(true);
  });

  it("SINGLE-FLIGHT: 2 requests for the SAME domain → 1 nudge, BOTH released on the claim", async () => {
    const reg = new TunnelRegistry();
    const box = mockTunnel("home.harry.flagship.services");
    reg.register({ tunnel: box, canonicals: ["home.harry.flagship.services"] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    const META = "chat.harry.flagship.services";
    const a = dial(router.port, META);
    const b = dial(router.port, META);
    sockets.push(a.sock, b.sock);

    // Exactly ONE nudge stream for the domain (single-flight), even with 2 waiters.
    await waitFor(() => reassembleAllData(box).includes("/internal/route-nudge"));
    await sleep(120); // give any erroneous 2nd nudge time to appear
    // The nudge opens with the box's OWN canonical as the SNI (gossip seam).
    expect(opensFor(box, box.podCanonical).length).toBe(1);

    // The claim lands → BOTH parked streams pipe to the now-registered tunnel.
    reg.register({ tunnel: box, canonicals: ["home.harry.flagship.services", META] });
    await waitFor(() => opensFor(box, META).length === 2);
    expect(a.sock.destroyed).toBe(false);
    expect(b.sock.destroyed).toBe(false);
  });

  it("MISS for a user with NO online boxes → IMMEDIATE drop (no park, no nudge)", async () => {
    const reg = new TunnelRegistry();
    // harry has a box; nobody-user does not.
    const box = mockTunnel("home.harry.flagship.services");
    reg.register({ tunnel: box, canonicals: ["home.harry.flagship.services"] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    const t0 = Date.now();
    const { sock, closed } = dial(router.port, "anything.nobody.flagship.services");
    sockets.push(sock);
    await closed;
    // Dropped well within the hold timeout (immediate, not parked).
    expect(Date.now() - t0).toBeLessThan(FAST.holdTimeoutMs);
    expect(sock.destroyed).toBe(true);
    // harry's box was never nudged for nobody's domain.
    expect(reassembleAllData(box)).not.toContain("/internal/route-nudge");
  });

  it("MISS for a known box's OWN offline apex → drop, never nudged", async () => {
    const reg = new TunnelRegistry();
    // Register then unregister 'attic' so it is a KNOWN (recent) box canonical
    // that is now offline; harry still has 'home' online.
    const attic = mockTunnel("attic.harry.flagship.services");
    reg.register({ tunnel: attic, canonicals: ["attic.harry.flagship.services"] });
    reg.unregister("attic.harry.flagship.services");
    const home = mockTunnel("home.harry.flagship.services");
    reg.register({ tunnel: home, canonicals: ["home.harry.flagship.services"] });
    router = await startSniRouter(reg, { port: 0, host: "127.0.0.1", ...FAST });

    const t0 = Date.now();
    const { sock, closed } = dial(router.port, "attic.harry.flagship.services");
    sockets.push(sock);
    await closed;
    expect(Date.now() - t0).toBeLessThan(FAST.holdTimeoutMs);
    expect(reassembleAllData(home)).not.toContain("/internal/route-nudge");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import {
  closeFrame,
  dataFrame,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_OUTBOUND_CREDIT,
  FRAME_OUTBOUND_RESULT,
  OUTBOUND_INITIAL_WINDOW,
  OUTBOUND_STREAM_ID_BASE,
  outboundCreditFrame,
  outboundOpenFrame,
  parseOutboundCredit,
  parseOutboundResult,
  type Frame,
} from "@flagship/tunnel-protocol";
import { destinationLabel, isPublicUnicast, OutboundRelay, vetOutboundHost, type OutboundRelayOptions } from "../src/tunnel/outboundRelay.js";
import { allowEveryHost } from "./support/allowEveryHost.js";

const ID = OUTBOUND_STREAM_ID_BASE + 1;
const PUBLIC_IP = "93.184.215.14";

describe("destination policy", () => {
  it("accepts public names and refuses literals, local and Fly-private names", () => {
    expect(vetOutboundHost("API.Anthropic.com.")).toBe("api.anthropic.com");
    for (const bad of [
      "127.0.0.1",
      "::1",
      "[fdaa::3]",
      "localhost",
      "intranet",
      "127.1",
      "0x7f.1",
      "2130706433",
      "my-app.internal",
      "top1.nearest.of.my-app.internal",
      "my-app.flycast",
      "printer.local",
      "nas.lan",
      "box.home.arpa",
      "a..b",
      "-a.example",
      "x".repeat(64) + ".example",
    ]) {
      expect(vetOutboundHost(bad), bad).toBeNull();
    }
  });

  it("allows only public unicast addresses", () => {
    for (const ok of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) {
      expect(isPublicUnicast(ok), ok).toBe(true);
    }
    for (const bad of [
      "127.0.0.1",
      "10.1.2.3",
      "172.19.0.5",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fdaa:0:1:a7b::2", // Fly 6PN
      "fd00::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2001:db8::1",
      "2001:0:4136:e378::1",
      "not-an-ip",
    ]) {
      expect(isPublicUnicast(bad), bad).toBe(false);
    }
  });
});

interface Harness {
  frames: Frame[];
  logs: string[];
  relay: OutboundRelay;
  session: ReturnType<OutboundRelay["session"]>;
  next(pred: (f: Frame) => boolean, ms?: number, from?: number): Promise<Frame>;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function upstream(onConn: (s: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer((s) => {
      sockets.push(s);
      onConn(s);
    });
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as AddressInfo).port));
  });
}

function harness(port: number, opts: OutboundRelayOptions = {}, records: string[] = [PUBLIC_IP]): Harness {
  const frames: Frame[] = [];
  const logs: string[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  const relay = new OutboundRelay({
    hostPolicy: allowEveryHost,
    resolve: async () => records,
    connect: () => netConnect({ host: "127.0.0.1", port }),
    log: (l) => logs.push(l),
    statsIntervalMs: 0,
    ...opts,
  });
  const session = relay.session("home.alice.flagship.services", (f) => {
    frames.push(f);
    for (const w of waiters.splice(0)) {
      if (w.pred(f)) w.resolve(f);
      else waiters.push(w);
    }
  });
  return {
    frames,
    logs,
    relay,
    session,
    next: (pred, ms = 3000, from = 0) =>
      new Promise<Frame>((resolve, reject) => {
        const hit = frames.slice(from).find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error("timed out waiting for frame")), ms);
        waiters.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
      }),
  };
}

const resultFor = (id: number) => (f: Frame) => f.type === FRAME_OUTBOUND_RESULT && f.streamId === id;

async function openResult(h: Harness, id: number, host = "api.provider.test", port = 443) {
  const from = h.frames.length;
  h.session.handleFrame(outboundOpenFrame(id, { host, port }));
  const f = await h.next(resultFor(id), 3000, from);
  return parseOutboundResult(f.payload)!;
}

describe("hub outbound session", () => {
  it("refuses the wrong port, IP literals and private resolutions without connecting", async () => {
    let connects = 0;
    const port = await upstream(() => connects++);
    const h = harness(port);
    expect(await openResult(h, ID, "api.provider.test", 80)).toEqual({ ok: false, reason: "forbidden-port" });
    expect(await openResult(h, ID + 1, "127.0.0.1")).toEqual({ ok: false, reason: "forbidden-host" });
    expect(await openResult(h, ID + 2, "metadata.internal")).toEqual({ ok: false, reason: "forbidden-host" });

    const priv = harness(port, {}, [PUBLIC_IP, "10.0.0.7"]);
    expect(await openResult(priv, ID, "rebind.example")).toEqual({ ok: false, reason: "forbidden-address" });
    const sixpn = harness(port, {}, ["fdaa:0:1:a7b::2"]);
    expect(await openResult(sixpn, ID, "app.example")).toEqual({ ok: false, reason: "forbidden-address" });
    const nx = harness(port, { resolve: async () => { throw new Error("ENOTFOUND"); } });
    expect(await openResult(nx, ID, "nope.example")).toEqual({ ok: false, reason: "dns-failed" });
    expect(connects).toBe(0);
    expect(h.session.activeStreams()).toBe(0);
  });

  it("caps concurrent streams and the open rate per box", async () => {
    const port = await upstream(() => {});
    const h = harness(port, { maxStreamsPerBox: 2 });
    expect((await openResult(h, ID)).ok).toBe(true);
    expect((await openResult(h, ID + 1)).ok).toBe(true);
    expect(await openResult(h, ID + 2)).toEqual({ ok: false, reason: "too-many-streams" });
    // The cap is per box, so a second tunnel from the same box shares it.
    const second = h.relay.session("home.alice.flagship.services", () => {});
    void second;
    h.session.handleFrame(closeFrame(ID, false));
    expect((await openResult(h, ID + 3)).ok).toBe(true);

    const r = harness(port, { opensPerMinute: 1 });
    expect((await openResult(r, ID)).ok).toBe(true);
    expect(await openResult(r, ID + 1)).toEqual({ ok: false, reason: "rate-limited" });
    expect(await openResult(r, ID)).toEqual({ ok: false, reason: "duplicate-stream" });
  });

  it("splices both ways, respects the box's credit, and logs only totals across all boxes", async () => {
    const big = Buffer.alloc(OUTBOUND_INITIAL_WINDOW * 3, 7);
    const got: Buffer[] = [];
    const port = await upstream((s) => {
      s.on("data", (c) => {
        got.push(c);
        if (Buffer.concat(got).toString() === "hello") s.end(big);
      });
    });
    const h = harness(port);
    expect((await openResult(h, ID)).ok).toBe(true);
    h.session.handleFrame(dataFrame(ID, new TextEncoder().encode("hello")));
    const credit = await h.next((f) => f.type === FRAME_OUTBOUND_CREDIT);
    expect(parseOutboundCredit(credit.payload)).toBe(5);

    // Without more credit the hub stops at exactly one window.
    await new Promise((r) => setTimeout(r, 200));
    const sent = () =>
      h.frames.filter((f) => f.type === FRAME_DATA).reduce((n, f) => n + f.payload.length, 0);
    expect(sent()).toBe(OUTBOUND_INITIAL_WINDOW);
    expect(h.frames.some((f) => f.type === FRAME_CLOSE_REMOTE)).toBe(false);

    // Grant credit until it all arrives, then CLOSE_REMOTE follows the data.
    while (sent() < big.length) {
      h.session.handleFrame(outboundCreditFrame(ID, OUTBOUND_INITIAL_WINDOW));
      await new Promise((r) => setTimeout(r, 50));
    }
    await h.next((f) => f.type === FRAME_CLOSE_REMOTE && f.streamId === ID);
    expect(sent()).toBe(big.length);
    expect(h.session.activeStreams()).toBe(0);
    // Nothing per call: a host, a size and a log timestamp could be matched
    // to one box. Only periodic totals, with no host.
    expect(h.logs).toEqual([]);
    expect(h.relay.flushStats()).toBe(`[outbound-relay] streams=1 to=other:1 up=5 down=${big.length}`);
    expect(h.relay.flushStats()).toBeNull();
    for (const l of h.logs) {
      expect(l).not.toContain("provider");
      expect(l).not.toContain("alice");
      expect(l).not.toContain("hello");
    }
  });

  it("counts known AI providers by name and every other host as other", () => {
    expect(destinationLabel("API.OpenAI.com")).toBe("api.openai.com");
    expect(destinationLabel("my-resource.openai.azure.com")).toBe("azure-openai");
    expect(destinationLabel("bedrock-runtime.us-east-1.amazonaws.com")).toBe("aws");
    expect(destinationLabel("llm.acme-corp.example")).toBe("other");
    expect(destinationLabel("api.openai.com.evil.example")).toBe("other");
  });

  it("drops a stream whose box overruns the window", async () => {
    const port = await upstream(() => {});
    const h = harness(port);
    expect((await openResult(h, ID)).ok).toBe(true);
    h.session.handleFrame(dataFrame(ID, new Uint8Array(OUTBOUND_INITIAL_WINDOW + 1)));
    await h.next((f) => f.type === FRAME_CLOSE_REMOTE && f.streamId === ID);
    expect(h.session.activeStreams()).toBe(0);
  });

  it("closes the upstream when the box closes, and everything when the tunnel drops", async () => {
    const closed: number[] = [];
    let n = 0;
    const port = await upstream((s) => {
      const i = n++;
      s.on("close", () => closed.push(i));
    });
    const h = harness(port);
    expect((await openResult(h, ID)).ok).toBe(true);
    expect((await openResult(h, ID + 1)).ok).toBe(true);
    h.session.handleFrame(closeFrame(ID, false));
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toContain(0);
    h.session.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closed.sort()).toEqual([0, 1]);
    expect(h.session.activeStreams()).toBe(0);
  });

  it("throttles to the per-box byte budget", async () => {
    const payload = Buffer.alloc(200 * 1024, 1);
    const port = await upstream((s) => s.end(payload));
    const h = harness(port, { bytesPerSecond: 400 * 1024, burstBytes: 64 * 1024 });
    const t0 = Date.now();
    expect((await openResult(h, ID)).ok).toBe(true);
    const pump = setInterval(() => h.session.handleFrame(outboundCreditFrame(ID, OUTBOUND_INITIAL_WINDOW)), 20);
    await h.next((f) => f.type === FRAME_CLOSE_REMOTE, 5000);
    clearInterval(pump);
    // 200 KiB minus a 64 KiB burst at 400 KiB/s is at least ~300 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});

import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeFrame, FRAME_OUTBOUND_RESULT, outboundOpenFrame, parseOutboundResult, type Frame } from "@flagship/tunnel-protocol";
import { OutboundRelay } from "../src/tunnel/outboundRelay.js";
import { ComHostPolicy, KnownHostsPolicy, nextUtcMidnight, type HostReportRow } from "../src/tunnel/outboundHostPolicy.js";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function upstream(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer((s) => {
      sockets.push(s);
      s.end();
    });
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as AddressInfo).port));
  });
}

/** A `.com` that answers /check from `blocked` and records what it was sent. */
function fakeCom(blocked: Set<string>, state: { down?: boolean; checks: string[]; reports: HostReportRow[][] } = { checks: [], reports: [] }) {
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (state.down) throw new Error("offline");
    const body = JSON.parse(String(init.body));
    expect(Object.keys(init.headers as object).sort()).toEqual(["content-type", "x-usage-secret"]);
    if (url.endsWith("/api/outbound/check")) {
      state.checks.push(body.host);
      expect(Object.keys(body)).toEqual(["host"]); // only the host is ever sent
      return new Response(JSON.stringify({ allowed: !blocked.has(body.host) }), { status: 200 });
    }
    state.reports.push(body.rows);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, state };
}

function run(policy: ComHostPolicy | KnownHostsPolicy, port: number) {
  const frames: Frame[] = [];
  const relay = new OutboundRelay({
    hostPolicy: policy,
    resolve: async () => ["93.184.215.14"],
    connect: () => netConnect({ host: "127.0.0.1", port }),
    log: () => {},
    statsIntervalMs: 0,
  });
  const session = relay.session("home.alice.flagship.services", (f) => frames.push(f));
  const open = async (id: number, host: string) => {
    const from = frames.length;
    session.handleFrame(outboundOpenFrame(id, { host, port: 443 }));
    for (let i = 0; i < 100; i++) {
      const f = frames.slice(from).find((x) => x.type === FRAME_OUTBOUND_RESULT && x.streamId === id);
      if (f) return parseOutboundResult(f.payload)!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no result");
  };
  return { relay, session, open };
}

const ID = 0x80000001;

describe("outbound host policy", () => {
  it("refuses a host the owner blocked and lets any other through, asking .com once", async () => {
    const port = await upstream();
    const com = fakeCom(new Set(["bad.example.org"]));
    const { open } = run(new ComHostPolicy({ baseUrl: "https://com", secret: "s", fetch: com.fetchFn }), port);
    expect(await open(ID, "bad.example.org")).toEqual({ ok: false, reason: "forbidden-host" });
    expect(await open(ID + 1, "api.newprovider.example.org")).toEqual({ ok: true });
    expect(await open(ID + 2, "api.newprovider.example.org")).toEqual({ ok: true });
    expect(com.state.checks).toEqual(["bad.example.org", "api.newprovider.example.org"]);
  });

  it("with .com unreachable, keeps the last answer and otherwise allows only the known providers", async () => {
    const port = await upstream();
    const com = fakeCom(new Set(), { down: true, checks: [], reports: [] });
    const { open } = run(new ComHostPolicy({ baseUrl: "https://com", secret: "s", fetch: com.fetchFn }), port);
    expect(await open(ID, "api.anthropic.com")).toEqual({ ok: true });
    expect(await open(ID + 1, "api.unheard-of.example.org")).toEqual({ ok: false, reason: "forbidden-host" });
  });

  it("a block is noticed once the short cache runs out", async () => {
    const port = await upstream();
    const blocked = new Set<string>();
    const com = fakeCom(blocked);
    let t = 1_000;
    const policy = new ComHostPolicy({ baseUrl: "https://com", secret: "s", fetch: com.fetchFn, now: () => t });
    const { open } = run(policy, port);
    expect(await open(ID, "api.flip.example.org")).toEqual({ ok: true });
    blocked.add("api.flip.example.org");
    expect(await open(ID + 1, "api.flip.example.org")).toEqual({ ok: true });
    t += 121_000;
    expect(await open(ID + 2, "api.flip.example.org")).toEqual({ ok: false, reason: "forbidden-host" });
  });

  it("without a policy only the known providers get through", async () => {
    const port = await upstream();
    const { open } = run(new KnownHostsPolicy(), port);
    expect(await open(ID, "api.openai.com")).toEqual({ ok: true });
    expect(await open(ID + 1, "evil.example.org")).toEqual({ ok: false, reason: "forbidden-host" });
  });

  it("reports per-host totals with no box in them", async () => {
    const port = await upstream();
    const com = fakeCom(new Set(["bad.example.org"]));
    const { relay, open } = run(new ComHostPolicy({ baseUrl: "https://com", secret: "s", fetch: com.fetchFn }), port);
    await open(ID, "api.openai.com");
    await open(ID + 1, "bad.example.org");
    await new Promise((r) => setTimeout(r, 100));
    relay.flushStats();
    await new Promise((r) => setTimeout(r, 50));
    const rows = com.state.reports.flat();
    expect(rows.find((r) => r.host === "bad.example.org")?.refused).toBe(1);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["down", "host", "refused", "streams", "up"]);
    expect(JSON.stringify(com.state.reports)).not.toContain("alice");
  });

  it("a box asking about too many new names in an hour is refused here, without costing .com a request", async () => {
    const port = await upstream();
    const com = fakeCom(new Set());
    let t = Date.UTC(2026, 9, 20, 10);
    const relay = new OutboundRelay({
      hostPolicy: new ComHostPolicy({ baseUrl: "https://com", secret: "s", fetch: com.fetchFn, now: () => t }),
      resolve: async () => ["93.184.215.14"],
      connect: () => netConnect({ host: "127.0.0.1", port }),
      log: () => {},
      statsIntervalMs: 0,
      newHostsPerHour: 3,
      now: () => t,
    });
    const frames: Frame[] = [];
    const session = relay.session("home.alice.flagship.services", (f) => frames.push(f));
    const open = async (id: number, host: string) => {
      const from = frames.length;
      session.handleFrame(outboundOpenFrame(id, { host, port: 443 }));
      for (let i = 0; i < 100; i++) {
        const f = frames.slice(from).find((x) => x.type === FRAME_OUTBOUND_RESULT && x.streamId === id);
        if (f) {
          session.handleFrame(closeFrame(id, false));
          return parseOutboundResult(f.payload)!;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("no result");
    };
    for (let i = 0; i < 3; i++) expect((await open(ID + i, `a${i}.example.org`)).ok).toBe(true);
    const checks = com.state.checks.length;
    expect(await open(ID + 10, "a3.example.org")).toEqual({ ok: false, reason: "forbidden-host" });
    expect(await open(ID + 11, "a4.example.org")).toEqual({ ok: false, reason: "forbidden-host" });
    expect(com.state.checks.length).toBe(checks);
    // A name already asked about, and a known provider, still go through.
    expect((await open(ID + 12, "a1.example.org")).ok).toBe(true);
    expect((await open(ID + 13, "api.anthropic.com")).ok).toBe(true);
    // An hour later the box has a new allowance.
    t += 3_600_001;
    expect((await open(ID + 14, "a3.example.org")).ok).toBe(true);
  });

  it("once .com says today's new-host cap is reached, unseen names are refused here until 00:00 UTC", async () => {
    let t = Date.UTC(2026, 9, 20, 22);
    const checks: string[] = [];
    const policy = new ComHostPolicy({
      baseUrl: "https://com",
      secret: "s",
      now: () => t,
      fetch: (async (_u: string, init: RequestInit) => {
        const host = JSON.parse(String(init.body)).host as string;
        checks.push(host);
        return new Response(JSON.stringify(host === "known.example.org" ? { allowed: true } : { allowed: false, reason: "new-host-cap" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await policy.allowed("known.example.org")).toBe(true);
    expect(await policy.allowed("new1.example.org")).toBe(false);
    const asked = checks.length;
    for (let i = 0; i < 50; i++) expect(await policy.allowed(`new${i + 2}.example.org`)).toBe(false);
    expect(checks.length).toBe(asked);
    // A name `.com` answered for still has its answer, and the known providers are not affected.
    expect(await policy.allowed("known.example.org")).toBe(true);
    // A known provider is still put to `.com` (in this fake it says no, which is the fake's doing).
    await policy.allowed("api.openai.com");
    expect(checks.length).toBe(asked + 1);
    t = nextUtcMidnight(t) + 1;
    await policy.allowed("new-day.example.org");
    expect(checks.length).toBe(asked + 2);
  });
});

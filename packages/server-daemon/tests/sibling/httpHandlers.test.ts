import { describe, expect, it } from "vitest";
import { InMemoryAppAuthTokens } from "../../src/serviceAuthToken.js";
import { buildSiblingHttpHandlers } from "../../src/sibling/httpHandlers.js";
import { InMemorySiblingRouter, type SiblingTransport } from "../../src/sibling/router.js";
import type { HttpRequest } from "../../src/runtime.js";

const HOME = "home.alice.flagship.services";
const OFFICE = "office.alice.flagship.services";
const GARAGE = "garage.alice.flagship.services";

interface RecordingTransport extends SiblingTransport {
  sent: Array<{
    serviceId: string;
    fromSiblingId: string;
    toSiblingId: string;
    payloadHex: string;
  }>;
}

function recordingTransport(): RecordingTransport {
  const sent: RecordingTransport["sent"] = [];
  return {
    sent,
    async send(args) {
      sent.push({ ...args });
    },
  };
}

async function setup(opts: { offlineSibling?: boolean } = {}) {
  const tokens = new InMemoryAppAuthTokens();
  const tokenA = await tokens.mint("app-a");
  const tokenB = await tokens.mint("app-b");
  const router = new InMemorySiblingRouter();
  const transport = recordingTransport();
  router.setSibling({
    siblingId: OFFICE,
    fqdns: [OFFICE, "*.office.alice.flagship.services"],
    online: !opts.offlineSibling,
    transport: opts.offlineSibling ? null : transport,
  });
  router.setSibling({
    siblingId: GARAGE,
    fqdns: [GARAGE],
    online: false,
    transport: null,
  });
  const handle = buildSiblingHttpHandlers({
    router,
    appAuthTokens: tokens,
    thisSiblingId: HOME,
    pollWaitMs: 100,
  });
  return { handle, router, transport, tokenA, tokenB, tokens };
}

function req(opts: {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}): HttpRequest {
  return {
    method: opts.method,
    path: opts.path,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: Buffer.from(opts.body !== undefined ? JSON.stringify(opts.body) : ""),
  };
}

describe("/api/live_siblings/list", () => {
  it("returns the registered siblings (token-gated)", async () => {
    const s = await setup();
    const r = await s.handle(req({ method: "GET", path: "/api/live_siblings/list", token: s.tokenA }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body));
    const ids = body.siblings.map((x: { siblingId: string }) => x.siblingId).sort();
    expect(ids).toEqual([GARAGE, OFFICE].sort());
    const office = body.siblings.find((x: { siblingId: string }) => x.siblingId === OFFICE);
    expect(office.online).toBe(true);
    expect(office.fqdns).toContain(OFFICE);
  });

  it("rejects missing app token", async () => {
    const s = await setup();
    const r = await s.handle(req({ method: "GET", path: "/api/live_siblings/list" }));
    expect(r?.status).toBe(401);
  });
});

describe("/api/live_siblings/send", () => {
  it("routes a payload to the named sibling under the calling app's id", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/live_siblings/send",
        token: s.tokenA,
        body: { toSiblingId: OFFICE, payloadHex: "deadbeef" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.transport.sent).toEqual([
      {
        serviceId: "app-a",
        fromSiblingId: HOME,
        toSiblingId: OFFICE,
        payloadHex: "deadbeef",
      },
    ]);
  });

  it("does NOT let app B send under app A's identity (token = scope)", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/live_siblings/send",
        token: s.tokenB,
        body: { toSiblingId: OFFICE, payloadHex: "" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.transport.sent[0]!.serviceId).toBe("app-b");
  });

  it("returns 404 for unknown sibling", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/live_siblings/send",
        token: s.tokenA,
        body: { toSiblingId: "ghost.alice.flagship.services", payloadHex: "" },
      }),
    );
    expect(r?.status).toBe(404);
  });

  it("returns 503 for an offline sibling", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/live_siblings/send",
        token: s.tokenA,
        body: { toSiblingId: GARAGE, payloadHex: "" },
      }),
    );
    expect(r?.status).toBe(503);
  });

  it("rejects malformed payload hex", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/live_siblings/send",
        token: s.tokenA,
        body: { toSiblingId: OFFICE, payloadHex: "ZZ" },
      }),
    );
    expect(r?.status).toBe(400);
  });
});

describe("/api/live_siblings/poll", () => {
  it("returns immediately with the buffered app-message event once one arrives", async () => {
    const s = await setup();
    // Pre-buffer an event by issuing a poll, then injecting after.
    const pending = s.handle(
      req({ method: "GET", path: "/api/live_siblings/poll", token: s.tokenA }),
    );
    // Give the poll a tick to register its resolver.
    await new Promise((r) => setTimeout(r, 10));
    s.router.ingestFromSibling({
      fromSiblingId: OFFICE,
      serviceId: "app-a",
      payloadHex: "01",
    });
    const r = await pending;
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body));
    expect(body.events).toEqual([
      { kind: "app-message", fromSiblingId: OFFICE, payloadHex: "01" },
    ]);
  });

  it("does NOT deliver app A's traffic to app B (route by serviceId)", async () => {
    const s = await setup();
    const pendingB = s.handle(
      req({ method: "GET", path: "/api/live_siblings/poll", token: s.tokenB }),
    );
    await new Promise((r) => setTimeout(r, 10));
    s.router.ingestFromSibling({
      fromSiblingId: OFFICE,
      serviceId: "app-a", // routed to app-a's subscriber, not app-b's
      payloadHex: "01",
    });
    const r = await pendingB;
    const body = JSON.parse(String(r!.body));
    expect(body.events).toEqual([]);
  });

  it("times out empty when no events arrive within pollWaitMs", async () => {
    const s = await setup();
    const r = await s.handle(req({ method: "GET", path: "/api/live_siblings/poll", token: s.tokenA }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body));
    expect(body.events).toEqual([]);
  });

  it("fans out a domain-granted event to ALL apps regardless of serviceId", async () => {
    const s = await setup();
    // Both apps poll concurrently.
    const pendingA = s.handle(
      req({ method: "GET", path: "/api/live_siblings/poll", token: s.tokenA }),
    );
    const pendingB = s.handle(
      req({ method: "GET", path: "/api/live_siblings/poll", token: s.tokenB }),
    );
    await new Promise((r) => setTimeout(r, 10));
    s.router.broadcastDomainGranted({
      fqdn: "notes.alice.flagship.services",
      ownerSiblingId: OFFICE,
    });
    const [rA, rB] = await Promise.all([pendingA, pendingB]);
    const expected = {
      kind: "domain-granted",
      fqdn: "notes.alice.flagship.services",
      ownerSiblingId: OFFICE,
    };
    expect(JSON.parse(String(rA!.body)).events).toEqual([expected]);
    expect(JSON.parse(String(rB!.body)).events).toEqual([expected]);
  });
});

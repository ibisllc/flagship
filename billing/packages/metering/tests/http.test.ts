import { describe, expect, it } from "vitest";
import { bearerAuth, createReportHandler, sendBatch } from "../src/http.js";
import { InMemoryMeterStore, LeaseBook, type MeterCatalog, type MeterLeasePolicy } from "../src/index.js";

const NOW = Date.UTC(2026, 9, 14, 12);
const ID = "0123456789abcdef0123456789abcdef";
const URL_ = "https://central.example/usage/report";

const catalog: MeterCatalog<"bandwidth" | "tokens", "basic" | "pro"> = {
  bandwidth: {
    unit: "bytes",
    period: "month",
    plans: { basic: { allowance: 1000, over: "throttle" }, pro: { allowance: 10_000, over: "allow" } },
  },
  tokens: { unit: "tokens", period: "day", plans: { basic: { allowance: 10, over: "stop" }, pro: { allowance: 100, over: "stop" } } },
};
const policy: MeterLeasePolicy = { fraction: 0.5, minGrant: 10, maxGrant: 400, ttlMs: 60_000, overTtlMs: 5_000 };

function setup(over: Partial<Parameters<typeof createReportHandler>[0]> = {}) {
  const store = new InMemoryMeterStore();
  const handler = createReportHandler({
    deps: { catalog, store, planOf: async (a) => (a === "pro" ? "pro" : "basic"), now: () => NOW },
    lease: policy,
    authorize: bearerAuth("s3cret"),
    ...over,
  });
  return { store, handler };
}

const post = (body: unknown, auth = "Bearer s3cret") =>
  new Request(URL_, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("createReportHandler", () => {
  it("counts a report once and answers a lease per account", async () => {
    const { store, handler } = setup();
    const body = {
      batchId: ID,
      items: [
        { account: "ann", resource: "bandwidth", amount: 600 },
        { account: "pro", resource: "bandwidth", amount: 5 },
        { account: "ann", resource: "bandwidth", amount: 100 },
      ],
    };
    const r = await handler(post(body));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({
      duplicate: false,
      results: [
        {
          account: "ann",
          resource: "bandwidth",
          action: "allow",
          used: 700,
          allowance: 1000,
          resetsAt: Date.UTC(2026, 10, 1),
          lease: { action: "allow", grant: 150, policy: "throttle", ttlMs: 60_000 },
        },
        {
          account: "pro",
          resource: "bandwidth",
          action: "allow",
          used: 5,
          allowance: 10_000,
          resetsAt: Date.UTC(2026, 10, 1),
          lease: { action: "allow", grant: 400, policy: "allow", ttlMs: 60_000 },
        },
      ],
    });
    const again = await (await handler(post(body))).json();
    expect(again.duplicate).toBe(true);
    expect((await store.get("ann", "bandwidth", "2026-10"))?.amount).toBe(700);
  });

  it("answers a throttle lease past the allowance", async () => {
    const { handler } = setup();
    const j = await (await handler(post({ batchId: ID, items: [{ account: "ann", resource: "bandwidth", amount: 1500 }] }))).json();
    expect(j.results[0].action).toBe("throttle");
    expect(j.results[0].lease).toEqual({ action: "throttle", grant: 0, policy: "throttle", ttlMs: 5_000 });
  });

  it("refuses what it must", async () => {
    const { handler } = setup();
    const ok = { batchId: ID, items: [{ account: "ann", resource: "bandwidth", amount: 1 }] };
    expect((await handler(new Request(URL_))).status).toBe(405);
    expect((await handler(post(ok, "Bearer nope"))).status).toBe(401);
    expect((await handler(post(ok, ""))).status).toBe(401);
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(post({ items: ok.items }))).status).toBe(400);
    expect((await handler(post({ batchId: "short", items: ok.items }))).status).toBe(400);
    expect((await handler(post({ batchId: ID, items: [{ account: "ann", resource: "disk", amount: 1 }] }))).status).toBe(400);
    expect((await handler(post({ batchId: ID, items: [{ account: "ann", resource: "toString", amount: 1 }] }))).status).toBe(400);
    expect((await handler(post({ batchId: ID, items: [{ account: "ann", resource: "bandwidth", amount: -1 }] }))).status).toBe(400);
    expect((await handler(post({ batchId: ID, items: [{ account: "", resource: "bandwidth", amount: 1 }] }))).status).toBe(400);
    const many = { batchId: ID, items: Array.from({ length: 501 }, () => ok.items[0]) };
    expect((await handler(post(many))).status).toBe(400);
    const { handler: small } = setup({ maxBodyBytes: 64 });
    expect((await small(post(ok))).status).toBe(413);
  });

  it("accepts reports without an id only when told to", async () => {
    const { handler } = setup({ requireBatchId: false });
    const r = await handler(post({ items: [{ account: "ann", resource: "tokens", amount: 3 }] }));
    expect(r.status).toBe(200);
  });

  it("turns a store failure into a 500 the edge retries", async () => {
    const errors: unknown[] = [];
    const store = new InMemoryMeterStore();
    store.addBatch = async () => {
      throw new Error("db down");
    };
    const handler = createReportHandler({
      deps: { catalog, store, planOf: async () => "basic" as const, now: () => NOW },
      lease: () => policy,
      authorize: () => true,
      onError: (e) => errors.push(e),
    });
    const r = await handler(post({ batchId: ID, items: [{ account: "ann", resource: "bandwidth", amount: 1 }] }));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "internal" });
    expect(errors).toHaveLength(1);
  });
});

describe("bearerAuth", () => {
  it("accepts any listed secret, so one can be rotated", () => {
    const auth = bearerAuth("old", "new");
    const req = (h: string) => new Request(URL_, { headers: { authorization: h } });
    expect(auth(req("Bearer old"))).toBe(true);
    expect(auth(req("bearer new"))).toBe(true);
    expect(auth(req("Bearer older"))).toBe(false);
    expect(auth(req("Basic old"))).toBe(false);
    expect(() => bearerAuth("")).toThrow(RangeError);
  });
});

describe("sendBatch", () => {
  function edge() {
    return new LeaseBook({ initialGrant: 100, unknownPolicy: "throttle", newBatchId: () => ID });
  }

  it("settles the book from the handler's answer", async () => {
    const { handler } = setup();
    const book = edge();
    book.use("ann", 950, NOW);
    expect(book.action("ann")).toBe("throttle");
    const batch = book.takeBatch(NOW, "all")!;
    const out = await sendBatch(book, batch, {
      url: URL_,
      resource: "bandwidth",
      headers: { authorization: "Bearer s3cret" },
      fetch: (u, init) => handler(new Request(u, init)),
      now: () => NOW,
    });
    expect(out).toBe("settled");
    expect(book.action("ann")).toBe("allow");
    book.use("ann", 20, NOW);
    expect(book.action("ann")).toBe("allow");
    book.use("ann", 5, NOW);
    expect(book.action("ann")).toBe("throttle");
  });

  it("keeps the batch for a retry on network errors and 5xx, drops it on 4xx", async () => {
    const book = edge();
    const opts = (fetch: (u: string, i: RequestInit) => Promise<Response>) => ({ url: URL_, resource: "bandwidth", fetch, now: () => NOW });
    book.use("ann", 10, NOW);
    let b = book.takeBatch(NOW, "all")!;
    expect(await sendBatch(book, b, opts(async () => { throw new TypeError("fetch failed"); }))).toBe("retry");
    expect(book.centralUnreachable).toBe(true);
    b = book.takeBatch(NOW + 60_000, "all")!;
    expect(b.id).toBe(ID);
    expect(b.attempts).toBe(2);
    expect(await sendBatch(book, b, opts(async () => new Response("", { status: 503 })))).toBe("retry");
    b = book.takeBatch(NOW + 120_000, "all")!;
    expect(await sendBatch(book, b, opts(async () => new Response("{}", { status: 400 })))).toBe("dropped");
    expect(book.droppedBatches).toBe(1);
  });
});

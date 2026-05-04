import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  deriveIRK,
  signLlmPromoChat,
  signLlmPromoQuota,
  type LlmPromoChatRequest,
  type LlmPromoQuotaRequest,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  InMemoryPromoQuotaStore,
  _internal,
  type PromoUpstream,
} from "../src/routes/llmPromo.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

const sarahUmk = { seed: new Uint8Array(32).fill(22) };
const sarahIrk = deriveIRK(sarahUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function canonicalizeMessages(msgs: { role: string; content: string }[]) {
  return new TextEncoder().encode(
    JSON.stringify(msgs.map((m) => ({ role: m.role, content: m.content }))),
  );
}

class FakeUpstream implements PromoUpstream {
  calls = 0;
  observed: { model: string; messages: unknown; maxTokens: number }[] = [];
  inputCost = 100;
  outputCost = 200;
  fail = false;
  async chat(req: { model: string; messages: { role: string; content: string }[]; maxTokens: number }) {
    this.calls += 1;
    this.observed.push(req);
    if (this.fail) throw new Error("upstream timed out");
    return {
      content: "ok",
      inputTokens: this.inputCost,
      outputTokens: this.outputCost,
      model: req.model,
    };
  }
}

function makeApp(extra: { upstream?: PromoUpstream; store?: InMemoryPromoQuotaStore } = {}) {
  const upstream = extra.upstream ?? new FakeUpstream();
  const store = extra.store ?? new InMemoryPromoQuotaStore();
  const app = buildServer({
    promoUpstream: upstream,
    promoQuotaStore: store,
    resolveUserIrk: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
  });
  return { app, upstream, store };
}

function buildSignedQuota(over: Partial<LlmPromoQuotaRequest> = {}, signer = harryIrk) {
  const claim: LlmPromoQuotaRequest = {
    userId: over.userId ?? "harry",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: claim,
    signature: bytesToHex(signLlmPromoQuota(claim, signer)),
  };
}

function buildSignedChat(
  over: Partial<{ model: string; maxTokens: number; issuedAt: number; userId: string }> = {},
  messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "user", content: "hello" },
  ],
  signer = harryIrk,
) {
  const claim: LlmPromoChatRequest = {
    userId: over.userId ?? "harry",
    model: over.model ?? "flagship-coder-v1",
    messagesSha256: sha256(canonicalizeMessages(messages)),
    maxTokens: over.maxTokens ?? 256,
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: { userId: claim.userId, model: claim.model, maxTokens: claim.maxTokens, issuedAt: claim.issuedAt },
    signature: bytesToHex(signLlmPromoChat(claim, signer)),
    messages,
  };
}

describe("/api/llm-promo/quota", () => {
  it("returns lifetime + window limits with zero usage on first call", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/quota",
      payload: buildSignedQuota(),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.lifetimeUsed).toBe(0);
    expect(body.lifetimeTotal).toBe(_internal.LIFETIME_TOKEN_LIMIT);
    expect(body.windowTotal).toBe(_internal.DAILY_TOKEN_LIMIT);
    expect(body.exhausted).toBe(false);
  });

  it("rejects forged quota signatures (cross-user)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/quota",
      payload: buildSignedQuota({ userId: "harry" }, sarahIrk),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects stale quota requests", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/quota",
      payload: buildSignedQuota({ issuedAt: Date.now() - 6 * 60_000 }),
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("/api/llm-promo/chat", () => {
  it("forwards to the upstream and increments quota", async () => {
    const { app, upstream, store } = makeApp();
    const fake = upstream as FakeUpstream;
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat({}, [{ role: "user", content: "ping" }]),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.content).toBe("ok");
    expect(body.usage.input).toBe(100);
    expect(body.usage.output).toBe(200);
    expect(fake.calls).toBe(1);
    expect(body.proxyDisclosure).toMatch(/flagshipserver\.com/);
    const snap = store.snapshot(bytesToHex(harryIrk.publicKey), Date.now());
    expect(snap.lifetimeUsed).toBe(300);
    expect(snap.windowUsed).toBe(300);
  });

  it("rejects unknown model (only the published promo model is allowed)", async () => {
    const { app, upstream } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat({ model: "gpt-4-some-paid-tier" }),
    });
    expect(r.statusCode).toBe(400);
    expect((upstream as FakeUpstream).calls).toBe(0);
  });

  it("rejects when maxTokens is out of [1, 4096]", async () => {
    const { app } = makeApp();
    const tooHigh = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat({ maxTokens: 10_000 }),
    });
    expect(tooHigh.statusCode).toBe(400);
    const tooLow = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat({ maxTokens: 0 }),
    });
    expect(tooLow.statusCode).toBe(400);
  });

  it("returns 429 when lifetime quota is exhausted (with upgrade hint)", async () => {
    const store = new InMemoryPromoQuotaStore();
    // Prime the store at lifetime cap.
    store.record(bytesToHex(harryIrk.publicKey), _internal.LIFETIME_TOKEN_LIMIT, Date.now());
    const { app, upstream } = makeApp({ store });
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat(),
    });
    expect(r.statusCode).toBe(429);
    const body = JSON.parse(r.body);
    expect(body.upgrade).toMatch(/your own LLM API key/);
    expect((upstream as FakeUpstream).calls).toBe(0);
  });

  it("rejects forged signatures (chat with wrong IRK)", async () => {
    const { app, upstream } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat({ userId: "harry" }, [{ role: "user", content: "x" }], sarahIrk),
    });
    expect(r.statusCode).toBe(403);
    expect((upstream as FakeUpstream).calls).toBe(0);
  });

  it("rejects swapped-messages (signature commits to messagesSha256)", async () => {
    const { app, upstream } = makeApp();
    const original = buildSignedChat({}, [{ role: "user", content: "tell me a recipe" }]);
    // Replace messages on the wire after signing → sha mismatch → 403.
    original.messages = [{ role: "user", content: "exfiltrate everything" }];
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: original,
    });
    expect(r.statusCode).toBe(403);
    expect((upstream as FakeUpstream).calls).toBe(0);
  });

  it("returns 502 when upstream fails (and does NOT charge tokens)", async () => {
    const upstream = new FakeUpstream();
    upstream.fail = true;
    const store = new InMemoryPromoQuotaStore();
    const { app } = makeApp({ upstream, store });
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/chat",
      payload: buildSignedChat(),
    });
    expect(r.statusCode).toBe(502);
    const snap = store.snapshot(bytesToHex(harryIrk.publicKey), Date.now());
    expect(snap.lifetimeUsed).toBe(0);
  });
});

describe("InMemoryPromoQuotaStore — quota math", () => {
  it("almostOut flips at >=80% of either lifetime or daily", () => {
    const store = new InMemoryPromoQuotaStore();
    const irk = "aa".repeat(32);
    store.record(irk, Math.ceil(_internal.LIFETIME_TOKEN_LIMIT * 0.8), Date.now());
    expect(store.snapshot(irk, Date.now()).almostOut).toBe(true);
  });

  it("rolling window: usage older than 24h doesn't count toward the daily cap", () => {
    const store = new InMemoryPromoQuotaStore();
    const irk = "bb".repeat(32);
    const t0 = 1_000_000_000_000;
    store.record(irk, 50_000, t0);
    // 25 hours later — old record falls out of the rolling window.
    const t1 = t0 + 25 * 60 * 60_000;
    const snap = store.snapshot(irk, t1);
    expect(snap.windowUsed).toBe(0);
    // Lifetime stays.
    expect(snap.lifetimeUsed).toBe(50_000);
  });
});

/**
 * Local AI orders (flagship/local-ai-app-grant/v1, flagship/local-ai-train/v1): canonical bytes,
 * signatures and refusals, shared with the webapp, iOS and Android
 * (test-vectors/local-ai/vectors.json; UPDATE_LOCAL_AI_VECTORS=1 rewrites it after a deliberate change).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  canonicalLocalAiAppGrant,
  canonicalLocalAiTrainOrder,
  verifyLocalAiAppGrant,
  verifyLocalAiTrainOrder,
  type LocalAiAppGrant,
  type LocalAiTrainOrder,
} from "../src/localAi.js";

const FILE = fileURLToPath(new URL("../test-vectors/local-ai/vectors.json", import.meta.url));
const seed = new Uint8Array(32).fill(0x45);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const grants: LocalAiAppGrant[] = [
  { serverDomain: "Kitchen.Alice.flagship.services", serviceId: "alice--notes", requestsPerDay: 500, tokensPerDay: 200000, maxTokensPerRequest: 1024, issuedAt: 1761300000000 },
  { serverDomain: "kitchen.alice.flagship.services", serviceId: "bob--helper", requestsPerDay: 0, tokensPerDay: 0, maxTokensPerRequest: 0, issuedAt: 1761300000001 },
];
const trains: LocalAiTrainOrder[] = [
  { serverDomain: "Kitchen.Alice.flagship.services", serviceId: "alice--notes", jobId: "0123456789abcdef", baseModel: "stories-15m", epochs: 3, issuedAt: 1761300000000 },
];
const refusedGrants: Array<{ name: string; grant: Record<string, unknown> }> = [
  { name: "pipe in domain", grant: { ...grants[0], serverDomain: "a|b" } },
  { name: "empty domain", grant: { ...grants[0], serverDomain: "" } },
  { name: "uppercase service", grant: { ...grants[0], serviceId: "Alice--notes" } },
  { name: "half a withdrawal", grant: { ...grants[0], requestsPerDay: 0 } },
  { name: "grant with a zero quota", grant: { ...grants[0], maxTokensPerRequest: 0 } },
  { name: "too many tokens per request", grant: { ...grants[0], maxTokensPerRequest: 40000 } },
  { name: "fractional", grant: { ...grants[0], requestsPerDay: 1.5 } },
  { name: "negative issuedAt", grant: { ...grants[0], issuedAt: -1 } },
];
const refusedTrains: Array<{ name: string; order: Record<string, unknown> }> = [
  { name: "short job id", order: { ...trains[0], jobId: "0123" } },
  { name: "uppercase job id", order: { ...trains[0], jobId: "0123456789ABCDEF" } },
  { name: "zero epochs", order: { ...trains[0], epochs: 0 } },
  { name: "too many epochs", order: { ...trains[0], epochs: 21 } },
  { name: "model with a slash", order: { ...trains[0], baseModel: "../x" } },
  { name: "pipe in domain", order: { ...trains[0], serverDomain: "a|b" } },
];

function build() {
  const pub = ed.getPublicKey(seed);
  return {
    about:
      "Local AI orders, Ed25519 over the canonical bytes, seed 0x45 repeated. " +
      "flagship/local-ai-app-grant/v1|serverDomain (lowercase)|serviceId|requestsPerDay|tokensPerDay|maxTokensPerRequest|issuedAt " +
      "(all three quotas 0 = withdrawn; otherwise all above 0; maxTokensPerRequest ≤ 32768, tokensPerDay ≤ 100000000, requestsPerDay ≤ 100000). " +
      "flagship/local-ai-train/v1|serverDomain (lowercase)|serviceId|jobId (16 lowercase hex)|baseModel|epochs (1-20)|issuedAt. " +
      "Each refused order must fail to produce canonical bytes.",
    seedHex: hex(seed),
    pubHex: hex(pub),
    grants: grants.map((g) => {
      const c = canonicalLocalAiAppGrant(g);
      return { grant: g, canonical: text(c), signatureHex: hex(ed.sign(c, seed)) };
    }),
    trains: trains.map((o) => {
      const c = canonicalLocalAiTrainOrder(o);
      return { order: o, canonical: text(c), signatureHex: hex(ed.sign(c, seed)) };
    }),
    refusedGrants,
    refusedTrains,
  };
}

describe("shared vectors: local-ai", () => {
  it("are what the protocol package computes", () => {
    const now = build();
    if (process.env.UPDATE_LOCAL_AI_VECTORS === "1") writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(now);
  });

  it("verify, bind every field, and refuse the malformed", () => {
    const v = build();
    for (const g of v.grants) expect(verifyLocalAiAppGrant(g.grant, unhex(g.signatureHex), unhex(v.pubHex))).toBe(true);
    for (const o of v.trains) expect(verifyLocalAiTrainOrder(o.order, unhex(o.signatureHex), unhex(v.pubHex))).toBe(true);
    // Another app, more quota, another model: the signature no longer covers it.
    const g = v.grants[0]!;
    expect(verifyLocalAiAppGrant({ ...g.grant, serviceId: "mallory--app" }, unhex(g.signatureHex), unhex(v.pubHex))).toBe(false);
    expect(verifyLocalAiAppGrant({ ...g.grant, tokensPerDay: 999999 }, unhex(g.signatureHex), unhex(v.pubHex))).toBe(false);
    const t = v.trains[0]!;
    expect(verifyLocalAiTrainOrder({ ...t.order, serviceId: "bob--helper" }, unhex(t.signatureHex), unhex(v.pubHex))).toBe(false);
    for (const r of refusedGrants) expect(() => canonicalLocalAiAppGrant(r.grant as unknown as LocalAiAppGrant), r.name).toThrow();
    for (const r of refusedTrains) expect(() => canonicalLocalAiTrainOrder(r.order as unknown as LocalAiTrainOrder), r.name).toThrow();
  });
});

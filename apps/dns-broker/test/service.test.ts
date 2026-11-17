import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";

import handler from "../src/index.js";
import {
  challengeHostOf,
  checkChallengeCreate,
  deleteStaleChallenges,
  handleServiceRequest,
  MAX_PER_NAME,
  type ServiceEnv,
  type ZoneApi,
  type ZoneRecord,
} from "../src/service.js";

const APEX = "flagship.services";
const SECRET = "x".repeat(48);
const THUMB = "Z".repeat(43);
const TOKEN = "tok_" + "a".repeat(39);

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const valueFor = (token: string, thumb: string) => b64url(sha256(new TextEncoder().encode(`${token}.${thumb}`)));
const VALUE = valueFor(TOKEN, THUMB);

class FakeZone implements ZoneApi {
  records: ZoneRecord[] = [];
  private n = 0;
  async list(o: { name?: string; type?: string } = {}) {
    return this.records.filter((r) => (!o.name || r.name === o.name) && (!o.type || r.type === o.type));
  }
  async get(id: string) {
    return this.records.find((r) => r.id === id) ?? null;
  }
  async createTxt(name: string, value: string) {
    const r = { id: `r${++this.n}`, type: "TXT", name, content: value, created_on: new Date().toISOString() };
    this.records.push(r);
    return r;
  }
  async delete(id: string) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length < before;
  }
}

const env = (extra: Partial<ServiceEnv> = {}): ServiceEnv => ({ DNS_BROKER_SECRET: SECRET, FLAGSHIP_APEX: APEX, ACME_ACCOUNT_THUMBPRINTS: THUMB, ...extra });
const req = (body: unknown, secret: string | null = SECRET) =>
  new Request("https://broker.test/service", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  });
const call = async (zone: ZoneApi, body: unknown, e = env(), secret: string | null = SECRET) => {
  const res = await handleServiceRequest(req(body, secret), e, zone);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe("which names the issuance service may write", () => {
  it("allows the account and box challenge names and one label more, nothing else", () => {
    expect(challengeHostOf(`_acme-challenge.alice.${APEX}`, APEX)).toBe(`alice.${APEX}`);
    expect(challengeHostOf(`_acme-challenge.home.alice.${APEX}`, APEX)).toBe(`home.alice.${APEX}`);
    expect(challengeHostOf(`_acme-challenge.app.home.alice.${APEX}.`, APEX)).toBe(`app.home.alice.${APEX}`);
    for (const bad of [
      `_acme-challenge.${APEX}`, // the apex: would validate *.flagship.services
      `_acme-challenge.a.b.home.alice.${APEX}`,
      `_acme-challenge.tunnel.${APEX}`,
      `_acme-challenge.iad1.tunnel.${APEX}`,
      `_acme-challenge.x.gym.${APEX}`,
      `_acme-challenge.www.${APEX}`,
      `alice.${APEX}`,
      `_acme-challenge.alice.${APEX}.evil.com`,
      `_acme-challenge.alice.example.com`,
      `_acme-challenge.al_ice.${APEX}`,
      `_acme-challenge.-a.alice.${APEX}`,
    ]) {
      expect(challengeHostOf(bad, APEX), bad).toBeNull();
    }
  });

  it("needs a DNS-01 digest and, with pinned accounts, the token of one of them", () => {
    const name = `_acme-challenge.alice.${APEX}`;
    expect(checkChallengeCreate({ name, value: VALUE, token: TOKEN }, APEX, [THUMB])).toEqual({ ok: true, recordName: name, value: VALUE });
    expect(checkChallengeCreate({ name, value: VALUE }, APEX, [THUMB]).ok).toBe(false);
    expect(checkChallengeCreate({ name, value: valueFor(TOKEN, "Q".repeat(43)), token: TOKEN }, APEX, [THUMB]).ok).toBe(false);
    expect(checkChallengeCreate({ name, value: VALUE, token: TOKEN }, APEX, ["Q".repeat(43), THUMB]).ok).toBe(true);
    expect(checkChallengeCreate({ name, value: "v=spf1 -all" }, APEX, []).ok).toBe(false);
    expect(checkChallengeCreate({ name, value: VALUE }, APEX, []).ok).toBe(true);
    expect(checkChallengeCreate({ name: `_acme-challenge.${APEX}`, value: VALUE, token: TOKEN }, APEX, [THUMB]).ok).toBe(false);
  });
});

describe("POST /service", () => {
  it("refuses a caller without the secret, a wrong one, and any caller when the broker's secret is short or unset", async () => {
    const zone = new FakeZone();
    const body = { op: "challenge.create", name: `_acme-challenge.alice.${APEX}`, value: VALUE, token: TOKEN };
    expect((await call(zone, body, env(), null)).status).toBe(401);
    expect((await call(zone, body, env(), "y".repeat(48))).status).toBe(401);
    expect((await call(zone, body, env({ DNS_BROKER_SECRET: "short" }), "short")).status).toBe(401);
    expect((await call(zone, body, env({ DNS_BROKER_SECRET: undefined }), SECRET)).status).toBe(401);
    expect(zone.records).toEqual([]);
  });

  it("creates a challenge record, is idempotent, and caps the records at a name", async () => {
    const zone = new FakeZone();
    const name = `_acme-challenge.alice.${APEX}`;
    const first = await call(zone, { op: "challenge.create", name, value: VALUE, token: TOKEN });
    expect(first).toEqual({ status: 200, json: { ok: true, recordId: "r1" } });
    expect((await call(zone, { op: "challenge.create", name, value: VALUE, token: TOKEN })).json).toMatchObject({ ok: true, recordId: "r1", idempotent: true });
    for (let i = 1; i < MAX_PER_NAME; i++) {
      const t = `tok_${i}`.padEnd(43, "b");
      expect((await call(zone, { op: "challenge.create", name, value: valueFor(t, THUMB), token: t })).status).toBe(200);
    }
    const t = "tok_over".padEnd(43, "c");
    expect((await call(zone, { op: "challenge.create", name, value: valueFor(t, THUMB), token: t })).status).toBe(429);
    expect(zone.records).toHaveLength(MAX_PER_NAME);
  });

  it("refuses names and values outside the policy with a body that says nothing", async () => {
    const zone = new FakeZone();
    const r = await call(zone, { op: "challenge.create", name: `_acme-challenge.${APEX}`, value: VALUE, token: TOKEN });
    expect(r).toEqual({ status: 403, json: { ok: false } });
    expect((await call(zone, { op: "publishARecord" })).status).toBe(400);
    expect((await call(zone, ["challenge.create"])).status).toBe(400);
    expect(zone.records).toEqual([]);
  });

  it("deletes only challenge TXT records under the apex", async () => {
    const zone = new FakeZone();
    zone.records.push(
      { id: "wild", type: "A", name: `*.${APEX}`, content: "149.248.216.86" },
      { id: "caa", type: "CAA", name: APEX, content: '0 issue "letsencrypt.org"' },
      { id: "txt", type: "TXT", name: `alice.${APEX}`, content: "hello" },
      { id: "ch", type: "TXT", name: `_acme-challenge.alice.${APEX}`, content: VALUE },
    );
    for (const id of ["wild", "caa", "txt"]) expect((await call(zone, { op: "challenge.delete", id })).status).toBe(403);
    expect((await call(zone, { op: "challenge.delete", id: "ch" })).json).toEqual({ ok: true, deleted: true });
    expect((await call(zone, { op: "challenge.delete", id: "ch" })).json).toMatchObject({ ok: true, missing: true });
    expect((await call(zone, { op: "challenge.delete", id: "../x" })).status).toBe(400);
    expect(zone.records.map((r) => r.id)).toEqual(["wild", "caa", "txt"]);
  });

  it("reads the zone for zone-health and the reap plan", async () => {
    const zone = new FakeZone();
    zone.records.push({ id: "wild", type: "A", name: `*.${APEX}`, content: "149.248.216.86" });
    expect((await call(zone, { op: "zone.list" })).json).toEqual({ ok: true, records: zone.records });
    expect((await call(zone, { op: "zone.get", id: "wild" })).json).toEqual({ ok: true, record: zone.records[0] });
    expect((await call(zone, { op: "zone.get", id: "nope" })).json).toEqual({ ok: true, record: null });
  });

  it("answers 502 with no detail when Cloudflare fails", async () => {
    const zone = new FakeZone();
    zone.list = async () => {
      throw new Error("token invalid: cf-secret-detail");
    };
    expect(await call(zone, { op: "zone.list" })).toEqual({ status: 502, json: { ok: false } });
  });
});

describe("the hourly clean-up", () => {
  it("removes challenge records older than an hour and nothing else", async () => {
    const zone = new FakeZone();
    const now = Date.parse("2026-11-17T12:00:00Z");
    const old = new Date(now - 2 * 3600_000).toISOString();
    const fresh = new Date(now - 10 * 60_000).toISOString();
    zone.records.push(
      { id: "old", type: "TXT", name: `_acme-challenge.alice.${APEX}`, content: VALUE, created_on: old },
      { id: "fresh", type: "TXT", name: `_acme-challenge.bob.${APEX}`, content: VALUE, created_on: fresh },
      { id: "undated", type: "TXT", name: `_acme-challenge.carol.${APEX}`, content: VALUE },
      { id: "other", type: "TXT", name: `alice.${APEX}`, content: "x", created_on: old },
    );
    expect(await deleteStaleChallenges(env(), zone, now)).toEqual({ scanned: 4, deleted: 1 });
    expect(zone.records.map((r) => r.id)).toEqual(["fresh", "undated", "other"]);
  });
});

describe("the Worker routes /service", () => {
  it("answers 401 without the secret, and 503 before the token is set", async () => {
    const base = { CLOUDFLARE_DNS_API_TOKEN: "t", CLOUDFLARE_SERVICES_ZONE_ID: "z", DNS_BROKER_SECRET: SECRET, FLAGSHIP_APEX: APEX };
    const res = await handler.fetch(new Request("https://broker.test/service", { method: "POST", body: "{}" }), base);
    expect(res.status).toBe(401);
    const none = await handler.fetch(req({ op: "zone.list" }), { DNS_BROKER_SECRET: SECRET });
    expect(none.status).toBe(503);
    expect((await handler.fetch(new Request("https://broker.test/service"), base)).status).toBe(404);
  });
});

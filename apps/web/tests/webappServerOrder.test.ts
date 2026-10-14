// The owner's server order on the webapp (docs/server-order.md): the envelope
// against the shared vectors, signing with the sensitive-order key, saving
// (post, put back on failure, a newer order elsewhere, demo kept local), Home
// ranking with the Leader badge and "standing in", and Make leader on a
// server's page moving the server to the top of Home.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyServerOrder } from "@flagship/protocol";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/server-order/vectors.json"), "utf8"),
);
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

const USER = "plucky-avocet";
const UMK = fromHex(V.keys.umkSeedHex);
const [A, B, C] = V.order.fields.stks as string[];
const HOME3 = `home3.${USER}.flagship.services`;
const LETICIA = `leticia.${USER}.flagship.services`;
const OFFICE = `office.${USER}.flagship.services`;
const NOW = 1_760_000_000_000;

const pod = (fqdn: string, stk: string, registeredAt: number, liveness = "live") => ({
  serverDomain: fqdn,
  identityPubKey: stk,
  registeredAt,
  liveness,
  lastReported: NOW,
});

const ok = (body: unknown = { ok: true }) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response;

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  (globalThis as { document?: unknown }).document = { getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {} };
  const { _resetServerOrdersForTests } = await load("lib/serverOrder.js");
  _resetServerOrdersForTests();
  const { getSession } = await load("lib/state.js");
  Object.assign(getSession(), { username: USER, umk: UMK, adminRootSeed: null });
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("the order envelope", () => {
  it("reproduces the vector's canonical bytes and IRK signature", async () => {
    const { canonicalServerOrderBytes, buildSignedServerOrder } = await load("lib/serverOrder.js");
    const { signWithIrk } = await load("keystore.js");
    expect(utf8(canonicalServerOrderBytes(V.order.fields))).toBe(V.order.canonical);
    const wire = await buildSignedServerOrder(
      { username: V.order.fields.user, stks: V.order.fields.stks },
      { umk: UMK, now: () => V.order.fields.issuedAt, nonceHex: V.order.fields.nonce, sign: signWithIrk },
    );
    expect(wire).toEqual(V.order.wire);
    expect(wire.signature).toBe(V.order.signatureHex);
    expect(verifyServerOrder(wire.order, wire.signature, fromHex(V.keys.irkPubHex))).toBe(true);
  });

  it("refuses every refuse case", async () => {
    const { canonicalServerOrderBytes } = await load("lib/serverOrder.js");
    for (const r of V.refuse) expect(() => canonicalServerOrderBytes(r.fields), r.why).toThrow();
  });

  it("is a sensitive order: the admin root signs it when held", async () => {
    const { SENSITIVE_TAGS, canonicalTag, makeSensitiveSigner } = await load("lib/adminRoot.js");
    const { canonicalServerOrderBytes } = await load("lib/serverOrder.js");
    expect(SENSITIVE_TAGS.has("flagship/server-order/v1")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/set-leader/v1")).toBe(false);
    const bytes = canonicalServerOrderBytes(V.order.fields);
    expect(canonicalTag(bytes)).toBe("flagship/server-order/v1");
    const admin = vi.fn(async () => new Uint8Array(64).fill(1));
    const legacy = vi.fn(async () => new Uint8Array(64));
    await makeSensitiveSigner(new Uint8Array(32), legacy, { signWithAdminRoot: admin })(UMK, bytes);
    expect(admin).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("saving the order", () => {
  it("posts the signed order to the account and keeps it", async () => {
    const { saveServerOrder, currentServerOrder } = await load("lib/serverOrder.js");
    const { signWithIrk } = await load("keystore.js");
    const fetch = vi.fn(async () => ok());
    await saveServerOrder({ stks: [B, A] }, { fetch, comBase: "https://com", now: () => NOW, sign: signWithIrk, demo: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://com/api/accounts/${USER}/server-order`);
    const body = JSON.parse(String(init.body));
    expect(body.order).toMatchObject({ user: USER, stks: [B, A], issuedAt: NOW });
    expect(verifyServerOrder(body.order, body.signature, fromHex(V.keys.irkPubHex))).toBe(true);
    expect(currentServerOrder()).toEqual([B, A]);
  });

  it("puts the previous order back when the post fails, with the reason", async () => {
    const { saveServerOrder, currentServerOrder, rememberServerOrder } = await load("lib/serverOrder.js");
    rememberServerOrder(USER, { order: { user: USER, stks: [A, B], issuedAt: 5, nonce: "00".repeat(32) }, signature: "" });
    const fetch = vi.fn(async () => fail(403, "invalid signature"));
    await expect(saveServerOrder({ stks: [B, A] }, { fetch, comBase: "https://com", demo: false })).rejects.toThrow(
      "invalid signature",
    );
    expect(currentServerOrder()).toEqual([A, B]);
  });

  it("says a newer order exists on 409", async () => {
    const { saveServerOrder } = await load("lib/serverOrder.js");
    const fetch = vi.fn(async () => fail(409, "stale"));
    await expect(saveServerOrder({ stks: [B, A] }, { fetch, comBase: "https://com", demo: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/another device/),
    });
  });

  it("refuses without an unlocked session and puts the order back", async () => {
    const { saveServerOrder, currentServerOrder } = await load("lib/serverOrder.js");
    const { getSession } = await load("lib/state.js");
    getSession().umk = null;
    const fetch = vi.fn();
    await expect(saveServerOrder({ stks: [B, A] }, { fetch, demo: false })).rejects.toThrow(/unlock/);
    expect(fetch).not.toHaveBeenCalled();
    expect(currentServerOrder()).toEqual([]);
  });

  it("keeps a demo account's order on this browser only", async () => {
    const { saveServerOrder, currentServerOrder } = await load("lib/serverOrder.js");
    const fetch = vi.fn();
    const out = await saveServerOrder({ stks: [B, A] }, { fetch, demo: true });
    expect(out.local).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(currentServerOrder()).toEqual([B, A]);
  });

  it("takes the newest order `.com` returns and ignores an older one", async () => {
    const { rememberServerOrder, currentServerOrder } = await load("lib/serverOrder.js");
    const wire = (stks: string[], issuedAt: number) => ({ order: { user: USER, stks, issuedAt, nonce: "00".repeat(32) }, signature: "" });
    rememberServerOrder(USER, wire([A, B], 10));
    rememberServerOrder(USER, wire([B, A], 5));
    expect(currentServerOrder()).toEqual([A, B]);
    rememberServerOrder(USER, wire([C, A], 11));
    expect(currentServerOrder()).toEqual([C, A]);
    rememberServerOrder("someone-else", wire([B], 99));
    expect(currentServerOrder()).toEqual([C, A]);
  });
});

describe("the leader follows the order", () => {
  it("is the first server in the order that's online, and returns when it's back", async () => {
    const { leaderOf } = await load("lib/appPlacement.js");
    const pods = [pod(HOME3, A, 1), pod(LETICIA, B, 2), pod(OFFICE, C, 3)];
    expect(leaderOf(pods, [], NOW)).toBe(HOME3);
    expect(leaderOf(pods, [C, B], NOW)).toBe(OFFICE);
    const officeDown = [pod(HOME3, A, 1), pod(LETICIA, B, 2), pod(OFFICE, C, 3, "unreachable")];
    expect(leaderOf(officeDown, [C, B], NOW)).toBe(LETICIA);
  });

  it("Home badges the leader, says who it stands in for, and numbers the rest", async () => {
    const { registeredEntries } = await load("views/home.js");
    const { rankByServerOrder } = await load("lib/serverOrder.js");
    const rows = [
      { server: { serverId: OFFICE }, pod: pod(OFFICE, C, 3, "unreachable"), bucket: "offline" },
      { server: { serverId: HOME3 }, pod: pod(HOME3, A, 1), bucket: "online" },
      { server: { serverId: LETICIA }, pod: pod(LETICIA, B, 2), bucket: "online" },
    ];
    const ranked = rankByServerOrder(rows, [C, B, A], (r: (typeof rows)[number]) => ({
      stk: r.pod.identityPubKey,
      birthDate: r.pod.registeredAt,
      domain: r.server.serverId,
    }));
    const entries = registeredEntries(ranked);
    expect(entries.map((e: { fields: { fqdn: string } }) => e.fields.fqdn)).toEqual([OFFICE, LETICIA, HOME3]);
    expect(entries[0].html).toContain("#1");
    expect(entries[1].html).toContain("data-order-leader");
    expect(entries[1].html).toContain("standing in for office");
    expect(entries[2].html).toContain("#3");
    expect(entries[2].html).not.toContain("data-order-leader");
    expect(entries.every((e: { html: string }) => e.html.includes("js-order-handle"))).toBe(true);
  });
});

describe("Make leader on a server's page", () => {
  const pods = [pod(HOME3, A, 1), pod(LETICIA, B, 2), pod(OFFICE, C, 3)];
  const rows = pods.map((p) => ({ server: { serverId: p.serverDomain }, pod: p, bucket: "online" }));

  it("moves the server to the top of Home with the Leader badge before the post returns", async () => {
    const home = await load("views/home.js");
    const { makeServerLeader } = await load("views/server-detail.js");
    const { signWithIrk } = await load("keystore.js");
    home._setHomeServersForTests(rows);
    expect(home.homeOrderView()[0]).toEqual({ fqdn: HOME3, leader: true });

    let release!: () => void;
    const posted = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async () => {
      await posted;
      return ok();
    });
    const saving = makeServerLeader(OFFICE, { loadAccountPods: async () => pods, fetch, comBase: "https://com", sign: signWithIrk, demo: false });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(home.homeOrderView()).toEqual([
      { fqdn: OFFICE, leader: true },
      { fqdn: HOME3, leader: false },
      { fqdn: LETICIA, leader: false },
    ]);
    release();
    await saving;
    expect(home.homeOrderStks()).toEqual([C, A, B]);
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.order.stks).toEqual([C, A, B]);
  });

  it("puts Home back when the save fails", async () => {
    const home = await load("views/home.js");
    const { makeServerLeader } = await load("views/server-detail.js");
    home._setHomeServersForTests(rows);
    const fetch = vi.fn(async () => fail(403, "invalid signature"));
    await expect(
      makeServerLeader(LETICIA, { loadAccountPods: async () => pods, fetch, comBase: "https://com", demo: false }),
    ).rejects.toThrow("invalid signature");
    expect(home.homeOrderView().map((r: { fqdn: string }) => r.fqdn)).toEqual([HOME3, LETICIA, OFFICE]);
    expect(home.homeOrderView()[0].leader).toBe(true);
  });
});

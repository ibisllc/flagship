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
      message: expect.stringMatching(/Another device changed the order/),
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

  it("Home badges only the leader, says who it stands in for, and numbers nothing", async () => {
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
    for (const e of entries as Array<{ html: string }>) {
      expect(e.html).not.toMatch(/#\d/);
      expect(e.html).not.toContain("Next in line");
      expect(e.html).toContain("fs-listrow-title-icon");
      expect(e.html).toContain("js-order-handle");
      expect(e.html).toContain("js-order-up");
      expect(e.html).toContain("js-order-down");
      expect(e.html).not.toContain("fs-listrow-icon--");
    }
    expect(entries[0].html).not.toContain("data-order-leader");
    expect(entries[1].html).toContain("data-order-leader");
    expect(entries[1].html).toContain("standing in for office");
    expect(entries[2].html).not.toContain("data-order-leader");
    // The handle is the row's first element, ahead of the name.
    const html = entries[1].html as string;
    expect(html.indexOf("js-order-handle")).toBeLessThan(html.indexOf("fs-listrow-body"));
  });

  it("a device that can't sign the order sees it without the controls to change it", async () => {
    const { registeredEntries } = await load("views/home.js");
    const { SERVER_ORDER_ADMIN_ONLY } = await load("lib/serverOrder.js");
    const rows = [
      { server: { serverId: HOME3 }, pod: pod(HOME3, A, 1), bucket: "online" },
      { server: { serverId: LETICIA }, pod: pod(LETICIA, B, 2), bucket: "online" },
    ];
    const entries = registeredEntries(rows, { canReorder: false });
    for (const e of entries as Array<{ html: string; orderStk: string }>) {
      expect(e.html).not.toContain("js-order-handle");
      expect(e.html).not.toContain("js-order-up");
      expect(e.orderStk).toBe("");
    }
    // The leader still wears its badge.
    expect(entries[0].html).toContain("data-order-leader");
    expect(SERVER_ORDER_ADMIN_ONLY).toBe("Only an admin device can change the server order.");
  });

  it("skips pending and revoked servers when saying who the leader stands in for", async () => {
    const { registeredEntries } = await load("views/home.js");
    const rows = [
      { server: { serverId: OFFICE, revoked: { reason: "lost", at: 1 } }, pod: { ...pod(OFFICE, C, 3, "unreachable"), revokedAt: 1 }, bucket: "offline" },
      { server: { serverId: LETICIA }, pod: pod(LETICIA, B, 2, "never"), bucket: "pending" },
      { server: { serverId: HOME3 }, pod: pod(HOME3, A, 1), bucket: "online" },
    ];
    const entries = registeredEntries(rows);
    expect(entries[2].html).toContain("data-order-leader");
    expect(entries[2].html).not.toContain("standing in for");
    // A revoked server can't be dragged into the order.
    expect(entries[0].orderStk).toBe("");
  });

  it("keeps the Leader badge gray until the leader holds the order on screen", async () => {
    const { registeredEntries } = await load("views/home.js");
    const rows = (acked?: number) => [
      { server: { serverId: HOME3 }, pod: { ...pod(HOME3, A, 1), ...(acked ? { orderIssuedAt: acked } : {}) }, bucket: "online" },
      { server: { serverId: LETICIA }, pod: pod(LETICIA, B, 2), bucket: "online" },
    ];
    const pending = registeredEntries(rows(), { orderIssuedAt: 50 })[0].html;
    expect(pending).toContain("data-order-leader-pending");
    expect(pending).toContain('title="Leader, waiting for the server to confirm"');
    expect(pending).not.toContain("pill ok\" data-order-leader");
    expect(registeredEntries(rows(49), { orderIssuedAt: 50 })[0].html).toContain("data-order-leader-pending");
    const confirmed = registeredEntries(rows(50), { orderIssuedAt: 50 })[0].html;
    expect(confirmed).toContain('class="pill ok" data-order-leader');
    expect(confirmed).not.toContain("data-order-leader-pending");
    expect(registeredEntries(rows(), { orderIssuedAt: 0 })[0].html).not.toContain("data-order-leader-pending");
    expect(registeredEntries(rows(50), { orderIssuedAt: 50, dragging: true })[0].html).toContain("data-order-leader-pending");
  });

  it("isLeaderConfirmed: no drag, and no order or the leader holds it", async () => {
    const { isLeaderConfirmed } = await load("lib/serverOrder.js");
    expect(isLeaderConfirmed({})).toBe(true);
    expect(isLeaderConfirmed({ orderIssuedAt: 0, leaderOrderIssuedAt: null })).toBe(true);
    expect(isLeaderConfirmed({ dragging: true })).toBe(false);
    expect(isLeaderConfirmed({ orderIssuedAt: 10, leaderOrderIssuedAt: null })).toBe(false);
    expect(isLeaderConfirmed({ orderIssuedAt: 10, leaderOrderIssuedAt: 9 })).toBe(false);
    expect(isLeaderConfirmed({ orderIssuedAt: 10, leaderOrderIssuedAt: 10 })).toBe(true);
    expect(isLeaderConfirmed({ orderIssuedAt: 10, leaderOrderIssuedAt: 11 })).toBe(true);
  });
});

describe("dragging on Home", () => {
  const pods = [pod(HOME3, A, 1), pod(LETICIA, B, 2), pod(OFFICE, C, 3)];
  const rows = pods.map((p) => ({ server: { serverId: p.serverDomain }, pod: p, bucket: "online" }));

  it("shows the draft while dragging, labels included, and saves it on the drop", async () => {
    const home = await load("views/home.js");
    home._setHomeServersForTests(rows, { demo: true });
    const drag = home._orderDragForTests;
    expect(drag.start(A)).toBe(true);
    drag.moveTo([B, C, A]);
    expect(drag.state().draft).toEqual([B, C, A]);
    expect(home.homeOrderView()).toEqual([
      { fqdn: LETICIA, leader: true },
      { fqdn: OFFICE, leader: false },
      { fqdn: HOME3, leader: false },
    ]);
    drag.end(true);
    await vi.waitFor(() => expect(drag.state().saving).toBe(false));
    expect(drag.state()).toMatchObject({ draft: null, dragging: "" });
    expect(home.homeOrderStks()).toEqual([B, C, A]);
    expect(home.homeOrderView()[0]).toEqual({ fqdn: LETICIA, leader: true });
  });

  it("a cancelled drag or a drop where nothing moved leaves no draft", async () => {
    const home = await load("views/home.js");
    home._setHomeServersForTests(rows, { demo: true });
    const drag = home._orderDragForTests;
    drag.start(A);
    drag.moveTo([B, A, C]);
    drag.end(false);
    expect(drag.state()).toMatchObject({ draft: null, dragging: "" });
    expect(home.homeOrderStks()).toEqual([A, B, C]);
    drag.start(B);
    drag.moveTo([B, A, C]);
    drag.moveTo([A, B, C]);
    drag.end(true);
    expect(drag.state()).toMatchObject({ draft: null, dragging: "", saving: false });
    expect(home.homeOrderStks()).toEqual([A, B, C]);
  });

  it("a failed save puts the committed order back with no draft left", async () => {
    const home = await load("views/home.js");
    const { getSession } = await load("lib/state.js");
    home._setHomeServersForTests(rows, { demo: false });
    getSession().umk = null;
    const drag = home._orderDragForTests;
    drag.start(C);
    drag.moveTo([C, A, B]);
    drag.end(true);
    await vi.waitFor(() => expect(drag.state().saving).toBe(false));
    expect(drag.state().draft).toBeNull();
    expect(home.homeOrderStks()).toEqual([A, B, C]);
    expect(home.homeOrderView()[0]).toEqual({ fqdn: HOME3, leader: true });
  });

  it("only one drag runs at a time", async () => {
    const home = await load("views/home.js");
    home._setHomeServersForTests(rows, { demo: true });
    const drag = home._orderDragForTests;
    drag.start(A);
    expect(drag.start(B)).toBe(false);
    drag.end(false);
  });
});

describe("handing the order to the boxes", () => {
  const wire = { order: { user: USER, stks: [A, B, C], issuedAt: 200, nonce: "00".repeat(32) }, signature: "ab" };

  const fakeClients = (answers: Record<string, (body: unknown) => Promise<unknown>>, sessions = Object.keys(answers)) => {
    const calls: Array<{ fqdn: string; path: string; body: unknown }> = [];
    const clientFor = (fqdn: string) => ({
      hasSession: () => sessions.includes(fqdn),
      fetch: async (path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ fqdn, path, body });
        return answers[fqdn]!(body);
      },
    });
    return { calls, clientFor };
  };

  it("posts the signed order to every online box with a session and records what each holds", async () => {
    const { deliverServerOrder, orderAckOf } = await load("lib/serverOrder.js");
    const { ScreensError } = await load("lib/api.js");
    const { calls, clientFor } = fakeClients({
      [HOME3]: async () => ({ ok: true, adopted: true, heldIssuedAt: 200 }),
      [LETICIA]: async () => {
        throw new ScreensError("bad signature", 422, { error: "bad signature", heldIssuedAt: 150 });
      },
      [OFFICE]: async () => {
        throw new ScreensError("HTTP 404", 404, null);
      },
    });
    const pods = [
      pod(HOME3, A, 1),
      { ...pod(LETICIA, B, 2), orderIssuedAt: 100 },
      pod(OFFICE, C, 3),
      pod(`down.${USER}.flagship.services`, "dd".repeat(32), 4, "unreachable"),
      { ...pod(`gone.${USER}.flagship.services`, "ee".repeat(32), 5), revokedAt: 1 },
    ];
    const out = await deliverServerOrder(wire, pods, { clientFor, now: () => NOW });
    expect(calls.map((c) => c.fqdn).sort()).toEqual([HOME3, LETICIA, OFFICE].sort());
    expect(calls.every((c) => c.path === "/api/screens/server-order")).toBe(true);
    expect(calls[0].body).toEqual(wire);
    expect(out).toEqual(expect.arrayContaining([
      { fqdn: HOME3, heldIssuedAt: 200 },
      { fqdn: LETICIA, heldIssuedAt: 150 },
      { fqdn: OFFICE, heldIssuedAt: null },
    ]));
    expect(orderAckOf(pods[0])).toBe(200);
    expect(orderAckOf(pods[1])).toBe(150);
    expect(orderAckOf({ ...pods[1], orderIssuedAt: 300 })).toBe(300);
    expect(orderAckOf(pods[2])).toBeNull();
  });

  it("skips boxes this browser has no session for, and acks only move forward", async () => {
    const { deliverServerOrder, orderAckOf, recordServerOrderAck } = await load("lib/serverOrder.js");
    const { calls, clientFor } = fakeClients({ [HOME3]: async () => ({ heldIssuedAt: 120 }) }, []);
    await deliverServerOrder(wire, [pod(HOME3, A, 1)], { clientFor, now: () => NOW });
    expect(calls).toHaveLength(0);
    recordServerOrderAck(HOME3, 200);
    recordServerOrderAck(HOME3, 120);
    expect(orderAckOf(pod(HOME3, A, 1))).toBe(200);
  });

  it("a save hands the order on after `.com` takes it, without waiting, and repaints Home's badge", async () => {
    const { saveServerOrder } = await load("lib/serverOrder.js");
    const { signWithIrk } = await load("keystore.js");
    const home = await load("views/home.js");
    const pods = [pod(HOME3, A, 1), pod(LETICIA, B, 2)];
    home._setHomeServersForTests(pods.map((p) => ({ server: { serverId: p.serverDomain }, pod: p, bucket: "online" })));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, clientFor } = fakeClients({
      [HOME3]: async (body) => {
        await gate;
        return { ok: true, adopted: true, heldIssuedAt: (body as typeof wire).order.issuedAt };
      },
      [LETICIA]: async () => ({ ok: true, adopted: true, heldIssuedAt: NOW }),
    });
    const fetch = vi.fn(async () => ok());
    const out = await saveServerOrder(
      { stks: [A, B] },
      { fetch, comBase: "https://com", now: () => NOW, sign: signWithIrk, demo: false, pods, clientFor },
    );
    expect(out.local).toBe(false);
    expect(calls.map((c) => c.fqdn).sort()).toEqual([HOME3, LETICIA].sort());
    expect(home._homeLeaderConfirmedForTests()).toBe(false);
    release();
    await out.delivered;
    expect(home._homeLeaderConfirmedForTests()).toBe(true);
  });

  it("a demo save or a refused save hands nothing to the boxes", async () => {
    const { saveServerOrder } = await load("lib/serverOrder.js");
    const { calls, clientFor } = fakeClients({ [HOME3]: async () => ({ heldIssuedAt: 1 }) });
    await saveServerOrder({ stks: [A] }, { demo: true, pods: [pod(HOME3, A, 1)], clientFor });
    const fetch = vi.fn(async () => fail(403, "invalid signature"));
    await expect(
      saveServerOrder({ stks: [A] }, { fetch, comBase: "https://com", demo: false, pods: [pod(HOME3, A, 1)], clientFor }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("the server page's order card", () => {
  it("says who a server takes over from, never a number", async () => {
    const { successionLine } = await load("views/server-detail.js");
    expect(successionLine([])).toBe("First in line to lead");
    expect(successionLine([HOME3])).toBe("Takes over while home3 is down");
    expect(successionLine([HOME3, LETICIA])).toBe("Takes over while home3 and leticia are down");
    expect(successionLine([HOME3, LETICIA, OFFICE])).toBe("Takes over while home3, leticia and office are down");
  });

  it("gives each server its line and the leader a caption until it confirms", async () => {
    const { leaderStatus } = await load("views/server-detail.js");
    const { rememberServerOrder } = await load("lib/serverOrder.js");
    rememberServerOrder(USER, { order: { user: USER, stks: [A, B, C], issuedAt: 500, nonce: "00".repeat(32) }, signature: "" });
    const pods = [pod(HOME3, A, 1, "unreachable"), { ...pod(LETICIA, B, 2), orderIssuedAt: 400 }, pod(OFFICE, C, 3)];
    const deps = { loadAccountPods: async () => pods, demo: false };
    expect(await leaderStatus(HOME3, deps)).toMatchObject({ text: "First in line to lead", waiting: false });
    expect(await leaderStatus(LETICIA, deps)).toMatchObject({ text: "Leader", pill: "pill", waiting: true });
    expect(await leaderStatus(OFFICE, deps)).toMatchObject({ text: "Takes over while home3 and leticia are down", waiting: false });
    pods[1] = { ...pods[1], orderIssuedAt: 500 };
    expect(await leaderStatus(LETICIA, deps)).toMatchObject({ text: "Leader", pill: "pill ok", waiting: false });
  });
});

describe("Home's layout", () => {
  it("puts Add/Import a server under the heading, above the filters, with no reorder hint", () => {
    const src = readFileSync(resolve(__dirname, "../public/webapp/views/home.js"), "utf8");
    const add = src.indexOf('class="secondary" id="home-add-server">${escapeHtml(ADD_IMPORT_LABEL)}');
    expect(add).toBeGreaterThan(src.indexOf("data-home-title>Servers</h2>"));
    expect(add).toBeLessThan(src.indexOf("${chipRow({ items: chips"));
    expect(add).toBeLessThan(src.indexOf("${searchField({ value: homeQuery"));
    expect(src).not.toContain("home-order-hint");
    expect(src).not.toMatch(/Drag servers to choose|Touch and hold/);
    expect(src).toContain("Save a passkey so you can recover your account if you get a new device.");
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

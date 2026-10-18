/**
 * The held /stream checks for change on a LIGHT inventory (no routing, health
 * or parsed signed report) and answers with the full one. The two must give the
 * same cursor for the same state, over the real D1 adapter, or a client would
 * be woken for nothing or never woken. Also: the inventory read together
 * (RequestD1) is the inventory read one query at a time.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, RequestD1, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import {
  STREAM_CHECK_DELAYS_MS,
  buildPodInventory,
  computePodInventoryCursor,
  handleUserStream,
  type PodInventoryDeps,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const U = "plucky-avocet";
const D = (n: number) => `home${n}.${U}.flagship.services`;

function depsOf(storage: D1Storage): PodInventoryDeps {
  return {
    daemonStatus: storage.daemonStatus,
    serverHealth: storage.serverHealth,
    servers: storage.servers,
    routing: storage.routing,
    authCodes: storage.authCodes,
    provisionStatus: storage.provisionStatus,
    secretMailbox: storage.secretMailbox,
    serverOrders: storage.serverOrders,
    now: () => NOW,
  };
}

async function world() {
  const sqlite = createSqliteD1();
  const raw = sqlite as unknown as D1Database;
  const s = new D1Storage(raw);
  // 1: a live box with a heartbeat and a pending unlock request.
  await s.servers.put({ serverDomain: D(1), username: U, identityPubKeyHex: "11".repeat(32), registeredAt: NOW - 5000 });
  await s.daemonStatus.put({
    serverDomain: D(1),
    certSha256: "aa".repeat(32),
    certValidUntil: NOW + 90_000,
    certIssuer: "R12",
    servicesServedJson: JSON.stringify(["b", "a"]),
    lastReported: NOW - 1000,
    reportJson: JSON.stringify({ serverDomain: D(1), leadsServices: ["a"], trustStatus: { report: { x: 1 }, signatureHex: "00".repeat(64) } }),
    signatureHex: "bb".repeat(64),
  });
  await s.secretMailbox.putRequest({
    serverDomain: D(1),
    username: U,
    requestNonceHex: "cd".repeat(32),
    stkPubHex: "11".repeat(32),
    purpose: "unlock-key",
    requestIssuedAt: NOW - 500,
    requestSignatureHex: "ee".repeat(64),
    deviceInfoJson: null,
    postedAt: NOW - 400,
    expiresAt: NOW + 300_000,
    lastPushAt: 0,
  });
  // 2: a box with no heartbeat whose install order reached "live" (the bridge).
  await s.servers.put({ serverDomain: D(2), username: U, identityPubKeyHex: "22".repeat(32), registeredAt: NOW - 4000 });
  await s.authCodes.put({
    serial: "serial-live",
    username: U,
    serverName: "home2",
    serverDomain: D(2),
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: "11".repeat(32),
    userSignatureHex: "00".repeat(64),
    issuedAt: NOW - 9000,
    expiresAt: NOW - 1,
    status: "used",
    recordedAt: NOW - 9000,
  });
  await s.provisionStatus.putProvisionStatus("serial-live", { serverDomain: D(2), phase: "live", ts: NOW - 3000 });
  // 3: an install in flight.
  await s.authCodes.put({
    serial: "serial-new",
    username: U,
    serverName: "home3",
    serverDomain: D(3),
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: "11".repeat(32),
    userSignatureHex: "00".repeat(64),
    issuedAt: NOW - 100,
    expiresAt: NOW + 3_600_000,
    status: "active",
    recordedAt: NOW - 100,
  });
  await s.provisionStatus.putProvisionStatus("serial-new", { phase: "installing", ts: NOW - 50 });
  return { raw, s };
}

describe("light inventory", () => {
  it("has the same cursor as the full inventory, over the real D1 adapter", async () => {
    const { s } = await world();
    const full = await buildPodInventory(depsOf(s), U);
    const light = await buildPodInventory(depsOf(s), U, { light: true });
    expect(computePodInventoryCursor(light)).toBe(computePodInventoryCursor(full));
    expect(full.pods).toHaveLength(2);
    expect(full.pending).toHaveLength(1);
    // The light one leaves out exactly what the cursor never reads.
    expect(light.pods.every((p) => p.signedStatus === null && p.trustStatus === null && p.routingTarget === null)).toBe(true);
    expect(full.pods.find((p) => p.serverDomain === D(1))?.signedStatus).not.toBeNull();
  });

  it("follows every field the cursor watches", async () => {
    const { s } = await world();
    const cursorOf = async () => computePodInventoryCursor(await buildPodInventory(depsOf(s), U, { light: true }));
    const base = await cursorOf();
    await s.daemonStatus.put({
      serverDomain: D(1), certSha256: "cc".repeat(32), certValidUntil: NOW + 90_000, certIssuer: "R12",
      servicesServedJson: JSON.stringify(["b", "a"]), lastReported: NOW - 1000, reportJson: null, signatureHex: null,
    });
    const afterCert = await cursorOf();
    expect(afterCert).not.toBe(base);
    await s.provisionStatus.putProvisionStatus("serial-new", { phase: "live", ts: NOW });
    expect(await cursorOf()).not.toBe(afterCert);
  });
});

describe("the inventory read together", () => {
  it("is the inventory read one query at a time", async () => {
    const { raw, s } = await world();
    const bare = await buildPodInventory(depsOf(s), U);
    const together = await buildPodInventory(depsOf(new D1Storage(new RequestD1(raw))), U);
    expect(together).toEqual(bare);
  });

  it("takes two D1 round trips for a user with servers and an install in flight", async () => {
    const { raw } = await world();
    const req = new RequestD1(raw);
    await buildPodInventory(depsOf(new D1Storage(req)), U);
    expect(req.roundTrips).toBeLessThanOrEqual(3);
  });
});

describe("handleUserStream default hold", () => {
  it("re-checks on the sparse schedule: four checks in 25 s", async () => {
    const { s } = await world();
    const cursor = computePodInventoryCursor(await buildPodInventory(depsOf(s), U));
    let t = NOW;
    const slept: number[] = [];
    const res = await handleUserStream(
      { ...depsOf(s), now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } },
      U,
      cursor,
    );
    expect(slept).toEqual([...STREAM_CHECK_DELAYS_MS]);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(25_000);
    expect((res.body as { cursor: string }).cursor).toBe(cursor);
  });

  it("wakes on the check after the change", async () => {
    const { s } = await world();
    const cursor = computePodInventoryCursor(await buildPodInventory(depsOf(s), U));
    let t = NOW;
    let n = 0;
    const res = await handleUserStream(
      {
        ...depsOf(s),
        now: () => t,
        sleep: async (ms) => {
          t += ms;
          if (++n === 2) await s.provisionStatus.putProvisionStatus("serial-new", { phase: "live", ts: NOW });
        },
      },
      U,
      cursor,
    );
    expect(n).toBe(2);
    expect((res.body as { cursor: string }).cursor).not.toBe(cursor);
    expect((res.body as { pending: { phase: string }[] }).pending[0]?.phase).toBe("live");
  });

  it("answers a stale cursor at once with the full inventory", async () => {
    const { s } = await world();
    let slept = 0;
    const res = await handleUserStream({ ...depsOf(s), sleep: async () => void slept++ }, U, "00".repeat(32));
    expect(slept).toBe(0);
    const body = res.body as { pods: { signedStatus: unknown }[] };
    expect(body.pods.some((p) => p.signedStatus !== null)).toBe(true);
  });
});

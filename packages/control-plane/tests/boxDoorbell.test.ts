/**
 * The box doorbell (src/boxDoorbell.ts): for a box, which `.com` lanes hold
 * something and a digest of each list a box reads. The contract a box relies on
 * to skip a poll: a lane left out would have answered 404 (nothing to collect),
 * and a stamp that has not changed means the list a poll would read has not
 * changed. Run over the real D1 adapter, with the real handlers as the oracle.
 */
import { describe, expect, it } from "vitest";
import {
  D1Storage,
  type D1Database,
  type PairingDepositRecord,
  type ServerEvictionRecord,
  type ServerMigrationRecord,
  type ServerTransferRecord,
} from "@flagship/storage";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import {
  buildBoxDoorbell,
  handleConsumeCgkDeposit,
  handleConsumePairingDeposit,
  handleConsumeSelfDeleteDeposit,
  handleConsumeSwkDeposit,
  handleConsumeUpdateDeposit,
  handleGetDecommission,
  handleGetMigrationAssignment,
  handleGetTransferRehome,
  type BoxDoorbellDeps,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const U = "plucky-avocet";
const HOST = `home.${U}.flagship.services`;
const OTHER = `home2.${U}.flagship.services`;
const STK = "11".repeat(32);
const DEV = "0102030405060708090a0b0c0d0e0f10";

async function world(over: Partial<Pick<BoxDoorbellDeps, "serverMigrations" | "serverTransfers" | "serverEvictions">> = {}) {
  const raw = createSqliteD1() as unknown as D1Database;
  const s = new D1Storage(raw);
  await s.usernames.put({ username: U, irkPubHex: "ab".repeat(32), claimedAt: 1 });
  await s.servers.put({ serverDomain: HOST, username: U, identityPubKeyHex: STK, registeredAt: 1 });
  await s.servers.put({ serverDomain: OTHER, username: U, identityPubKeyHex: "22".repeat(32), registeredAt: 2 });
  const deps: BoxDoorbellDeps = {
    secretMailbox: s.secretMailbox,
    serverMigrations: over.serverMigrations ?? s.serverMigrations,
    serverTransfers: over.serverTransfers ?? s.serverTransfers,
    serverEvictions: over.serverEvictions ?? s.serverEvictions,
    userServiceAliases: s.userServiceAliases,
    usernames: s.usernames,
    rotations: s.adminRootRotations,
    now: () => NOW,
  };
  const ring = () => buildBoxDoorbell(deps, { serverDomain: HOST, username: U, identityPubKeyHex: STK });
  return { s, deps, ring };
}

const deposit = (host = HOST, nonce = "aa".repeat(32), over: Partial<PairingDepositRecord> = {}): PairingDepositRecord => ({
  serverDomain: host,
  username: U,
  requestNonceHex: nonce,
  stkPubHex: STK,
  sealedHex: "cd".repeat(40),
  issuedAt: NOW - 1000,
  expiresAt: NOW + 600_000,
  ...over,
});

describe("lanes: the six mailbox lanes", () => {
  it("is empty for a box with nothing waiting", async () => {
    const { ring } = await world();
    expect((await ring()).lanes).toEqual([]);
  });

  it("lists a lane while its deposit is waiting and drops it once collected, as the consume call does", async () => {
    const { s, deps, ring } = await world();
    const sm = { secretMailbox: s.secretMailbox, servers: s.servers, now: () => NOW } as never;
    await s.secretMailbox.putSwkDeposit(deposit(HOST, "01".repeat(32)));
    await s.secretMailbox.putCgkDeposit(deposit(HOST, "02".repeat(32)));
    await s.secretMailbox.putPairingDeposit(deposit(HOST, "03".repeat(32)));
    await s.secretMailbox.putUpdateDeposit(deposit(HOST, "04".repeat(32)));
    await s.secretMailbox.putSelfDeleteDeposit(deposit(HOST, "05".repeat(32)));
    await s.secretMailbox.putEntitlementDeposit(deposit(HOST, "06".repeat(32)));
    expect((await ring()).lanes).toEqual(["cgk", "entitlement-deposit", "pairing", "self-delete", "swk", "update"]);

    expect((await handleConsumeSwkDeposit(sm, HOST)).status).toBe(200);
    expect((await handleConsumeCgkDeposit(sm, HOST)).status).toBe(200);
    expect((await handleConsumePairingDeposit(sm, HOST)).status).toBe(200);
    expect((await handleConsumeUpdateDeposit(sm, HOST)).status).toBe(200);
    // The self-delete order is read without being consumed: it stays.
    expect((await handleConsumeSelfDeleteDeposit(sm, HOST, STK)).status).toBe(200);
    expect((await ring()).lanes).toEqual(["entitlement-deposit", "self-delete"]);

    // Every lane the doorbell left out answers a poll with 404.
    for (const call of [handleConsumeSwkDeposit, handleConsumeCgkDeposit, handleConsumePairingDeposit, handleConsumeUpdateDeposit]) {
      expect((await call(sm, HOST)).status).toBe(404);
    }
    void deps;
  });

  it("ignores another box's deposits and expired ones", async () => {
    const { s, ring } = await world();
    await s.secretMailbox.putSwkDeposit(deposit(OTHER, "07".repeat(32)));
    await s.secretMailbox.putUpdateDeposit(deposit(HOST, "08".repeat(32), { expiresAt: NOW - 1 }));
    expect((await ring()).lanes).toEqual([]);
  });
});

describe("lanes: migration, rehome, decommission agree with their handlers", () => {
  const session = (over: Partial<ServerMigrationRecord>): ServerMigrationRecord => ({
    serverDomain: OTHER,
    username: U,
    oldStkPubHex: "22".repeat(32),
    orderJson: "{}",
    orderSignatureHex: "00".repeat(64),
    disposition: "keep",
    phase: "initiated",
    initiatedAt: NOW - 100,
    newServerDomain: null,
    newStkPubHex: null,
    attachedAt: null,
    preSeededAt: null,
    readyAt: null,
    freezeAt: null,
    takenOverAt: null,
    abortedAt: null,
    ...over,
  });

  it("migration: the same sessions give the same answer as GET migration-assignment", async () => {
    const cases: [string, ServerMigrationRecord[]][] = [
      ["no session", []],
      ["an unassigned initiated session of another box", [session({})]],
      ["a session naming this box", [session({ phase: "provisioned", newServerDomain: HOST, newStkPubHex: STK })]],
      ["an aborted one", [session({ phase: "aborted", abortedAt: NOW })]],
      ["this box's own session", [session({ serverDomain: HOST })]],
    ];
    for (const [name, sessions] of cases) {
      const { s, ring, deps } = await world({ serverMigrations: { listForUser: async () => sessions } });
      const handler = await handleGetMigrationAssignment(
        {
          servers: s.servers,
          usernames: s.usernames,
          serverMigrations: deps.serverMigrations,
          serverEvictions: s.serverEvictions,
          mailbox: { secretMailbox: s.secretMailbox, servers: s.servers },
          grants: s.deviceCapabilityGrants,
          autoUnlockLeases: s.autoUnlockLeases,
          boxSealedLeases: s.boxSealedLeases,
          auditEvents: s.auditEvents,
        } as never,
        HOST,
      );
      expect((await ring()).lanes.includes("migration"), name).toBe(handler.status === 200);
    }
  });

  it("rehome: only a claimed offer rings, as GET transfer/rehome answers", async () => {
    const offer = (over: Partial<ServerTransferRecord>) => ({ claimedAt: null, acquirerUsername: null, acquirerIrkPubHex: null, ...over }) as ServerTransferRecord;
    for (const [name, row] of [
      ["no offer", undefined],
      ["an unclaimed offer", offer({})],
      ["a claimed one", offer({ claimedAt: NOW, acquirerUsername: "bob", acquirerIrkPubHex: "cd".repeat(32) })],
    ] as const) {
      const { s, ring, deps } = await world({ serverTransfers: { getOffer: async () => row } });
      const handler = await handleGetTransferRehome(
        { servers: s.servers, usernames: s.usernames, routing: s.routing, serverTransfers: deps.serverTransfers, now: () => NOW } as never,
        HOST,
      );
      expect((await ring()).lanes.includes("rehome"), name).toBe(handler.status === 200);
    }
  });

  it("decommission: an eviction order for this box's key rings, as GET decommission answers", async () => {
    const row = { orderJson: "{}", orderSignatureHex: "ee".repeat(64) } as ServerEvictionRecord;
    for (const [name, found] of [["none", undefined], ["an order", row]] as const) {
      const { ring, deps } = await world({ serverEvictions: { getEviction: async () => found } });
      const handler = await handleGetDecommission({ serverEvictions: deps.serverEvictions } as never, HOST, STK);
      expect((await ring()).lanes.includes("decommission"), name).toBe(handler.status === 200);
    }
  });
});

describe("stamps: a list a box reads changes its stamp when its contents change", () => {
  it("aliases", async () => {
    const { s, ring } = await world();
    const a = (await ring()).stamps.aliases;
    expect((await ring()).stamps.aliases).toBe(a);
    await s.userServiceAliases.upsert({ username: U, serviceId: "blog", displayLabel: "blog", createdAt: 1, updatedAt: 1 });
    const b = (await ring()).stamps.aliases;
    expect(b).not.toBe(a);
    await s.userServiceAliases.upsert({ username: U, serviceId: "blog", displayLabel: "journal", createdAt: 1, updatedAt: 2 });
    expect((await ring()).stamps.aliases).not.toBe(b);
  });

  it("admin-root rotations", async () => {
    const { s, ring } = await world();
    const a = (await ring()).stamps.rotations;
    await s.adminRootRotations.append({ username: U, oldAdminRootPubHex: "01".repeat(32), newAdminRootPubHex: "02".repeat(32), issuedAt: 5, signatureHex: "ff".repeat(64) });
    expect((await ring()).stamps.rotations).not.toBe(a);
  });
});

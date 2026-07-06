/**
 * Storage adapter contract — ServerMigrationStorage (the server-migration
 * orchestration lane, docs/server-migration.md; migration 0081).
 *
 * One session row per migrating FQDN. Focused on the InMemory adapter's
 * observable behaviour: put→get→list, the attach stamp, and each phase mark.
 * The D1↔InMemory PARITY of the same operations is asserted in parity.test.ts
 * against the real D1-over-SQLite adapter.
 */
import { describe, expect, it } from "vitest";
import { InMemoryServerMigrationStorage } from "../src/index.js";
import type { ServerMigrationRecord } from "../src/index.js";

const POD = "home.alice.flagship.services";

function rec(over: Partial<ServerMigrationRecord> = {}): ServerMigrationRecord {
  return {
    serverDomain: POD,
    username: "alice",
    oldStkPubHex: "aa".repeat(32),
    orderJson: JSON.stringify({ migrate: true }),
    orderSignatureHex: "ff".repeat(64),
    disposition: "wipe-after-handoff",
    phase: "initiated",
    initiatedAt: 100,
    newServerDomain: null,
    newStkPubHex: null,
    attachedAt: null,
    preSeededAt: null,
    readyAt: null,
    freezeAt: null,
    takenOverAt: null,
    abortedAt: null,
    ...over,
  };
}

describe("InMemoryServerMigrationStorage", () => {
  it("put → get returns the session with hex/hostnames lowercased", async () => {
    const s = new InMemoryServerMigrationStorage();
    await s.putSession(
      rec({
        serverDomain: "HOME.Alice.Flagship.Services",
        username: "Alice",
        oldStkPubHex: "AA".repeat(32),
        orderSignatureHex: "FF".repeat(64),
      }),
    );
    const got = await s.getSession(POD);
    expect(got?.username).toBe("alice");
    expect(got?.oldStkPubHex).toBe("aa".repeat(32));
    expect(got?.orderSignatureHex).toBe("ff".repeat(64));
    expect(got?.phase).toBe("initiated");
  });

  it("putSession upserts on serverDomain", async () => {
    const s = new InMemoryServerMigrationStorage();
    await s.putSession(rec({ orderJson: "v1" }));
    await s.putSession(rec({ orderJson: "v2" }));
    expect((await s.getSession(POD))?.orderJson).toBe("v2");
    expect(await s.listForUser("alice")).toHaveLength(1);
  });

  it("listForUser is account-scoped and ordered by initiatedAt asc", async () => {
    const s = new InMemoryServerMigrationStorage();
    await s.putSession(rec({ serverDomain: "b.alice.flagship.services", initiatedAt: 300 }));
    await s.putSession(rec({ serverDomain: "a.alice.flagship.services", initiatedAt: 100 }));
    await s.putSession(rec({ serverDomain: "c.bob.flagship.services", username: "bob", initiatedAt: 1 }));
    const list = await s.listForUser("alice");
    expect(list.map((m) => m.serverDomain)).toEqual([
      "a.alice.flagship.services",
      "b.alice.flagship.services",
    ]);
  });

  it("attachNewBox stamps the new pod + STK and advances to provisioned", async () => {
    const s = new InMemoryServerMigrationStorage();
    await s.putSession(rec());
    expect(await s.attachNewBox(POD, "ATTIC.alice.flagship.services", "BB".repeat(32), 10)).toBe(true);
    const got = await s.getSession(POD);
    expect(got?.phase).toBe("provisioned");
    expect(got?.newServerDomain).toBe("attic.alice.flagship.services");
    expect(got?.newStkPubHex).toBe("bb".repeat(32));
    expect(got?.attachedAt).toBe(10);
    expect(await s.attachNewBox("nope." + POD, "x.alice.flagship.services", "cc".repeat(32), 11)).toBe(false);
  });

  it("each mark* stamps its timestamp and the phase; false when the row is missing", async () => {
    const s = new InMemoryServerMigrationStorage();
    await s.putSession(rec());
    expect(await s.markPreSeeded(POD, 11)).toBe(true);
    expect((await s.getSession(POD))?.phase).toBe("pre-seeded");
    expect(await s.markReady(POD, 12)).toBe(true);
    expect(await s.markFreeze(POD, 13)).toBe(true);
    expect(await s.markTakenOver(POD, 14)).toBe(true);
    const got = await s.getSession(POD);
    expect(got?.phase).toBe("taken-over");
    expect([got?.preSeededAt, got?.readyAt, got?.freezeAt, got?.takenOverAt]).toEqual([11, 12, 13, 14]);
    expect(await s.markAborted("missing.alice.flagship.services", 15)).toBe(false);
  });

  it("markAborted is terminal-stamping", async () => {
    const s = new InMemoryServerMigrationStorage();
    await s.putSession(rec());
    expect(await s.markAborted(POD, 42)).toBe(true);
    const got = await s.getSession(POD);
    expect(got?.phase).toBe("aborted");
    expect(got?.abortedAt).toBe(42);
  });
});

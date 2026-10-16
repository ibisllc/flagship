/**
 * The Worker side of peer backup between accounts: the routes, the secrets,
 * and the D1 store (on the real schema, every migration applied), driven by
 * the same in-process network as the control-plane simulation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { D1PbNetStore, handlePeerBackupNetRoute } from "../src/peerBackupNetworkRoutes.js";
import { SIM_NETWORK, Sim } from "../../../packages/control-plane/tests/peerBackupSim.js";
import { restoreFromPeers } from "../../../packages/server-daemon/src/peerNet/restore.js";

const jwk = JSON.stringify(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }));

function req(path: string, init?: RequestInit) {
  return new Request(`https://flagshipserver.com${path}`, init);
}

describe("peer backup routes on .com", () => {
  it("says it isn't set up until the secrets are there", async () => {
    const db = createSqliteD1() as unknown as D1Database;
    const res = await handlePeerBackupNetRoute(req("/api/peer-backup/network"), { DB: db });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Peer backup between accounts isn't set up on this server yet.");
  });

  it("serves the network constants, the gym's override and the relay", async () => {
    const db = createSqliteD1() as unknown as D1Database;
    const env = {
      DB: db,
      PB_TOKEN_RSA_JWK: jwk,
      PB_FILLER_SECRET: "11".repeat(32),
      PB_TAG_SECRET: "22".repeat(32),
      PB_NETWORK: JSON.stringify({ k: 1, n: 1, brickBytes: 65536, diversity: "account" }),
      SERVICES_BASE_URL: "https://gym-hub.example:8443",
    };
    const body = (await (await handlePeerBackupNetRoute(req("/api/peer-backup/network"), env)).json()) as {
      network: { k: number; n: number; brickBytes: number; diversity: string };
      tokenKey: { kty: string; n: string };
      relayBase: string;
    };
    expect(body.network).toMatchObject({ k: 1, n: 1, brickBytes: 65536, diversity: "account" });
    expect(body.tokenKey.kty).toBe("RSA");
    expect(body.tokenKey).not.toHaveProperty("d");
    expect(body.relayBase).toBe("https://gym-hub.example:8443");
    expect((await handlePeerBackupNetRoute(req("/api/peer-backup/root/nobody.x.flagship.services"), env)).status).toBe(404);
    expect((await handlePeerBackupNetRoute(req("/api/peer-backup/holder/checkin", { method: "POST", body: "{nope" }), env)).status).toBe(400);
  });

  it("places and restores a 4-of-8 backup with D1 as .com's store", { timeout: 120_000 }, async () => {
    const db = createSqliteD1() as unknown as D1Database;
    const sim = new Sim(SIM_NETWORK, new D1PbNetStore(db), new D1Storage(db).servers);
    for (let i = 0; i < 10; i++) sim.addBox();
    await sim.holderTicks();
    const owner = sim.boxes[0]!;
    const archive = sim.writeArchive("d1", 90_000);
    await owner.owner.offer(archive);
    for (let r = 0; r < 4; r++) {
      await sim.holderTicks();
      await owner.owner.step();
      sim.advance(10 * 60_000);
    }
    expect((await owner.owner.summary()).state).toBe("protected");
    const out = join(sim.dir, "d1-restored.data");
    await restoreFromPeers({ serverId: owner.serverId, pbk: owner.pbk, com: sim.boxes[5]!.com, transport: sim.transport, outPath: out, now: sim.now });
    expect(new Uint8Array(readFileSync(out))).toEqual(archive.content);

    const store = new D1PbNetStore(db);
    expect((await store.listHolders()).length).toBe(10);
    expect(await store.latestRoot(owner.serverId)).toMatchObject({ generation: 1, revision: 1 });
    // A spent serial can't be spent again.
    expect(await store.spendSerial("ab".repeat(32), "cd".repeat(32), 1)).toBe(true);
    expect(await store.spendSerial("ab".repeat(32), "ef".repeat(32), 2)).toBe(false);
  });

  it("keeps the newest eight roots of a server", async () => {
    const db = createSqliteD1() as unknown as D1Database;
    const store = new D1PbNetStore(db);
    for (let g = 1; g <= 10; g++) {
      await store.putRoot({ serverDomain: "a.b.flagship.services", username: "b", generation: g, revision: 1, storedAt: g, nonceHex: "00".repeat(12), ciphertextHex: "ab" }, 8);
    }
    const rows = await store.listRoots("a.b.flagship.services");
    expect(rows.map((r) => r.generation)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
  });
});

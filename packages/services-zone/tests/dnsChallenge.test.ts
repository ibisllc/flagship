import { describe, expect, it } from "vitest";
import { DnsChallengeService } from "../src/dnsChallenge.js";
import type { TxtRecord, ZoneApi } from "../src/types.js";

class FakeZone implements ZoneApi {
  records: (TxtRecord & { id: string })[] = [];
  private nextId = 1;
  callLog: string[] = [];

  async createTxt(record: { name: string; value: string; ttl?: number }): Promise<TxtRecord> {
    this.callLog.push(`create:${record.name}`);
    const id = `rec-${this.nextId++}`;
    const r = { id, name: record.name, value: record.value, ttl: record.ttl };
    this.records.push(r);
    return r;
  }

  async deleteTxt(id: string): Promise<void> {
    this.callLog.push(`delete:${id}`);
    this.records = this.records.filter((r) => r.id !== id);
  }

  async listTxtByName(name: string): Promise<TxtRecord[]> {
    this.callLog.push(`list:${name}`);
    return this.records.filter((r) => r.name === name);
  }
}

describe("DnsChallengeService", () => {
  it("publishes a TXT record and returns a disposer that deletes by id", async () => {
    const zone = new FakeZone();
    const svc = new DnsChallengeService(zone);
    const dispose = await svc.publishTxt(
      "_acme-challenge.harry.flagship.services",
      "tok-thumb",
    );
    expect(zone.records).toHaveLength(1);
    await dispose();
    expect(zone.records).toHaveLength(0);
  });

  it("cleans up stale TXT records of the same name before publishing", async () => {
    const zone = new FakeZone();
    // Pretend a previous failed issuance left two stale records around.
    await zone.createTxt({ name: "_acme-challenge.harry.flagship.services", value: "stale-1" });
    await zone.createTxt({ name: "_acme-challenge.harry.flagship.services", value: "stale-2" });
    expect(zone.records).toHaveLength(2);

    const svc = new DnsChallengeService(zone);
    await svc.publishTxt("_acme-challenge.harry.flagship.services", "fresh");

    expect(zone.records).toHaveLength(1);
    expect(zone.records[0]!.value).toBe("fresh");
  });

  it("disposer tolerates a record that's already gone (no second-delete throw)", async () => {
    const zone = new FakeZone();
    const svc = new DnsChallengeService(zone);
    const dispose = await svc.publishTxt("_acme-challenge.harry.flagship.services", "v");
    // Manually wipe what dispose() will try to delete:
    zone.records = [];
    await expect(dispose()).resolves.toBeUndefined();
  });
});

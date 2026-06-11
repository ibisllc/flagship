import { describe, expect, it } from "vitest";
import {
  InMemoryDaemonStatusStorage,
  type DaemonStatusRecord,
} from "../src/index.js";

function rec(over: Partial<DaemonStatusRecord> = {}): DaemonStatusRecord {
  return {
    serverDomain: "abc5.harry1.flagship.services",
    certSha256: "ab".repeat(32),
    certValidUntil: 1_800_000_000_000,
    certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
    servicesServedJson: JSON.stringify(["abc5.harry1.flagship.services"]),
    lastReported: 1_700_000_000_000,
    ...over,
  };
}

describe("InMemoryDaemonStatusStorage — signed-report fields (migration 0048)", () => {
  it("round-trips reportJson + signatureHex verbatim", async () => {
    const s = new InMemoryDaemonStatusStorage();
    const reportJson = JSON.stringify({
      serverDomain: "abc5.harry1.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: 1_800_000_000_000,
      certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
      appsServed: ["abc5.harry1.flagship.services"],
      nonce: "00112233445566778899aabbccddeeff",
      issuedAt: 1_700_000_000_000,
    });
    const signatureHex = "cd".repeat(64);
    await s.put(rec({ reportJson, signatureHex }));
    const got = await s.get("abc5.harry1.flagship.services");
    expect(got?.reportJson).toBe(reportJson);
    expect(got?.signatureHex).toBe(signatureHex);
  });

  it("a put WITHOUT the signed-report fields reads back as explicit nulls (D1 read-shape parity)", async () => {
    const s = new InMemoryDaemonStatusStorage();
    await s.put(rec());
    const got = await s.get("abc5.harry1.flagship.services");
    expect(got?.reportJson).toBeNull();
    expect(got?.signatureHex).toBeNull();
  });

  it("listForUser carries the signed-report fields", async () => {
    const s = new InMemoryDaemonStatusStorage();
    await s.put(rec({ reportJson: "{}", signatureHex: "ee".repeat(64) }));
    const rows = await s.listForUser("harry1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportJson).toBe("{}");
    expect(rows[0]?.signatureHex).toBe("ee".repeat(64));
  });

  it("a re-put without the fields clears a previously stored report (the row mirrors the LATEST report)", async () => {
    const s = new InMemoryDaemonStatusStorage();
    await s.put(rec({ reportJson: "{}", signatureHex: "ee".repeat(64) }));
    await s.put(rec({ lastReported: 1_700_000_100_000 }));
    const got = await s.get("abc5.harry1.flagship.services");
    expect(got?.lastReported).toBe(1_700_000_100_000);
    expect(got?.reportJson).toBeNull();
    expect(got?.signatureHex).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildLanServiceRecord,
  InMemoryMdnsAdvertiser,
  startLanFallback,
} from "../src/lanFallback.js";

const STK = "ab".repeat(32);

describe("buildLanServiceRecord", () => {
  it("publishes _flagship._tcp with username + server in the name", () => {
    const r = buildLanServiceRecord({
      serverId: "srv-1",
      username: "harry",
      port: 9090,
      stkPubHex: STK,
    });
    expect(r.type).toBe("_flagship._tcp");
    expect(r.name).toBe("flagship-harry-srv-1");
    expect(r.port).toBe(9090);
  });

  it("TXT record carries non-secret discovery metadata only", () => {
    const r = buildLanServiceRecord({
      serverId: "srv-1",
      username: "harry",
      port: 9090,
      stkPubHex: STK,
    });
    expect(r.txt).toEqual({
      v: "1",
      user: "harry",
      server: "srv-1",
      stkPub: STK,
      path: "/tunnel-lan",
    });
  });

  it("rejects an stkPubHex that is not 32-byte hex (defense against record poisoning)", () => {
    expect(() =>
      buildLanServiceRecord({
        serverId: "x",
        username: "y",
        port: 1,
        stkPubHex: "not-hex",
      }),
    ).toThrow(/32-byte hex/);
  });

  it("respects an explicit basePath override", () => {
    const r = buildLanServiceRecord({
      serverId: "srv-1",
      username: "harry",
      port: 9090,
      stkPubHex: STK,
      basePath: "/v2/lan",
    });
    expect(r.txt!.path).toBe("/v2/lan");
  });
});

describe("startLanFallback", () => {
  it("publishes the service through the advertiser and lets you stop it", async () => {
    const adv = new InMemoryMdnsAdvertiser();
    const handle = await startLanFallback(adv, {
      serverId: "srv-1",
      username: "harry",
      port: 9090,
      stkPubHex: STK,
    });
    expect(adv.published).toHaveLength(1);
    await handle.stop();
    expect(adv.published).toHaveLength(0);
  });
});

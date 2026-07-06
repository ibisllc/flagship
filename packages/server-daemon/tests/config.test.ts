import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const validHex = "00".repeat(32);

describe("parseConfig", () => {
  it("accepts a well-formed config", () => {
    const cfg = parseConfig({
      serverId: "srv-1",
      userId: "u1",
      bakPublicKey: validHex,
      irkPublicKey: validHex,
    });
    expect(cfg.serverId).toBe("srv-1");
    expect(cfg.bakPublicKey.length).toBe(32);
    expect(cfg.irkPublicKey.length).toBe(32);
  });

  it("rejects missing serverId", () => {
    expect(() =>
      parseConfig({ userId: "u1", bakPublicKey: validHex, irkPublicKey: validHex }),
    ).toThrow(/serverId/);
  });

  it("rejects bad-length pubkeys", () => {
    expect(() =>
      parseConfig({
        serverId: "srv-1",
        userId: "u1",
        bakPublicKey: "00",
        irkPublicKey: validHex,
      }),
    ).toThrow(/bakPublicKey/);
  });

  it("rejects non-hex pubkeys", () => {
    expect(() =>
      parseConfig({
        serverId: "srv-1",
        userId: "u1",
        bakPublicKey: "z".repeat(64),
        irkPublicKey: validHex,
      }),
    ).toThrow(/bakPublicKey/);
  });

  it("gating v2 — parses an optional ownerAidPubHex", () => {
    const aid = "ab".repeat(32);
    const cfg = parseConfig({
      serverId: "srv-1",
      userId: "u1",
      bakPublicKey: validHex,
      irkPublicKey: validHex,
      ownerAidPubHex: aid,
    });
    expect(cfg.ownerAidPub).toBeDefined();
    expect(cfg.ownerAidPub!.length).toBe(32);
  });

  it("gating v2 — a malformed ownerAidPubHex is IGNORED (non-blocking), not thrown", () => {
    const cfg = parseConfig({
      serverId: "srv-1",
      userId: "u1",
      bakPublicKey: validHex,
      irkPublicKey: validHex,
      ownerAidPubHex: "nothex",
    });
    expect(cfg.ownerAidPub).toBeUndefined(); // dropped, but the config still loads
    expect(cfg.serverId).toBe("srv-1");
  });
});

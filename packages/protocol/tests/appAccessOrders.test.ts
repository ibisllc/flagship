import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appRankCanonicalBytes,
  parseAppRankOrder,
  parseAppRankTarget,
  parseServiceAccessModeV2,
  parseServiceAllowRemoveV2,
  serviceAccessModeV2CanonicalBytes,
  serviceAllowRemoveV2CanonicalBytes,
  signAppRank,
  signServiceAccessModeV2,
  signServiceAllowRemoveV2,
  verifyAppRank,
  verifyServiceAccessModeV2,
  verifyServiceAllowRemoveV2,
  type AppRankOrder,
  type ServiceAccessModeOrder,
  type ServiceAllowRemoveOrder,
} from "../src/appAccessOrders.js";
import { hex } from "../src/canonicalBase.js";
import { ed } from "../src/edSync.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-access-orders/vectors.json"), "utf8"),
);
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const seed = fromHex(V.signerSeedHex);
const signer = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const other = (() => {
  const s = new Uint8Array(32).fill(0x11);
  return { privateKey: s, publicKey: ed.getPublicKey(s) };
})();

describe("app-access-orders vectors", () => {
  it("signer pub matches", () => {
    expect(hex(signer.publicKey)).toBe(V.signerPub);
  });

  it.each(V.rank.cases.map((c: AppRankOrder & { canonical: string; signature: string }, i: number) => [i, c]))(
    "rank case #%i",
    (_i, c) => {
      const o: AppRankOrder = { serviceRef: c.serviceRef, target: c.target, rank: c.rank, issuedAt: c.issuedAt };
      expect(new TextDecoder().decode(appRankCanonicalBytes(o))).toBe(c.canonical);
      expect(hex(signAppRank(o, signer))).toBe(c.signature);
      expect(verifyAppRank(o, fromHex(c.signature), signer.publicKey)).toBe(true);
      expect(verifyAppRank(o, fromHex(c.signature), other.publicKey)).toBe(false);
      expect(verifyAppRank({ ...o, issuedAt: o.issuedAt + 1 }, fromHex(c.signature), signer.publicKey)).toBe(false);
      expect(parseAppRankOrder(JSON.parse(JSON.stringify(o)))).toEqual(o);
    },
  );

  it.each(V.rank.invalid.map((c: AppRankOrder & { why: string }) => [c.why, c]))("rank refuses: %s", (_w, c) => {
    const o = { serviceRef: c.serviceRef, target: c.target, rank: c.rank, issuedAt: c.issuedAt };
    expect(() => appRankCanonicalBytes(o)).toThrow();
    expect(parseAppRankOrder(o)).toBeNull();
  });

  it.each(V.mode.cases.map((c: ServiceAccessModeOrder & { canonical: string; signature: string }, i: number) => [i, c]))(
    "mode case #%i",
    (_i, c) => {
      const o: ServiceAccessModeOrder = { serviceRef: c.serviceRef, mode: c.mode, issuedAt: c.issuedAt };
      expect(new TextDecoder().decode(serviceAccessModeV2CanonicalBytes(o))).toBe(c.canonical);
      expect(hex(signServiceAccessModeV2(o, signer))).toBe(c.signature);
      expect(verifyServiceAccessModeV2(o, fromHex(c.signature), signer.publicKey)).toBe(true);
      expect(parseServiceAccessModeV2(o)).toEqual(o);
    },
  );

  it.each(V.mode.invalid.map((c: { why: string }) => [c.why, c]))("mode refuses: %s", (_w, c) => {
    expect(() => serviceAccessModeV2CanonicalBytes(c as ServiceAccessModeOrder)).toThrow();
    expect(parseServiceAccessModeV2(c)).toBeNull();
  });

  it.each(V.remove.cases.map((c: ServiceAllowRemoveOrder & { canonical: string; signature: string }, i: number) => [i, c]))(
    "remove case #%i",
    (_i, c) => {
      const o: ServiceAllowRemoveOrder = { serviceRef: c.serviceRef, aid: c.aid, issuedAt: c.issuedAt };
      expect(new TextDecoder().decode(serviceAllowRemoveV2CanonicalBytes(o))).toBe(c.canonical);
      expect(hex(signServiceAllowRemoveV2(o, signer))).toBe(c.signature);
      expect(verifyServiceAllowRemoveV2(o, fromHex(c.signature), signer.publicKey)).toBe(true);
      expect(parseServiceAllowRemoveV2(o)).toEqual(o);
    },
  );

  it.each(V.remove.invalid.map((c: { why: string }) => [c.why, c]))("remove refuses: %s", (_w, c) => {
    expect(() => serviceAllowRemoveV2CanonicalBytes(c as ServiceAllowRemoveOrder)).toThrow();
    expect(parseServiceAllowRemoveV2(c)).toBeNull();
  });
});

describe("app-access-orders beyond the vectors", () => {
  it("parses each target kind", () => {
    const d = "a".repeat(64);
    expect(parseAppRankTarget(`device:${d}`)).toEqual({ kind: "device", pub: d });
    expect(parseAppRankTarget(`share:${"b".repeat(32)}`)).toEqual({ kind: "share", shareId: "b".repeat(32) });
    expect(parseAppRankTarget(`grant:x1/${d}`)).toEqual({ kind: "grant", inviteId: "x1", aid: d });
    expect(parseAppRankTarget("owner")).toBeNull();
  });

  it("a v1 mode order (with serverId) never parses as v2", () => {
    expect(parseServiceAccessModeV2({ serverId: "home.x", serviceRef: "a--b", mode: "open", issuedAt: 1 })).toBeNull();
    expect(parseServiceAllowRemoveV2({ serverId: "home.x", serviceRef: "a--b", aid: "a".repeat(64), issuedAt: 1 })).toBeNull();
  });

  it("different tags never verify for one another", () => {
    const mode: ServiceAccessModeOrder = { serviceRef: "a--b", mode: "open", issuedAt: 5 };
    const sig = signServiceAccessModeV2(mode, signer);
    const rank: AppRankOrder = { serviceRef: "a--b", target: `device:${"a".repeat(64)}`, rank: "member", issuedAt: 5 };
    expect(verifyAppRank(rank, sig, signer.publicKey)).toBe(false);
  });
});

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handlePbTokens,
  InMemoryPbNetStore,
  PB_TOKEN_STARTER,
  type PbHolderRow,
  type PbNetDeps,
  type PbNetStore,
} from "@flagship/control-plane";
import { canonicalPbTokens, ed, pbBlindedDigest, PB_NETWORK_DEFAULT, rsaPrivateKeyFromJwk } from "@flagship/protocol";
import type { D1Database, ServerRecord, ServerStorage } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { D1PbNetStore } from "../src/peerBackupNetworkRoutes.js";

const tokenKey = rsaPrivateKeyFromJwk(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }) as Record<string, string>,
);
const kHex = Math.ceil(tokenKey.n.toString(16).length / 2) * 2;
const NOW = 1_800_000_000_000;
const DOMAIN = "home.alice.flagship.services";
const stkPriv = new Uint8Array(randomBytes(32));
const stkPub = ed.getPublicKey(stkPriv);

function servers(): ServerStorage {
  const rec: ServerRecord = { serverDomain: DOMAIN, username: "alice", identityPubKeyHex: Buffer.from(stkPub).toString("hex"), registeredAt: 1 };
  return { get: async (d: string) => (d === DOMAIN ? { ...rec } : undefined) } as unknown as ServerStorage;
}

function holder(): PbHolderRow {
  return {
    pikPubHex: "aa".repeat(32),
    serverDomain: DOMAIN,
    username: "alice",
    xPubHex: "bb".repeat(32),
    poolBytes: 1,
    accountTag: "t",
    netTag: "n",
    registeredAt: 1,
    lastCheckinAt: NOW,
    presenceHex: "",
    presenceLastHour: 0,
    fillerCount: 0,
    fillerLastAt: 0,
    fillerDay: 0,
    fillerDayBytes: 0,
    pending: null,
    lastChallengeAt: 0,
    proofsOk: 0,
    proofsFailed: 0,
    proofsDay: 0,
    leaving: false,
  };
}

function body(count: number) {
  const blindedHex = Array.from({ length: count }, () => `00${randomBytes(kHex / 2 - 1).toString("hex")}`);
  const sig = ed.sign(canonicalPbTokens(DOMAIN, count, pbBlindedDigest(blindedHex), NOW), stkPriv);
  return { serverDomain: DOMAIN, blindedHex, issuedAt: NOW, signatureHex: Buffer.from(sig).toString("hex") };
}

async function deps(store: PbNetStore): Promise<PbNetDeps> {
  await store.putHolder(holder());
  return {
    servers: servers(),
    store,
    network: PB_NETWORK_DEFAULT,
    relayBase: "https://relay.example",
    tokenKey,
    fillerSecret: new Uint8Array(32),
    tagSecret: new Uint8Array(32),
    now: () => NOW,
  };
}

const stores: Array<[string, () => PbNetStore]> = [
  ["in memory", () => new InMemoryPbNetStore()],
  ["D1", () => new D1PbNetStore(createSqliteD1() as unknown as D1Database)],
];

describe.each(stores)("peer backup token cap (%s)", (_name, make) => {
  it("never hands out more than the allowance to parallel requests", async () => {
    const d = await deps(make());
    const res = await Promise.all(Array.from({ length: 20 }, () => handlePbTokens(d, body(1))));
    const ok = res.filter((r) => r.status === 200);
    expect(ok.length).toBe(PB_TOKEN_STARTER);
    expect(res.filter((r) => r.status === 429).length).toBe(20 - PB_TOKEN_STARTER);
    expect(ok.flatMap((r) => (r.body as { signatures: string[] }).signatures).length).toBe(PB_TOKEN_STARTER);
    expect(await d.store.tokensIssuedSince(DOMAIN, 0)).toBe(PB_TOKEN_STARTER);
  });

  it("holds the cap with multi-token requests and signs nothing when refused", async () => {
    const d = await deps(make());
    const res = await Promise.all(Array.from({ length: 6 }, () => handlePbTokens(d, body(3))));
    const signed = res.filter((r) => r.status === 200).flatMap((r) => (r.body as { signatures: string[] }).signatures);
    expect(signed.length).toBe(6);
    for (const r of res.filter((x) => x.status === 429)) expect(r.body).not.toHaveProperty("signatures");
    expect(await d.store.tokensIssuedSince(DOMAIN, 0)).toBe(6);
  });

  it("refuses an out-of-range blinded token before reserving", async () => {
    const d = await deps(make());
    const b = body(2);
    b.blindedHex[1] = "ff".repeat(kHex / 2);
    const r = await handlePbTokens(d, { ...b, signatureHex: Buffer.from(ed.sign(canonicalPbTokens(DOMAIN, 2, pbBlindedDigest(b.blindedHex), NOW), stkPriv)).toString("hex") });
    expect(r.status).toBe(400);
    expect(await d.store.tokensIssuedSince(DOMAIN, 0)).toBe(0);
  });
});
